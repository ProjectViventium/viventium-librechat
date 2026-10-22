/* === VIVENTIUM START === Thin host adapter for the typed native result owner. === */
const {
  createNativeResponseRecoveryService,
  createForegroundAttentionControl,
  createNativeResponseFetch,
  isAcceptedMainProjectionComplete,
  GenerationJobManager,
  sanitizeMessageForTransmit,
  preserveMainContextUpdate,
  nativeIdentityJson,
  nativeJobMatches,
  interactionPresentationSequence,
  projectNativeToolEvidence,
  collectGlassHiveNativeMediaReferences,
  renderGlassHiveNativeMediaAttachmentLinks,
  isAudioDeliveryRequested,
  supportsMessagingDeliveryDisposition,
  prepareNativeSourceRecovery,
  deliverCortexBatchToRunningMain,
} = require('@librechat/api');
const {
  extractEnvVariable,
  ResourceType,
  PermissionBits,
  SystemRoles,
  EModelEndpoint,
  isEphemeralAgentId,
} = require('librechat-data-provider');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');

/* === VIVENTIUM START === Passive, content-free admission and HTTP timing. === */
const { createHash } = require('crypto');
const { logger } = require('@librechat/data-schemas');
const { voiceLatencyNow, logVoiceLatencyNumericStage } = require('./voiceLatencyTiming');

function observeNativeResponsePhase(req, stage, operation) {
  if (req?.viventiumVoiceLogLatency !== true) return operation();
  const startedAt = voiceLatencyNow();
  let outcome = 'failed';
  const record = () => {
    try {
      const requestHash = createHash('sha256')
        .update(String(req.viventiumVoiceRequestId || 'unknown'))
        .digest('hex');
      logVoiceLatencyNumericStage(
        logger,
        req,
        'native_response',
        `${stage}_${outcome}`,
        startedAt,
        requestHash,
      );
    } catch {
      // Passive diagnostics must preserve the exact admission or transport outcome.
    }
  };
  try {
    return Promise.resolve(operation())
      .then((result) => {
        outcome = 'completed';
        return result;
      })
      .finally(record);
  } catch (error) {
    record();
    throw error;
  }
}
/* === VIVENTIUM END === */

const runNativeResponseTransaction = (operation) =>
  runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' });

function projectNativeMessage(identity, response, message, purpose, candidate) {
  const {
    attachEffectiveDeliveryDisposition,
    inspectProviderDeliveryDisposition,
  } = require('./deliveryDisposition');
  const { inspectProviderDeliveryRanges } = require('@librechat/api');
  const {
    sanitizeVoiceAssistantMessageForPersistence,
    sanitizeVoiceSurfaceTextForDisplay,
  } = require('./voiceArtifactText');
  message = projectNativeToolEvidence(identity, response, message, candidate);
  const projectMedia = (value) =>
    renderGlassHiveNativeMediaAttachmentLinks(value, message.attachments, {
      ownerId: identity.userId,
      messageId: identity.responseMessageId,
    });
  message = {
    ...message,
    text: typeof message.text === 'string' ? projectMedia(message.text) : message.text,
    content: Array.isArray(message.content)
      ? message.content.map((part) =>
          part?.type === 'text' && typeof part.text === 'string'
            ? { ...part, text: projectMedia(part.text) }
            : part,
        )
      : message.content,
  };
  const context = identity.deliveryContext;
  const req = {
    _viventiumDeliveryDispositionRequired:
      purpose === 'terminal' || identity.deliveryDispositionRequired === true,
    body: {
      voiceMode: context?.surface === 'voice',
      viventiumSurface: context?.surface,
      telegramAudioRequested: context?.surface === 'telegram' && context.audioRequested,
    },
  };
  // Only the accepted candidate may decide this field; preserve other metadata siblings.
  const metadata = { ...message.metadata, viventium: { ...message.metadata?.viventium } };
  delete metadata.viventium.deliveryDisposition;
  message = attachEffectiveDeliveryDisposition(
    req,
    { ...message, metadata },
    inspectProviderDeliveryDisposition(response),
  );
  const projectRanges = (value) => {
    if (!Array.isArray(value.content)) return value;
    return {
      ...value,
      content: value.content.map((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return part;
        const ranges = inspectProviderDeliveryRanges(response, part.text, (source) => {
          const projected = projectMedia(source);
          if (purpose !== 'transmit' && context?.surface === 'voice')
            return sanitizeVoiceSurfaceTextForDisplay(projected);
          return context?.surface === 'web'
            ? sanitizeVoiceAssistantMessageForPersistence(req, { text: projected }).text
            : projected;
        });
        return ranges === null ? part : { ...part, deliveryDispositionRanges: ranges };
      }),
    };
  };
  if (
    purpose === 'transmit' &&
    context?.authenticated === true &&
    (context.surface === 'telegram' || context.surface === 'voice')
  ) {
    if (context.surface === 'voice' && Array.isArray(message.content)) {
      message = {
        ...message,
        content: message.content.filter(
          (part) => part?.type !== 'think' && part?.type !== 'reasoning',
        ),
      };
    }
    // The authenticated bridge consumes original structural controls; Mongo stays clean.
    return projectRanges(message);
  }
  return projectRanges(sanitizeVoiceAssistantMessageForPersistence(req, message));
}

