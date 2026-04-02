const { Router } = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  CacheKeys,
  Constants,
  PermissionBits,
  PermissionTypes,
  Permissions,
} = require('librechat-data-provider');
const {
  createSafeUser,
  MCPOAuthHandler,
  MCPTokenStorage,
  getBasePath,
  setOAuthSession,
  getUserMCPAuthMap,
  validateOAuthCsrf,
  OAUTH_CSRF_COOKIE,
  setOAuthCsrfCookie,
  generateCheckAccess,
  validateOAuthSession,
  OAUTH_SESSION_COOKIE,
} = require('@librechat/api');
const {
  getMCPManager,
  getFlowStateManager,
  getOAuthReconnectionManager,
  getMCPServersRegistry,
} = require('~/config');
const { getMCPSetupData, getServerConnectionStatus } = require('~/server/services/MCP');
const { requireJwtAuth, canAccessMCPServerResource } = require('~/server/middleware');
const { findToken, updateToken, createToken, deleteTokens } = require('~/models');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { updateMCPServerTools } = require('~/server/services/Config/mcp');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const { getMCPTools } = require('~/server/controllers/mcp');
const { findPluginAuthsByKeys } = require('~/models');
const { getRoleByName } = require('~/models/Role');
const { getLogStores } = require('~/cache');
const {
  createMCPServerController,
  getMCPServerById,
  getMCPServersList,
  updateMCPServerController,
  deleteMCPServerController,
} = require('~/server/controllers/mcp');

const router = Router();
const OAUTH_CSRF_COOKIE_PATH = '/api/mcp';

/* VIVENTIUM START: MCP OAuth redirect-uri hardening + config source-of-truth */
function getExpectedMCPOAuthCallback(serverName) {
  if (!process.env.DOMAIN_SERVER) {
    return null;
  }
  const domain = process.env.DOMAIN_SERVER.replace(/\/+$/, '');
  return `${domain}/api/mcp/${serverName}/oauth/callback`;
}

function getExpectedMCPOAuthUrls(serverName) {
  switch (serverName) {
    case 'google_workspace':
      return {
        authorization_url: process.env.GOOGLE_WORKSPACE_MCP_AUTH_URL,
        token_url: process.env.GOOGLE_WORKSPACE_MCP_TOKEN_URL,
      };
    case 'ms-365':
      return {
        authorization_url: process.env.MS365_MCP_AUTH_URL,
        token_url: process.env.MS365_MCP_TOKEN_URL,
      };
    default:
      return null;
  }
}

function isLoopbackUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(urlString);
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch (_error) {
    return false;
  }
}

/* VIVENTIUM START: persistent MCP warm-up across app restarts */
function getPersistentMCPServers() {
  return new Set(
    (process.env.MCP_PERSISTENT_CONNECTION_SERVERS ?? 'scheduling-cortex')
      .split(',')
      .map((serverName) => serverName.trim())
      .filter(Boolean),
  );
}

/* VIVENTIUM START: persistent MCP warm-up dedupe across status pollers */
const persistentWarmupInFlight = new Set();
const persistentWarmupLastAttemptAt = new Map();

function getPersistentWarmupKey(userId, serverName) {
  return `${userId}:${serverName}`;
}

