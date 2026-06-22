/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker service
 * Purpose:
 * - Re-export reviewed LibreChat MCP tools to GlassHive workers through one broker MCP surface.
 * - Invoke underlying MCP tools as the authenticated LibreChat user without exposing provider tokens.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPManager, getMCPServersRegistry, getFlowStateManager } = require('~/config');
const { findToken, createToken, updateToken, deleteToken, getUserById } = require('~/models');
const { getLogStores } = require('~/cache');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const {
  auditSafeToolSummary,
  brokerToolName,
  collectAllowedServers,
  evaluateToolCallPolicy,
  getPolicy,
  helperToolDefinitions,
  isTrustedServerConfig,
  logOmission,
} = require('./GlassHiveCapabilityPolicyService');
const {
  grantReplayTtlMs,
  rememberInvocation,
  verifyWriteConfirmation,
} = require('./GlassHiveCapabilityBrokerAuth');

const DEFAULT_PROVIDER = 'openai';

function brokerDiscoveryRetryDelayMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

function brokerProviderTimeoutMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS);
  // Bound a single underlying provider call below the per-server MCP timeout (ms-365 = 120000)
  // so a slow/unavailable provider becomes a clean blocker rather than a hang.
  return Number.isFinite(raw) && raw > 0 ? raw : 45000;
}

async function userForGrant(grant) {
  const userId = String(grant?.user_id || '').trim();
  if (!userId) {
    throw new Error('GlassHive capability broker grant is missing user id');
  }
  const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes').catch(
    () => null,
  );
  if (!user) {
    throw new Error('GlassHive capability broker user no longer exists');
  }
  return {
    ...user,
    id: String(user?.id || user?._id || userId),
    _id: user._id || userId,
    role: user?.role || grant.user_role || 'USER',
  };
}

async function requestedServersFromGrant(grant, user, registry) {
  const servers = new Set(
    (grant?.allowed_servers || []).map((server) => String(server || '').trim()).filter(Boolean),
  );
  if (grant?.allow_dynamic_policy_servers === true && registry?.getAllServerConfigs) {
    const mcpConfig = await registry.getAllServerConfigs(user.id).catch((error) => {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Failed to resolve dynamic policy servers',
        {
          message: error?.message,
        },
      );
      return null;
    });
    for (const serverName of collectAllowedServers({
      mcpConfig: mcpConfig || {},
      executionMode: grant.execution_mode,
    })) {
      servers.add(serverName);
    }
  }
  return Array.from(servers).sort();
}

async function discoverServerTools({ user, serverName, serverConfig, signal } = {}) {
  const discoverOnce = () =>
    reinitMCPServer({
      user,
      signal,
      forceNew: true,
      serverName,
      serverConfig,
      returnOnOAuth: true,
      oauthStart: async () => {
        // Worker-side OAuth starts are intentionally not launched from the sandbox.
      },
    });

  let result = await discoverOnce();
  const toolCount = () => (Array.isArray(result?.tools) ? result.tools.length : 0);
  const shouldRetry =
    !signal?.aborted && !result?.oauthRequired && (!result?.success || toolCount() === 0);

  if (shouldRetry) {
    const delayMs = brokerDiscoveryRetryDelayMs();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!signal?.aborted) {
      result = await discoverOnce();
    }
  }

  return {
    tools: Array.isArray(result?.tools) ? result.tools : [],
    oauthRequired: Boolean(result?.oauthRequired),
    success: Boolean(result?.success),
    message: result?.message || '',
  };
}

function omissionReasonForDiscovery(discovered) {
  if (discovered.oauthRequired && discovered.tools.length === 0) {
    return 'oauth_required';
  }
  if (!discovered.success) {
    return 'server_unavailable';
  }
  if (discovered.tools.length === 0) {
    return 'no_tools_discovered';
  }
  return '';
}

