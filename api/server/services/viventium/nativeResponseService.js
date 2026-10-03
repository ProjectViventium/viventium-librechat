/* === VIVENTIUM START === Thin host adapter for the typed native result owner. === */
const {
  createNativeResponseRecoveryService,
  createNativeResponseFetch,
  isAcceptedMainProjectionComplete,
  GenerationJobManager,
  sanitizeMessageForTransmit,
  preserveMainContextUpdate,
  nativeIdentityJson,
  nativeJobMatches,
  interactionPresentationSequence,
  projectNativeToolEvidence,
  isAudioDeliveryRequested,
  supportsMessagingDeliveryDisposition,
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

const runNativeResponseTransaction = (operation) =>
  runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' });

function projectNativeMessage(identity, response, message, purpose, candidate) {
  const {
    attachEffectiveDeliveryDisposition,
    inspectProviderDeliveryDisposition,
  } = require('./deliveryDisposition');
  const { sanitizeVoiceAssistantMessageForPersistence } = require('./voiceArtifactText');
  message = projectNativeToolEvidence(identity, response, message, candidate);
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
  if (purpose === 'transmit' && context?.surface === 'telegram' && context.authenticated) {
    // The authenticated bridge consumes original structural controls; Mongo stays clean.
    return message;
  }
  return sanitizeVoiceAssistantMessageForPersistence(req, message);
}

async function resolveNativeResponseRoute(identity) {
  const db = require('~/models');
  const user = await db.findUser({ _id: identity.userId });
  if (!user) throw new Error('native_response_owner_unavailable');
  const config = await require('~/server/services/Config').getAppConfig({ role: user.role });
  const req = { user: { ...user, id: identity.userId }, config };
  const agent = await require('~/models/Agent').loadAgent({
    req,
    agent_id: identity.agentId,
    endpoint: EModelEndpoint.agents,
  });
  if (
    !agent ||
    (!isEphemeralAgentId(identity.agentId) &&
      user.role !== SystemRoles.ADMIN &&
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
function getService() {
  if (service) return service;
  const db = require('~/models');
  service = createNativeResponseRecoveryService({
    db,
    projectMessage: projectNativeMessage,
    prepareAttachments: async (identity, response, candidate) => {
      const user = await db.findUser({ _id: identity.userId });
      if (!user) throw new Error('native_response_owner_unavailable');
      const config = await require('~/server/services/Config').getAppConfig({ role: user.role });
      const context = identity.deliveryContext;
      return require('./nativeOutputFiles').prepareNativeOutputFiles(
        {
          user: { ...user, id: identity.userId },
          config,
          _viventiumTelegram: context?.surface === 'telegram' && context.authenticated === true,
          body: { endpoint: 'agents', viventiumSurface: context?.surface },
        },
        response.glasshive.output_files,
        {
          ...identity,
          requestId: candidate.requestId,
          runId: candidate.runId,
          invocationId: identity.invocationId,
        },
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
let lastReportedResponseTimeoutMs = 0;

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
  const baseURL = extractEnvVariable(endpoint?.baseURL || '');
  const apiKey = extractEnvVariable(endpoint?.apiKey || '');
  const ownerId = String(req.user?.id || '').trim();
  const routable = Boolean(
    baseURL && !baseURL.includes('${') && apiKey && !apiKey.includes('${') && ownerId,
  );
  let occupiedWaits = 0;

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
  if (route.agentId !== primaryAgentId) return baseFetch;
  return createNativeResponseFetch(
    baseFetch,
    async () => {
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
    (identity) => getService().admit(identity),
    (identity) => {
      req._viventiumNativeResponseIdentity = identity;
    },
    createNativeResponseRelease(req, route),
  );
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

async function markNativeResponseReplayStored(identity, mode) {
  const marked = await require('~/models').markNativeResponseReplayStored(identity);
  if (!marked) return false;
  return GenerationJobManager.settleNativeResponse(identity, mode);
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
          preserveMainContextUpdate(sanitizeMessageForPersistence(row), row),
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
        ),
        row,
      );
      const saved =
        mode === 'augmentation'
          ? await db.saveNativeResponseSnapshot(identity.userId, message, identity, 'augmentation')
          : await db.settleNativeResponse(identity, 'cancelled', message);
      return saved?.messageId
        ? sanitizeMessageForTransmit(
            preserveMainContextUpdate(sanitizeMessageForPersistence(saved), saved),
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
  resolveNativeResponseRoute,
  getService,
  createNativeResponseRelease,
  wrapNativeResponseFetch,
  recoverSavedNativeResponse,
  markNativeResponseReplayStored,
  recoverNativeResponse,
  recoverNativeResponses,
  installNativeResponseRecovery,
  mutateNativeResponseSources,
};
/* === VIVENTIUM END === */