async function resolveNativeResponseRoute(identity) {
  const db = require('~/models');
  const user = await db.findUser({ _id: identity.userId });
  if (!user) throw new Error('native_response_owner_unavailable');
  const config = await require('~/server/services/Config').getAppConfig({ role: user.role });
  // Ephemeral identity belongs to the original request; only saved agents need a VIEW lookup.
  if (!identity.agentId || !isEphemeralAgentId(identity.agentId)) {
    const req = { user: { ...user, id: identity.userId }, config };
    const agent = await require('~/models/Agent').loadAgent({
      req,
      agent_id: identity.agentId,
      endpoint: EModelEndpoint.agents,
    });
    if (
      !agent ||
      (user.role !== SystemRoles.ADMIN &&
        (!agent._id ||
          !(await require('~/server/services/PermissionService').checkPermission({
            userId: identity.userId,
            role: user.role,
            resourceType: ResourceType.AGENT,
            resourceId: agent._id,
            requiredPermission: PermissionBits.VIEW,
          }))))
    )
      throw new Error('native_response_agent_unavailable');
  }
  const capability = config?.endpoints?.agents?.providerCapabilities?.[identity.providerId];
  const endpoint = config?.endpoints?.custom?.find((entry) => entry.name === identity.providerId);
  if (
    !endpoint ||
    capability?.conversation_session !== true ||
    capability?.workspace_binding !== true
  ) {
    throw new Error('native_response_provider_unavailable');
  }
  const apiKey = extractEnvVariable(endpoint.apiKey || '');
  if (!apiKey || apiKey.includes('${')) throw new Error('native_response_auth_unavailable');
  return {
    baseURL: extractEnvVariable(endpoint.baseURL || ''),
    headers: { Authorization: `Bearer ${apiKey}`, 'X-Viventium-User-Id': identity.userId },
  };
}

let service;
let foregroundAttentionControl;
function getForegroundAttentionControl() {
  if (foregroundAttentionControl) return foregroundAttentionControl;
  const db = require('~/models');
  foregroundAttentionControl = createForegroundAttentionControl({
    readMessage: (ownerId, messageId) => db.getMessage({ user: ownerId, messageId }),
    readNative: (ownerId, messageId) => db.getNativeResponse(ownerId, messageId),
    sourceMatches: (identity) => db.nativeResponseSourceMatches(identity),
    readResult: (identity) => getService().readResult(identity),
    resolveRoute: resolveNativeResponseRoute,
    cancel: (identity, result, route) => {
      const {
        deliverHarnessCancellation,
        MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
        MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
        MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
      } = require('./GlassHiveConversationProviderService');
      return deliverHarnessCancellation({
        url: `${route.baseURL.replace(/\/$/, '')}/requests/${encodeURIComponent(result.request_id)}/cancel`,
        headers: {
          ...route.headers,
          'X-Viventium-Foreground-Attention': identity.invocationId,
        },
        fetchImpl: fetch,
        requireCapacityRelease: true,
        includeRequestState: true,
        attemptTimeoutMs: MAINTENANCE_CANCELLATION_ATTEMPT_TIMEOUT_MS,
        retryDelaysMs: MAINTENANCE_CANCELLATION_RETRY_DELAYS_MS,
        totalTimeoutMs: MAINTENANCE_CANCELLATION_TOTAL_TIMEOUT_MS,
      });
    },
  });
  return foregroundAttentionControl;
}
function getService() {
  if (service) return service;
  const db = require('~/models');
  service = createNativeResponseRecoveryService({
    db,
    projectMessage: projectNativeMessage,
    prepareAttachments: async (identity, response, candidate) => {
      if (
        response.glasshive?.output_files == null &&
        !collectGlassHiveNativeMediaReferences(candidate.text).length
      )
        return [];
      const user = await db.findUser({ _id: identity.userId });
      if (!user) throw new Error('native_response_owner_unavailable');
      const config = await require('~/server/services/Config').getAppConfig({ role: user.role });
      const context = identity.deliveryContext;
      return require('./nativeOutputFiles').prepareNativeResponseOutputFiles(
        {
          user: { ...user, id: identity.userId },
          config,
          _viventiumTelegram: context?.surface === 'telegram' && context.authenticated === true,
          body: { endpoint: 'agents', viventiumSurface: context?.surface },
        },
        response,
        {
          ...identity,
          requestId: candidate.requestId,
          runId: candidate.runId,
          invocationId: identity.invocationId,
        },
        candidate.text,
      );
    },
    transaction: runNativeResponseTransaction,
    bind: (identity) => GenerationJobManager.bindNativeResponse(identity),
    commit: (identity, digest) => GenerationJobManager.commitNativeResponse(identity, digest),
    revoke: (identity) => GenerationJobManager.revokeNativeResponse(identity),
    isCurrent: async (identity) => {
      const job = await GenerationJobManager.getJobStore().getJob(identity.streamId);
      return (
        nativeJobMatches(job, identity) &&
        job.nativeResponse &&
        nativeIdentityJson(job.nativeResponse) === nativeIdentityJson(identity)
      );
    },
    authorizeTerminal: async (identity) =>
      (await GenerationJobManager.revokeNativeResponse(identity, true)).status === 'revoked',
    release: (identity) => GenerationJobManager.settleNativeResponse(identity, 'unsupported'),
    resolveRoute: resolveNativeResponseRoute,
  });
  return service;
}

