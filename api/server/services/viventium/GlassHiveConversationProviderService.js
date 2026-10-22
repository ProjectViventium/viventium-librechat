const { VOICE_TASK_TOOL_NAME, voiceTaskBrokerResources } = require('./VoiceTaskManagementTool');
const { configuredBackgroundWorkerRoute } = require('@librechat/api');
/* === VIVENTIUM START ===
 * Feature: GlassHive core-provider capability projection
 * Purpose: Attach a signed, Agent-declared MCP broker bundle to an authenticated harness request
 * without exposing provider credentials or GlassHive self-delegation.
 * === VIVENTIUM END === */

const { Constants, extractEnvVariable } = require('librechat-data-provider');
const crypto = require('crypto');
/* === VIVENTIUM START === Passive current-attempt capability timing. === */
const { voiceLatencyNow, logVoiceLatencyNumericStage } = require('./voiceLatencyTiming');
/* === VIVENTIUM END === */
const {
  transcriptionAttachmentReferences,
  resolveSelectedHistoryAttachments,
} = require('@librechat/api');
const { getMessages, getFiles } = require('~/models');
const { logger } = require('@librechat/data-schemas');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
const { getEndpointsConfig } = require('~/server/services/Config/getEndpointsConfig');
const { isConversationOrchestrationTool } = require('./GlassHiveConversationOrchestration');
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
/* === VIVENTIUM START ===
 * Fix: A cortex attempt that reaches its execution deadline, or whose guard stops waiting for it,
 * is an owned cancellation of that exact native request, which must release its capacity before
 * its owner treats the attempt as ended.
 * === VIVENTIUM END === */
const CORTEX_ATTEMPT_DEADLINE_REASON = 'cortex_attempt_deadline';
const HARNESS_CANCELLATION_ABORT_REASONS = new Set([
  'user_cancelled',
  'superseded',
  'maintenance_yield',
  'compaction_lease_lost',
  CORTEX_ATTEMPT_DEADLINE_REASON,
]);
/* === VIVENTIUM START ===
 * Fix: An attempt that ends without its accepted result releases its exact native request before
 * any fallback or retry, even when nothing aborted it (a provider error, an empty result).
 * === VIVENTIUM END === */
const CORTEX_ATTEMPT_RELEASE_REASON = 'cortex_attempt_release';
const HARNESS_RELEASE_REASONS = new Set([
  'maintenance_yield',
  'compaction_lease_lost',
  CORTEX_ATTEMPT_DEADLINE_REASON,
  CORTEX_ATTEMPT_RELEASE_REASON,
]);
const restrictedVoiceCancellationRoutes = Symbol('restrictedVoiceCancellationRoutes');

/* === VIVENTIUM START ===
 * Feature: Owner Stop for a tool-less Voice reply.
 * Purpose: Capture only the server-validated native transport on this request. Speaker work
 * authority, executable keys and agent configs remain subject to the destructive sanitizer.
 */
