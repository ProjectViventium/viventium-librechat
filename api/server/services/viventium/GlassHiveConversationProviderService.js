const { configuredBackgroundWorkerRoute } = require('@librechat/api');
/* === VIVENTIUM START ===
 * Feature: GlassHive core-provider capability projection
 * Purpose: Attach a signed, Agent-declared MCP broker bundle to an authenticated harness request
 * without exposing provider credentials or GlassHive self-delegation.
 * === VIVENTIUM END === */

const { Constants, extractEnvVariable } = require('librechat-data-provider');
const crypto = require('crypto');
const {
  transcriptionAttachmentReferences,
  resolveSelectedHistoryAttachments,
} = require('@librechat/api');
const { getMessages, getFiles } = require('~/models');
const { logger } = require('@librechat/data-schemas');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
const { getEndpointsConfig } = require('~/server/services/Config/getEndpointsConfig');
const {
  MAIN_DELEGATION_PROFILES,
  isConversationOrchestrationTool,
} = require('./GlassHiveConversationOrchestration');
const {
  projectTrustedClientPresentation,
  projectTrustedNativeInteractionHeaders,
} = require('./interactionContext');
const { trustedUploadedFilesFromRequestBody } = require('./GlassHiveSourceSelection');
const {
  enforceRestrictedVoiceRequest,
  isVoiceActorSideEffectRestricted,
} = require('./VoiceActorAuthorityService');

/* === VIVENTIUM START ===
 * Feature: Acknowledged graph-family Stop delivery.
 * Purpose: Keep user-visible Stop immediate while retrying only transient, owner-scoped
 * cancellation delivery failures within one small background budget.
 * === VIVENTIUM END === */
const HARNESS_CANCELLATION_ATTEMPT_TIMEOUT_MS = 1500;
const MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS = 4500;
const MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS = 5500;
const MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS = Object.freeze([100, 250, 500]);
const HARNESS_CANCELLATION_RETRY_DELAYS_MS = Object.freeze([100, 300]);
const HARNESS_CANCELLATION_RETRYABLE_STATUSES = new Set([408, 425, 429]);
const HARNESS_CANCELLATION_ABORT_REASONS = new Set([
  'user_cancelled',
  'superseded',
  'maintenance_yield',
]);

function waitForHarnessCancellationRetry(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    // Delivery is deliberately best-effort during process shutdown. Do not keep the API process
    // alive solely for a retry, while still allowing retries during normal request handling.
    timer.unref?.();
  });
}

function isRetryableHarnessCancellationStatus(status) {
  return (
    status == null ||
    HARNESS_CANCELLATION_RETRYABLE_STATUSES.has(status) ||
    (status >= 500 && status <= 599)
  );
}

function buildHarnessCancellationDeliveryError({ attempts, status }) {
  const outcome = status == null ? 'transport failure' : `HTTP ${status}`;
  const error = new Error(
    `GlassHive cancellation was not acknowledged after ${attempts} attempts (last outcome: ${outcome})`,
  );
  error.code = 'HARNESS_CANCELLATION_DELIVERY_FAILED';
  error.attempts = attempts;
  error.status = status;
  return error;
}

async function deliverHarnessCancellation({
  url,
  headers,
  fetchImpl,
  attemptTimeoutMs = HARNESS_CANCELLATION_ATTEMPT_TIMEOUT_MS,
  retryDelaysMs = HARNESS_CANCELLATION_RETRY_DELAYS_MS,
  requireCapacityRelease = false,
  totalTimeoutMs = 0,
}) {
  let attempts = 0;
  let lastStatus = null;
  const startedAt = Date.now();

  for (let index = 0; index <= retryDelaysMs.length; index += 1) {
    attempts += 1;
    let response;
    try {
      const remainingMs = totalTimeoutMs > 0 ? totalTimeoutMs - (Date.now() - startedAt) : 0;
      if (totalTimeoutMs > 0 && remainingMs <= 0) {
        throw buildHarnessCancellationDeliveryError({ attempts, status: lastStatus });
      }
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(
          totalTimeoutMs > 0 ? Math.min(attemptTimeoutMs, remainingMs) : attemptTimeoutMs,
        ),
      });
    } catch (_) {
      response = null;
    }

    if (response?.ok && !requireCapacityRelease) {
      return { acknowledged: true };
    }
    let capacityReleasePending = false;
    if (response?.ok && requireCapacityRelease) {
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      if (body?.capacityReleased === true) {
        return { acknowledged: true, capacityReleased: true };
      }
      capacityReleasePending = true;
    }

    const numericStatus = Number(response?.status);
    lastStatus = capacityReleasePending
      ? 425
      : Number.isInteger(numericStatus) && numericStatus > 0
        ? numericStatus
        : null;
    if (!isRetryableHarnessCancellationStatus(lastStatus) || index === retryDelaysMs.length) {
      throw buildHarnessCancellationDeliveryError({ attempts, status: lastStatus });
    }
    const remainingBeforeDelay =
      totalTimeoutMs > 0 ? totalTimeoutMs - (Date.now() - startedAt) : retryDelaysMs[index];
    if (totalTimeoutMs > 0 && remainingBeforeDelay <= 0) {
      throw buildHarnessCancellationDeliveryError({ attempts, status: lastStatus });
    }
    await waitForHarnessCancellationRetry(
      totalTimeoutMs > 0
        ? Math.min(retryDelaysMs[index], remainingBeforeDelay)
        : retryDelaysMs[index],
    );
  }
}

