/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker service
 * Purpose:
 * - Re-export reviewed LibreChat MCP tools to GlassHive workers through one broker MCP surface.
 * - Invoke underlying MCP tools as the authenticated LibreChat user without exposing provider tokens.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { loadWebSearchAuth } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPManager, getMCPServersRegistry, getFlowStateManager } = require('~/config');
const { findToken, createToken, updateToken, deleteToken, getUserById } = require('~/models');
const { getLogStores } = require('~/cache');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const {
  createFileSearchTool,
  fileSearchJsonSchema,
} = require('~/app/clients/tools/util/fileSearch');
const { createViventiumSearchTool } = require('~/app/clients/tools/util/viventiumSearchTool');
const {
  buildMcpOAuthRecovery,
  inspectStoredOAuthCredentialState,
  reinitMCPServer,
} = require('~/server/services/Tools/mcp');
const {
  auditSafeToolSummary,
  collisionSafeBrokerToolName,
  collectAllowedServers,
  evaluateToolCallPolicy,
  getPolicy,
  helperToolDefinitions,
  isTrustedServerConfig,
  logOmission,
  mcpToolAnnotations,
} = require('./GlassHiveCapabilityPolicyService');
const {
  grantReplayTtlMs,
  rememberInvocation,
  verifyWriteConfirmation,
} = require('./GlassHiveCapabilityBrokerAuth');

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_DISCOVERY_CACHE_GRANTS = 256;
const GRANT_DISCOVERY_CACHE = new Map();

const HOST_TOOL_DEFINITIONS = Object.freeze({
  file_search: Object.freeze({
    name: 'file_search',
    description:
      'Search the files and conversation-recall resources resolved by the host for this exact Agent turn. Results include source provenance when available; degraded recall is reported explicitly.',
    inputSchema: fileSearchJsonSchema,
    annotations: Object.freeze(mcpToolAnnotations({ access: 'read', openWorldDefault: false })),
  }),
  web_search: Object.freeze({
    name: 'web_search',
    description:
      'Search the configured live web provider through the authenticated host. Provider failures and successful empty results are returned explicitly.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A concise search query.' },
        date: {
          type: 'string',
          enum: ['h', 'd', 'w', 'm', 'y'],
          description: 'Optional result age: hour, day, week, month, or year.',
        },
        country: { type: 'string', description: 'Optional two-letter country code.' },
        images: { type: 'boolean', description: 'Also search images.' },
        videos: { type: 'boolean', description: 'Also search videos.' },
        news: { type: 'boolean', description: 'Also search news.' },
      },
      required: ['query'],
    }),
    annotations: Object.freeze(mcpToolAnnotations({ access: 'read', openWorldDefault: true })),
  }),
});

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

/* === VIVENTIUM START ===
 * Feature: grant-scoped broker discovery reuse
 * Purpose: `tools/list` already proves the provider schemas for this short-lived signed grant.
 * Reuse only that successful schema discovery during the ensuing tool calls so an MCP client's
 * request deadline is spent on the real provider operation, while user existence and current
 * policy authorization are still revalidated on every request. */
function brokerDiscoveryCacheTtlMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISCOVERY_CACHE_TTL_MS;
}

function discoveryCacheKey(grant = {}) {
  const grantId = String(grant.grant_id || '').trim();
  const userId = String(grant.user_id || '').trim();
  const nonce = String(grant.nonce || '').trim();
  return grantId && userId && nonce ? `${grantId}:${userId}:${nonce}` : '';
}

function pruneDiscoveryCache(nowMs = Date.now()) {
  for (const [key, record] of GRANT_DISCOVERY_CACHE.entries()) {
    if (!record || Number(record.expiresAtMs) <= nowMs) {
      GRANT_DISCOVERY_CACHE.delete(key);
    }
  }
  while (GRANT_DISCOVERY_CACHE.size > MAX_DISCOVERY_CACHE_GRANTS) {
    GRANT_DISCOVERY_CACHE.delete(GRANT_DISCOVERY_CACHE.keys().next().value);
  }
}