/* === VIVENTIUM START ===
 * Feature: Release-gated current revision.
 * Purpose: A newer revision of the same logical turn waits, while it stays current, for every
 * superseded native Main operation it carries to release before Core admits it. Only GlassHive's
 * release acknowledgement grants dispatch. Its reported response timeout, anchored at the
 * revision's start, ends the wait truthfully; an unreachable host keeps the revision pending, and
 * a route that cannot be asked is the typed occupied condition. Typed native occupancy after
 * dispatch stays pending the same way until GlassHive's own anchored deadline ends it.
 * === VIVENTIUM END === */
const NATIVE_RELEASE_POLL_DELAYS_MS = Object.freeze([150, 300, 600, 1000, 2000]);

function waitForNativeRelease(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

function supersededDispatchError() {
  const error = new Error('operation was aborted');
  error.name = 'AbortError';
  error.code = 'superseded';
  return error;
}

function releaseUnconfirmedError(code, message) {
  return Object.assign(new Error(message), { code, errorClass: code });
}

function createNativeResponseRelease(req, route, deps = {}) {
  const probe =
    deps.probe || require('./GlassHiveConversationProviderService').probeHarnessFamilyRelease;
  const sleep = deps.sleep || waitForNativeRelease;
  const now = deps.now || Date.now;
  const providerId = route.endpoint || route.provider;
  const endpoint = req.config?.endpoints?.custom?.find((entry) => entry.name === providerId);
  const baseURL = deps.baseURL || extractEnvVariable(endpoint?.baseURL || '');
  const apiKey = deps.apiKey || extractEnvVariable(endpoint?.apiKey || '');
  const ownerId = String(req.user?.id || '').trim();
  const routable = Boolean(
    baseURL && !baseURL.includes('${') && apiKey && !apiKey.includes('${') && ownerId,
  );
  let occupiedWaits = 0;
  let lastReportedResponseTimeoutMs = 0;

  const currentTargets = async (context) => {
    const store = GenerationJobManager.getJobStore();
    const job = await store.getJob(context.streamId);
    if (
      !job ||
      job.createdAt !== context.jobCreatedAt ||
      job.userId !== context.userId ||
      job.status !== 'running' ||
      !(await store.isCurrentLogicalTurn(context.streamId))
    ) {
      return null;
    }
    return (job.nativeReleaseTargets || []).filter(
      (target) => typeof target === 'string' && target.length > 0,
    );
  };
  const released = async (targets) => {
    for (const messageId of targets) {
      const evidence = await Promise.resolve()
        .then(() => probe({ baseURL, apiKey, ownerId, messageId }))
        .catch(() => null);
      const timeoutS = Number(evidence?.responseTimeoutS);
      if (Number.isFinite(timeoutS) && timeoutS > 0) {
        lastReportedResponseTimeoutMs = timeoutS * 1000;
      }
      if (evidence?.released !== true) return false;
    }
    return true;
  };

  // The waiting generator keeps its pre-dispatch lease; once another generator recovered this
  // revision after a restart, it never dispatches.
  const ownsDispatch = (context) =>
    GenerationJobManager.renewNativeDispatchLease(context.streamId, context.jobCreatedAt);

  return {
    get responseTimeoutMs() {
      return lastReportedResponseTimeoutMs;
    },
    async beforeDispatch(context) {
      for (let attempt = 0; ; attempt += 1) {
        const targets = await currentTargets(context);
        if (!targets) throw supersededDispatchError();
        if (targets.length === 0) return;
        if (!(await ownsDispatch(context))) throw supersededDispatchError();
        if (!routable) {
          throw releaseUnconfirmedError(
            'conversation_session_authority_conflict',
            'The earlier reply could not be confirmed as released',
          );
        }
        if (await released(targets)) {
          if (!(await ownsDispatch(context))) throw supersededDispatchError();
          return;
        }
        if (
          lastReportedResponseTimeoutMs > 0 &&
          now() >= context.jobCreatedAt + lastReportedResponseTimeoutMs
        ) {
          throw releaseUnconfirmedError(
            'provider_response_deadline_exceeded',
            'The turn reached its response deadline before the earlier reply released',
          );
        }
        await sleep(
          NATIVE_RELEASE_POLL_DELAYS_MS[
            Math.min(attempt, NATIVE_RELEASE_POLL_DELAYS_MS.length - 1)
          ],
        );
      }
    },
    async whileOccupied(context) {
      const targets = await currentTargets(context);
      if (!targets) return false;
      if (routable && targets.length > 0) await released(targets);
      await sleep(
        NATIVE_RELEASE_POLL_DELAYS_MS[
          Math.min(occupiedWaits, NATIVE_RELEASE_POLL_DELAYS_MS.length - 1)
        ],
      );
      occupiedWaits += 1;
      return Boolean(await currentTargets(context));
    },
    async isCurrent(context) {
      return Boolean(await currentTargets(context));
    },
  };
}
/* === VIVENTIUM END === */

function wrapNativeResponseFetch(req, primaryAgentId, baseFetch, route) {
  if (route.agentId !== primaryAgentId) {
    // Participants own their provider invocation and effects. Only the current shared turn's
    // provenance follows them, so their native files retain their original author identity.
    return async (input, init) => {
      const requestUrl =
        typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (!new URL(requestUrl).pathname.endsWith('/chat/completions'))
        return baseFetch(input, init);
      const source = req._viventiumNativeResponseSource;
      const context = require('./interactionContext').getTrustedInteractionContext(req);
      const providerId = route.endpoint || route.provider;
      const capability = req.config?.endpoints?.agents?.providerCapabilities?.[providerId];
      if (
        !context?.logical_turn_id ||
        context.origin !== 'interactive' ||
        context.actor_kind !== 'external_user' ||
        capability?.conversation_session !== true ||
        capability?.workspace_binding !== true
      )
        return baseFetch(input, init);
      const store = GenerationJobManager.getJobStore();
      const streamId = req._resumableStreamId;
      const job = await store.getJob(streamId);
      const conversationId = source ? source.conversationId : job?.conversationId;
      const responseMessageId = source ? source.responseMessageId : job?.responseMessageId;
      const sourceMessageId = source ? source.proof?.messageId : job?.userMessage?.messageId;
      if (
        !job ||
        !req.user?.id ||
        !conversationId ||
        !responseMessageId ||
        !sourceMessageId ||
        job.userId !== req.user.id ||
        job.streamId !== streamId ||
        job.status !== 'running' ||
        job.conversationId !== conversationId ||
        context.conversation_id !== conversationId ||
        job.responseMessageId !== responseMessageId ||
        job.userMessage?.messageId !== sourceMessageId ||
        job.interactionContext?.logical_turn_id !== context.logical_turn_id ||
        job.interactionContext?.revision !== context.revision ||
        !(await store.isCurrentLogicalTurn(streamId))
      )
        throw supersededDispatchError();
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      headers.set('X-Viventium-Logical-Turn-Id', context.logical_turn_id);
      headers.set('X-Viventium-Logical-Turn-Revision', String(context.revision));
      return baseFetch(input, { ...init, headers });
    };
  }
  return createNativeResponseFetch(
    (input, init) =>
      observeNativeResponsePhase(req, 'provider_response_headers', () => baseFetch(input, init)),
    async () => {
      /* === VIVENTIUM START === Each Main attempt owns its current admission proof. */
      delete req._viventiumNativeResponseUnaccepted;
      /* === VIVENTIUM END === */
      const source = req._viventiumNativeResponseSource;
      const context = require('./interactionContext').getTrustedInteractionContext(req);
      const providerId = route.endpoint || route.provider;
      const capability = req.config?.endpoints?.agents?.providerCapabilities?.[providerId];
      if (
        !source ||
        !context?.logical_turn_id ||
        context.origin !== 'interactive' ||
        context.actor_kind !== 'external_user' ||
        capability?.conversation_session !== true ||
        capability?.workspace_binding !== true
      )
        return null;
      const job = await GenerationJobManager.getJob(req._resumableStreamId);
      if (!job) throw new Error('native_response_job_missing');
      let deliveryContext = { surface: 'web' };
      if (req.body?.voiceMode === true) deliveryContext = { surface: 'voice' };
      else if (String(req.body?.viventiumSurface || '').toLowerCase() === 'telegram') {
        deliveryContext = {
          surface: 'telegram',
          authenticated: req._viventiumTelegram === true,
          audioRequested:
            req.body?.telegramAudioRequested === true ||
            String(req.body?.telegramAudioRequested || '').toLowerCase() === 'true',
        };
      }
      return {
        userId: req.user.id,
        conversationId: source.conversationId,
        responseMessageId: source.responseMessageId,
        streamId: req._resumableStreamId,
        jobCreatedAt: job.createdAt,
        logicalTurnId: context.logical_turn_id,
        revision: context.revision,
        sourceOrderScope: context.source_order_scope,
        sourceSequence: interactionPresentationSequence(context),
        deliveryDispositionRequired:
          isAudioDeliveryRequested(req) && supportsMessagingDeliveryDisposition(capability),
        deliveryContext,
        providerId,
        agentId: route.agentId,
        source: source.proof,
      };
    },
    (identity) =>
      observeNativeResponsePhase(req, 'host_native_admission', () => getService().admit(identity)),
    (identity) => {
      req._viventiumNativeResponseIdentity = identity;
    },
    createNativeResponseRelease(req, route),
    /* === VIVENTIUM START === Retain proof only after the exact recovery fence was released. */
    async (identity) => {
      await getService().rejectUnaccepted(identity);
      req._viventiumNativeResponseUnaccepted = identity;
    },
    /* === VIVENTIUM END === */
  );
}

/* VIVENTIUM: The original native Main may have handed off before its cohort sealed. Later
 * primary graph dispatches read the immutable accepted data from that exact parent, while
 * foreground instructions and history remain request-pinned. This read never changes receipts. */
async function readCurrentMainBackgroundInputs(req, primaryAgentId) {
  const identity = req._viventiumNativeResponseIdentity;
  if (!identity) return [];
  const source = req._viventiumNativeResponseSource;
  const context = require('./interactionContext').getTrustedInteractionContext(req);
  const invalid = () =>
    Object.assign(new Error('Current Main background source is unavailable'), {
      code: 'main_background_source_unavailable',
    });
  if (
    !source ||
    !context ||
    identity.userId !== req.user?.id ||
    identity.agentId !== primaryAgentId ||
    identity.streamId !== req._resumableStreamId ||
    identity.conversationId !== source.conversationId ||
    identity.responseMessageId !== source.responseMessageId ||
    identity.source.messageId !== source.proof?.messageId ||
    identity.source.id !== source.proof?.id ||
    identity.source.digest !== source.proof?.digest ||
    context.conversation_id !== identity.conversationId ||
    context.logical_turn_id !== identity.logicalTurnId ||
    context.revision !== identity.revision ||
    context.source_order_scope !== identity.sourceOrderScope ||
    interactionPresentationSequence(context) !== identity.sourceSequence
  )
    throw invalid();
  const store = GenerationJobManager.getJobStore();
  const assertCurrent = async () => {
    if (!(await store.isCurrentLogicalTurn(identity.streamId))) throw supersededDispatchError();
    if (identity.sourceOrderScope && identity.sourceSequence != null) {
      const observed = await GenerationJobManager.observeSourceOrder({
        source_order_scope: identity.sourceOrderScope,
        source_sequence: identity.sourceSequence,
      });
      if (observed.stale || observed.latest_source_sequence !== identity.sourceSequence)
        throw supersededDispatchError();
    }
    const job = await store.getJob(identity.streamId);
    if (
      !nativeJobMatches(job, identity) ||
      job.status !== 'running' ||
      job.generationCompleted ||
      job.nativeResponseCancelled ||
      (job.nativeResponse &&
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity))
    )
      throw supersededDispatchError();
  };
  await assertCurrent();
  const db = require('~/models');
  const row = await db.getNativeResponse(identity.userId, identity.responseMessageId);
  if (
    !row ||
    String(row.user) !== identity.userId ||
    row.deletedAt ||
    (row.error === true && row.nativeResponse?.status !== 'unsupported') ||
    row.isCreatedByUser !== false ||
    row.conversationId !== identity.conversationId ||
    row.messageId !== identity.responseMessageId ||
    row.parentMessageId !== identity.source.messageId ||
    !row.nativeResponse ||
    nativeIdentityJson(row.nativeResponse) !== nativeIdentityJson(identity) ||
    !['pending', 'unsupported'].includes(row.nativeResponse.status)
  )
    throw invalid();
  const inputs = require('@librechat/data-schemas').normalizeMainBackgroundInputs(
    row.metadata?.viventium?.backgroundInputs,
  );
  if (inputs.some((value) => value.invocationId !== identity.invocationId)) throw invalid();
  if (inputs.length && !(await db.nativeResponseSourceMatches(identity))) throw invalid();
  // Revalidate after every canonical source lookup; Core can move on before Native sees it.
  await assertCurrent();
  return inputs;
}