function reportHarnessCancellationDeliveryError(onDeliveryError, error) {
  const observer =
    typeof onDeliveryError === 'function'
      ? onDeliveryError
      : (deliveryError) => {
          logger.warn('[GlassHiveProvider] Native cancellation delivery failed', {
            error: deliveryError?.message || 'provider_unreachable',
          });
        };
  try {
    observer(error);
  } catch (_) {
    logger.warn('[GlassHiveProvider] Native cancellation delivery observer failed', {
      error: 'cancellation_delivery_observer_failed',
    });
  }
}

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

function buildHarnessAttemptIdempotencyKey(req, messageId, agentId = '') {
  if (req?._viventiumHarnessExecutionEnabled !== true) {
    return '';
  }
  const role = req?._viventiumFallbackLlmAttempt === true ? 'main-fallback' : 'main';
  return buildHarnessIdempotencyKey(role, messageId, agentId);
}

/* === VIVENTIUM START ===
 * Feature: Graph-agent-scoped GlassHive request identity.
 * Purpose: Keep retries idempotent per participant while preventing a GlassHive handoff from
 * replaying the primary agent's request under the same owner/key uniqueness boundary.
 * === VIVENTIUM END === */
function buildHarnessAgentIdempotencyKeys(
  req,
  messageId,
  { primaryAgentId = '', agentIds = [], preserveGraphTurnFamily = false } = {},
) {
  const normalizedAgentIds = Array.from(
    new Set((agentIds || []).map((agentId) => String(agentId || '').trim()).filter(Boolean)),
  );
  if (normalizedAgentIds.length === 0) {
    return { primaryKey: '', byAgentId: {}, allKeys: [] };
  }

  const normalizedPrimaryAgentId = String(primaryAgentId || '').trim();
  // Graph retries keep one user-turn family so completed transfer receipts and family Stop
  // tombstones survive a model change. GlassHive's graph execution digest still separates the
  // actual provider attempts by model, effort, tool choice, and message state. Plain retries keep
  // the distinct main-fallback base because they have no graph execution digest.
  const role =
    req?._viventiumFallbackLlmAttempt === true && preserveGraphTurnFamily !== true
      ? 'main-fallback'
      : 'main';
  const primaryKey = normalizedAgentIds.includes(normalizedPrimaryAgentId)
    ? buildHarnessIdempotencyKey(role, messageId)
    : '';
  const byAgentId = {};
  const allKeys = [];
  for (const agentId of normalizedAgentIds) {
    const key =
      agentId === normalizedPrimaryAgentId
        ? primaryKey
        : buildHarnessIdempotencyKey(role, messageId, agentId);
    if (!key) {
      continue;
    }
    byAgentId[agentId] = key;
    if (!allKeys.includes(key)) {
      allKeys.push(key);
    }
  }

  if (primaryKey && !allKeys.includes(primaryKey)) {
    allKeys.unshift(primaryKey);
  }
  return { primaryKey, byAgentId, allKeys };
}

function resolveConversationProviderId(agent) {
  return String(agent?.endpoint || agent?.provider || '').trim();
}