async function prepareRestrictedVoiceCancellation({
  req,
  signal,
  endpointConfig,
  providerId,
  fallback = false,
  activate = true,
}) {
  if (!isVoiceActorSideEffectRestricted(req)) return false;
  const session = req.viventiumCallSession;
  const ownerId = String(req.user?.id || '').trim();
  const callSessionId = String(session?.callSessionId || '').trim();
  if (!session && !req.body?.viventiumCallSessionId && !req.body?.viventiumVoiceTaskId) {
    // Voice metadata narrows work authority even on an ordinary authenticated chat. Its
    // server-owned inference still belongs to the same generation job and Stop signal.
    const { GenerationJobManager } = require('@librechat/api');
    const streamId = String(req._resumableStreamId || '').trim();
    const capability = resolveConversationProviderCapability(req, String(providerId || ''));
    const job = streamId && (await GenerationJobManager.getJob(streamId));
    const jobCreatedAt = job?.createdAt;
    const conversationId = String(job?.metadata?.conversationId || '').trim();
    const ownsJob = (current) =>
      current?.createdAt === jobCreatedAt &&
      current?.metadata?.userId === ownerId &&
      current?.metadata?.conversationId === conversationId &&
      !current?.metadata?.viventiumCallSessionId &&
      !current?.metadata?.viventiumVoiceTaskId &&
      current?.metadata?.interactionContext?.actor_kind === 'external_user' &&
      current?.metadata?.interactionContext?.origin === 'interactive' &&
      current?.abortController?.signal === signal;
    if (
      !ownerId ||
      !conversationId ||
      !signal ||
      !job ||
      job.status !== 'running' ||
      !ownsJob(job) ||
      (req.body?.conversationId && req.body.conversationId !== conversationId) ||
      capability?.conversation_session !== true ||
      capability?.workspace_binding !== true
    )
      return false;
    let responseId = '';
    const currentScope = async () => {
      const current = await GenerationJobManager.getJob(streamId);
      if (
        String(req.user?.id || '') !== ownerId ||
        req._resumableStreamId !== streamId ||
        !ownsJob(current) ||
        ['complete', 'error', 'superseded'].includes(current.status)
      )
        return null;
      const key = String(current.metadata?.responseMessageId || '').trim();
      if (!key || (responseId && key !== responseId)) return null;
      responseId = key;
      return { responseId };
    };
    const routes = req[restrictedVoiceCancellationRoutes] || {};
    if (!req[restrictedVoiceCancellationRoutes])
      Object.defineProperty(req, restrictedVoiceCancellationRoutes, {
        value: routes,
        enumerable: false,
      });
    routes[fallback ? 'fallback' : 'primary'] = Object.freeze({
      native: true,
      chat: true,
      bindingKey: Symbol('restrictedChatCancellationBinding'),
      request: req,
      signal,
      endpointConfig: Object.freeze({
        baseURL: endpointConfig?.baseURL,
        apiKey: endpointConfig?.apiKey,
      }),
      ownerId,
      streamId,
      currentScope,
    });
    return activate ? bindHarnessCancellation({ req, signal }) : true;
  }
  if (
    req.body?.voiceMode !== true ||
    !ownerId ||
    !callSessionId ||
    String(session?.userId || '') !== ownerId
  )
    return false;
  const tasks = require('./VoiceTaskService');
  const task = tasks
    .listVoiceTasks({ userId: ownerId, callSessionId })
    .find((item) => item.taskId === req.body.viventiumVoiceTaskId);
  const streamId = String(req._resumableStreamId || '').trim();
  if (
    !task ||
    task.streamId !== streamId ||
    task.owner?.id !== streamId ||
    !['generation_job', 'remote_generation'].includes(task.owner?.kind)
  )
    return false;
  const capability = resolveConversationProviderCapability(req, String(providerId || ''));
  const native =
    capability?.conversation_session === true && capability?.workspace_binding === true;
  const role = fallback ? 'fallback' : 'primary';
  const routes = req[restrictedVoiceCancellationRoutes] || {};
  if (!req[restrictedVoiceCancellationRoutes])
    Object.defineProperty(req, restrictedVoiceCancellationRoutes, {
      value: routes,
      enumerable: false,
    });
  if (!native) {
    routes[role] = Object.freeze({
      native: false,
      ownerId,
      callSessionId,
      taskId: task.taskId,
      streamId,
    });
    return activate ? bindHarnessCancellation({ req, signal }) : false;
  }
  // A missing transport or late response identity must never become a local-only confirmation.
  if (activate)
    tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      ownerId: streamId,
      cancellationConfirmable: false,
    });
  const { GenerationJobManager } = require('@librechat/api');
  const job = await GenerationJobManager.getJob(streamId);
  const jobCreatedAt = job?.createdAt;
  const ownsJob = (current) =>
    current?.createdAt === jobCreatedAt &&
    current?.metadata?.userId === ownerId &&
    current?.metadata?.viventiumCallSessionId === callSessionId &&
    current?.metadata?.viventiumVoiceTaskId === task.taskId;
  if (!job || !ownsJob(job) || !signal || job.abortController?.signal !== signal) return false;
  let responseId = '';
  let stopCompletion;
  const beginStop = () => {
    let settle;
    stopCompletion = new Promise((resolve) => {
      settle = resolve;
    });
    return settle;
  };
  const currentScope = async () => {
    // The ordinary manager may retire the exact job before returning from Stop. Wait for
    // that server result before the listener reads the store; failed Stop remains closed.
    const stopped = stopCompletion ? await stopCompletion : null;
    if (stopCompletion && stopped?.success !== true) return null;
    const current = tasks
      .listVoiceTasks({ userId: ownerId, callSessionId })
      .find((item) => item.taskId === task.taskId);
    if (
      current?.createdAt !== task.createdAt ||
      current?.streamId !== streamId ||
      current?.owner?.id !== streamId ||
      !['generation_job', 'remote_generation'].includes(current?.owner?.kind) ||
      ['completed', 'failed'].includes(current?.state)
    )
      return null;
    const call = await require('./CallSessionService').getCallSession(callSessionId);
    // Hangup ends presentation, not the owner's authority to Stop this exact accepted reply.
    if (call?.callSessionId !== callSessionId || String(call?.userId || '') !== ownerId)
      return null;
    const currentJob = await GenerationJobManager.getJob(streamId);
    let key;
    if (currentJob) {
      if (!ownsJob(currentJob) || currentJob.abortController?.signal !== signal) return null;
      key = String(currentJob.metadata?.responseMessageId || '').trim();
    } else {
      const retired = stopped?.jobData;
      if (
        !retired ||
        !signal.aborted ||
        signal.reason !== 'user_cancelled' ||
        retired.createdAt !== jobCreatedAt ||
        retired.streamId !== streamId ||
        retired.userId !== ownerId ||
        retired.viventiumCallSessionId !== callSessionId ||
        retired.viventiumVoiceTaskId !== task.taskId ||
        !responseId ||
        retired.responseMessageId !== responseId
      )
        return null;
      key = responseId;
    }
    if (responseId && key !== responseId) return null;
    if (key) responseId = key;
    return { task: current, responseId };
  };
  routes[role] = Object.freeze({
    native: true,
    bindingKey: Symbol('restrictedVoiceCancellationBinding'),
    endpointConfig: Object.freeze({
      baseURL: endpointConfig?.baseURL,
      apiKey: endpointConfig?.apiKey,
    }),
    ownerId,
    callSessionId,
    taskId: task.taskId,
    streamId,
    currentScope,
    beginStop,
  });
  return activate ? bindHarnessCancellation({ req, signal }) : true;
}
/* === VIVENTIUM END === */

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
  includeRequestState = false,
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
    let responseTimeoutS = null;
    if (response?.ok && requireCapacityRelease) {
      let body = null;
      try {
        body = await response.json();
      } catch (_) {
        body = null;
      }
      const reportedTimeoutS = Number(body?.responseTimeoutS);
      responseTimeoutS =
        Number.isFinite(reportedTimeoutS) && reportedTimeoutS > 0 ? reportedTimeoutS : null;
      if (body?.capacityReleased === true) {
        return {
          acknowledged: true,
          capacityReleased: true,
          responseTimeoutS,
          ...(includeRequestState ? { state: body?.state } : {}),
        };
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
      const deliveryError = buildHarnessCancellationDeliveryError({ attempts, status: lastStatus });
      if (capacityReleasePending) {
        deliveryError.capacityReleasePending = true;
        deliveryError.responseTimeoutS = responseTimeoutS;
      }
      throw deliveryError;
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

/* === VIVENTIUM START ===
 * Feature: Release acknowledgement for a superseded Main family.
 * Purpose: The current revision may take the native conversation only after the exact
 * owner-scoped family of a superseded Main operation is stopped and GlassHive acknowledges that
 * every request and run in it is terminal with no retained lease. One idempotent Stop per probe.
 * The evidence also carries GlassHive's effective response timeout, the owner of the deadline.
 * An unreachable or unconfirmed host is never reported as released.
 * === VIVENTIUM END === */
async function probeHarnessFamilyRelease({
  baseURL,
  apiKey,
  ownerId,
  messageId,
  fetchImpl = globalThis.fetch,
}) {
  const releaseBaseURL = String(baseURL || '').replace(/\/$/, '');
  const releaseOwnerId = String(ownerId || '').trim();
  // Restricted turns omit native idempotency headers. Native then owns the exact bare
  // response-id family; it must release as well as the two explicit attempt families.
  const responseId = String(messageId || '').trim();
  const keys = responseId
    ? [
        ...['main', 'main-fallback'].map((role) => buildHarnessIdempotencyKey(role, responseId)),
        responseId,
      ]
    : [];
  let responseTimeoutS = null;
  if (
    !releaseBaseURL ||
    !apiKey ||
    !releaseOwnerId ||
    keys.length === 0 ||
    typeof fetchImpl !== 'function'
  ) {
    return { released: false, reachable: false, responseTimeoutS };
  }
  for (const key of keys) {
    try {
      const outcome = await deliverHarnessCancellation({
        url: `${releaseBaseURL}/requests/by-idempotency/${encodeURIComponent(key)}/cancel`,
        headers: { Authorization: `Bearer ${apiKey}`, 'X-Viventium-User-Id': releaseOwnerId },
        fetchImpl,
        requireCapacityRelease: true,
        retryDelaysMs: [],
      });
      responseTimeoutS = outcome?.responseTimeoutS ?? responseTimeoutS;
      if (outcome?.capacityReleased !== true) {
        return { released: false, reachable: true, responseTimeoutS };
      }
    } catch (error) {
      const pending = error?.capacityReleasePending === true;
      return {
        released: false,
        reachable: pending,
        responseTimeoutS: (pending ? error.responseTimeoutS : null) ?? responseTimeoutS,
      };
    }
  }
  return { released: true, reachable: true, responseTimeoutS };
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

function restrictedConversationProviderBootstrapHeaders({
  privateStructuredResponse = false,
} = {}) {
  if (typeof privateStructuredResponse !== 'boolean') {
    throw new TypeError('privateStructuredResponse must be a boolean');
  }
  const encodedBundle = Buffer.from(
    JSON.stringify({
      provider_capabilities: {
        native_tools: false,
        ...(privateStructuredResponse
          ? {
              response_contract: {
                version: 1,
                visibility: 'private_machine_state',
                format: 'json_object',
              },
            }
          : {}),
      },
    }),
    'utf8',
  ).toString('base64');
  const issuedAt = String(Math.floor(Date.now() / 1000));
  return {
    'X-GlassHive-Bootstrap-Bundle-B64': encodedBundle,
    'X-GlassHive-Bootstrap-Timestamp': issuedAt,
    'X-GlassHive-Bootstrap-Signature': signBootstrapBundle(encodedBundle, issuedAt),
  };
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

function resolveConversationProviderCapability(req, agentOrProvider) {
  const providerId =
    typeof agentOrProvider === 'string'
      ? String(agentOrProvider || '').trim()
      : resolveConversationProviderId(agentOrProvider);
  return req?.config?.endpoints?.agents?.providerCapabilities?.[providerId];
}

function conversationProviderUsesInvocationLocalTime(req, agentOrProvider) {
  return (
    resolveConversationProviderCapability(req, agentOrProvider)?.time_context_delivery ===
    'per_turn_header'
  );
}

/** Select the declared native body courier; header-only and mixed attempts keep legacy bounds. */
function conversationProviderUsesNativeBody(
  req,
  agent,
  { alternates = [], requireTransport = false } = {},
) {
  const routes = [agent, ...alternates].filter(Boolean);
  if (
    !routes.length ||
    routes.some((route) => {
      const capability = resolveConversationProviderCapability(req, route);
      return (
        capability?.context_protocol !== 'main_context_v1' ||
        capability?.native_session_authority !== 'stable_authority_v1' ||
        capability?.time_context_delivery !== 'per_turn_header' ||
        capability?.usage_accounting_scope !== 'visible_message_local' ||
        capability?.workspace_binding !== true
      );
    })
  )
    return false;
  if (!requireTransport) return true;
  return routes.every((route) =>
    Boolean(route?.model_parameters?.configuration?.defaultHeaders?.['X-GlassHive-Agent-Id']),
  );
}

/** Same selected-file read for early admission sizing and the signed invocation projection. */
function resolveConversationProviderHistoryAttachments(req, requestBody = req?.body) {
  const body = projectTrustedClientPresentation(requestBody, req);
  return resolveSelectedHistoryAttachments(
    {
      userId: String(req?.user?.id || req?.user?._id || ''),
      conversationId: body?.conversationId,
      parentMessageId: body?.parentMessageId,
    },
    { getMessages, getFiles },
    undefined,
    req,
  );
}

/** Exact current-source precedence and selected ancestry for both sizing and signed invocation. */
async function resolveConversationProviderUploadedFiles(
  req,
  requestBody = req?.body,
  { includeHistory = true } = {},
) {
  const trustedRequestBody = projectTrustedClientPresentation(requestBody, req);
  const currentUploads = trustedUploadedFilesFromRequestBody(trustedRequestBody);
  const historyUploads = includeHistory
    ? await resolveConversationProviderHistoryAttachments(req, trustedRequestBody)
    : [];
  // Fill missing bodies only from the same owned selected source; current text and order prevail.
  const historyById = new Map(historyUploads.map((file) => [file.file_id, file]));
  const hydratedCurrent = currentUploads.map((file) => {
    const history = file.file_id && historyById.get(file.file_id);
    return file.text === undefined &&
      file.source &&
      file.source === history?.source &&
      typeof history.text === 'string'
      ? { ...file, text: history.text }
      : file;
  });
  const currentUploadKeys = new Set(currentUploads.map((file) => file.file_id || file.filename));
  return Array.from(
    new Map(
      trustedUploadedFilesFromRequestBody({
        files: [
          ...hydratedCurrent,
          ...historyUploads.filter((file) => !currentUploadKeys.has(file.file_id || file.filename)),
        ],
      }).map((file) => [file.file_id || file.filename, file]),
    ).values(),
  );
}

function conversationProviderUsesLocalVisibleAccounting(req, agentOrProvider) {
  return (
    resolveConversationProviderCapability(req, agentOrProvider)?.usage_accounting_scope ===
    'visible_message_local'
  );
}

function resolveConversationProviderContextProtocol(req, agentOrProvider) {
  return resolveConversationProviderCapability(req, agentOrProvider)?.context_protocol || 'legacy';
}

function setConversationProviderCapability(req, provider) {
  const providerId = String(provider || '').trim();
  const capability = resolveConversationProviderCapability(req, providerId);
  if (!req || typeof req !== 'object') {
    return capability;
  }
  if (isVoiceActorSideEffectRestricted(req)) {
    enforceRestrictedVoiceRequest(req);
    return capability;
  }
  req.viventiumTimeContextDelivery = conversationProviderUsesInvocationLocalTime(req, providerId)
    ? 'per_turn_header'
    : 'developer';
  req.viventiumUsageAccountingScope = capability?.usage_accounting_scope || 'provider_request';
  req.viventiumContextProtocol = capability?.context_protocol || 'legacy';
  req.viventiumNativeSessionAuthority = capability?.native_session_authority || 'none';
  req.viventiumReplayProtocol = capability?.replay_protocol || 'legacy_message_count';
  req._viventiumHarnessActivityEnabled = capability?.activity_stream === true;
  req._viventiumHarnessExecutionEnabled = capability?.workspace_binding === true;
  if (req._viventiumHarnessExecutionEnabled !== true) {
    req._viventiumHarnessCancellationActiveBaseURL = '';
  }
  return capability;
}

function canonicalStableAuthorityValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => canonicalStableAuthorityValue(item))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined && typeof value[key] !== 'function')
        .map((key) => [key, canonicalStableAuthorityValue(value[key])]),
    );
  }
  return value;
}