async function buildCapabilityCatalog({ grant, signal } = {}) {
  const user = await userForGrant(grant);
  const registry = getMCPServersRegistry();
  const tools = [];
  const servers = [];
  const omissions = [];

  for (const serverName of await requestedServersFromGrant(grant, user, registry)) {
    const serverConfig = await registry.getServerConfig(serverName, user.id).catch(() => null);
    const policy = getPolicy(serverConfig);
    if (!serverConfig || !policy || !isTrustedServerConfig(serverConfig)) {
      omissions.push(logOmission('policy_not_authorized', serverName));
      continue;
    }
    let discovered;
    try {
      discovered = await discoverServerTools({ user, serverName, serverConfig, signal });
    } catch (error) {
      omissions.push(logOmission('discovery_failed', serverName, { message: error?.message }));
      continue;
    }
    const omissionReason = omissionReasonForDiscovery(discovered);
    if (omissionReason) {
      omissions.push(logOmission(omissionReason, serverName, { message: discovered.message }));
    }
    servers.push({
      name: serverName,
      riskClass: policy.riskClass,
      available: discovered.success && discovered.tools.length > 0,
      oauthRequired: discovered.oauthRequired,
      toolCount: discovered.tools.length,
      message: discovered.message,
    });
    for (const tool of discovered.tools) {
      if (policy.reexportNativeTools === false) {
        continue;
      }
      const name = String(tool?.name || '').trim();
      if (!name) {
        continue;
      }
      const brokerName = brokerToolName(serverName, name);
      tools.push({
        serverName,
        toolName: name,
        brokerName,
        policy,
        mcpTool: tool,
        definition: auditSafeToolSummary({
          serverName,
          toolName: name,
          brokerName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          policy,
          tool,
        }),
      });
    }
  }

  return {
    user,
    servers,
    omissions,
    tools,
    helperTools: helperToolDefinitions(),
  };
}

function toolDefinitionsForMcp(catalog) {
  return [
    ...catalog.helperTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...catalog.tools.map((item) => item.definition),
  ];
}

function publicCatalog(catalog) {
  return {
    servers: catalog.servers,
    tools: catalog.tools.map((item) => ({
      name: item.brokerName,
      server: item.serverName,
      tool: item.toolName,
      description: item.mcpTool?.description || '',
      access: item.definition.annotations.access,
      riskClass: item.definition.annotations.riskClass,
    })),
    omissions: catalog.omissions,
  };
}

function findNativeTool(catalog, brokerToolNameValue) {
  return catalog.tools.find((item) => item.brokerName === brokerToolNameValue);
}

function findNativeToolByServerTool(catalog, serverName, toolName) {
  return catalog.tools.find((item) => item.serverName === serverName && item.toolName === toolName);
}

function extractIntentFlags(args = {}) {
  const meta = args.__viventiumCapabilityIntent || args.__glasshiveCapabilityIntent || {};
  return {
    explicitContentIntent: meta.explicitContentIntent === true,
    invocationId: String(meta.invocation_id || args.invocation_id || '').trim(),
    writeConfirmationToken: String(
      meta.write_confirmation_token ||
        meta.confirmation_token ||
        args.write_confirmation_token ||
        args.confirmation_token ||
        '',
    ).trim(),
  };
}

function stripBrokerIntentMetadata(args = {}) {
  const {
    __viventiumCapabilityIntent,
    __glasshiveCapabilityIntent,
    invocation_id,
    confirmation_token,
    write_confirmation_token,
    ...toolArguments
  } = args || {};
  return toolArguments;
}

