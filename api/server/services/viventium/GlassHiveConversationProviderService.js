/* === VIVENTIUM START ===
 * Feature: GlassHive core-provider capability projection
 * Purpose: Attach a signed, Agent-declared MCP broker bundle to an authenticated harness request
 * without exposing provider credentials or GlassHive self-delegation.
 * === VIVENTIUM END === */

const { Constants, extractEnvVariable } = require('librechat-data-provider');
const crypto = require('crypto');

function signBootstrapBundle(encodedBundle, issuedAt) {
  const secret = String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET || '').trim();
  if (!secret) {
    throw new Error('GlassHive bootstrap signature secret is not configured');
  }
  return `sha256=${crypto
    .createHmac('sha256', secret)
    .update(`v1\n${issuedAt}\n${encodedBundle}`)
    .digest('hex')}`;
}

function buildHarnessIdempotencyKey(role, messageId, agentId = '') {
  const cleanRole = String(role || '').trim();
  const cleanMessageId = String(messageId || '').trim();
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanRole || !cleanMessageId) {
    return '';
  }
  return [cleanRole, cleanAgentId, cleanMessageId].filter(Boolean).join(':');
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function bindHarnessCancellation({
  req,
  signal,
  endpointConfig,
  fetchImpl = globalThis.fetch,
  onDeliveryError = () => {},
  activityDeliveryTimeoutMs = 2000,
}) {
  if (req?._viventiumHarnessExecutionEnabled !== true || !signal) {
    return false;
  }
  const cancelBaseURL = extractEnvVariable(endpointConfig?.baseURL || '').replace(/\/$/, '');
  const cancelApiKey = extractEnvVariable(endpointConfig?.apiKey || '');
  const cancelOwnerId = String(req.user?.id || '').trim();
  const cancelStreamId = String(req?._resumableStreamId || '').trim();
  let settleCancellationDelivery;
  const cancellationDelivery = new Promise((resolve) => {
    settleCancellationDelivery = resolve;
  });
  try {
    Object.defineProperty(signal, '_viventiumHarnessCancellationDelivery', {
      configurable: true,
      value: cancellationDelivery,
    });
  } catch (_) {
    // Delivery still occurs; older/non-extensible AbortSignal implementations simply cannot
    // make the user-facing abort endpoint wait for its activity acknowledgement.
  }
  let cancellationStarted = false;
  const deliverCancellation = () => {
    if (cancellationStarted) {
      return;
    }
    cancellationStarted = true;
    signal.removeEventListener('abort', deliverCancellation);
    const cancelIdempotencyKey =
      String(req._viventiumHarnessIdempotencyKey || '').trim() ||
      buildHarnessIdempotencyKey('main', req.body?.responseMessageId);
    if (
      signal.reason !== 'user_cancelled' ||
      !cancelBaseURL ||
      cancelBaseURL.includes('${') ||
      !cancelApiKey ||
      cancelApiKey.includes('${') ||
      !cancelIdempotencyKey ||
      !cancelOwnerId ||
      typeof fetchImpl !== 'function'
    ) {
      settleCancellationDelivery?.({ delivered: false });
      return;
    }
    void (async () => {
      try {
        const response = await fetchImpl(
          `${cancelBaseURL}/requests/by-idempotency/${encodeURIComponent(cancelIdempotencyKey)}/cancel`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cancelApiKey}`,
              'X-Viventium-User-Id': cancelOwnerId,
            },
            signal: AbortSignal.timeout(5000),
          },
        );
        if (!response?.ok) {
          throw new Error(`GlassHive cancellation returned HTTP ${response?.status || 'unknown'}`);
        }

        // Native cancellation is the acknowledgement the user-facing abort path must wait for.
        // Activity delivery is best-effort and must not keep Stop pending behind a stalled stream.
        settleCancellationDelivery?.({ delivered: true });
        if (cancelStreamId && req?._viventiumHarnessActivityEnabled === true) {
          try {
            const { GraphEvents } = require('@librechat/agents');
            const { GenerationJobManager } = require('@librechat/api');
            await withTimeout(
              GenerationJobManager.emitChunk(cancelStreamId, {
                _viventiumAllowAfterAbort: true,
                event: GraphEvents.ON_REASONING_DELTA,
                data: {
                  id: `${cancelStreamId}-harness-cancelled`,
                  delta: {
                    content: [
                      {
                        type: 'harness_activity',
                        harness_activity: {
                          event: 'cancelled',
                          summary: 'The harness turn was cancelled.\n',
                        },
                      },
                    ],
                  },
                },
              }),
              Math.max(1, Number(activityDeliveryTimeoutMs) || 2000),
              'GlassHive cancellation activity delivery timed out',
            );
          } catch (error) {
            onDeliveryError(error);
          }
        }
      } catch (error) {
        onDeliveryError(error);
        settleCancellationDelivery?.({ delivered: false });
      }
    })();
  };
  signal.addEventListener('abort', deliverCancellation, { once: true });
  if (signal.aborted) {
    deliverCancellation();
  }
  return true;
}

function declaredMcpServerNames(agent, excludedServers = []) {
  const excluded = new Set((excludedServers || []).map((value) => String(value || '').trim()));
  const serverNames = new Set();
  for (const tool of agent?.tools || []) {
    if (typeof tool !== 'string') {
      continue;
    }
    const index = tool.lastIndexOf(Constants.mcp_delimiter);
    if (index < 0) {
      continue;
    }
    const serverName = tool.slice(index + Constants.mcp_delimiter.length).trim();
    if (serverName && !excluded.has(serverName)) {
      serverNames.add(serverName);
    }
  }
  return Array.from(serverNames).sort();
}

async function attachConversationProviderCapabilityBundle({
  targetAgent,
  declaredAgent = targetAgent,
  req,
  capability,
  requestBody = req?.body || {},
} = {}) {
  if (!targetAgent || capability?.workspace_binding !== true) {
    return false;
  }
  const allowedServerNames = declaredMcpServerNames(declaredAgent, capability.excluded_mcp_servers);
  if (allowedServerNames.length === 0) {
    return false;
  }
  // Load the broker boundary only when an Agent actually declares an eligible MCP server. This
  // keeps ordinary harness chat independent of connected-account cache/bootstrap dependencies.
  const {
    buildConversationProviderBootstrapBundle,
  } = require('./GlassHiveCapabilityBootstrapService');
  const bundle = await buildConversationProviderBootstrapBundle({
    user: req?.user,
    requestBody,
    allowedServerNames,
  });
  if (!bundle || Object.keys(bundle).length === 0) {
    return false;
  }
  const modelParameters = { ...(targetAgent.model_parameters || {}) };
  const configuration = { ...(modelParameters.configuration || {}) };
  const defaultHeaders = { ...(configuration.defaultHeaders || {}) };
  const encodedBundle = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
  const issuedAt = String(Math.floor(Date.now() / 1000));
  defaultHeaders['X-GlassHive-Bootstrap-Bundle-B64'] = encodedBundle;
  defaultHeaders['X-GlassHive-Bootstrap-Timestamp'] = issuedAt;
  defaultHeaders['X-GlassHive-Bootstrap-Signature'] = signBootstrapBundle(encodedBundle, issuedAt);
  configuration.defaultHeaders = defaultHeaders;
  modelParameters.configuration = configuration;
  targetAgent.model_parameters = modelParameters;
  return true;
}

module.exports = {
  attachConversationProviderCapabilityBundle,
  bindHarnessCancellation,
  buildHarnessIdempotencyKey,
  declaredMcpServerNames,
};