function conversationProviderStableAuthorityDescriptor(agent) {
  const modelParameters =
    agent?.model_parameters && typeof agent.model_parameters === 'object'
      ? { ...agent.model_parameters }
      : {};
  delete modelParameters.configuration;
  return canonicalStableAuthorityValue({
    version: 2,
    agentId: String(agent?.id || ''),
    provider: String(agent?.provider || ''),
    model: String(agent?.model || modelParameters.model || ''),
    modelParameters,
    instructions: String(agent?.instructions || '').trim(),
    additionalInstructions: String(agent?.additional_instructions || '').trim(),
    artifacts: agent?.artifacts || '',
    tools: agent?.tools || [],
    mcp: agent?.mcp || [],
    toolOptions: agent?.tool_options || {},
    toolResources: agent?.tool_resources || {},
    agentIds: agent?.agent_ids || [],
    edges: agent?.edges || [],
    backgroundCortices: agent?.background_cortices || [],
    glassHiveOptions: agent?.glasshive_options || {},
    fallbackProvider: String(agent?.fallback_llm_provider || ''),
    fallbackModel: String(agent?.fallback_llm_model || ''),
    fallbackModelParameters: agent?.fallback_llm_model_parameters || {},
  });
}

function conversationProviderStableAuthorityDigest(agent) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(conversationProviderStableAuthorityDescriptor(agent)), 'utf8')
    .digest('hex');
}