async function recoverSavedNativeResponse(identity, onTerminal) {
  const saved = await getService().recover(identity, onTerminal);
  if (!saved) return null;
  // The ordinary Message reader owns public memory status and private admission removal.
  const [response] = await require('~/models').getMessages({
    user: identity.userId,
    conversationId: identity.conversationId,
    messageId: identity.responseMessageId,
  });
  return response ? getService().projectForTransmit(identity, response) : null;
}

/* VIVENTIUM: a released host graph replays its canonical final, without reviving a native job. */
async function hostResponseAuthorIsCurrent(identity) {
  const store = GenerationJobManager.getJobStore();
  if (await store.resolveDeliveryOwner(identity.logicalTurnId, identity.revision + 1)) return false;
  if (identity.sourceOrderScope && identity.sourceSequence != null) {
    const observed = await GenerationJobManager.observeSourceOrder({
      source_order_scope: identity.sourceOrderScope,
      source_sequence: identity.sourceSequence,
    });
    if (observed.stale) return false;
  }
  return true;
}
async function readRetainedHostFinal(query) {
  const db = require('~/models');
  const response = await db.readHostResponseFinal(query);
  if (!response) return null;
  const identity = response.hostFinal;
  if (!(await hostResponseAuthorIsCurrent(identity))) return null;
  const requestMessage = await db.getMessage({
    user: identity.userId,
    conversationId: identity.conversationId,
    messageId: identity.source.messageId,
  });
  const [publicResponse] = await db.getMessages({
    user: identity.userId,
    conversationId: identity.conversationId,
    messageId: identity.responseMessageId,
  });
  if (
    !requestMessage ||
    !publicResponse ||
    !(await db.readHostResponseFinal(query)) ||
    !(await hostResponseAuthorIsCurrent(identity))
  )
    return null;
  return {
    responseMessageId: response.messageId,
    conversationId: response.conversationId,
    interactionContext: response.metadata?.viventium?.interactionContext,
    acknowledgement: response.metadata?.viventium?.deliveryAcknowledgement,
    finalEvent: {
      final: true,
      conversation: { conversationId: response.conversationId },
      requestMessage: sanitizeMessageForTransmit(requestMessage),
      responseMessage: { ...sanitizeMessageForTransmit(publicResponse), unfinished: false },
    },
  };
}
async function acknowledgeRetainedHostFinal(acknowledgement, surface) {
  return require('~/models').acknowledgeHostResponseFinal(
    acknowledgement,
    surface,
    runNativeResponseTransaction,
    hostResponseAuthorIsCurrent,
  );
}