function getPersistentWarmupCooldownMs() {
  const parsed = Number.parseInt(process.env.MCP_PERSISTENT_WARMUP_COOLDOWN_MS ?? '10000', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10000;
}

function clearPersistentWarmupTracking(warmupKey) {
  persistentWarmupInFlight.delete(warmupKey);
  persistentWarmupLastAttemptAt.delete(warmupKey);
}
/* VIVENTIUM END */

async function warmPersistentUserMCPConnections(user, mcpConfig, oauthServers) {
  const persistentServers = [...getPersistentMCPServers()].filter(
    (serverName) => mcpConfig?.[serverName] && !oauthServers?.has?.(serverName),
  );

  if (!persistentServers.length) {
    return;
  }

  const mcpManager = getMCPManager();
  if (
    !mcpManager ||
    typeof mcpManager.getConnection !== 'function' ||
    typeof mcpManager.getUserConnections !== 'function'
  ) {
    return;
  }

  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const tokenMethods = { findToken, updateToken, createToken, deleteTokens };

  for (const serverName of persistentServers) {
    const warmupKey = getPersistentWarmupKey(user.id, serverName);
    const existingConnection = mcpManager.getUserConnections(user.id)?.get(serverName);
    if (existingConnection?.connectionState === 'connected') {
      clearPersistentWarmupTracking(warmupKey);
      continue;
    }

    if (existingConnection?.connectionState === 'connecting') {
      logger.debug(
        `[MCP Persistent Warmup][User: ${user.id}] Skipping "${serverName}" because connection is already in-flight`,
      );
      continue;
    }

    if (persistentWarmupInFlight.has(warmupKey)) {
      logger.debug(
        `[MCP Persistent Warmup][User: ${user.id}] Skipping "${serverName}" because a warm-up is already running`,
      );
      continue;
    }

    const cooldownMs = getPersistentWarmupCooldownMs();
    const lastAttemptAt = persistentWarmupLastAttemptAt.get(warmupKey);
    if (lastAttemptAt && Date.now() - lastAttemptAt < cooldownMs) {
      logger.debug(
        `[MCP Persistent Warmup][User: ${user.id}] Skipping "${serverName}" because the last warm-up was attempted ${Date.now() - lastAttemptAt}ms ago`,
      );
      continue;
    }

    const serverConfig = mcpConfig[serverName];
    const hasCustomVars =
      serverConfig?.customUserVars && Object.keys(serverConfig.customUserVars).length > 0;

    if (hasCustomVars) {
      logger.debug(
        `[MCP Persistent Warmup] Skipping server "${serverName}" because custom user vars are required`,
      );
      continue;
    }

    persistentWarmupInFlight.add(warmupKey);
    persistentWarmupLastAttemptAt.set(warmupKey, Date.now());
    try {
      await mcpManager.getConnection({
        user,
        serverName,
        flowManager,
        tokenMethods,
        returnOnOAuth: true,
      });
      logger.info(
        `[MCP Persistent Warmup][User: ${user.id}] Ensured connection for "${serverName}"`,
      );
    } catch (error) {
      logger.warn(
        `[MCP Persistent Warmup][User: ${user.id}] Failed to warm "${serverName}": ${error?.message ?? String(error)}`,
      );
    } finally {
      persistentWarmupInFlight.delete(warmupKey);
    }
  }
}

function getStatusSettleWindowMs() {
  const parsed = Number.parseInt(process.env.MCP_CONNECTION_STATUS_SETTLE_WINDOW_MS ?? '3500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function getStatusSettlePollMs() {
  const parsed = Number.parseInt(process.env.MCP_CONNECTION_STATUS_SETTLE_POLL_MS ?? '500', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
}

async function settleTransientConnectingOAuthStatuses({
  userId,
  connectionStatus,
  mcpConfig,
  oauthServers,
  targetServers,
}) {
  const oauthServerSet =
    oauthServers instanceof Set
      ? oauthServers
      : new Set(Array.isArray(oauthServers) ? oauthServers : []);

  const settleWindowMs = getStatusSettleWindowMs();
  if (!settleWindowMs) {
    return;
  }

  const connectingServers = (targetServers ?? Object.keys(connectionStatus)).filter(
    (serverName) =>
      oauthServerSet.has(serverName) &&
      connectionStatus[serverName]?.connectionState === 'connecting',
  );

  if (!connectingServers.length) {
    return;
  }

  const pollMs = Math.max(250, getStatusSettlePollMs());
  const maxAttempts = Math.max(1, Math.ceil(settleWindowMs / pollMs));

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));

    let setupData;
    try {
      setupData = await getMCPSetupData(userId);
    } catch (error) {
      logger.warn(
        `[MCP Connection Status] Failed settle setup fetch (attempt ${attempt + 1}/${maxAttempts}): ${error?.message ?? String(error)}`,
      );
      break;
    }

    if (!setupData) {
      break;
    }

    const latestConfig = setupData.mcpConfig ?? mcpConfig;
    let stillConnecting = 0;

    for (const serverName of connectingServers) {
      const config = latestConfig?.[serverName];
      if (!config) {
        continue;
      }

      try {
        connectionStatus[serverName] = await getServerConnectionStatus(
          userId,
          serverName,
          config,
          setupData.appConnections,
          setupData.userConnections,
          setupData.oauthServers,
        );
      } catch (error) {
        logger.warn(
          `[MCP Connection Status] Failed settle pass for server "${serverName}" (attempt ${attempt + 1}/${maxAttempts}): ${error?.message ?? String(error)}`,
        );
      }

      if (connectionStatus[serverName]?.connectionState === 'connecting') {
        stillConnecting += 1;
      }
    }

    if (!stillConnecting) {
      break;
    }
  }
}
/* VIVENTIUM END */