function cachedServerDiscovery(grant, serverName, nowMs = Date.now()) {
  pruneDiscoveryCache(nowMs);
  const key = discoveryCacheKey(grant);
  if (!key) {
    return null;
  }
  return GRANT_DISCOVERY_CACHE.get(key)?.servers?.get(serverName) || null;
}

function rememberServerDiscovery(grant, serverName, discovered, nowMs = Date.now()) {
  if (!discovered?.success || !Array.isArray(discovered.tools) || discovered.tools.length === 0) {
    return;
  }
  const key = discoveryCacheKey(grant);
  if (!key) {
    return;
  }
  const grantExpiryMs = Number(grant.exp) * 1000;
  const expiresAtMs = Math.min(
    nowMs + brokerDiscoveryCacheTtlMs(),
    Number.isFinite(grantExpiryMs) ? grantExpiryMs : nowMs + brokerDiscoveryCacheTtlMs(),
  );
  if (expiresAtMs <= nowMs) {
    return;
  }
  const existing = GRANT_DISCOVERY_CACHE.get(key);
  const record =
    existing && Number(existing.expiresAtMs) > nowMs
      ? existing
      : { expiresAtMs, servers: new Map() };
  record.expiresAtMs = Math.min(record.expiresAtMs, expiresAtMs);
  record.servers.set(serverName, discovered);
  GRANT_DISCOVERY_CACHE.set(key, record);
  pruneDiscoveryCache(nowMs);
}
/* === VIVENTIUM END === */

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

async function requestedServersFromGrant(grant, user, registry, requestedServerNames) {
  /* === VIVENTIUM START ===
   * Feature: Deferred connected-account projection.
   * Purpose: Initial catalog construction is limited to the signed eager set. A helper call may
   * request an exact signed deferred server without waking every connected account.
   */
  const allowedServers = new Set(
    (grant?.allowed_servers || []).map((server) => String(server || '').trim()).filter(Boolean),
  );
  const eagerServers = Array.isArray(grant?.eager_servers)
    ? grant.eager_servers
    : grant?.allowed_servers || [];
  const requested = Array.isArray(requestedServerNames)
    ? requestedServerNames.map((server) => String(server || '').trim()).filter(Boolean)
    : null;
  const servers = new Set(
    (requested || eagerServers).filter((server) => allowedServers.has(server)),
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
      reqUser: user,
    })) {
      if (!requested || requested.includes(serverName)) {
        servers.add(serverName);
      }
    }
  }
  return Array.from(servers).sort();
  /* === VIVENTIUM END === */
}

async function discoverServerTools({ user, serverName, serverConfig, signal } = {}) {
  const requiresOAuth = Boolean(serverConfig?.requiresOAuth || serverConfig?.oauthMetadata);
  if (requiresOAuth) {
    let credentialState = null;
    try {
      credentialState = await inspectStoredOAuthCredentialState(user?.id, serverName);
    } catch (error) {
      // Readiness inspection is advisory when it cannot run. Continue through the normal MCP
      // path so a telemetry outage cannot falsely delete a working capability.
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] OAuth readiness inspection unavailable',
        { serverName, errorType: typeOfError(error) },
      );
    }
    if (credentialState?.status && credentialState.status !== 'credential_present') {
      // A background/native harness cannot complete an interactive OAuth redirect. Return the
      // exact structured blocker immediately; do not start an OAuth flow, wait on flow-state
      // polling, or repeat the same unavailable initialization on describe then invoke.
      return {
        tools: [],
        oauthRequired: true,
        success: false,
        credentialStatus: credentialState.status,
        message: 'Connected account requires reconnection before this worker can use it.',
        recovery: buildMcpOAuthRecovery(serverName),
      };
    }
  }
  const discoverOnce = () =>
    reinitMCPServer({
      user,
      signal,
      forceNew: false,
      serverName,
      serverConfig,
      returnOnOAuth: true,
      allowOAuthInitiation: false,
      oauthStart: async () => {
        // Worker-side OAuth starts are intentionally not launched from the sandbox.
      },
    });

  /* === VIVENTIUM START ===
   * Feature: Stable GlassHive broker MCP reuse.
   * Purpose: Catalog resolution runs before every brokered tool call. Replacing a healthy
   *   user-scoped MCP connection here can invalidate the connection immediately before the
   *   actual call, especially when a harness retries in parallel. Reuse first; only force a
   *   fresh connection when discovery proves the cached connection stale or empty.
   */
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
  /* === VIVENTIUM END === */

  return {
    tools: Array.isArray(result?.tools) ? result.tools : [],
    oauthRequired: Boolean(result?.oauthRequired),
    success: Boolean(result?.success),
    message: result?.message || '',
    credentialStatus: String(result?.credentialState?.status || '').trim(),
    recovery: result?.recovery || null,
  };
}