async function markNativeResponseReplayStored(identity, mode) {
  const marked = await require('~/models').markNativeResponseReplayStored(identity);
  if (!marked) return false;
  const settled = await GenerationJobManager.settleNativeResponse(identity, mode);
  if (settled) {
    // Canonical replay is committed. Wake the existing durable mission lane, including recovery.
    try {
      require('./GlassHiveMissionAdjudicationService').wakeGlassHiveMissionAdjudications({
        ownerId: identity.userId,
        conversationId: identity.conversationId,
      });
    } catch {
      // The committed Main stays committed; existing durable reconciliation owns recovery.
      require('@librechat/data-schemas').logger.warn(
        '[NativeResponse] Mission wake remains pending',
      );
    }
  }
  return settled;
}

async function recoverNativeResponse(identity) {
  const row = await require('~/models').getNativeResponse(
    identity.userId,
    identity.responseMessageId,
  );
  if (
    row?.nativeResponse?.status === 'cancelled' &&
    typeof row.nativeResponse.stopSnapshotStoredAt === 'number' &&
    row.nativeResponse.stopSnapshotStoredAt > 0 &&
    nativeIdentityJson(row.nativeResponse) === nativeIdentityJson(identity)
  ) {
    const stopped = await GenerationJobManager.abortJob(
      identity.streamId,
      'user_cancelled',
      identity,
    );
    return stopped.success;
  }
  let terminal = false;
  const response = await recoverSavedNativeResponse(identity, () => {
    terminal = true;
  });
  if (!response) return false;
  const requestMessage = await require('~/models').getMessage({
    user: identity.userId,
    messageId: identity.source.messageId,
  });
  if (!requestMessage) return false;
  const finished = await GenerationJobManager.finishNativeResponse(
    identity,
    {
      final: true,
      conversation: { conversationId: identity.conversationId },
      requestMessage: sanitizeMessageForTransmit(requestMessage),
      responseMessage: sanitizeMessageForTransmit(response),
    },
    terminal ? 'cancelled' : undefined,
  );
  if (!finished) return false;
  if (terminal) return markNativeResponseReplayStored(identity, 'cancelled');
  const job = await GenerationJobManager.getJob(identity.streamId);
  if (job?.metadata?.deliveryPolicy?.commit_authority === 'server') {
    const accepted = await GenerationJobManager.acknowledgeStreamDelivery(identity.streamId, {
      state: 'committed',
      presentation_ref: identity.responseMessageId,
    });
    if (accepted?.status !== 'recorded') return false;
    const projected =
      await require('./ViventiumMainContinuityService').commitAcceptedMainTurnFromPresentation(
        accepted.presentation,
      );
    if (!isAcceptedMainProjectionComplete(projected)) return false;
  }
  return markNativeResponseReplayStored(identity);
}