function setConversationProviderCapability(req, provider) {
  const providerId = String(provider || '').trim();
  const capability = req?.config?.endpoints?.agents?.providerCapabilities?.[providerId];
  if (!req || typeof req !== 'object') {
    return capability;
  }
  if (isVoiceActorSideEffectRestricted(req)) {
    enforceRestrictedVoiceRequest(req);
    return capability;
  }
  req.viventiumTimeContextDelivery =
    capability?.workspace_binding === true && capability?.conversation_session === true
      ? 'per_turn_header'
      : 'developer';
  req._viventiumHarnessActivityEnabled = capability?.activity_stream === true;
  req._viventiumHarnessExecutionEnabled = capability?.workspace_binding === true;
  if (req._viventiumHarnessExecutionEnabled !== true) {
    req._viventiumHarnessCancellationActiveBaseURL = '';
  }
  return capability;
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

function bindHarnessCancellation({
  req,
  signal,
  endpointConfig,
  fetchImpl = globalThis.fetch,
  onDeliveryError,
}) {
  const hasGraphHarnessKeys =
    (req?._viventiumHarnessIdempotencyKeys instanceof Set &&
      req._viventiumHarnessIdempotencyKeys.size > 0) ||
    (Array.isArray(req?._viventiumHarnessIdempotencyKeys) &&
      req._viventiumHarnessIdempotencyKeys.length > 0);
  if ((req?._viventiumHarnessExecutionEnabled !== true && !hasGraphHarnessKeys) || !signal) {
    return false;
  }
  const cancelBaseURL = extractEnvVariable(endpointConfig?.baseURL || '').replace(/\/$/, '');
  const cancelApiKey = extractEnvVariable(endpointConfig?.apiKey || '');
  const cancelOwnerId = String(req.user?.id || '').trim();
  if (
    !cancelBaseURL ||
    cancelBaseURL.includes('${') ||
    !cancelApiKey ||
    cancelApiKey.includes('${')
  ) {
    return false;
  }
  const boundBaseURLs =
    req._viventiumHarnessCancellationBoundBaseURLs instanceof Set
      ? req._viventiumHarnessCancellationBoundBaseURLs
      : new Set();
  req._viventiumHarnessCancellationBoundBaseURLs = boundBaseURLs;
  req._viventiumHarnessCancellationActiveBaseURL = cancelBaseURL;
  if (boundBaseURLs.has(cancelBaseURL)) {
    return true;
  }
  boundBaseURLs.add(cancelBaseURL);
  const deliverCancellation = () => {
    if (req._viventiumHarnessCancellationActiveBaseURL !== cancelBaseURL) {
      return;
    }
    const fallbackIdempotencyKey =
      String(req._viventiumHarnessIdempotencyKey || '').trim() ||
      buildHarnessAttemptIdempotencyKey(req, req.body?.responseMessageId);
    const configuredKeys =
      req._viventiumHarnessIdempotencyKeys instanceof Set
        ? Array.from(req._viventiumHarnessIdempotencyKeys)
        : Array.isArray(req._viventiumHarnessIdempotencyKeys)
          ? req._viventiumHarnessIdempotencyKeys
          : [];
    const cancelIdempotencyKeys = Array.from(
      new Set(
        (configuredKeys.length > 0 ? configuredKeys : [fallbackIdempotencyKey])
          .map((key) => String(key || '').trim())
          .filter(Boolean),
      ),
    );
    if (
      !HARNESS_CANCELLATION_ABORT_REASONS.has(signal.reason) ||
      cancelIdempotencyKeys.length === 0 ||
      !cancelOwnerId ||
      typeof fetchImpl !== 'function'
    ) {
      return;
    }
    const maintenanceYield = signal.reason === 'maintenance_yield';
    const deliveries = cancelIdempotencyKeys.map(async (cancelIdempotencyKey) => {
      try {
        return await deliverHarnessCancellation({
          url: `${cancelBaseURL}/requests/by-idempotency/${encodeURIComponent(cancelIdempotencyKey)}/cancel`,
          headers: {
            Authorization: `Bearer ${cancelApiKey}`,
            'X-Viventium-User-Id': cancelOwnerId,
          },
          fetchImpl,
          ...(maintenanceYield
            ? {
                attemptTimeoutMs: MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
                retryDelaysMs: MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
                requireCapacityRelease: true,
                totalTimeoutMs: MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
              }
            : {}),
        });
      } catch (error) {
        reportHarnessCancellationDeliveryError(onDeliveryError, error);
        return {
          acknowledged: false,
          errorCode: String(error?.code || 'HARNESS_CANCELLATION_DELIVERY_FAILED'),
          status: Number(error?.status) || null,
        };
      }
    });
    req._viventiumHarnessCancellationDeliveryPromise = Promise.all(deliveries).then((outcomes) => ({
      acknowledged: outcomes.every((outcome) => outcome?.acknowledged === true),
      outcomes,
    }));
  };
  if (signal.aborted) deliverCancellation();
  else signal.addEventListener('abort', deliverCancellation, { once: true });
  return true;
}

function declaredMcpServerNames(agent, excludedServers = []) {
  const excluded = new Set((excludedServers || []).map((value) => String(value || '').trim()));
  const serverNames = new Set();
  for (const tool of agent?.declaredToolNames ?? agent?.tools ?? []) {
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

/* === VIVENTIUM START ===
 * Feature: Resolved host-tool projection.
 * Purpose: Project only host tools that survived the common Agent initialization seam. This is
 * capability/resource state, never provider-name, prompt-text, or user-entity matching.
 * === VIVENTIUM END === */
function resolvedAgentToolNameSet(targetAgent) {
  const resolved = new Set();
  if (targetAgent?.toolRegistry instanceof Map) {
    for (const name of targetAgent.toolRegistry.keys()) {
      resolved.add(String(name || '').trim());
    }
  }
  for (const tool of targetAgent?.tools || []) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    if (name) {
      resolved.add(String(name).trim());
    }
  }
  for (const definition of targetAgent?.toolDefinitions || []) {
    const name = definition?.name || definition?.function?.name;
    if (name) {
      resolved.add(String(name).trim());
    }
  }
  return resolved;
}

function resolvedHostToolNames(targetAgent, capability = {}) {
  if (capability.host_tools_transport !== 'broker_mcp') {
    return [];
  }
  const permitted = new Set(
    (capability.host_tools || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  if (permitted.size === 0) {
    return [];
  }
  const resolved = resolvedAgentToolNameSet(targetAgent);
  return Array.from(permitted)
    .filter((name) => resolved.has(name))
    .sort();
}

/* === VIVENTIUM START ===
 * Feature: Conversation-lane orchestration projection.
 * Purpose: Resolve only canonical Core facades from Main's initialized tools. These names remain
 * separate from ordinary host tools so durable mission roots cannot inherit peer authority.
 * === VIVENTIUM END === */
function resolvedConversationOrchestrationToolNames(targetAgent, capability = {}) {
  if (
    targetAgent?.glasshive_options?.orchestration?.parallel_available !== true ||
    capability.workspace_binding !== true ||
    capability.host_tools_transport !== 'broker_mcp'
  ) {
    return [];
  }
  const resolved = resolvedAgentToolNameSet(targetAgent);
  return Array.from(
    new Set(
      (capability.conversation_orchestration_tools || [])
        .map((value) => String(value || '').trim())
        .filter(isConversationOrchestrationTool),
    ),
  )
    .filter((name) => resolved.has(name))
    .sort();
}

function configuredConversationOrchestrationWorkerRoute(agent) {
  return configuredBackgroundWorkerRoute(agent);
}

function configuredBrokerHostTools(providerCapabilities = {}) {
  const configured = new Set();
  for (const capability of Object.values(providerCapabilities || {})) {
    if (
      capability?.workspace_binding !== true ||
      capability?.host_tools_transport !== 'broker_mcp'
    ) {
      continue;
    }
    for (const toolName of capability.host_tools || []) {
      const normalized = String(toolName || '').trim();
      if (normalized) {
        configured.add(normalized);
      }
    }
  }
  return Array.from(configured).sort();
}

/* === VIVENTIUM START ===
 * Feature: Host-owned evidence boundary for conversation providers.
 * Purpose: A full-access worker may inspect ordinary workspace artifacts, but it must never
 * impersonate an unavailable host-owned capability by trawling app state, exports, caches,
 * logs, or backups. This boundary is derived from structured capability/resource state and is
 * independent of prompt wording, provider labels, user identity, and named entities.
 * === VIVENTIUM END === */
function unavailableHostToolInstructions(toolNames = []) {
  const unavailable = Array.from(
    new Set((toolNames || []).map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
  if (unavailable.length === 0) {
    return '';
  }
  return [
    'Host-owned evidence boundary:',
    `- These configured host capabilities have no authorized resources for this turn: ${unavailable.join(', ')}.`,
    '- Do not emulate or replace an unavailable host capability by searching application state, conversation exports, caches, logs, backups, hidden runtime folders, or unrelated workspace copies.',
    '- Native filesystem tools remain valid for ordinary project/workspace artifacts that are actually in scope, but their contents are not evidence that the missing host capability ran.',
    '- If the user needs evidence owned by an unavailable host capability, state the limitation or ask for the missing context instead of claiming the evidence was retrieved.',
  ].join('\n');
}

const HOST_EVIDENCE_BOUNDARY_START = '<viventium_host_evidence_boundary>';
const HOST_EVIDENCE_BOUNDARY_END = '</viventium_host_evidence_boundary>';

function applyHostEvidenceBoundaryInstructions(targetAgent, unavailableHostTools = []) {
  if (!targetAgent) {
    return '';
  }
  const currentInstructions = String(targetAgent.instructions || '').trim();
  const startIndex = currentInstructions.indexOf(HOST_EVIDENCE_BOUNDARY_START);
  const endIndex = currentInstructions.indexOf(HOST_EVIDENCE_BOUNDARY_END);
  const instructionsWithoutBoundary =
    startIndex >= 0 && endIndex >= startIndex
      ? `${currentInstructions.slice(0, startIndex)}${currentInstructions.slice(
          endIndex + HOST_EVIDENCE_BOUNDARY_END.length,
        )}`.trim()
      : currentInstructions;
  const boundaryInstructions = unavailableHostToolInstructions(unavailableHostTools);
  const wrappedBoundary = boundaryInstructions
    ? `${HOST_EVIDENCE_BOUNDARY_START}\n${boundaryInstructions}\n${HOST_EVIDENCE_BOUNDARY_END}`
    : '';
  targetAgent.instructions = [instructionsWithoutBoundary, wrappedBoundary]
    .filter(Boolean)
    .join('\n\n');
  return boundaryInstructions;
}

const BROKER_UNAVAILABLE_START = '<viventium_capability_broker_unavailable>';
const BROKER_UNAVAILABLE_END = '</viventium_capability_broker_unavailable>';
const CONVERSATION_PROVIDER_INSTRUCTION_APPEND = 'viventiumConversationProviderInstructionAppend';
const CONVERSATION_PROVIDER_CAPABILITY_REFRESH = 'viventiumConversationProviderCapabilityRefresh';
const BOOTSTRAP_HEADER_NAMES = Object.freeze([
  'X-GlassHive-Bootstrap-Bundle-B64',
  'X-GlassHive-Bootstrap-Timestamp',
  'X-GlassHive-Bootstrap-Signature',
]);

function setConversationProviderInstructionAppend(targetAgent, instructions) {
  if (!targetAgent || typeof targetAgent !== 'object') {
    return;
  }
  Object.defineProperty(targetAgent, CONVERSATION_PROVIDER_INSTRUCTION_APPEND, {
    value: String(instructions || '').trim(),
    configurable: true,
    enumerable: false,
    writable: false,
  });
}

/* === VIVENTIUM START ===
 * Feature: Invocation-fresh conversation-provider authority.
 * Purpose: Graph initialization can precede a later participant re-entry by more than the
 * provider's 300-second bootstrap-signature window. Keep the short replay defense intact by
 * rebuilding the complete signed bundle and broker grant immediately before an actual model
 * attempt. The runtime-only closure reuses already-resolved Agent capability/resource state; it
 * never reloads ToolService/MCPs and cannot enter Agent serialization or persistence.
 * Added: 2026-08-10
 * === VIVENTIUM END === */
function removeBootstrapBundleHeaders(targetAgent) {
  const modelParameters = targetAgent?.model_parameters;
  const configuration = modelParameters?.configuration;
  const currentHeaders = configuration?.defaultHeaders;
  if (!currentHeaders || typeof currentHeaders !== 'object') {
    return;
  }
  const defaultHeaders = { ...currentHeaders };
  for (const headerName of BOOTSTRAP_HEADER_NAMES) {
    delete defaultHeaders[headerName];
  }
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: { ...configuration, defaultHeaders },
  };
}

function capabilityRefreshResult(targetAgent, attached, previousInstructionAppend = '') {
  return Object.freeze({
    attached: attached === true,
    defaultHeaders: Object.freeze({
      ...(targetAgent?.model_parameters?.configuration?.defaultHeaders || {}),
    }),
    instructionAppend: String(targetAgent?.[CONVERSATION_PROVIDER_INSTRUCTION_APPEND] || '').trim(),
    previousInstructionAppend: String(previousInstructionAppend || '').trim(),
  });
}

function installConversationProviderCapabilityRefresher({
  targetAgent,
  declaredAgent = targetAgent,
  capabilitySourceAgent = targetAgent,
  req,
  capability,
  requestBody = req?.body || {},
} = {}) {
  const declaredProvider = resolveConversationProviderId(declaredAgent);
  const resolvedCapability =
    capability ?? req?.config?.endpoints?.agents?.providerCapabilities?.[declaredProvider];
  if (!targetAgent || resolvedCapability?.workspace_binding !== true) {
    return false;
  }
  /* === VIVENTIUM START ===
   * Feature: Finalized gateway turn scope for invocation-fresh provider grants.
   * Purpose: Telegram, voice, scheduler, and other trusted gateways can initialize an Agent before
   * the controller allocates the durable conversation/response ids. Prefer the finalized per-run
   * body supplied at the model-attempt boundary so the broker grant is exact and fail-closed.
   * === VIVENTIUM END === */
  const refresh = async (finalizedRequestBody) => {
    const effectiveRequestBody =
      finalizedRequestBody &&
      typeof finalizedRequestBody === 'object' &&
      !Array.isArray(finalizedRequestBody)
        ? finalizedRequestBody
        : requestBody;
    const previousInstructionAppend = String(
      targetAgent?.[CONVERSATION_PROVIDER_INSTRUCTION_APPEND] || '',
    ).trim();
    const attached = await attachConversationProviderCapabilityBundle({
      targetAgent,
      declaredAgent,
      capabilitySourceAgent,
      req,
      capability: resolvedCapability,
      requestBody: effectiveRequestBody,
    });
    if (!attached) {
      // Never leave a previously valid but now expired bundle on the next provider attempt.
      removeBootstrapBundleHeaders(targetAgent);
    }
    return capabilityRefreshResult(targetAgent, attached, previousInstructionAppend);
  };
  Object.defineProperty(targetAgent, CONVERSATION_PROVIDER_CAPABILITY_REFRESH, {
    value: refresh,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return true;
}

function applyCapabilityBrokerUnavailableInstructions(targetAgent, unavailable = true) {
  if (!targetAgent) {
    return '';
  }
  const currentInstructions = String(targetAgent.instructions || '').trim();
  const startIndex = currentInstructions.indexOf(BROKER_UNAVAILABLE_START);
  const endIndex = currentInstructions.indexOf(BROKER_UNAVAILABLE_END);
  const instructionsWithoutBoundary =
    startIndex >= 0 && endIndex >= startIndex
      ? `${currentInstructions.slice(0, startIndex)}${currentInstructions.slice(
          endIndex + BROKER_UNAVAILABLE_END.length,
        )}`.trim()
      : currentInstructions;
  const boundary = unavailable
    ? [
        'The host capability broker is unavailable for this run.',
        'Do not claim that brokered host capabilities ran or substitute memory, recall, filesystem state, logs, caches, or exports for live provider evidence.',
        'Continue with genuinely callable worker-native tools when useful; otherwise state the exact capability limitation.',
      ].join('\n')
    : '';
  const wrappedBoundary = boundary
    ? `${BROKER_UNAVAILABLE_START}\n${boundary}\n${BROKER_UNAVAILABLE_END}`
    : '';
  targetAgent.instructions = [instructionsWithoutBoundary, wrappedBoundary]
    .filter(Boolean)
    .join('\n\n');
  return boundary;
}

const hostToolRequiresResources = (toolName) =>
  ['file_search', 'transcribe_audio'].includes(toolName);

async function resolvedHostToolResources(
  targetAgent,
  allowedHostTools = [],
  req,
  uploadedFiles = [],
) {
  const resources = {};
  const toolResources = targetAgent?.tool_resources || {};
  for (const toolName of allowedHostTools) {
    if (toolName === 'transcribe_audio') {
      const files = transcriptionAttachmentReferences(uploadedFiles);
      if (files.length) resources.transcribe_audio = { files };
      continue;
    }
    if (toolName !== 'file_search') {
      continue;
    }
    const { files = [] } = await primeFiles({
      tool_resources: toolResources,
      req,
      agentId: String(targetAgent?.id || '').trim() || undefined,
    });
    if (files.length === 0) {
      continue;
    }
    resources.file_search = {
      entity_id: String(targetAgent?.id || '').trim(),
      files,
    };
  }
  return resources;
}

async function resolveHostToolCapabilityState({
  targetAgent,
  declarationSource = targetAgent,
  capability,
  req,
  uploadedFiles = [],
} = {}) {
  let allowedHostTools = resolvedHostToolNames(targetAgent, capability);
  if (capability?.worker_native_tools === true || capability?.native_tools === true) {
    // Native execution deliberately omits ordinary tool binding. Resolve the original
    // participant declarations against the same endpoint capability gate as ToolService.
    const endpoints = await getEndpointsConfig(req);
    const enabled = new Set(endpoints?.agents?.capabilities ?? []);
    allowedHostTools = resolvedHostToolNames(
      {
        tools: declarationSource?.declaredToolNames ?? declarationSource?.tools,
      },
      capability,
    ).filter((name) => enabled.has(name));
  }
  // Selected conversation attachments are a declared native capability, independent of semantic routing.
  if (
    capability?.workspace_binding === true &&
    capability?.host_tools_transport === 'broker_mcp' &&
    capability.host_tools?.includes('transcribe_audio') &&
    !allowedHostTools.includes('transcribe_audio') &&
    transcriptionAttachmentReferences(uploadedFiles).length > 0
  ) {
    allowedHostTools.push('transcribe_audio');
  }
  let hostToolResources = {};
  try {
    hostToolResources = await resolvedHostToolResources(
      targetAgent,
      allowedHostTools,
      req,
      uploadedFiles,
    );
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Host tool resource priming failed', {
      message: error?.message,
    });
  }
  const authorizedHostTools = allowedHostTools.filter(
    (toolName) => !hostToolRequiresResources(toolName) || hostToolResources[toolName],
  );
  const unavailableHostTools = allowedHostTools.filter(
    (toolName) => hostToolRequiresResources(toolName) && !hostToolResources[toolName],
  );
  return {
    allowedHostTools,
    authorizedHostTools,
    unavailableHostTools,
    hostToolResources,
  };
}

async function attachDeclaredConversationProviderCapabilityBundle({
  targetAgent,
  declaredAgent = targetAgent,
  capabilitySourceAgent = targetAgent,
  req,
  requestBody = req?.body || {},
  resolveAgentById,
} = {}) {
  const declaredProvider = resolveConversationProviderId(declaredAgent);
  const capability = req?.config?.endpoints?.agents?.providerCapabilities?.[declaredProvider];
  return attachConversationProviderCapabilityBundle({
    targetAgent,
    declaredAgent,
    capabilitySourceAgent,
    req,
    capability,
    requestBody,
    resolveAgentById,
  });
}

async function attachConversationProviderCapabilityBundle({
  targetAgent,
  declaredAgent = targetAgent,
  capabilitySourceAgent = targetAgent,
  req,
  capability,
  requestBody = req?.body || {},
} = {}) {
  if (isVoiceActorSideEffectRestricted(req)) {
    enforceRestrictedVoiceRequest(req);
    return false;
  }
  if (!targetAgent || capability?.workspace_binding !== true) {
    return false;
  }
  const modelParameters = { ...(targetAgent.model_parameters || {}) };
  const configuration = { ...(modelParameters.configuration || {}) };
  configuration.defaultHeaders = projectTrustedNativeInteractionHeaders(
    req,
    configuration.defaultHeaders,
  );
  if (
    Object.keys(configuration.defaultHeaders).length > 0 ||
    modelParameters.configuration?.defaultHeaders
  ) {
    targetAgent.model_parameters = { ...modelParameters, configuration };
  }
  /* === VIVENTIUM START ===
   * Feature: Participant-owned capability parity across provider fallback routes.
   * Purpose: The fallback route declares provider identity, while the owning participant declares
   * its authorized tools. Project MCP servers from that explicit capability source so a tool-less
   * fallback model cannot silently lose the participant's connected-account access.
   * === VIVENTIUM END === */
  const mcpCapabilitySource =
    capabilitySourceAgent === targetAgent ? declaredAgent : capabilitySourceAgent;
  const allowedServerNames = declaredMcpServerNames(
    mcpCapabilitySource,
    capability.excluded_mcp_servers,
  );
  const trustedRequestBody = projectTrustedClientPresentation(requestBody, req);
  const currentUploads = trustedUploadedFilesFromRequestBody(trustedRequestBody);
  const historyUploads =
    capability.workspace_binding === true
      ? await resolveSelectedHistoryAttachments(
          {
            userId: String(req?.user?.id || req?.user?._id || ''),
            conversationId: trustedRequestBody.conversationId,
            parentMessageId: trustedRequestBody.parentMessageId,
          },
          { getMessages, getFiles },
        )
      : [];
  // Preserve current source inputs; selected history enriches only the signed file/capability view.
  const uploadedFiles = Array.from(
    new Map(
      trustedUploadedFilesFromRequestBody({ files: [...currentUploads, ...historyUploads] }).map(
        (file) => [file.file_id || file.filename, file],
      ),
    ).values(),
  );
  const hostToolCapabilityState = await resolveHostToolCapabilityState({
    targetAgent: capabilitySourceAgent,
    declarationSource: mcpCapabilitySource,
    capability,
    req,
    uploadedFiles,
  });
  const allowedConversationOrchestrationTools = resolvedConversationOrchestrationToolNames(
    mcpCapabilitySource,
    capability,
  );
  const workerRoute = configuredConversationOrchestrationWorkerRoute(mcpCapabilitySource);
  const unavailableInstructions = applyHostEvidenceBoundaryInstructions(
    targetAgent,
    hostToolCapabilityState.unavailableHostTools,
  );
  if (
    allowedServerNames.length === 0 &&
    hostToolCapabilityState.authorizedHostTools.length === 0 &&
    allowedConversationOrchestrationTools.length === 0 &&
    uploadedFiles.length === 0
  ) {
    setConversationProviderInstructionAppend(targetAgent, unavailableInstructions);
    return false;
  }
  // Load the broker boundary only when an Agent actually resolves an eligible capability. This
  // keeps ordinary harness chat independent of connected-account and host-tool bootstrap work.
  const {
    buildConversationProviderBootstrapBundle,
  } = require('./GlassHiveCapabilityBootstrapService');
  let bundle;
  try {
    bundle = await buildConversationProviderBootstrapBundle({
      user: req?.user,
      requestBody: trustedRequestBody,
      allowedServerNames,
      allowedHostTools: hostToolCapabilityState.authorizedHostTools,
      hostToolResources: hostToolCapabilityState.hostToolResources,
      ...(allowedConversationOrchestrationTools.length > 0
        ? { allowedConversationOrchestrationTools, ...workerRoute }
        : {}),
      ...(req?._viventiumGlassHiveWorkerMemory !== undefined
        ? { workerMemory: req._viventiumGlassHiveWorkerMemory }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelings !== undefined
        ? { workerFeelings: req._viventiumGlassHiveWorkerFeelings }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsEnabled !== undefined
        ? { workerFeelingsEnabled: req._viventiumGlassHiveWorkerFeelingsEnabled === true }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsHash !== undefined
        ? { workerFeelingsHash: req._viventiumGlassHiveWorkerFeelingsHash }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsScope !== undefined
        ? { workerFeelingsScope: req._viventiumGlassHiveWorkerFeelingsScope }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsRangePromptOverrideCount !== undefined
        ? {
            workerFeelingsRangePromptOverrideCount:
              req._viventiumGlassHiveWorkerFeelingsRangePromptOverrideCount,
          }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideCount !== undefined
        ? {
            workerFeelingsActiveRangePromptOverrideCount:
              req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideCount,
          }
        : {}),
      ...(req?._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideChars !== undefined
        ? {
            workerFeelingsActiveRangePromptOverrideChars:
              req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideChars,
          }
        : {}),
      ...(req?._viventiumGlassHiveCapabilityDependency !== undefined
        ? { capabilityDependency: req._viventiumGlassHiveCapabilityDependency }
        : {}),
    });
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Provider bundle build failed', {
      message: error?.message,
    });
    const brokerUnavailableInstructions = applyCapabilityBrokerUnavailableInstructions(
      targetAgent,
      true,
    );
    setConversationProviderInstructionAppend(
      targetAgent,
      [unavailableInstructions, brokerUnavailableInstructions].filter(Boolean).join('\n\n'),
    );
    return false;
  }
  if (bundle == null) {
    setConversationProviderInstructionAppend(targetAgent, unavailableInstructions);
    return false;
  }
  // The signed ledger carries only current upload IDs and safe metadata. GlassHive resolves
  // original bytes under this authenticated owner's storage root, never a request-supplied path.
  if (uploadedFiles.length > 0) {
    bundle = { ...bundle, viventium_upload_context: { selected_uploads: uploadedFiles } };
  }
  if (!bundle || Object.keys(bundle).length === 0) {
    const brokerUnavailableInstructions = applyCapabilityBrokerUnavailableInstructions(
      targetAgent,
      true,
    );
    setConversationProviderInstructionAppend(
      targetAgent,
      [unavailableInstructions, brokerUnavailableInstructions].filter(Boolean).join('\n\n'),
    );
    return false;
  }
  return attachConversationProviderBootstrapBundle({
    targetAgent,
    bundle,
    unavailableInstructions,
    req,
  });
}

function attachConversationProviderBootstrapBundle({
  targetAgent,
  bundle,
  unavailableInstructions = '',
  req,
}) {
  const modelParameters = { ...(targetAgent.model_parameters || {}) };
  const configuration = { ...(modelParameters.configuration || {}) };
  if (req)
    configuration.defaultHeaders = projectTrustedNativeInteractionHeaders(
      req,
      configuration.defaultHeaders,
    );
  const capabilityInstructions = [
    String(bundle.conversation_provider_instructions || '').trim(),
    unavailableInstructions,
  ]
    .filter(Boolean)
    .join('\n\n');
  const defaultHeaders = { ...(configuration.defaultHeaders || {}) };
  const encodedBundle = Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64');
  const issuedAt = String(Math.floor(Date.now() / 1000));
  let signature;
  try {
    signature = signBootstrapBundle(encodedBundle, issuedAt);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Provider bundle signing failed', {
      message: error?.message,
    });
    const brokerUnavailableInstructions = applyCapabilityBrokerUnavailableInstructions(
      targetAgent,
      true,
    );
    setConversationProviderInstructionAppend(
      targetAgent,
      [unavailableInstructions, brokerUnavailableInstructions].filter(Boolean).join('\n\n'),
    );
    return false;
  }
  applyCapabilityBrokerUnavailableInstructions(targetAgent, false);
  if (capabilityInstructions) {
    const currentInstructions = String(targetAgent.instructions || '').trim();
    targetAgent.instructions = currentInstructions.includes(capabilityInstructions)
      ? currentInstructions
      : [currentInstructions, capabilityInstructions].filter(Boolean).join('\n\n');
  }
  setConversationProviderInstructionAppend(targetAgent, capabilityInstructions);
  defaultHeaders['X-GlassHive-Bootstrap-Bundle-B64'] = encodedBundle;
  defaultHeaders['X-GlassHive-Bootstrap-Timestamp'] = issuedAt;
  defaultHeaders['X-GlassHive-Bootstrap-Signature'] = signature;
  configuration.defaultHeaders = defaultHeaders;
  modelParameters.configuration = configuration;
  targetAgent.model_parameters = modelParameters;
  // Server-owned observer stays outside the signed/serialized model input and is closed by its run.
  req?._viventiumCortexToolEvidence?.observeGrant(bundle.glasshive_capability_broker?.grant_id);
  return true;
}

module.exports = {
  attachConversationProviderBootstrapBundle,
  applyHostEvidenceBoundaryInstructions,
  applyCapabilityBrokerUnavailableInstructions,
  attachDeclaredConversationProviderCapabilityBundle,
  attachConversationProviderCapabilityBundle,
  bindConversationProviderDeveloperInstructionTail,
  bindHarnessCancellation,
  buildHarnessAgentIdempotencyKeys,
  buildHarnessAttemptIdempotencyKey,
  configuredBrokerHostTools,
  configuredConversationOrchestrationWorkerRoute,
  buildHarnessIdempotencyKey,
  declaredMcpServerNames,
  installConversationProviderCapabilityRefresher,
  resolveHostToolCapabilityState,
  resolvedHostToolNames,
  resolvedConversationOrchestrationToolNames,
  resolvedHostToolResources,
  resolveConversationProviderId,
  setConversationProviderCapability,
};
