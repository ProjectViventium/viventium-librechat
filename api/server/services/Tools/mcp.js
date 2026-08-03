const { decryptV2, logger } = require('@librechat/data-schemas');
const { MCPOAuthHandler } = require('@librechat/api');
const { CacheKeys, Constants } = require('librechat-data-provider');
const { findToken, createToken, updateToken, deleteToken, deleteTokens } = require('~/models');
const { updateMCPServerTools } = require('~/server/services/Config');
const { getMCPManager, getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');

/* === VIVENTIUM START ===
 * Feature: Credential-aware MCP readiness.
 * Purpose: Distinguish missing, unreadable, and present OAuth state without exposing tokens.
 */
async function inspectStoredOAuthCredentialState(userId, serverName) {
  const now = new Date();
  const accessToken = await findToken({
    userId,
    type: 'mcp_oauth',
    identifier: `mcp:${serverName}`,
  });
  const refreshToken = await findToken({
    userId,
    type: 'mcp_oauth_refresh',
    identifier: `mcp:${serverName}:refresh`,
  });

  const liveAccess =
    accessToken && (!accessToken.expiresAt || accessToken.expiresAt >= now) ? accessToken : null;
  const liveRefresh =
    refreshToken && (!refreshToken.expiresAt || refreshToken.expiresAt >= now)
      ? refreshToken
      : null;
  if (!liveAccess && !liveRefresh) {
    return { status: 'missing_auth' };
  }
  let unreadableCredential = false;
  // A still-live access token is independently usable even if an older refresh token was
  // encrypted under unavailable key material. Accept either readable credential; reconnect only
  // when no live credential can be decrypted.
  for (const credential of [liveAccess, liveRefresh]) {
    if (!credential?.token) {
      continue;
    }
    try {
      await decryptV2(credential.token);
      return { status: 'credential_present' };
    } catch (_) {
      unreadableCredential = true;
    }
  }
  return { status: unreadableCredential ? 'unreadable_credential' : 'missing_auth' };
}

/**
 * Stable, provider-independent recovery guidance for an OAuth MCP that cannot authenticate during
 * a non-interactive request. The owning agent is deliberately resolved by the user in Agent
 * Builder: this layer knows the MCP server, not which one of potentially many agent graphs owns it.
 */
function buildMcpOAuthRecovery(serverName) {
  return {
    action: 'connect_mcp_account',
    surface: 'agent_builder',
    server: String(serverName || '').trim(),
    instructions:
      'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
  };
}

function shouldUseCachedMcpTools(serverConfig, credentialState) {
  const requiresOAuth = Boolean(serverConfig?.requiresOAuth || serverConfig?.oauthMetadata);
  return !requiresOAuth || credentialState?.status === 'credential_present';
}
/* === VIVENTIUM END === */

async function initiateOAuthFlowFallback({
  user,
  signal,
  serverName,
  flowManager,
  oauthStart,
  serverConfig,
}) {
  const { authorizationUrl, flowId, flowMetadata } = await MCPOAuthHandler.initiateOAuthFlow(
    serverName,
    serverConfig.url || '',
    user.id,
    serverConfig.oauth_headers ?? {},
    serverConfig.oauth,
  );

  await flowManager.deleteFlow(flowId, 'mcp_oauth').catch(() => {});
  flowManager.createFlow(flowId, 'mcp_oauth', flowMetadata, signal).catch(() => {});
  await oauthStart(authorizationUrl);
}

/**
 * Reinitializes an MCP server connection and discovers available tools.
 * When OAuth is required, uses discovery mode to list tools without full authentication
 * (per MCP spec, tool listing should be possible without auth).
 * @param {Object} params
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName - The name of the MCP server
 * @param {boolean} params.returnOnOAuth - Whether to initiate OAuth and return, or wait for OAuth flow to finish
 * @param {AbortSignal} [params.signal] - The abort signal to handle cancellation.
 * @param {boolean} [params.forceNew]
 * @param {number} [params.connectionTimeout]
 * @param {FlowStateManager<any>} [params.flowManager]
 * @param {(authURL: string) => Promise<void>} [params.oauthStart]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {Record<string, import('@librechat/api').ParsedServerConfig>} [params.configServers]
 * @param {import('@librechat/api').ParsedServerConfig} [params.serverConfig]
 * @param {boolean} [params.allowOAuthInitiation]
 */
async function reinitMCPServer({
  user,
  signal,
  forceNew,
  serverName,
  configServers,
  userMCPAuthMap,
  connectionTimeout,
  returnOnOAuth = true,
  oauthStart: _oauthStart,
  flowManager: _flowManager,
  serverConfig: providedConfig,
  allowOAuthInitiation = true,
}) {
  /** @type {MCPConnection | null} */
  let connection = null;
  /** @type {LCAvailableTools | null} */
  let availableTools = null;
  /** @type {ReturnType<MCPConnection['fetchTools']> | null} */
  let tools = null;
  let oauthRequired = false;
  let oauthUrl = null;
  let credentialState = null;
  let serverConfig = null;

  try {
    const registry = getMCPServersRegistry();
    serverConfig =
      providedConfig ?? (await registry.getServerConfig(serverName, user?.id, configServers));
    if (serverConfig?.inspectionFailed) {
      /* === VIVENTIUM START ===
       * Feature: Upstream-aligned MCP reinit recovery.
       * Purpose: Config-source failures are already guarded by the config cache;
       * do not reinspect them synchronously from voice/tool-definition hot paths.
       */
      if (serverConfig.source === 'config') {
        logger.info(
          `[MCP Reinitialize] Config-source server ${serverName} has inspectionFailed - retry handled by config cache`,
        );
        return {
          availableTools: null,
          success: false,
          message: `MCP server '${serverName}' is still unreachable`,
          oauthRequired: false,
          serverName,
          oauthUrl: null,
          tools: null,
        };
      }
      /* === VIVENTIUM END === */
      logger.info(
        `[MCP Reinitialize] Server ${serverName} had failed inspection, attempting reinspection`,
      );
      try {
        const storageLocation =
          serverConfig.source === 'user' || serverConfig.dbId ? 'DB' : 'CACHE';
        await registry.reinspectServer(serverName, storageLocation, user?.id);
        logger.info(`[MCP Reinitialize] Reinspection succeeded for server: ${serverName}`);
      } catch (reinspectError) {
        logger.error(
          `[MCP Reinitialize] Reinspection failed for server ${serverName}:`,
          reinspectError,
        );
        return {
          availableTools: null,
          success: false,
          message: `MCP server '${serverName}' is still unreachable`,
          oauthRequired: false,
          serverName,
          oauthUrl: null,
          tools: null,
        };
      }
    }

    /* === VIVENTIUM START ===
     * Feature: Non-interactive OAuth preflight.
     * Purpose: Voice and other request hot paths must not create an interactive OAuth flow merely
     * while resolving tool definitions. Explicit Connect/reconnect flows retain the default.
     */
    const serverRequiresOAuth = Boolean(serverConfig?.requiresOAuth || serverConfig?.oauthMetadata);
    if (!allowOAuthInitiation && serverRequiresOAuth) {
      credentialState = await inspectStoredOAuthCredentialState(user?.id, serverName);
      if (credentialState?.status !== 'credential_present') {
        return {
          availableTools: null,
          success: false,
          message: `MCP server '${serverName}' requires account reconnection`,
          oauthRequired: true,
          serverName,
          oauthUrl: null,
          tools: null,
          credentialState,
          recovery: buildMcpOAuthRecovery(serverName),
        };
      }
    }
    /* === VIVENTIUM END === */

    const customUserVars = userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
    const flowManager = _flowManager ?? getFlowStateManager(getLogStores(CacheKeys.FLOWS));
    const mcpManager = getMCPManager();
    const tokenMethods = { findToken, updateToken, createToken, deleteToken, deleteTokens };

    const oauthStart =
      _oauthStart ??
      (async (authURL) => {
        logger.info(`[MCP Reinitialize] OAuth URL received for ${serverName}`);
        oauthUrl = authURL;
        oauthRequired = true;
      });

    try {
      connection = await mcpManager.getConnection({
        user,
        signal,
        forceNew,
        oauthStart,
        serverName,
        flowManager,
        tokenMethods,
        returnOnOAuth,
        customUserVars,
        connectionTimeout,
        serverConfig,
        allowOAuthInitiation,
      });

      logger.info(`[MCP Reinitialize] Successfully established connection for ${serverName}`);
    } catch (err) {
      logger.info(`[MCP Reinitialize] getConnection threw error: ${err.message}`);
      logger.info(
        `[MCP Reinitialize] OAuth state - oauthRequired: ${oauthRequired}, oauthUrl: ${oauthUrl ? 'present' : 'null'}`,
      );

      const isOAuthError =
        err.message?.includes('OAuth') ||
        err.message?.includes('authentication') ||
        err.message?.includes('401');
      const isConnectionTimeout = err.message?.includes('Connection timeout');
      const serverRequiresOAuth = Boolean(
        serverConfig?.requiresOAuth || serverConfig?.oauthMetadata,
      );
      credentialState = serverRequiresOAuth
        ? await inspectStoredOAuthCredentialState(user.id, serverName)
        : null;
      if (
        serverRequiresOAuth &&
        credentialState?.status === 'credential_present' &&
        (isOAuthError || oauthRequired)
      ) {
        credentialState = { status: 'reconnect_required' };
      }
      const hasStoredOAuthTokens =
        serverRequiresOAuth && user.id && credentialState?.status === 'credential_present';

      const isOAuthFlowInitiated = err.message === 'OAuth flow initiated - return early';

      if (
        allowOAuthInitiation &&
        serverRequiresOAuth &&
        (isConnectionTimeout || isOAuthError) &&
        !oauthRequired &&
        !isOAuthFlowInitiated &&
        !hasStoredOAuthTokens
      ) {
        logger.warn(
          `[MCP Reinitialize] ${serverName} could not use stored OAuth state; initiating a clean OAuth flow`,
        );

        try {
          await initiateOAuthFlowFallback({
            user,
            signal,
            serverName,
            flowManager,
            oauthStart,
            serverConfig,
          });
          oauthRequired = true;
        } catch (oauthFallbackError) {
          logger.error(
            `[MCP Reinitialize] Failed to initiate fallback OAuth flow for ${serverName}`,
            oauthFallbackError,
          );
        }
      }

      if (isOAuthError || oauthRequired || isOAuthFlowInitiated) {
        logger.info(
          `[MCP Reinitialize] OAuth required for ${serverName}, attempting tool discovery without auth`,
        );
        oauthRequired = true;

        try {
          if (!allowOAuthInitiation) {
            throw new Error('Non-interactive OAuth discovery is disabled');
          }
          const discoveryResult = await mcpManager.discoverServerTools({
            user,
            signal,
            serverName,
            flowManager,
            tokenMethods,
            oauthStart,
            customUserVars,
            connectionTimeout,
            configServers,
          });

          if (discoveryResult.tools && discoveryResult.tools.length > 0) {
            tools = discoveryResult.tools;
            logger.info(
              `[MCP Reinitialize] Discovered ${tools.length} tools for ${serverName} without full auth`,
            );
          }
        } catch (discoveryErr) {
          logger.debug(
            `[MCP Reinitialize] Tool discovery failed for ${serverName}: ${discoveryErr?.message ?? String(discoveryErr)}`,
          );
        }
      } else {
        logger.error(
          `[MCP Reinitialize] Error initializing MCP server ${serverName} for user:`,
          err,
        );
      }
    }

    if (connection && !oauthRequired) {
      tools = await connection.fetchTools();
    }

    if (tools && tools.length > 0) {
      availableTools = await updateMCPServerTools({
        userId: user.id,
        serverName,
        tools,
      });
    }

    logger.debug(
      `[MCP Reinitialize] Sending response for ${serverName} - oauthRequired: ${oauthRequired}, oauthUrl: ${oauthUrl ? 'present' : 'null'}`,
    );

    const getResponseMessage = () => {
      if (oauthRequired && tools && tools.length > 0) {
        return `MCP server '${serverName}' tools discovered, OAuth required for execution`;
      }
      if (oauthRequired) {
        return `MCP server '${serverName}' ready for OAuth authentication`;
      }
      if (connection) {
        return `MCP server '${serverName}' reinitialized successfully`;
      }
      return `Failed to reinitialize MCP server '${serverName}'`;
    };

    const result = {
      availableTools,
      success: Boolean(
        (connection && !oauthRequired) ||
        (oauthRequired && oauthUrl) ||
        (tools && tools.length > 0),
      ),
      message: getResponseMessage(),
      oauthRequired,
      serverName,
      oauthUrl,
      tools,
      ...(credentialState ? { credentialState } : {}),
      ...(!allowOAuthInitiation && oauthRequired
        ? { recovery: buildMcpOAuthRecovery(serverName) }
        : {}),
    };

    logger.debug(`[MCP Reinitialize] Response for ${serverName}:`, {
      success: result.success,
      oauthRequired: result.oauthRequired,
      oauthUrl: result.oauthUrl ? 'present' : null,
      toolsCount: tools?.length ?? 0,
    });

    return result;
  } catch (error) {
    logger.error(
      '[MCP Reinitialize] Error loading MCP Tools, servers may still be initializing:',
      error,
    );
    /* === VIVENTIUM START ===
     * Feature: Explicit MCP reinitialization failures.
     * Purpose: Preserve a stable result contract so callers can distinguish a failed
     * reinitialization from an absent result without silently collapsing undefined.
     * === VIVENTIUM END === */
    return {
      availableTools: null,
      success: false,
      failureClass: 'reinitialization_error',
      message: `Failed to reinitialize MCP server '${serverName}'`,
      oauthRequired,
      serverName,
      oauthUrl,
      tools,
    };
  }
}

module.exports = {
  buildMcpOAuthRecovery,
  inspectStoredOAuthCredentialState,
  reinitMCPServer,
  shouldUseCachedMcpTools,
};