async function persistNativeResponseCancellation(identity, snapshot, mode) {
  const db = require('~/models');
  const { sanitizeMessageForPersistence } = require('~/models/Message').__testables;
  return mutateNativeResponseSources(
    { user: identity.userId, messageId: identity.responseMessageId },
    async () => {
      const row = await db.getNativeResponse(identity.userId, identity.responseMessageId);
      if (
        !row?.nativeResponse ||
        nativeIdentityJson(row.nativeResponse) !== nativeIdentityJson(identity) ||
        identity.recoverUntil <= Date.now()
      )
        return null;
      const stopped =
        row.nativeResponse.status === 'cancelled' &&
        typeof row.nativeResponse.stopSnapshotStoredAt === 'number' &&
        row.nativeResponse.stopSnapshotStoredAt > 0;
      if (mode === 'published') {
        if (!stopped || !(await db.markNativeResponseReplayStored(identity))) return null;
      }
      if (stopped && mode !== 'augmentation') {
        return sanitizeMessageForTransmit(
          preserveMainContextUpdate(
            sanitizeMessageForPersistence(row, { purpose: 'document' }),
            row,
          ),
        );
      }
      const message = preserveMainContextUpdate(
        sanitizeMessageForPersistence(
          projectNativeMessage(
            identity,
            {},
            {
              ...row,
              text: snapshot.text,
              content: snapshot.content,
            },
            'persist',
          ),
          { purpose: 'document' },
        ),
        row,
      );
      const saved =
        mode === 'augmentation'
          ? await db.saveNativeResponseSnapshot(identity.userId, message, identity, 'augmentation')
          : await db.settleNativeResponse(identity, 'cancelled', message);
      return saved?.messageId
        ? sanitizeMessageForTransmit(
            preserveMainContextUpdate(
              sanitizeMessageForPersistence(saved, { purpose: 'document' }),
              saved,
            ),
          )
        : null;
    },
    'system',
  );
}