function bindConversationProviderStableAuthorityDigest(targetAgent, stableAuthoritySha256) {
  const digest = String(stableAuthoritySha256 || '')
    .trim()
    .toLowerCase();
  const modelParameters = targetAgent?.model_parameters;
  const configuration = modelParameters?.configuration;
  const currentHeaders = configuration?.defaultHeaders;
  if (
    !/^[a-f0-9]{64}$/.test(digest) ||
    !currentHeaders ||
    typeof currentHeaders !== 'object' ||
    !Object.prototype.hasOwnProperty.call(currentHeaders, 'X-GlassHive-Agent-Id')
  ) {
    return false;
  }
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: {
      ...configuration,
      defaultHeaders: {
        ...currentHeaders,
        'X-GlassHive-Stable-Authority-SHA256': digest,
      },
    },
  };
  return true;
}

function captureConversationProviderStableAuthority(targetAgent) {
  const currentHeaders = targetAgent?.model_parameters?.configuration?.defaultHeaders;
  if (
    !currentHeaders ||
    typeof currentHeaders !== 'object' ||
    !Object.prototype.hasOwnProperty.call(currentHeaders, 'X-GlassHive-Agent-Id')
  ) {
    return false;
  }
  const existingDigest = String(currentHeaders['X-GlassHive-Stable-Authority-SHA256'] || '')
    .trim()
    .toLowerCase();
  return bindConversationProviderStableAuthorityDigest(
    targetAgent,
    /^[a-f0-9]{64}$/.test(existingDigest)
      ? existingDigest
      : conversationProviderStableAuthorityDigest(targetAgent),
  );
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
  const restricted = isVoiceActorSideEffectRestricted(req);
  const readOnlyRoute = restricted
    ? req?.[restrictedVoiceCancellationRoutes]?.[
        req._viventiumFallbackLlmAttempt === true ? 'fallback' : 'primary'
      ]
    : null;
  if (restricted && !readOnlyRoute) {
    if (!req._viventiumCortexToolEvidence && req?.[restrictedVoiceCancellationRoutes])
      req[restrictedVoiceCancellationRoutes].active = null;
    return false;
  }
  if (
    readOnlyRoute?.chat &&
    (readOnlyRoute.request !== req ||
      readOnlyRoute.signal !== signal ||
      readOnlyRoute.ownerId !== String(req.user?.id || '') ||
      readOnlyRoute.streamId !== req._resumableStreamId)
  )
    return false;
  if (
    readOnlyRoute &&
    !readOnlyRoute.chat &&
    (readOnlyRoute.ownerId !== String(req.user?.id || '') ||
      readOnlyRoute.callSessionId !== req.viventiumCallSession?.callSessionId ||
      readOnlyRoute.ownerId !== String(req.viventiumCallSession?.userId || '') ||
      readOnlyRoute.taskId !== req.body?.viventiumVoiceTaskId ||
      readOnlyRoute.streamId !== req._resumableStreamId)
  )
    return false;
  if (readOnlyRoute?.native === false) {
    if (req._viventiumCortexToolEvidence) return false;
    const tasks = require('./VoiceTaskService');
    if (tasks.isVoiceTaskSuppressed(readOnlyRoute.taskId)) return false;
    req[restrictedVoiceCancellationRoutes].active = null;
    const directTask = tasks.setVoiceTaskOwnerCapabilities(readOnlyRoute.taskId, {
      kind: 'generation_job',
      ownerId: readOnlyRoute.streamId,
      cancellationConfirmable: true,
    });
    if (directTask?.owner?.kind === 'generation_job') {
      tasks.registerVoiceTaskOwnerAdapter(readOnlyRoute.taskId, { kind: 'generation_job' });
    }
    return false;
  }
  if (readOnlyRoute) endpointConfig = readOnlyRoute.endpointConfig;
  const hasGraphHarnessKeys =
    (req?._viventiumHarnessIdempotencyKeys instanceof Set &&
      req._viventiumHarnessIdempotencyKeys.size > 0) ||
    (Array.isArray(req?._viventiumHarnessIdempotencyKeys) &&
      req._viventiumHarnessIdempotencyKeys.length > 0);
  if (
    (!readOnlyRoute && req?._viventiumHarnessExecutionEnabled !== true && !hasGraphHarnessKeys) ||
    !signal
  ) {
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
  if (readOnlyRoute && cancelOwnerId !== readOnlyRoute.ownerId) return false;
  let stopDiagnosticOwner = null;
  // Stop diagnostics expose only structural checks; observing must never change delivery.
  const observeVoiceStop = (stage, checks = {}) => {
    if (req.body?.voiceMode !== true && !req.body?.viventiumVoiceTaskId) return;
    try {
      const decision = {
        stage,
        ...(stopDiagnosticOwner || {}),
        restrictedRoute: Boolean(readOnlyRoute),
        voiceMode: req.body?.voiceMode === true,
        workAuthorityPresent: Boolean(req.viventiumVoiceWorkAuthority),
        workAuthorityOwn: Object.prototype.hasOwnProperty.call(req, 'viventiumVoiceWorkAuthority'),
        cortexAttempt: Boolean(req._viventiumCortexToolEvidence),
        signalAborted: signal.aborted,
        signalAbortReason: !signal.aborted
          ? null
          : HARNESS_CANCELLATION_ABORT_REASONS.has(signal.reason) ||
              HARNESS_RELEASE_REASONS.has(signal.reason)
            ? signal.reason
            : 'other',
        activeBinding: req._viventiumHarnessCancellationActiveBaseURL === cancelBaseURL,
        boundListener:
          req._viventiumHarnessCancellationBoundBaseURLs instanceof Set &&
          req._viventiumHarnessCancellationBoundBaseURLs.has(
            readOnlyRoute?.bindingKey || cancelBaseURL,
          ),
        ...checks,
      };
      logger.debug('[GlassHiveProvider] Voice Stop confirmation', decision);
      if (
        checks.failedCheck ||
        [
          'abort_started',
          'confirmation_checks',
          'confirmation_saved',
          'already_completed',
          'delivery_settled',
          'failed_attention_confirmed',
        ].includes(stage)
      ) {
        logger.info(`[GlassHiveProvider] Voice Stop decision ${JSON.stringify(decision)}`);
      }
    } catch (_) {
      // A diagnostic observer cannot accept, reject or interrupt Stop.
    }
  };
  if (readOnlyRoute && !req._viventiumCortexToolEvidence) {
    req[restrictedVoiceCancellationRoutes].active = readOnlyRoute;
    if (!readOnlyRoute.chat) {
      require('./VoiceTaskService').setVoiceTaskOwnerCapabilities(readOnlyRoute.taskId, {
        kind: 'remote_generation',
        ownerId: readOnlyRoute.streamId,
        cancellationConfirmable: false,
      });
    }
  }
  // Foreground native input uses the same authenticated owner and exact response key as Stop.
  // Cortices keep their attempt transport; Main owns foreground task Stop and input.
  if (
    !req._viventiumCortexToolEvidence &&
    req.body?.voiceMode === true &&
    (req.viventiumVoiceWorkAuthority || readOnlyRoute) &&
    req.body?.viventiumVoiceTaskId
  ) {
    const {
      listVoiceTasks,
      getVoiceTask,
      registerVoiceTaskOwnerAdapter,
      observeGenerationEvent,
      confirmVoiceTaskOwnerCancellation,
    } = require('./VoiceTaskService');
    const taskId = req.body.viventiumVoiceTaskId;
    const authority = req.viventiumVoiceWorkAuthority || readOnlyRoute;
    const ownsTask = () => {
      const task = listVoiceTasks({
        userId: cancelOwnerId,
        callSessionId: authority.callSessionId,
      }).find((item) => item.taskId === taskId);
      return (
        task?.callSessionId === authority.callSessionId &&
        ['generation_job', 'remote_generation'].includes(task.owner?.kind) &&
        !['completed', 'failed', 'cancelled_confirmed', 'cancelled_unenforceable'].includes(
          task.state,
        )
      );
    };
    if (ownsTask()) {
      const boundTask = listVoiceTasks({
        userId: cancelOwnerId,
        callSessionId: authority.callSessionId,
      }).find((item) => item.taskId === taskId);
      const owner = boundTask.owner;
      stopDiagnosticOwner = Object.freeze({
        scopeSha256: crypto
          .createHash('sha256')
          .update(JSON.stringify([boundTask.taskId, boundTask.streamId, boundTask.callSessionId]))
          .digest('hex'),
      });
      const failedAttentionKey =
        String(req._viventiumHarnessIdempotencyKey || '').trim() ||
        buildHarnessAttemptIdempotencyKey(req, req.body?.responseMessageId);
      const currentOwnerTask = () => {
        const current = getVoiceTask(taskId);
        const checks = {
          taskPresent: Boolean(current),
          taskCreatedAtMatches: current?.createdAt === boundTask.createdAt,
          taskCallMatches: current?.callSessionId === boundTask.callSessionId,
          authorityCallMatches: authority.callSessionId === boundTask.callSessionId,
          foregroundOwnerKind: ['generation_job', 'remote_generation'].includes(
            current?.owner?.kind,
          ),
          ownerIdMatches: current?.owner?.id === owner.id,
          streamIdMatches: current?.streamId === owner.id,
          taskStateEligible: Boolean(current) && !['completed', 'failed'].includes(current.state),
        };
        if (Object.values(checks).every((matched) => matched === true)) return current;
        observeVoiceStop('owner_guard', { ...checks, failedCheck: 'owner_current' });
        return null;
      };
      registerVoiceTaskOwnerAdapter(taskId, {
        kind: owner.kind,
        preserveExisting: true,
        cancelFailedProviderAttention: Boolean(readOnlyRoute || failedAttentionKey),
        cancel: async ({ failedProviderCode } = {}) => {
          let stage = 'owner_before_abort';
          try {
            const current = currentOwnerTask();
            if (!current) {
              observeVoiceStop(stage, { failedCheck: 'owner_current' });
              return { accepted: false };
            }
            stage = 'scope_before_abort';
            if (readOnlyRoute && !(await readOnlyRoute.currentScope())) {
              observeVoiceStop(stage, { failedCheck: 'scope_current' });
              return { accepted: false };
            }
            if (failedProviderCode === 'provider_progress_stalled') {
              stage = 'failed_attention_release';
              const scope = readOnlyRoute ? await readOnlyRoute.currentScope() : null;
              const key = readOnlyRoute ? scope?.responseId : failedAttentionKey;
              if (
                !key ||
                (!readOnlyRoute && req._viventiumHarnessCancellationActiveBaseURL !== cancelBaseURL)
              ) {
                observeVoiceStop(stage, { failedCheck: 'exact_request' });
                return { accepted: false };
              }
              const outcome = await deliverHarnessCancellation({
                url: `${cancelBaseURL}/requests/by-idempotency/${encodeURIComponent(key)}/cancel`,
                headers: {
                  Authorization: `Bearer ${cancelApiKey}`,
                  'X-Viventium-User-Id': cancelOwnerId,
                },
                fetchImpl,
                requireCapacityRelease: true,
                includeRequestState: true,
                attemptTimeoutMs: MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
                retryDelaysMs: MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
                totalTimeoutMs: MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
              });
              if (!currentOwnerTask() || (readOnlyRoute && !(await readOnlyRoute.currentScope())))
                return { accepted: false };
              if (outcome.state === 'completed') return { alreadyCompleted: true };
              if (outcome.acknowledged !== true || outcome.capacityReleased !== true)
                return { accepted: false };
              const confirmation = await confirmVoiceTaskOwnerCancellation(
                taskId,
                'The native owner confirmed Stop.',
              );
              observeVoiceStop('failed_attention_confirmed', { accepted: Boolean(confirmation) });
              return { accepted: Boolean(confirmation) };
            }
            const { GenerationJobManager } = require('@librechat/api');
            const priorDelivery = req._viventiumHarnessCancellationDeliveryPromise;
            observeVoiceStop('abort_started', { priorDeliveryPresent: Boolean(priorDelivery) });
            const settleStop = readOnlyRoute?.beginStop();
            let stopped;
            stage = 'abort_job';
            try {
              stopped = await GenerationJobManager.abortJob(
                current.streamId,
                'user_cancelled',
                cancelOwnerId,
              );
            } finally {
              settleStop?.(stopped);
            }
            stage = 'owner_after_abort';
            if (!currentOwnerTask()) {
              observeVoiceStop(stage, {
                failedCheck: 'owner_current',
                localStopSucceeded: stopped?.success === true,
              });
              return { accepted: false };
            }
            stage = 'scope_after_abort';
            if (
              readOnlyRoute &&
              !['committed', 'pending'].includes(stopped?.nativeResponse) &&
              !(await readOnlyRoute.currentScope())
            ) {
              observeVoiceStop(stage, {
                failedCheck: 'scope_current',
                localStopSucceeded: stopped?.success === true,
              });
              return { accepted: false };
            }
            if (['committed', 'pending'].includes(stopped?.nativeResponse)) {
              observeVoiceStop('already_completed');
              return { alreadyCompleted: true };
            }
            stage = 'delivery';
            const delivery = await req._viventiumHarnessCancellationDeliveryPromise;
            stage = 'scope_after_delivery';
            const readOnlyScopeCurrent =
              !readOnlyRoute || Boolean(await readOnlyRoute.currentScope());
            let ownerCurrent = null;
            const confirmed =
              stopped?.success === true &&
              req._viventiumHarnessCancellationDeliveryPromise !== priorDelivery &&
              delivery?.acknowledged === true &&
              Array.isArray(delivery.outcomes) &&
              delivery.outcomes.length > 0 &&
              delivery.outcomes.every((outcome) => outcome?.capacityReleased === true) &&
              (ownerCurrent = Boolean(currentOwnerTask())) &&
              readOnlyScopeCurrent;
            const checks = {
              localStopSucceeded: stopped?.success === true,
              nativeResponseState: ['committed', 'pending', 'unavailable'].includes(
                stopped?.nativeResponse,
              )
                ? stopped.nativeResponse
                : null,
              freshDelivery: req._viventiumHarnessCancellationDeliveryPromise !== priorDelivery,
              deliveryAcknowledged: delivery?.acknowledged === true,
              outcomesPresent: Array.isArray(delivery?.outcomes),
              familyCount: Array.isArray(delivery?.outcomes) ? delivery.outcomes.length : 0,
              releasedFamilyCount: Array.isArray(delivery?.outcomes)
                ? delivery.outcomes.filter((outcome) => outcome?.capacityReleased === true).length
                : 0,
              ownerCurrent,
              scopeCurrent: readOnlyScopeCurrent,
              confirmed,
            };
            const failedCheck = !checks.localStopSucceeded
              ? 'local_stop'
              : !checks.freshDelivery
                ? 'fresh_delivery'
                : !checks.deliveryAcknowledged
                  ? 'delivery_acknowledged'
                  : !checks.outcomesPresent
                    ? 'outcomes_present'
                    : checks.familyCount === 0
                      ? 'family_nonempty'
                      : checks.releasedFamilyCount !== checks.familyCount
                        ? 'families_released'
                        : ownerCurrent !== true
                          ? 'owner_current'
                          : !readOnlyScopeCurrent
                            ? 'scope_current'
                            : null;
            observeVoiceStop('confirmation_checks', { ...checks, failedCheck });
            if (!confirmed) return { accepted: false };
            stage = 'confirm_owner';
            const confirmation = await confirmVoiceTaskOwnerCancellation(
              taskId,
              'The native owner confirmed Stop.',
            );
            observeVoiceStop('confirmation_saved', { accepted: Boolean(confirmation) });
            return { accepted: Boolean(confirmation) };
          } catch (error) {
            observeVoiceStop(stage, { failedCheck: 'exception' });
            throw error;
          }
        },
      });
    }
    if (!readOnlyRoute && ownsTask() && !req._viventiumNativeVoiceInputPolling) {
      const {
        createNativeVoiceInputClient,
        nativeQuestionFormFromSchema,
      } = require('@librechat/api');
      const client = createNativeVoiceInputClient({
        baseURL: cancelBaseURL,
        apiKey: cancelApiKey,
        userId: cancelOwnerId,
        fetchImpl,
      });
      req._viventiumNativeVoiceInputPolling = client
        .poll({
          signal,
          key: () =>
            String(req._viventiumHarnessIdempotencyKey || '').trim() ||
            buildHarnessAttemptIdempotencyKey(req, req.body?.responseMessageId),
          isActive: ownsTask,
          onInput: (request, key) => {
            if (!ownsTask()) return;
            const owner = listVoiceTasks({
              userId: cancelOwnerId,
              callSessionId: authority.callSessionId,
            }).find((item) => item.taskId === taskId)?.owner;
            if (!owner) return;
            registerVoiceTaskOwnerAdapter(taskId, {
              kind: owner.kind,
              preserveExisting: true,
              inputExpiresAtMs: Date.parse(request.expiresAt),
              isNativeInputCurrent: async (metadata) => {
                const current = listVoiceTasks({
                  userId: cancelOwnerId,
                  callSessionId: authority.callSessionId,
                }).find((item) => item.taskId === taskId);
                if (
                  !ownsTask() ||
                  current?.owner?.kind !== owner.kind ||
                  current?.owner?.id !== owner.id ||
                  !['requestId', 'requestFingerprint', 'runId', 'attemptId', 'expiresAt'].every(
                    (field) => metadata?.[field] === request[field],
                  ) ||
                  metadata.kind !== (request.kind || 'permission')
                )
                  return false;
                return client.isCurrent(key, request);
              },
              provideInput: async ({ input }) => {
                const current = listVoiceTasks({
                  userId: cancelOwnerId,
                  callSessionId: authority.callSessionId,
                }).find((item) => item.taskId === taskId);
                if (
                  !ownsTask() ||
                  current?.owner?.kind !== owner.kind ||
                  current?.owner?.id !== owner.id
                )
                  throw new Error('voice_native_input_owner_changed');
                await require('./VoiceWorkAuthorityService').assertVoiceWorkAuthority(
                  authority,
                  cancelOwnerId,
                );
                return client.submit(key, request, input);
              },
            });
            observeGenerationEvent(taskId, {
              event: 'needs_input',
              data: {
                prompt: request.prompt,
                nativeInputRequest: {
                  version: 1,
                  kind: request.kind === 'question' ? 'question' : 'permission',
                  requestId: request.requestId,
                  requestFingerprint: request.requestFingerprint,
                  runId: request.runId,
                  attemptId: request.attemptId,
                  expiresAt: request.expiresAt,
                },
                ...(request.kind === 'question'
                  ? {
                      inputType: 'native_question',
                      questionForm: nativeQuestionFormFromSchema(request.requestedSchema),
                    }
                  : {
                      inputType: 'choice',
                      choices: request.choices,
                      ...(request.operationTitle !== undefined
                        ? { operationTitle: request.operationTitle }
                        : {}),
                    }),
              },
            });
          },
        })
        .catch((error) => {
          if (!signal.aborted) reportHarnessCancellationDeliveryError(onDeliveryError, error);
        });
    }
  }
  const boundBaseURLs =
    req._viventiumHarnessCancellationBoundBaseURLs instanceof Set
      ? req._viventiumHarnessCancellationBoundBaseURLs
      : new Set();
  req._viventiumHarnessCancellationBoundBaseURLs = boundBaseURLs;
  req._viventiumHarnessCancellationActiveBaseURL = cancelBaseURL;
  const bindingKey = readOnlyRoute?.bindingKey || cancelBaseURL;
  if (boundBaseURLs.has(bindingKey)) {
    return true;
  }
  boundBaseURLs.add(bindingKey);
  let restrictedChatDelivery;
  let restrictedChatDeliveryFailed = false;
  const deliverCancellation = (reason) => {
    if (readOnlyRoute) {
      if (
        reason !== 'user_cancelled' ||
        req[restrictedVoiceCancellationRoutes]?.active !== readOnlyRoute
      )
        return;
      req._viventiumHarnessCancellationDeliveryPromise = (async () => {
        const scope = await readOnlyRoute.currentScope();
        if (!scope?.responseId || req[restrictedVoiceCancellationRoutes]?.active !== readOnlyRoute)
          return { acknowledged: false, outcomes: [] };
        observeVoiceStop('delivery_started', { familyCount: 1, capacityRequired: true });
        const outcome = await deliverHarnessCancellation({
          url: `${cancelBaseURL}/requests/by-idempotency/${encodeURIComponent(scope.responseId)}/cancel`,
          headers: {
            Authorization: `Bearer ${cancelApiKey}`,
            'X-Viventium-User-Id': cancelOwnerId,
          },
          fetchImpl,
          requireCapacityRelease: true,
          attemptTimeoutMs: MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
          retryDelaysMs: MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
          totalTimeoutMs: MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
        });
        observeVoiceStop('delivery_settled', {
          familyCount: 1,
          releasedFamilyCount: Number(outcome?.capacityReleased === true),
          deliveryAcknowledged: outcome?.acknowledged === true,
        });
        return { acknowledged: outcome?.acknowledged === true, outcomes: [outcome] };
      })().catch((error) => {
        reportHarnessCancellationDeliveryError(onDeliveryError, error);
        return { acknowledged: false, outcomes: [] };
      });
      if (readOnlyRoute.chat) {
        // Reuse the manager's Stop-delivery seam so it cannot retire this exact job before
        // the native owner acknowledges capacity release. Restricted activity stays hidden.
        restrictedChatDeliveryFailed = false;
        restrictedChatDelivery = req._viventiumHarnessCancellationDeliveryPromise
          .then((delivery) => {
            if (
              delivery?.acknowledged !== true ||
              delivery.outcomes?.length !== 1 ||
              delivery.outcomes[0]?.capacityReleased !== true
            ) {
              throw Object.assign(new Error('Native cancellation could not be confirmed.'), {
                code: 'HARNESS_CANCELLATION_DELIVERY_FAILED',
              });
            }
            return { delivered: false };
          })
          .catch((error) => {
            restrictedChatDeliveryFailed = true;
            throw error;
          });
      }
      return req._viventiumHarnessCancellationDeliveryPromise;
    }
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
      !(HARNESS_CANCELLATION_ABORT_REASONS.has(reason) || HARNESS_RELEASE_REASONS.has(reason)) ||
      cancelIdempotencyKeys.length === 0 ||
      !cancelOwnerId ||
      typeof fetchImpl !== 'function'
    ) {
      return;
    }
    // Maintenance, an attempt deadline and an attempt release require native capacity release.
    const requireRelease =
      HARNESS_RELEASE_REASONS.has(reason) ||
      (reason === 'user_cancelled' &&
        req.body?.voiceMode === true &&
        Boolean(req.viventiumVoiceWorkAuthority));
    observeVoiceStop('delivery_started', {
      familyCount: cancelIdempotencyKeys.length,
      capacityRequired: requireRelease,
    });
    const deliveries = cancelIdempotencyKeys.map(async (cancelIdempotencyKey) => {
      try {
        return await deliverHarnessCancellation({
          url: `${cancelBaseURL}/requests/by-idempotency/${encodeURIComponent(cancelIdempotencyKey)}/cancel`,
          headers: {
            Authorization: `Bearer ${cancelApiKey}`,
            'X-Viventium-User-Id': cancelOwnerId,
          },
          fetchImpl,
          ...(requireRelease
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
    req._viventiumHarnessCancellationDeliveryPromise = Promise.all(deliveries).then((outcomes) => {
      const acknowledged = outcomes.every((outcome) => outcome?.acknowledged === true);
      observeVoiceStop('delivery_settled', {
        familyCount: outcomes.length,
        releasedFamilyCount: outcomes.filter((outcome) => outcome?.capacityReleased === true)
          .length,
        deliveryAcknowledged: acknowledged,
      });
      return { acknowledged, outcomes };
    });
    return req._viventiumHarnessCancellationDeliveryPromise;
  };
  // The attempt boundary's own release: the same exact keys, owner and capacity-release answer.
  req._viventiumHarnessReleaseAttempt = () => deliverCancellation(CORTEX_ATTEMPT_RELEASE_REASON);
  if (readOnlyRoute?.chat) {
    Object.defineProperty(signal, '_viventiumHarnessCancellationDelivery', {
      configurable: true,
      get() {
        // A failed native ACK leaves the exact job retained. A fresh owner Stop may retry
        // its same sealed transport even though the local AbortSignal is already stopped.
        if (
          signal.aborted &&
          signal.reason === 'user_cancelled' &&
          (!restrictedChatDelivery || restrictedChatDeliveryFailed)
        ) {
          deliverCancellation('user_cancelled');
        }
        return restrictedChatDelivery;
      },
    });
  }
  if (signal.aborted) deliverCancellation(signal.reason);
  else signal.addEventListener('abort', () => deliverCancellation(signal.reason), { once: true });
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
const BOOTSTRAP_HEADER_NAMES_LOWERCASE = new Set(
  BOOTSTRAP_HEADER_NAMES.map((headerName) => headerName.toLowerCase()),
);

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
  for (const headerName of Object.keys(defaultHeaders)) {
    if (BOOTSTRAP_HEADER_NAMES_LOWERCASE.has(headerName.toLowerCase())) {
      delete defaultHeaders[headerName];
    }
  }
  targetAgent.model_parameters = {
    ...modelParameters,
    configuration: { ...configuration, defaultHeaders },
  };
}

function clearConversationProviderCapabilityBundle(targetAgent) {
  removeBootstrapBundleHeaders(targetAgent);
  setConversationProviderInstructionAppend(targetAgent, '');
  return targetAgent;
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
  mcpCapabilitySourceAgent,
  req,
  capability,
  requestBody = req?.body || {},
  nativeTools,
  privateStructuredResponse = false,
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
    const startedAt = req?.viventiumVoiceLogLatency === true ? voiceLatencyNow() : null;
    let outcome = 'failed';
    try {
      const attached = await attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        capabilitySourceAgent,
        mcpCapabilitySourceAgent,
        req,
        capability: resolvedCapability,
        requestBody: effectiveRequestBody,
        nativeTools,
        ...(privateStructuredResponse ? { privateStructuredResponse: true } : {}),
      });
      if (!attached) {
        // Never leave a previously valid but now expired bundle on the next provider attempt.
        removeBootstrapBundleHeaders(targetAgent);
      }
      outcome = 'completed';
      return capabilityRefreshResult(targetAgent, attached, previousInstructionAppend);
    } finally {
      if (startedAt != null) {
        try {
          const requestHash = crypto
            .createHash('sha256')
            .update(String(req.viventiumVoiceRequestId || 'unknown'))
            .digest('hex');
          const participantHash = crypto
            .createHash('sha256')
            .update(String(targetAgent.id || 'unknown'))
            .digest('hex');
          logVoiceLatencyNumericStage(
            logger,
            req,
            `conversation_provider:${participantHash}`,
            `capability_refresh_${outcome}`,
            startedAt,
            requestHash,
          );
        } catch {
          // Passive timing must never alter authorization or model execution.
        }
      }
    }
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
  const voiceTaskResources =
    capability?.native_tools === true || capability?.worker_native_tools === true
      ? voiceTaskBrokerResources(req)
      : null;
  if (voiceTaskResources) allowedHostTools.push(VOICE_TASK_TOOL_NAME);
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
  if (voiceTaskResources) hostToolResources[VOICE_TASK_TOOL_NAME] = voiceTaskResources;
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
  mcpCapabilitySourceAgent,
  req,
  requestBody = req?.body || {},
  resolveAgentById,
  deferUntilInvocation = false,
} = {}) {
  const declaredProvider = resolveConversationProviderId(declaredAgent);
  const capability = req?.config?.endpoints?.agents?.providerCapabilities?.[declaredProvider];
  return attachConversationProviderCapabilityBundle({
    targetAgent,
    declaredAgent,
    capabilitySourceAgent,
    mcpCapabilitySourceAgent,
    req,
    capability,
    requestBody,
    resolveAgentById,
    deferUntilInvocation,
  });
}

async function attachConversationProviderCapabilityBundle({
  targetAgent,
  declaredAgent = targetAgent,
  capabilitySourceAgent = targetAgent,
  mcpCapabilitySourceAgent,
  req,
  capability,
  requestBody = req?.body || {},
  nativeTools,
  privateStructuredResponse = false,
  deferUntilInvocation = false,
  inheritedConversation: suppliedInheritedConversation,
} = {}) {
  if (
    typeof privateStructuredResponse !== 'boolean' ||
    (privateStructuredResponse && nativeTools !== false)
  ) {
    throw new TypeError('Private structured response requires an explicit zero-tool capability');
  }
  if (nativeTools !== undefined && typeof nativeTools !== 'boolean') {
    throw new TypeError('nativeTools must be a boolean');
  }
  if (isVoiceActorSideEffectRestricted(req)) {
    enforceRestrictedVoiceRequest(req);
    return false;
  }
  if (!targetAgent || capability?.workspace_binding !== true) {
    return false;
  }
  if (nativeTools === false) {
    // A signed capability narrows an explicitly tool-less owner. Never silently drop tools.
    for (const participant of new Set(
      [targetAgent, declaredAgent, capabilitySourceAgent, mcpCapabilitySourceAgent].filter(Boolean),
    )) {
      if (
        resolvedAgentToolNameSet(participant).size > 0 ||
        (participant.declaredToolNames || []).length > 0 ||
        (participant.mcp || []).length > 0 ||
        (participant.agent_ids || []).length > 0 ||
        (participant.edges || []).length > 0
      ) {
        throw new Error('Native zero-tool capability requires a tool-less participant');
      }
    }
    const headers = restrictedConversationProviderBootstrapHeaders({ privateStructuredResponse });
    clearConversationProviderCapabilityBundle(targetAgent);
    const modelParameters = { ...(targetAgent.model_parameters || {}) };
    const configuration = { ...(modelParameters.configuration || {}) };
    configuration.defaultHeaders = {
      ...projectTrustedNativeInteractionHeaders(req, configuration.defaultHeaders),
      ...headers,
      ...(privateStructuredResponse
        ? {
            'X-Viventium-Actor-Kind': 'system',
            'X-Viventium-Origin': 'system',
            'X-Viventium-Audio-Eligible': 'false',
          }
        : {}),
    };
    targetAgent.model_parameters = { ...modelParameters, configuration };
    return true;
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
  /* === VIVENTIUM START === Defer duplicate minting to the existing invocation owner. === */
  // Graph-owned attempts rebuild this exact capability after durable turn IDs exist.
  // Keep structural headers above; zero-tool/private contracts remain eager. A runtime
  // refresher is required, so direct attach callers cannot lose their signed authority.
  if (
    deferUntilInvocation === true &&
    typeof targetAgent[CONVERSATION_PROVIDER_CAPABILITY_REFRESH] === 'function'
  ) {
    removeBootstrapBundleHeaders(targetAgent);
    return false;
  }
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Participant-owned capability parity across provider fallback routes.
   * Purpose: The fallback route declares provider identity, while the owning participant declares
   * its authorized tools. Project MCP servers from that explicit capability source so a tool-less
   * fallback model cannot silently lose the participant's connected-account access.
   * === VIVENTIUM END === */
  const mcpCapabilitySource =
    mcpCapabilitySourceAgent ||
    (capabilitySourceAgent === targetAgent ? declaredAgent : capabilitySourceAgent);
  const allowedServerNames = declaredMcpServerNames(
    mcpCapabilitySource,
    capability.excluded_mcp_servers,
  );
  const trustedRequestBody = projectTrustedClientPresentation(requestBody, req);
  const uploadedFiles = await resolveConversationProviderUploadedFiles(req, trustedRequestBody, {
    includeHistory: capability.workspace_binding === true,
  });
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
  const modelDefinition = capability.models?.find(
    (item) => item.id === (targetAgent.model || targetAgent.model_parameters?.model),
  );
  const coordinationOnly =
    mcpCapabilitySource?.glasshive_options?.orchestration?.tool_mode === 'coordination' &&
    ['direct-openai', 'direct-anthropic', 'direct-xai'].includes(modelDefinition?.harnessProfile);
  const inheritedConversation = coordinationOnly
    ? suppliedInheritedConversation ||
      require('./ViventiumMainContextService').getMainContextAttemptState(req)
        ?.inheritedConversation
    : undefined;
  if (coordinationOnly && !inheritedConversation) {
    throw new Error('coordination_context_unavailable');
  }
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
      ...(coordinationOnly ? { conversationToolMode: 'coordination', inheritedConversation } : {}),
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
  if (coordinationOnly) bundle.conversation_tool_mode = 'coordination';
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
  resolveConversationProviderHistoryAttachments,
  resolveConversationProviderUploadedFiles,
  restrictedConversationProviderBootstrapHeaders,
  attachConversationProviderBootstrapBundle,
  applyHostEvidenceBoundaryInstructions,
  applyCapabilityBrokerUnavailableInstructions,
  attachDeclaredConversationProviderCapabilityBundle,
  attachConversationProviderCapabilityBundle,
  bindConversationProviderDeveloperInstructionTail,
  bindConversationProviderStableAuthorityDigest,
  captureConversationProviderStableAuthority,
  bindHarnessCancellation,
  deliverHarnessCancellation,
  MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
  MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
  MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
  CORTEX_ATTEMPT_DEADLINE_REASON,
  probeHarnessFamilyRelease,
  prepareRestrictedVoiceCancellation,
  buildHarnessAgentIdempotencyKeys,
  buildHarnessAttemptIdempotencyKey,
  configuredBrokerHostTools,
  configuredConversationOrchestrationWorkerRoute,
  conversationProviderUsesLocalVisibleAccounting,
  conversationProviderUsesInvocationLocalTime,
  conversationProviderUsesNativeBody,
  conversationProviderStableAuthorityDigest,
  buildHarnessIdempotencyKey,
  clearConversationProviderCapabilityBundle,
  declaredMcpServerNames,
  installConversationProviderCapabilityRefresher,
  resolveHostToolCapabilityState,
  resolvedHostToolNames,
  resolvedConversationOrchestrationToolNames,
  resolvedHostToolResources,
  resolveConversationProviderContextProtocol,
  resolveConversationProviderId,
  setConversationProviderCapability,
};
