/* === VIVENTIUM START ===
 * Feature: Voice actor side-effect authority boundary
 * Purpose: Shared-mic, guest, unknown, or otherwise unverified voice turns remain useful context,
 * but can never initialize or retain executable tools, agent graphs, native workspace capability
 * headers, background work, or durable in-call memory writes.
 * === VIVENTIUM END === */

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

function isVoiceActorSideEffectRestricted(req) {
  const body = req?.body;
  if (!body || typeof body !== 'object') {
    return false;
  }
  const carriesVoiceAuthority =
    Boolean(req?.viventiumCallSession?.callSessionId) ||
    Boolean(body.viventiumCallSessionId) ||
    body.voiceMode === true ||
    hasOwn(body, 'viventiumActorTrust') ||
    hasOwn(body, 'viventiumCanAuthorizeSideEffects');
  if (!carriesVoiceAuthority) {
    return false;
  }
  return (
    body.viventiumActorTrust !== 'owner_participant' ||
    body.viventiumCanAuthorizeSideEffects !== true
  );
}

function stripGlassHiveHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return headers;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        !String(name || '')
          .toLowerCase()
          .startsWith('x-glasshive-'),
    ),
  );
}

function restrictGlassHiveHeaders(headers) {
  const sanitized = stripGlassHiveHeaders(headers);
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    return sanitized;
  }
  const nativeTransport = Object.keys(headers).some((name) =>
    ['x-glasshive-agent-id', 'x-glasshive-bootstrap-bundle-b64'].includes(
      String(name).toLowerCase(),
    ),
  );
  if (!nativeTransport) {
    return sanitized;
  }
  // Core initializes these canonical courier fields; neither grants native execution.
  const transportHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name === 'X-GlassHive-Agent-Id' || name === 'X-GlassHive-Turn-Context-B64',
    ),
  );
  // The provider service imports this authority owner. Resolve its signer only after initialization.
  const {
    restrictedConversationProviderBootstrapHeaders,
  } = require('./GlassHiveConversationProviderService');
  return { ...sanitized, ...transportHeaders, ...restrictedConversationProviderBootstrapHeaders() };
}

function sanitizeModelParameters(modelParameters) {
  if (!modelParameters || typeof modelParameters !== 'object') {
    return modelParameters;
  }
  const sanitized = { ...modelParameters };
  if (sanitized.defaultHeaders && typeof sanitized.defaultHeaders === 'object') {
    sanitized.defaultHeaders = restrictGlassHiveHeaders(sanitized.defaultHeaders);
  }
  if (sanitized.configuration && typeof sanitized.configuration === 'object') {
    const configuration = { ...sanitized.configuration };
    if (configuration.defaultHeaders && typeof configuration.defaultHeaders === 'object') {
      configuration.defaultHeaders = restrictGlassHiveHeaders(configuration.defaultHeaders);
    }
    if (configuration.headers && typeof configuration.headers === 'object') {
      configuration.headers = restrictGlassHiveHeaders(configuration.headers);
    }
    sanitized.configuration = configuration;
  }
  return sanitized;
}

function sanitizeAgentForRestrictedVoiceTurn(agent) {
  if (!agent || typeof agent !== 'object') {
    return agent;
  }
  const sanitized = {
    ...agent,
    tools: [],
    toolDefinitions: [],
    toolRegistry: new Map(),
    tool_resources: {},
    userMCPAuthMap: {},
    background_cortices: [],
    agent_ids: [],
    edges: [],
    model_parameters: sanitizeModelParameters(agent.model_parameters),
  };
  delete sanitized.tool_options;
  delete sanitized.glasshive_options;
  delete sanitized.viventiumHarnessCancellationEndpointConfig;
  delete sanitized.viventiumFallbackLlm;
  delete sanitized.viventiumFallbackLlmAssignment;
  delete sanitized.viventiumFallbackLlmInitializer;
  delete sanitized.viventiumFallbackLlmInitializationError;
  return sanitized;
}

function enforceRestrictedVoiceRequest(req) {
  if (!isVoiceActorSideEffectRestricted(req)) {
    return false;
  }
  req.body.viventiumDeferVoiceMemory = true;
  req.body.suppressBackgroundCortices = true;
  req.body.ephemeralAgent = {};
  req._viventiumHarnessActivityEnabled = false;
  req._viventiumHarnessExecutionEnabled = false;
  req._viventiumHarnessInvocationStarted = false;
  req._viventiumHarnessCancellationActiveBaseURL = '';
  delete req._viventiumHarnessIdempotencyKey;
  delete req._viventiumHarnessIdempotencyKeys;
  return true;
}

function emptyToolLoadResult() {
  return {
    tools: [],
    toolContextMap: {},
    toolDefinitions: [],
    userMCPAuthMap: {},
    toolRegistry: new Map(),
  };
}

module.exports = {
  emptyToolLoadResult,
  enforceRestrictedVoiceRequest,
  isVoiceActorSideEffectRestricted,
  sanitizeAgentForRestrictedVoiceTurn,
  stripGlassHiveHeaders,
};