async function installNativeResponseRecovery() {
  await require('~/models').ensureNativeResponseIndexes();
  GenerationJobManager.setNativeResponseRecovery(recoverNativeResponse);
  GenerationJobManager.setNativeResponseCancellation(persistNativeResponseCancellation);
  GenerationJobManager.setNativeSourceRecovery(async (current, previous) => {
    const route = previous.nativeResponse
      ? await resolveNativeResponseRoute(previous.nativeResponse)
      : null;
    const release = createNativeResponseRelease(
      { user: { id: current.userId } },
      {},
      {
        baseURL: route?.baseURL,
        apiKey: route?.headers.Authorization.slice('Bearer '.length),
      },
    );
    return prepareNativeSourceRecovery(current, previous, {
      isUnboundCancelled: (job) =>
        GenerationJobManager.getJobStore().isNativeResponseUnboundCancelled(job),
      beforeCapture: async (job) => {
        const callId = job.viventiumCallSessionId || job.voiceCallSessionId;
        if (job.interactionContext?.surface === 'voice' && callId) {
          const call = await require('./CallSessionService').getCallSession(callId);
          if (!call || call.userId !== job.userId || call.conversationId !== job.conversationId) {
            throw releaseUnconfirmedError(
              'native_source_delivery_unavailable',
              'The owning call could not be confirmed',
            );
          }
          if (['ended', 'failed'].includes(call.status)) {
            throw releaseUnconfirmedError(
              'native_source_delivery_terminal',
              'The owning call has ended or failed',
            );
          }
        }
        await release.beforeDispatch({
          streamId: job.streamId,
          jobCreatedAt: job.createdAt,
          userId: job.userId,
        });
        return release.responseTimeoutMs > 0
          ? job.createdAt + release.responseTimeoutMs
          : undefined;
      },
      getJob: (streamId) => GenerationJobManager.getJobStore().getJob(streamId),
      readFacts: require('./InteractionDurableEffectService').getSourceRecoverySnapshot,
      sleep: waitForNativeRelease,
    });
  });
}

async function recoverNativeResponses() {
  return getService().scanRecoverable(async (admission) => {
    const stopped =
      admission.status === 'cancelled' &&
      typeof admission.stopSnapshotStoredAt === 'number' &&
      admission.stopSnapshotStoredAt > 0;
    if (
      !stopped &&
      ['pending', 'prepared'].includes(admission.status) &&
      GenerationJobManager.hasLocalNativeResponseProducer(admission)
    )
      return;
    try {
      await recoverNativeResponse(admission);
    } catch (error) {
      require('@librechat/data-schemas').logger.warn('[NativeResponse] Recovery remains pending', {
        error: error?.message || 'native_response_unavailable',
      });
    }
  });
}

/* === VIVENTIUM START ===
 * Terminal evidence joins the exact currently running Native Main, using its existing background
 * input courier. A native enqueue is not consumption; the mission ledger still owns synthesis.
 */