/**
 * Get all MCP tools available to the user
 * Returns only MCP tools, completely decoupled from regular LibreChat tools
 */
router.get('/tools', requireJwtAuth, async (req, res) => {
  return getMCPTools(req, res);
});

/**
 * Initiate OAuth flow
 * This endpoint is called when the user clicks the auth link in the UI
 */
router.get('/:serverName/oauth/initiate', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;
    const queryUserId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
    const flowId = typeof req.query.flowId === 'string' ? req.query.flowId : undefined;
    const userId = user.id;

    // Some clients call this endpoint without userId/flowId query params.
    // Only enforce user match when userId is explicitly provided.
    if (queryUserId && queryUserId !== userId) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    logger.debug('[MCP OAuth] Initiate request', { serverName, userId, flowId });

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const serverConfig = await getMCPServersRegistry().getServerConfig(serverName, userId);
    /** VIVENTIUM START: prefer live registry config; flow metadata is fallback only */
    let flowState = null;
    if (flowId) {
      flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
      if (!flowState && !serverConfig?.oauth) {
        logger.error('[MCP OAuth] Flow state not found', { flowId, serverName, userId });
        return res.status(404).json({ error: 'Flow not found' });
      }
      if (!flowState) {
        logger.warn('[MCP OAuth] Flow state missing, falling back to live registry config', {
          flowId,
          serverName,
          userId,
        });
      }
    }
    const flowMetadata = flowState?.metadata || {};

    const serverUrl = serverConfig?.url || flowMetadata.serverUrl;
    let oauthConfig = serverConfig?.oauth || flowMetadata.oauth;
    /** VIVENTIUM END */
    if (!serverUrl || !oauthConfig) {
      logger.error('[MCP OAuth] Missing server URL or OAuth config in flow state');
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    /* VIVENTIUM START: stabilize OAuth URLs + callback for active local/prod environment */
    const expectedOauthUrls = getExpectedMCPOAuthUrls(serverName);
    if (expectedOauthUrls) {
      const nextOauthConfig = { ...oauthConfig };
      let urlsPatched = false;

      if (
        expectedOauthUrls.authorization_url &&
        expectedOauthUrls.authorization_url !== oauthConfig.authorization_url
      ) {
        logger.warn('[MCP OAuth] Rewriting authorization_url from env source', {
          serverName,
          originalAuthorizationUrl: oauthConfig.authorization_url,
          expectedAuthorizationUrl: expectedOauthUrls.authorization_url,
        });
        nextOauthConfig.authorization_url = expectedOauthUrls.authorization_url;
        urlsPatched = true;
      }

      if (expectedOauthUrls.token_url && expectedOauthUrls.token_url !== oauthConfig.token_url) {
        logger.warn('[MCP OAuth] Rewriting token_url from env source', {
          serverName,
          originalTokenUrl: oauthConfig.token_url,
          expectedTokenUrl: expectedOauthUrls.token_url,
        });
        nextOauthConfig.token_url = expectedOauthUrls.token_url;
        urlsPatched = true;
      }

      if (urlsPatched) {
        oauthConfig = nextOauthConfig;
      }
    }

    const expectedCallback = getExpectedMCPOAuthCallback(serverName);
    if (expectedCallback && oauthConfig.redirect_uri !== expectedCallback) {
      logger.warn('[MCP OAuth] Rewriting redirect_uri from domain source', {
        serverName,
        originalRedirectUri: oauthConfig.redirect_uri,
        expectedCallback,
        originalWasLoopback: isLoopbackUrl(oauthConfig.redirect_uri),
      });
      oauthConfig = {
        ...oauthConfig,
        redirect_uri: expectedCallback,
      };
    }
    /* VIVENTIUM END */

    const oauthHeaders = await getOAuthHeaders(serverName, userId);
    const { authorizationUrl, flowId: oauthFlowId } = await MCPOAuthHandler.initiateOAuthFlow(
      serverName,
      serverUrl,
      userId,
      oauthHeaders,
      oauthConfig,
    );

    logger.debug('[MCP OAuth] OAuth flow initiated', { oauthFlowId, authorizationUrl });

    setOAuthCsrfCookie(res, oauthFlowId, OAUTH_CSRF_COOKIE_PATH);
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('[MCP OAuth] Failed to initiate OAuth', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

/**
 * OAuth callback handler
 * This handles the OAuth callback after the user has authorized the application
 */
router.get('/:serverName/oauth/callback', async (req, res) => {
  const basePath = getBasePath();
  try {
    const { serverName } = req.params;
    const { code, state, error: oauthError } = req.query;

    logger.debug('[MCP OAuth] Callback received', {
      serverName,
      code: code ? 'present' : 'missing',
      state,
      error: oauthError,
    });

    if (oauthError) {
      logger.error('[MCP OAuth] OAuth error received', { error: oauthError });
      return res.redirect(
        `${basePath}/oauth/error?error=${encodeURIComponent(String(oauthError))}`,
      );
    }

    if (!code || typeof code !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid code');
      return res.redirect(`${basePath}/oauth/error?error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid state');
      return res.redirect(`${basePath}/oauth/error?error=missing_state`);
    }

    const flowId = state;
    logger.debug('[MCP OAuth] Using flow ID from state', { flowId });

    const flowParts = flowId.split(':');
    if (flowParts.length < 2 || !flowParts[0] || !flowParts[1]) {
      logger.error('[MCP OAuth] Invalid flow ID format in state', { flowId });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    const [flowUserId] = flowParts;
    if (
      !validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH) &&
      !validateOAuthSession(req, flowUserId)
    ) {
      logger.error('[MCP OAuth] CSRF validation failed: no valid CSRF or session cookie', {
        flowId,
        hasCsrfCookie: !!req.cookies?.[OAUTH_CSRF_COOKIE],
        hasSessionCookie: !!req.cookies?.[OAUTH_SESSION_COOKIE],
      });
      return res.redirect(`${basePath}/oauth/error?error=csrf_validation_failed`);
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    logger.debug('[MCP OAuth] Getting flow state for flowId: ' + flowId);
    const flowState = await MCPOAuthHandler.getFlowState(flowId, flowManager);

    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found for flowId:', flowId);
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    logger.debug('[MCP OAuth] Flow state details', {
      serverName: flowState.serverName,
      userId: flowState.userId,
      hasMetadata: !!flowState.metadata,
      hasClientInfo: !!flowState.clientInfo,
      hasCodeVerifier: !!flowState.codeVerifier,
    });

    /** Check if this flow has already been completed (idempotency protection) */
    const currentFlowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (currentFlowState?.status === 'COMPLETED') {
      logger.warn('[MCP OAuth] Flow already completed, preventing duplicate token exchange', {
        flowId,
        serverName,
      });
      return res.redirect(`${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`);
    }

    logger.debug('[MCP OAuth] Completing OAuth flow');
    const oauthHeaders = await getOAuthHeaders(serverName, flowState.userId);
    const tokens = await MCPOAuthHandler.completeOAuthFlow(flowId, code, flowManager, oauthHeaders);
    logger.info('[MCP OAuth] OAuth flow completed, tokens received in callback route');

    /** Persist tokens immediately so reconnection uses fresh credentials */
    if (flowState?.userId && tokens) {
      try {
        await MCPTokenStorage.storeTokens({
          userId: flowState.userId,
          serverName,
          tokens,
          createToken,
          updateToken,
          findToken,
          clientInfo: flowState.clientInfo,
          metadata: flowState.metadata,
        });
        logger.debug('[MCP OAuth] Stored OAuth tokens prior to reconnection', {
          serverName,
          userId: flowState.userId,
        });
      } catch (error) {
        logger.error('[MCP OAuth] Failed to store OAuth tokens after callback', error);
        throw error;
      }

      /**
       * Clear any cached `mcp_get_tokens` flow result so subsequent lookups
       * re-fetch the freshly stored credentials instead of returning stale nulls.
       */
      if (typeof flowManager?.deleteFlow === 'function') {
        try {
          await flowManager.deleteFlow(flowId, 'mcp_get_tokens');
        } catch (error) {
          logger.warn('[MCP OAuth] Failed to clear cached token flow state', error);
        }
      }
    }

    try {
      const mcpManager = getMCPManager(flowState.userId);
      logger.debug(`[MCP OAuth] Attempting to reconnect ${serverName} with new OAuth tokens`);

      if (flowState.userId !== 'system') {
        const user = { id: flowState.userId };

        const userConnection = await mcpManager.getUserConnection({
          user,
          serverName,
          flowManager,
          tokenMethods: {
            findToken,
            updateToken,
            createToken,
            deleteTokens,
          },
        });

        logger.info(
          `[MCP OAuth] Successfully reconnected ${serverName} for user ${flowState.userId}`,
        );

        // clear any reconnection attempts
        const oauthReconnectionManager = getOAuthReconnectionManager();
        oauthReconnectionManager.clearReconnection(flowState.userId, serverName);

        const tools = await userConnection.fetchTools();
        await updateMCPServerTools({
          userId: flowState.userId,
          serverName,
          tools,
        });
      } else {
        logger.debug(`[MCP OAuth] System-level OAuth completed for ${serverName}`);
      }
    } catch (error) {
      logger.warn(
        `[MCP OAuth] Failed to reconnect ${serverName} after OAuth, but tokens are saved:`,
        error,
      );
    }

    /** ID of the flow that the tool/connection is waiting for */
    const toolFlowId = flowState.metadata?.toolFlowId;
    if (toolFlowId) {
      logger.debug('[MCP OAuth] Completing tool flow', { toolFlowId });
      await flowManager.completeFlow(toolFlowId, 'mcp_oauth', tokens);
    }

    /** Redirect to success page with flowId and serverName */
    const redirectUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('[MCP OAuth] OAuth callback error', error);
    res.redirect(`${basePath}/oauth/error?error=callback_failed`);
  }
});

/**
 * Get OAuth tokens for a completed flow
 * This is primarily for user-level OAuth flows
 */
router.get('/oauth/tokens/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!flowId.startsWith(`${user.id}:`) && !flowId.startsWith('system:')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    if (flowState.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Flow not completed' });
    }

    res.json({ tokens: flowState.result });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get tokens', error);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

/**
 * Set CSRF binding cookie for OAuth flows initiated outside of HTTP request/response
 * (e.g. during chat via SSE). The frontend should call this before opening the OAuth URL
 * so the callback can verify the browser matches the flow initiator.
 */
router.post('/:serverName/oauth/bind', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const flowId = MCPOAuthHandler.generateFlowId(user.id, serverName);
    setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);

    res.json({ success: true });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to set CSRF binding cookie', error);
    res.status(500).json({ error: 'Failed to bind OAuth flow' });
  }
});

/**
 * Check OAuth flow status
 * This endpoint can be used to poll the status of an OAuth flow
 */
router.get('/oauth/status/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!flowId.startsWith(`${user.id}:`) && !flowId.startsWith('system:')) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    res.json({
      status: flowState.status,
      completed: flowState.status === 'COMPLETED',
      failed: flowState.status === 'FAILED',
      error: flowState.error,
    });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get flow status', error);
    res.status(500).json({ error: 'Failed to get flow status' });
  }
});

/**
 * Cancel OAuth flow
 * This endpoint cancels a pending OAuth flow
 */
router.post('/oauth/cancel/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    logger.info(`[MCP OAuth Cancel] Cancelling OAuth flow for ${serverName} by user ${user.id}`);

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);
    const flowId = MCPOAuthHandler.generateFlowId(user.id, serverName);
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');

    if (!flowState) {
      logger.debug(`[MCP OAuth Cancel] No active flow found for ${serverName}`);
      return res.json({
        success: true,
        message: 'No active OAuth flow to cancel',
      });
    }

    await flowManager.failFlow(flowId, 'mcp_oauth', 'User cancelled OAuth flow');

    logger.info(`[MCP OAuth Cancel] Successfully cancelled OAuth flow for ${serverName}`);

    res.json({
      success: true,
      message: `OAuth flow for ${serverName} cancelled successfully`,
    });
  } catch (error) {
    logger.error('[MCP OAuth Cancel] Failed to cancel OAuth flow', error);
    res.status(500).json({ error: 'Failed to cancel OAuth flow' });
  }
});

/**
 * Reinitialize MCP server
 * This endpoint allows reinitializing a specific MCP server
 */
router.post('/:serverName/reinitialize', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = createSafeUser(req.user);

    if (!user.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

    const mcpManager = getMCPManager();
    const serverConfig = await getMCPServersRegistry().getServerConfig(serverName, user.id);
    if (!serverConfig) {
      return res.status(404).json({
        error: `MCP server '${serverName}' not found in configuration`,
      });
    }

    await mcpManager.disconnectUserConnection(user.id, serverName);
    logger.info(
      `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
    );

    /** @type {Record<string, Record<string, string>> | undefined} */
    let userMCPAuthMap;
    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      userMCPAuthMap = await getUserMCPAuthMap({
        userId: user.id,
        servers: [serverName],
        findPluginAuthsByKeys,
      });
    }

    const result = await reinitMCPServer({
      user,
      serverName,
      userMCPAuthMap,
    });

    if (!result) {
      return res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
    }

    const { success, message, oauthRequired, oauthUrl } = result;

    if (oauthRequired) {
      const flowId = MCPOAuthHandler.generateFlowId(user.id, serverName);
      setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
    }

    res.json({
      success,
      message,
      oauthUrl,
      serverName,
      oauthRequired,
    });
  } catch (error) {
    logger.error('[MCP Reinitialize] Unexpected error', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get connection status for all MCP servers
 * This endpoint returns all app level and user-scoped connection statuses from MCPManager without disconnecting idle connections
 */
router.get('/connection/status', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    let { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
    );

    await warmPersistentUserMCPConnections(createSafeUser(user), mcpConfig, oauthServers);
    ({ mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(user.id));
    const connectionStatus = {};

    for (const [serverName, config] of Object.entries(mcpConfig)) {
      try {
        connectionStatus[serverName] = await getServerConnectionStatus(
          user.id,
          serverName,
          config,
          appConnections,
          userConnections,
          oauthServers,
        );
      } catch (error) {
        const message = `Failed to get status for server "${serverName}"`;
        logger.error(`[MCP Connection Status] ${message},`, error);
        connectionStatus[serverName] = {
          connectionState: 'error',
          requiresOAuth: oauthServers.has(serverName),
          error: message,
        };
      }
    }

    await settleTransientConnectingOAuthStatuses({
      userId: user.id,
      connectionStatus,
      mcpConfig,
      oauthServers,
    });

    res.json({
      success: true,
      connectionStatus,
    });
  } catch (error) {
    if (error.message === 'MCP config not found') {
      return res.status(404).json({ error: error.message });
    }
    logger.error('[MCP Connection Status] Failed to get connection status', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Get connection status for a single MCP server
 * This endpoint returns the connection status for a specific server for a given user
 */
router.get('/connection/status/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const user = req.user;
    const { serverName } = req.params;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    let { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
    );

    await warmPersistentUserMCPConnections(createSafeUser(user), mcpConfig, oauthServers);
    ({ mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(user.id));

    if (!mcpConfig[serverName]) {
      return res
        .status(404)
        .json({ error: `MCP server '${serverName}' not found in configuration` });
    }

    const serverStatus = await getServerConnectionStatus(
      user.id,
      serverName,
      mcpConfig[serverName],
      appConnections,
      userConnections,
      oauthServers,
    );
    const settledStatus = { [serverName]: serverStatus };

    await settleTransientConnectingOAuthStatuses({
      userId: user.id,
      connectionStatus: settledStatus,
      mcpConfig,
      oauthServers,
      targetServers: [serverName],
    });

    const finalServerStatus = settledStatus[serverName] ?? serverStatus;

    res.json({
      success: true,
      serverName,
      connectionStatus: finalServerStatus.connectionState,
      requiresOAuth: finalServerStatus.requiresOAuth,
    });
  } catch (error) {
    if (error.message === 'MCP config not found') {
      return res.status(404).json({ error: error.message });
    }
    logger.error(
      `[MCP Per-Server Status] Failed to get connection status for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Check which authentication values exist for a specific MCP server
 * This endpoint returns only boolean flags indicating if values are set, not the actual values
 */
router.get('/:serverName/auth-values', requireJwtAuth, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const serverConfig = await getMCPServersRegistry().getServerConfig(serverName, user.id);
    if (!serverConfig) {
      return res.status(404).json({
        error: `MCP server '${serverName}' not found in configuration`,
      });
    }

    const pluginKey = `${Constants.mcp_prefix}${serverName}`;
    const authValueFlags = {};

    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      for (const varName of Object.keys(serverConfig.customUserVars)) {
        try {
          const value = await getUserPluginAuthValue(user.id, varName, false, pluginKey);
          authValueFlags[varName] = !!(value && value.length > 0);
        } catch (err) {
          logger.error(
            `[MCP Auth Value Flags] Error checking ${varName} for user ${user.id}:`,
            err,
          );
          authValueFlags[varName] = false;
        }
      }
    }

    res.json({
      success: true,
      serverName,
      authValueFlags,
    });
  } catch (error) {
    logger.error(
      `[MCP Auth Value Flags] Failed to check auth value flags for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to check auth value flags' });
  }
});

async function getOAuthHeaders(serverName, userId) {
  const serverConfig = await getMCPServersRegistry().getServerConfig(serverName, userId);
  return serverConfig?.oauth_headers ?? {};
}

/**
MCP Server CRUD Routes (User-Managed MCP Servers)
*/

// Permission checkers for MCP server management
const checkMCPUsePermissions = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE],
  getRoleByName,
});

const checkMCPCreate = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName,
});

/**
 * Get list of accessible MCP servers
 * @route GET /api/mcp/servers
 * @param {Object} req.query - Query parameters for pagination and search
 * @param {number} [req.query.limit] - Number of results per page
 * @param {string} [req.query.after] - Pagination cursor
 * @param {string} [req.query.search] - Search query for title/description
 * @returns {MCPServerListResponse} 200 - Success response - application/json
 */
router.get('/servers', requireJwtAuth, checkMCPUsePermissions, getMCPServersList);

/**
 * Create a new MCP server
 * @route POST /api/mcp/servers
 * @param {MCPServerCreateParams} req.body - The MCP server creation parameters.
 * @returns {MCPServer} 201 - Success response - application/json
 */
router.post('/servers', requireJwtAuth, checkMCPCreate, createMCPServerController);

/**
 * Get single MCP server by ID
 * @route GET /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.get(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPUsePermissions,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'serverName',
  }),
  getMCPServerById,
);

/**
 * Update MCP server
 * @route PATCH /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @param {MCPServerUpdateParams} req.body - The MCP server update parameters.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.patch(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'serverName',
  }),
  updateMCPServerController,
);

/**
 * Delete MCP server
 * @route DELETE /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {Object} 200 - Success response - application/json
 */
router.delete(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'serverName',
  }),
  deleteMCPServerController,
);

module.exports = router;
/* VIVENTIUM START: MCP route test reset hook for module-level warm-up state */
module.exports.__resetPersistentWarmupStateForTests = () => {
  persistentWarmupInFlight.clear();
  persistentWarmupLastAttemptAt.clear();
};
/* VIVENTIUM END */
