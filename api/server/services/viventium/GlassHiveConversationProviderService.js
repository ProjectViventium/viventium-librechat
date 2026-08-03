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

function bindConversationProviderDeveloperInstructionTail({ targetAgent, tail } = {}) {
  const modelParameters = targetAgent?.model_parameters;
  const configuration = modelParameters?.configuration;
  const currentHeaders = configuration?.defaultHeaders;
  if (
    !currentHeaders ||
    typeof currentHeaders !== 'object' ||
    !Object.prototype.hasOwnProperty.call(currentHeaders, 'X-GlassHive-Agent-Id')
  ) {
    return false;
  }
  const defaultHeaders = { ...currentHeaders };
  const exactTail = typeof tail === 'string' ? tail.trim() : '';
  if (exactTail) {
    defaultHeaders['X-GlassHive-Developer-Instruction-Tail-B64'] = Buffer.from(
      exactTail,
      'utf8',
    ).toString('base64');
  } else {
    delete defaultHeaders['X-GlassHive-Developer-Instruction-Tail-B64'];
  }
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: { ...configuration, defaultHeaders },
  };
  return true;
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

async function declaredHandoffMcpServerNames(agent, excludedServers = [], resolveAgentById) {
  if (!Array.isArray(agent?.edges) || typeof resolveAgentById !== 'function') {
    return [];
  }
  const agentId = String(agent.id || '').trim();
  const endpointIds = (value) =>
    (Array.isArray(value) ? value : [value])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  const targetIds = Array.from(
    new Set(
      agent.edges
        .filter(
          (edge) =>
            edge &&
            typeof edge === 'object' &&
            (edge.edgeType ?? 'handoff') === 'handoff' &&
            (!agentId || endpointIds(edge.from).includes(agentId)),
        )
        .flatMap((edge) => endpointIds(edge.to))
        .filter(Boolean),
    ),
  ).sort();
  const serverNames = new Set();
  for (const targetId of targetIds) {
    const target = await resolveAgentById(targetId);
    if (!target) {
      const error = new Error('Declared handoff capability target is unavailable');
      error.code = 'handoff_capability_resolution_unavailable';
      throw error;
    }
    for (const serverName of declaredMcpServerNames(target, excludedServers)) {
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
  resolveAgentById,
} = {}) {
  if (!targetAgent || capability?.workspace_binding !== true) {
    return false;
  }
  const allowedServerNames = declaredMcpServerNames(declaredAgent, capability.excluded_mcp_servers);
  /* === VIVENTIUM START ===
   * Feature: Deferred connected-account projection.
   * Purpose: Provider capability metadata may authorize reviewed MCP servers for on-demand use
   * without adding their schemas or discovery latency to every conversation turn.
   */
  const excludedServers = new Set(
    (capability.excluded_mcp_servers || []).map((value) => String(value || '').trim()),
  );
  const includeDeclaredHandoffServers = capability.reviewed_mcp_projection === 'deferred';
  const effectiveResolver =
    resolveAgentById ||
    (async (agentId) => {
      const { getAgent } = require('~/models/Agent');
      return getAgent({ id: agentId });
    });
  let deferredServerNames = [];
  let capabilityResolutionStatus = '';
  if (includeDeclaredHandoffServers) {
    try {
      deferredServerNames = await declaredHandoffMcpServerNames(
        declaredAgent,
        Array.from(excludedServers),
        effectiveResolver,
      );
    } catch (_) {
      capabilityResolutionStatus = 'handoff_capability_resolution_unavailable';
    }
  }
  if (
    allowedServerNames.length === 0 &&
    deferredServerNames.length === 0 &&
    !capabilityResolutionStatus
  ) {
    return false;
  }
  // Load the broker boundary only when the provider has an eager or deferred reviewed MCP scope.
  // Deferred scopes add signed metadata but no connected-account discovery to ordinary chat.
  const {
    buildConversationProviderBootstrapBundle,
  } = require('./GlassHiveCapabilityBootstrapService');
  const bundle = await buildConversationProviderBootstrapBundle({
    user: req?.user,
    requestBody,
    allowedServerNames,
    deferredServerNames,
    excludedServerNames: Array.from(excludedServers).filter(Boolean).sort(),
    ...(capabilityResolutionStatus ? { capabilityResolutionStatus } : {}),
  });
  /* === VIVENTIUM END === */
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
  bindConversationProviderDeveloperInstructionTail,
  bindHarnessCancellation,
  buildHarnessIdempotencyKey,
  declaredMcpServerNames,
  declaredHandoffMcpServerNames,
};