async function offerMissionEvidenceToCurrentMain({
  ownerId,
  conversationId,
  currentLeafMessageId,
  messages,
  mainAgentId,
  insights,
  onPending,
}) {
  if (!ownerId || !conversationId || !currentLeafMessageId || !mainAgentId) return false;
  const byId = new Map((messages || []).map((message) => [message.messageId, message]));
  const seen = new Set();
  let cursor = currentLeafMessageId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const message = byId.get(cursor);
    if (!message) return false;
    cursor = message.parentMessageId;
    if (message.isCreatedByUser === true) return false;
    const row = await require('~/models').getNativeResponse(ownerId, message.messageId);
    const identity = row?.nativeResponse;
    if (!identity || identity.agentId !== mainAgentId) continue;
    if (
      row.deletedAt ||
      row.isCreatedByUser !== false ||
      String(row.user) !== ownerId ||
      row.conversationId !== conversationId ||
      row.messageId !== message.messageId ||
      row.messageId !== identity.responseMessageId ||
      row.parentMessageId !== identity.source?.messageId ||
      identity.userId !== ownerId ||
      identity.conversationId !== conversationId
    )
      return false;
    if (
      !['pending', 'prepared', 'completed'].includes(identity.status) ||
      identity.finalReplayStoredAt > 0
    )
      return false;
    const store = GenerationJobManager.getJobStore();
    const current = async () => {
      const job = await store.getJob(identity.streamId);
      if (
        !nativeJobMatches(job, identity) ||
        job.status !== 'running' ||
        job.generationCompleted ||
        job.nativeResponseCancelled ||
        !job.nativeResponse ||
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity) ||
        !(await store.isCurrentLogicalTurn(identity.streamId))
      )
        return false;
      if (identity.sourceOrderScope && identity.sourceSequence != null) {
        const order = await GenerationJobManager.observeSourceOrder({
          source_order_scope: identity.sourceOrderScope,
          source_sequence: identity.sourceSequence,
        });
        if (order.stale || order.latest_source_sequence !== identity.sourceSequence) return false;
      }
      return true;
    };
    if (!(await current())) return false;
    if (!(await require('~/models').nativeResponseSourceMatches(identity)))
      throw new Error('mission_current_main_source_unavailable');
    await module.exports.deliverCompletedCortexBatchToRunningMain(
      {
        ownerId,
        conversationId,
        parentMessageId: identity.responseMessageId,
        streamId: identity.streamId,
        insights,
        context: JSON.stringify(
          insights?.some((insight) => insight.authority?.kind === 'durable_work_callback')
            ? { accepted_work_evidence: insights }
            : { terminal_evidence: insights },
        ),
      },
      current,
    );
    // Completion can win during the native offer. Only the exact still-running author defers.
    const refreshed = await require('~/models').getNativeResponse(
      ownerId,
      identity.responseMessageId,
    );
    if (
      !refreshed?.nativeResponse ||
      nativeIdentityJson(refreshed.nativeResponse) !== nativeIdentityJson(identity)
    )
      return false;
    if (
      ['failed', 'cancelled'].includes(refreshed.nativeResponse.status) ||
      refreshed.nativeResponse.finalReplayStoredAt > 0
    )
      return false;
    if (!(await current())) return false;
    // The replay wake may run while this mission claim is still processing. Capture a single
    // exact readiness recheck for after claim release; it does not poll or wait for Main.
    onPending?.(async () => {
      const latest = await require('~/models').getNativeResponse(
        ownerId,
        identity.responseMessageId,
      );
      return (
        !latest?.nativeResponse ||
        nativeIdentityJson(latest.nativeResponse) !== nativeIdentityJson(identity) ||
        !['pending', 'prepared', 'completed'].includes(latest.nativeResponse.status) ||
        latest.nativeResponse.finalReplayStoredAt > 0 ||
        !(await current())
      );
    });
    return true;
  }
  return false;
}
/* === VIVENTIUM END === */

const mutateNativeResponseSources = (filter, operation, kind = 'edit') =>
  runNativeResponseTransaction(() =>
    require('~/models').mutateAcceptedMainContinuitySources(filter, () =>
      require('~/models').mutateNativeResponseSources(
        filter,
        operation,
        (identity) => GenerationJobManager.revokeNativeResponse(identity),
        runNativeResponseTransaction,
        (identity) => GenerationJobManager.retireNativeResponse(identity),
        kind,
      ),
    ),
  );

module.exports = {
  offerMissionEvidenceToCurrentMain,
  deliverCompletedCortexBatchToRunningMain: (input, isEligible) =>
    deliverCortexBatchToRunningMain(input, {
      // The native runtime owns exact artifact and interjection capability validation.
      liveContextEnabled: true,
      getJob: (streamId) => GenerationJobManager.getJobStore().getJob(streamId),
      readAdmission: async (ownerId, messageId) =>
        (await require('~/models').getNativeResponse(ownerId, messageId))?.nativeResponse || null,
      resolveRoute: resolveNativeResponseRoute,
      isEligible,
      isCurrentLogicalTurn: (streamId) =>
        GenerationJobManager.getJobStore().isCurrentLogicalTurn(streamId),
      observeSourceOrder: (context) => GenerationJobManager.observeSourceOrder(context),
      prepareInput: (identity, input, mode) =>
        require('~/models').prepareNativeMainBackgroundInput(
          identity,
          input,
          runNativeResponseTransaction,
          mode,
        ),
      recordInputReceipt: (identity, receipt) =>
        require('~/models').recordNativeMainBackgroundInputReceipt(identity, receipt),
    }),
  readCurrentMainBackgroundInputs,
  resolveNativeResponseRoute,
  getService,
  getForegroundAttentionControl,
  createNativeResponseRelease,
  wrapNativeResponseFetch,
  recoverSavedNativeResponse,
  readRetainedHostFinal,
  acknowledgeRetainedHostFinal,
  markNativeResponseReplayStored,
  recoverNativeResponse,
  recoverNativeResponses,
  installNativeResponseRecovery,
  mutateNativeResponseSources,
};
/* === VIVENTIUM END === */