function typeOfError(error) {
  return String(error?.name || error?.constructor?.name || 'Error');
}

function omissionReasonForDiscovery(discovered) {
  if (discovered.credentialStatus) {
    return discovered.credentialStatus;
  }
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

async function buildCapabilityCatalog({ grant, signal, requestedServerNames, appConfig } = {}) {
  const user = await userForGrant(grant);
  const registry = getMCPServersRegistry();
  const tools = [];
  const servers = [];
  const omissions = [];
  const hostTools = [];
  const claimedBrokerToolNames = new Map();

  for (const toolName of grant?.allowed_host_tools || []) {
    const definition = HOST_TOOL_DEFINITIONS[toolName];
    if (!definition) {
      omissions.push({ reason: 'unsupported_host_tool', tool: toolName });
      continue;
    }
    const resources = grant?.host_tool_resources?.[toolName];
    if (toolName === 'file_search' && !Array.isArray(resources?.files)) {
      omissions.push({ reason: 'missing_host_tool_resources', tool: toolName });
      continue;
    }
    hostTools.push({ toolName, definition, resources });
  }

  for (const serverName of await requestedServersFromGrant(
    grant,
    user,
    registry,
    requestedServerNames,
  )) {
    const serverConfig = await registry.getServerConfig(serverName, user.id).catch(() => null);
    const policy = getPolicy(serverConfig);
    if (!serverConfig || !policy || !isTrustedServerConfig(serverConfig)) {
      omissions.push(logOmission('policy_not_authorized', serverName));
      continue;
    }
    const explicitDeferredRequest = Array.isArray(requestedServerNames);
    let discovered = explicitDeferredRequest ? null : cachedServerDiscovery(grant, serverName);
    if (discovered) {
      logger.info('[VIVENTIUM][glasshive-capability-broker] Reused grant-scoped discovery', {
        grantId: grant.grant_id,
        serverName,
        toolCount: discovered.tools.length,
      });
    } else {
      try {
        discovered = await discoverServerTools({ user, serverName, serverConfig, signal });
        if (!explicitDeferredRequest) {
          rememberServerDiscovery(grant, serverName, discovered);
        }
      } catch (error) {
        omissions.push(logOmission('discovery_failed', serverName, { message: error?.message }));
        continue;
      }
    }
    const omissionReason = omissionReasonForDiscovery(discovered);
    if (omissionReason) {
      const omission = logOmission(omissionReason, serverName, {
        message: discovered.message,
        ...(discovered.recovery ? { recovery: discovered.recovery } : {}),
      });
      omissions.push(
        discovered.recovery ? { ...omission, recovery: discovered.recovery } : omission,
      );
    }
    servers.push({
      name: serverName,
      riskClass: policy.riskClass,
      available: discovered.success && discovered.tools.length > 0,
      oauthRequired: discovered.oauthRequired,
      toolCount: discovered.tools.length,
      message: discovered.message,
      ...(discovered.credentialStatus ? { credentialStatus: discovered.credentialStatus } : {}),
      ...(discovered.recovery ? { recovery: discovered.recovery } : {}),
    });
    for (const tool of discovered.tools) {
      if (policy.reexportNativeTools === false) {
        continue;
      }
      const name = String(tool?.name || '').trim();
      if (!name) {
        continue;
      }
      const brokerName = collisionSafeBrokerToolName(serverName, name, claimedBrokerToolNames);
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
    hostTools,
    appConfig,
    helperTools: helperToolDefinitions(),
    deferredServers: (grant?.deferred_servers || [])
      .map((server) => String(server || '').trim())
      .filter(Boolean)
      .sort(),
  };
}

function toolDefinitionsForMcp(catalog) {
  return [
    ...catalog.helperTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
    ...catalog.hostTools.map((item) => item.definition),
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
    hostTools: catalog.hostTools.map((item) => ({
      name: item.toolName,
      access: 'read',
      transport: 'host',
    })),
    omissions: catalog.omissions,
    deferredServers: catalog.deferredServers || [],
  };
}

function findHostTool(catalog, toolName) {
  return catalog.hostTools.find((item) => item.toolName === toolName);
}

async function invokeHostTool({ grant, catalog, hostTool, args = {}, signal } = {}) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { status: 'blocked', reason: 'invalid_arguments', tool: hostTool.toolName };
  }
  try {
    let content;
    let artifact;
    let resourceCount;
    if (hostTool.toolName === 'file_search') {
      const fileSearchTool = await createFileSearchTool({
        userId: catalog.user.id,
        files: hostTool.resources.files,
        entity_id: String(hostTool.resources.entity_id || '').trim() || undefined,
        conversationId: String(grant?.conversation_id || '').trim() || undefined,
        activeMessageId: String(grant?.message_id || '').trim() || undefined,
        fileCitations: false,
      });
      [content, artifact] = await fileSearchTool.func({ query });
      resourceCount = hostTool.resources.files.length;
    } else if (hostTool.toolName === 'web_search') {
      const auth = await loadWebSearchAuth({
        userId: catalog.user.id,
        loadAuthValues,
        webSearchConfig: catalog.appConfig?.webSearch,
        throwError: true,
      });
      if (!auth?.authenticated) {
        return {
          status: 'blocked',
          reason: 'missing_auth_or_config',
          tool: hostTool.toolName,
          retryable: false,
        };
      }
      const webSearchTool = createViventiumSearchTool({
        ...auth.authResult,
        logger,
      });
      [content, artifact] = await webSearchTool.func({ ...args, query }, undefined, {
        ...(signal ? { signal } : {}),
        toolCall: { id: 'broker-web-search', name: 'web_search', turn: 0 },
        metadata: {
          user_id: catalog.user.id,
          thread_id: String(grant?.conversation_id || '').trim(),
          run_id: String(grant?.message_id || '').trim(),
        },
      });
    } else {
      return { status: 'not_found', tool: hostTool.toolName };
    }
    logger.info('[VIVENTIUM][glasshive-capability-broker] Host tool invoked', {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      toolName: hostTool.toolName,
      ...(resourceCount !== undefined ? { resourceCount } : {}),
      hasArtifact: artifact != null,
      outcome: 'success',
    });
    return {
      status: 'ok',
      tool: hostTool.toolName,
      content: String(content || ''),
      ...(artifact != null ? { artifact } : {}),
    };
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Host tool call failed', {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      toolName: hostTool.toolName,
      message: error?.message,
    });
    return {
      status: 'blocked',
      reason: 'host_tool_error',
      tool: hostTool.toolName,
      retryable: true,
    };
  }
}

