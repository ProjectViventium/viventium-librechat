/* === VIVENTIUM START ===
 * Feature: GlassHive core-provider capability projection
 * Purpose: Attach a signed, Agent-declared MCP broker bundle to an authenticated harness request
 * without exposing provider credentials or GlassHive self-delegation.
 * === VIVENTIUM END === */

const { Constants, extractEnvVariable } = require('librechat-data-provider');

function buildHarnessIdempotencyKey(role, messageId, agentId = '') {
  const cleanRole = String(role || '').trim();
  const cleanMessageId = String(messageId || '').trim();
  const cleanAgentId = String(agentId || '').trim();
  if (!cleanRole || !cleanMessageId) {
    return '';
  }
  return [cleanRole, cleanAgentId, cleanMessageId].filter(Boolean).join(':');
}

function bindHarnessCancellation({
  req,
  signal,
  endpointConfig,
  fetchImpl = globalThis.fetch,
  onDeliveryError = () => {},
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
  signal.addEventListener(
    'abort',
    () => {
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
          if (cancelStreamId && req?._viventiumHarnessActivityEnabled === true) {
            const { GraphEvents } = require('@librechat/agents');
            const { GenerationJobManager } = require('@librechat/api');
            await GenerationJobManager.emitChunk(cancelStreamId, {
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
            });
          }
          settleCancellationDelivery?.({ delivered: true });
        } catch (error) {
          onDeliveryError(error);
          settleCancellationDelivery?.({ delivered: false });
        }
      })();
    },
    { once: true },
  );
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
  const allowedServerNames = declaredMcpServerNames(
    declaredAgent,
    capability.excluded_mcp_servers,
  );
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
  defaultHeaders['X-GlassHive-Bootstrap-Bundle-B64'] = Buffer.from(
    JSON.stringify(bundle),
    'utf8',
  ).toString('base64');
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