async function invokeUnderlyingTool({ grant, catalog, nativeTool, args = {}, signal } = {}) {
  const { invocationId, writeConfirmationToken } = extractIntentFlags(args);
  const toolArguments = stripBrokerIntentMetadata(args);
  const grantContentReadIntent = grant?.scopes?.content_read === true;
  let policyDecision = evaluateToolCallPolicy({
    policy: nativeTool.policy,
    toolName: nativeTool.toolName,
    tool: nativeTool.mcpTool,
    confirmed: false,
    contentReadIntent: grantContentReadIntent,
  });
  if (policyDecision.toolPolicy?.access === 'write' && !invocationId) {
    return {
      status: 'blocked',
      reason: 'write_requires_invocation_id',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  if (policyDecision.reason === 'write_requires_host_confirmation') {
    try {
      verifyWriteConfirmation(writeConfirmationToken, {
        grantId: grant.grant_id,
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        invocationId,
        args: toolArguments,
      });
      policyDecision = evaluateToolCallPolicy({
        policy: nativeTool.policy,
        toolName: nativeTool.toolName,
        tool: nativeTool.mcpTool,
        confirmed: true,
        contentReadIntent: grantContentReadIntent,
      });
    } catch (error) {
      return {
        status: 'blocked',
        reason: 'write_requires_host_confirmation',
        server: nativeTool.serverName,
        tool: nativeTool.toolName,
      };
    }
  }
  if (!policyDecision.allowed) {
    return {
      status: 'blocked',
      reason: policyDecision.reason,
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  const replay = await rememberInvocation({
    grantId: grant.grant_id,
    invocationId,
    ttlMs: grantReplayTtlMs(grant),
  });
  if (!replay.accepted) {
    return {
      status: 'blocked',
      reason: replay.reason || 'duplicate_invocation',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  const mcpManager = getMCPManager(catalog.user.id);
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  /* === VIVENTIUM START ===
   * Feature: bounded provider-call timeout + structured degraded blocker
   * Purpose: A slow/unavailable underlying MCP (e.g. MS365) must surface a structured
   *   `provider_degraded` blocker the worker reports per its completion contract, not hang or
   *   bubble an opaque RPC error that nudges the worker into a browser fallback. */
  const providerTimeoutMs = brokerProviderTimeoutMs();
  const abortController = new AbortController();
  const onParentAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else if (typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
  }
  let timedOut = false;
  let timeoutHandle = null;
  let result;
  try {
    result = await Promise.race([
      mcpManager.callTool({
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        provider: DEFAULT_PROVIDER,
        toolArguments,
        options: { signal: abortController.signal },
        user: catalog.user,
        requestBody: {
          conversationId: grant.conversation_id,
          parentMessageId: grant.parent_message_id,
          messageId: grant.message_id,
        },
        flowManager,
        tokenMethods: {
          findToken,
          createToken,
          updateToken,
          deleteToken,
        },
        oauthStart: async () => {
          throw new Error('OAuth authentication required for this MCP server');
        },
        oauthEnd: async () => {},
        graphTokenResolver: getGraphApiToken,
      }),
      new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          abortController.abort();
          reject(new Error(`broker provider call timed out after ${providerTimeoutMs}ms`));
        }, providerTimeoutMs);
      }),
    ]);
  } catch (error) {
    const message = String((error && error.message) || '');
    const isTimeout =
      timedOut || /timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|abort/i.test(message);
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Provider tool call failed', {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      serverName: nativeTool.serverName,
      toolName: nativeTool.toolName,
      timedOut: isTimeout,
      timeoutMs: providerTimeoutMs,
      message,
    });
    return {
      status: 'blocked',
      reason: isTimeout ? 'provider_degraded' : 'provider_error',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
      retryable: isTimeout,
      detail: isTimeout
        ? `Connected-account provider ${nativeTool.serverName} did not respond within ${Math.round(
            providerTimeoutMs / 1000,
          )}s. Report this as a temporary provider issue; do not fall back to browser automation.`
        : `Connected-account provider ${nativeTool.serverName} returned an error for ${nativeTool.toolName}.`,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onParentAbort);
    }
  }
  logger.info('[VIVENTIUM][glasshive-capability-broker] MCP tool invoked', {
    userId: catalog.user.id,
    grantId: grant.grant_id,
    serverName: nativeTool.serverName,
    toolName: nativeTool.toolName,
    outcome: 'success',
  });
  return result;
  /* === VIVENTIUM END === */
}

async function handleToolCall({ grant, toolName, args = {}, signal } = {}) {
  const catalog = await buildCapabilityCatalog({ grant, signal });
  if (toolName === 'capabilities_list') {
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_describe') {
    const requested = args || {};
    if (requested.tool) {
      const native =
        findNativeTool(catalog, requested.tool) ||
        findNativeToolByServerTool(catalog, requested.server, requested.tool);
      if (!native) {
        return { status: 'not_found', server: requested.server || '', tool: requested.tool };
      }
      return native.definition;
    }
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_invoke') {
    const native = findNativeToolByServerTool(catalog, args.server, args.tool);
    if (!native) {
      return { status: 'not_found', server: args.server || '', tool: args.tool || '' };
    }
    return invokeUnderlyingTool({
      grant,
      catalog,
      nativeTool: native,
      args: args.arguments || {},
      signal,
    });
  }
  const nativeTool = findNativeTool(catalog, toolName);
  if (!nativeTool) {
    return { status: 'not_found', tool: toolName };
  }
  return invokeUnderlyingTool({
    grant,
    catalog,
    nativeTool,
    args,
    signal,
  });
}

module.exports = {
  buildCapabilityCatalog,
  handleToolCall,
  publicCatalog,
  toolDefinitionsForMcp,
};