function findNativeTool(catalog, brokerToolNameValue) {
  return catalog.tools.find((item) => item.brokerName === brokerToolNameValue);
}

function findNativeToolByServerTool(catalog, serverName, toolName) {
  return catalog.tools.find((item) => item.serverName === serverName && item.toolName === toolName);
}

function authBlockedServerResult(catalog, serverName, toolName = '') {
  const server = catalog.servers.find((item) => item.name === serverName);
  if (!server || server.available !== false || !server.credentialStatus || !server.recovery) {
    return null;
  }
  return {
    status: 'blocked',
    reason: server.credentialStatus,
    server: serverName,
    ...(toolName ? { tool: toolName } : {}),
    oauthRequired: server.oauthRequired === true,
    recovery: server.recovery,
  };
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
  /* Let the MCP SDK own its request timeout. Passing a broker-created AbortSignal through
   * `MCPManager.callTool` made a reusable HTTP connection behave like a one-shot connection:
   * the next call could fail locally with `This operation was aborted` before the request ever
   * reached the healthy provider. A real caller cancellation signal is still preserved. */
  const requestOptions = {
    timeout: providerTimeoutMs,
    ...(signal ? { signal } : {}),
  };
  let timedOut = false;
  let timeoutHandle = null;
  let result;
  const providerCallStartedAt = Date.now();
  logger.info(
    `[VIVENTIUM][glasshive-capability-broker] Provider tool call starting ` +
      `(parent_signal_present=${Boolean(signal)} ` +
      `parent_signal_aborted=${signal?.aborted === true} ` +
      `broker_signal_aborted=${requestOptions.signal?.aborted === true})`,
    {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      serverName: nativeTool.serverName,
      toolName: nativeTool.toolName,
      parentSignalPresent: Boolean(signal),
      parentSignalAborted: signal?.aborted === true,
      brokerSignalAborted: requestOptions.signal?.aborted === true,
      timeoutMs: providerTimeoutMs,
    },
  );
  try {
    result = await Promise.race([
      mcpManager.callTool({
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        provider: DEFAULT_PROVIDER,
        toolArguments,
        options: requestOptions,
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
          reject(new Error(`broker provider call timed out after ${providerTimeoutMs}ms`));
        }, providerTimeoutMs);
      }),
    ]);
  } catch (error) {
    const message = String((error && error.message) || '');
    const isTimeout =
      timedOut || /timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|abort/i.test(message);
    logger.warn(
      `[VIVENTIUM][glasshive-capability-broker] Provider tool call failed ` +
        `(elapsed_ms=${Date.now() - providerCallStartedAt} ` +
        `parent_signal_present=${Boolean(signal)} ` +
        `parent_signal_aborted=${signal?.aborted === true} ` +
        `broker_signal_aborted=${requestOptions.signal?.aborted === true})`,
      {
        userId: catalog.user.id,
        grantId: grant.grant_id,
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        timedOut: isTimeout,
        timeoutMs: providerTimeoutMs,
        elapsedMs: Date.now() - providerCallStartedAt,
        parentSignalPresent: Boolean(signal),
        parentSignalAborted: signal?.aborted === true,
        brokerSignalAborted: requestOptions.signal?.aborted === true,
        message,
      },
    );
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

async function handleToolCall({ grant, toolName, args = {}, signal, appConfig } = {}) {
  if (toolName === 'capabilities_list') {
    const catalog = await buildCapabilityCatalog({ grant, signal, appConfig });
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_describe') {
    const requested = args || {};
    const catalog = await buildCapabilityCatalog({
      grant,
      signal,
      appConfig,
      requestedServerNames: requested.server ? [requested.server] : undefined,
    });
    if (requested.tool) {
      const native =
        findNativeTool(catalog, requested.tool) ||
        findNativeToolByServerTool(catalog, requested.server, requested.tool);
      if (!native) {
        const blocked = authBlockedServerResult(catalog, requested.server, requested.tool);
        if (blocked) {
          return blocked;
        }
        return { status: 'not_found', server: requested.server || '', tool: requested.tool };
      }
      return native.definition;
    }
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_invoke') {
    const catalog = await buildCapabilityCatalog({
      grant,
      signal,
      appConfig,
      requestedServerNames: args.server ? [args.server] : [],
    });
    const native = findNativeToolByServerTool(catalog, args.server, args.tool);
    if (!native) {
      const blocked = authBlockedServerResult(catalog, args.server, args.tool);
      if (blocked) {
        return blocked;
      }
      return { status: 'not_found', server: args.server || '', tool: args.tool || '' };
    }
    return invokeUnderlyingTool({
      grant,
      catalog,
      nativeTool: native,
      args: {
        ...(args.arguments || {}),
        ...(args.invocation_id ? { invocation_id: args.invocation_id } : {}),
      },
      signal,
    });
  }
  const catalog = await buildCapabilityCatalog({ grant, signal, appConfig });
  const hostTool = findHostTool(catalog, toolName);
  if (hostTool) {
    return invokeHostTool({ grant, catalog, hostTool, args, signal });
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
