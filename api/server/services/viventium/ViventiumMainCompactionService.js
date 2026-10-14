'use strict';

/* === VIVENTIUM START ===
 * Feature: Validated semantic compaction for provider-neutral Main continuity.
 * Purpose: Summarize only server-accepted older turns, keep recent turns intact, preserve opaque
 * identifiers, and fail without deleting source evidence when the compactor is unavailable.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { HumanMessage } = require('@langchain/core/messages');
const {
  inspectMainCompactionCandidate,
  inspectMainCompactionCarrier,
  mainCompactionOutputConstraints,
  mainCompactionCandidateDigest,
  mainCompactionOutputContractDigest,
  MAIN_COMPACTION_SOURCE_TARGET_BYTES,
  MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
  forgetFailedMainCompaction,
  mainCompactionLeaseRemainingMs,
  mainCompactionSizeRepairBudget,
  mainCompactionStageBudget,
  mainCompactionStageLeaseRenewal,
  mainCompactionSourceTargetBytes,
  recordAcceptedMainCompactionClaim,
  recordMainCompactionRejection,
  recordUnacceptedMainCompactionClaim,
  rememberFailedMainCompaction,
  repeatedFailedMainCompaction,
  retainMainCompactionCancellationDelivery,
  recoverMainContinuityCarrierForAdmission,
  renderAcceptedMainContextForCarrier,
} = require('@librechat/api');
const { getRequiredPromptText } = require('./promptRegistry');
const { getTrustedInteractionContext } = require('./interactionContext');
const { logger } = require('@librechat/data-schemas');
const {
  claimAcceptedMainCompaction,
  loadAcceptedMainContext,
  completeAcceptedMainCompaction,
  rejectAcceptedMainCompaction,
  renewAcceptedMainCompaction,
} = require('./ViventiumMainContinuityService');

const MAX_ATTEMPTS = 2;
const COMPACTOR_TIMEOUT_MS = 240 * 1000;
const MAX_TRANSPORT_RETRIES = 1;
const TRANSIENT_RETRY_DELAY_MS = 5 * 1000;
const MAX_TRANSIENT_RETRY_DELAY_MS = 30 * 1000;
const INTERACTIVE_YIELD_WAIT_MS = 6 * 1000;
const activeCompactionsByOwnerId = new Map();
const interactiveAdmissionFencesByOwnerId = new Map();

function acquireInteractiveMainAdmissionFence(ownerId) {
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!normalizedOwnerId) return () => {};
  const token = {};
  const ownerFences = interactiveAdmissionFencesByOwnerId.get(normalizedOwnerId) || new Set();
  ownerFences.add(token);
  interactiveAdmissionFencesByOwnerId.set(normalizedOwnerId, ownerFences);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ownerFences.delete(token);
    if (
      ownerFences.size === 0 &&
      interactiveAdmissionFencesByOwnerId.get(normalizedOwnerId) === ownerFences
    ) {
      interactiveAdmissionFencesByOwnerId.delete(normalizedOwnerId);
    }
  };
}

function yieldToInteractiveMainAdmission(ownerId, controller) {
  const ownerFences = interactiveAdmissionFencesByOwnerId.get(ownerId);
  if (!ownerFences || ownerFences.size === 0) return false;
  if (!controller.signal.aborted) controller.abort('maintenance_yield');
  return true;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function waitWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise).then(() => true), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function yieldAcceptedMainCompaction(ownerId, options = {}) {
  const normalizedOwnerId = String(ownerId || '').trim();
  const activeCompactions = Array.from(activeCompactionsByOwnerId.get(normalizedOwnerId) || []);
  if (activeCompactions.length === 0) return { status: 'idle', count: 0 };
  for (const active of activeCompactions) {
    if (!active.controller.signal.aborted) {
      active.controller.abort('maintenance_yield');
    }
  }
  const configuredTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeoutMs)
    ? Math.max(0, configuredTimeoutMs)
    : INTERACTIVE_YIELD_WAIT_MS;
  const settled = await waitWithin(
    Promise.all(activeCompactions.map((active) => active.settled)),
    timeoutMs,
  );
  const capacityReleaseAcknowledged = activeCompactions.every(
    (active) => active.capacityReleaseAcknowledged === true,
  );
  let status = 'yield_pending';
  if (settled) status = capacityReleaseAcknowledged ? 'yielded' : 'yield_unconfirmed';
  return {
    status,
    count: activeCompactions.length,
    capacityReleaseAcknowledged: settled && capacityReleaseAcknowledged,
  };
}

function providerErrorStatus(error) {
  const status = Number(error?.errorStatus ?? error?.status ?? error?.statusCode);
  return Number.isInteger(status) && status > 0 ? status : 0;
}

function providerErrorReason(error) {
  for (const candidate of [error?.errorCode, error?.code]) {
    const reason = String(candidate || '')
      .trim()
      .replace(/[^a-zA-Z0-9_.:-]/g, '_')
      .slice(0, 80);
    if (reason) return reason;
  }
  const status = providerErrorStatus(error);
  return status ? `provider_http_${status}` : 'provider_failed';
}

function isTransientProviderError(error) {
  const status = providerErrorStatus(error);
  return status >= 500 && status <= 599;
}

function parseSemanticCompactionOutput(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(raw);
  const candidate = (fenced ? fenced[1] : raw).trim();
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

/** One epoch's compaction work: owner, Main agent and its stable authority. */
function compactionEpochKey(input) {
  return [input.ownerId, input.agentId, input.stableAuthoritySha256]
    .map((value) => String(value || '').trim())
    .join('\n');
}

/** The approved contract and exact compactor route a failed claim was produced under. */
function compactionContractKey(agent, contract) {
  return JSON.stringify({
    constraints: contract || mainCompactionOutputConstraints,
    provider: String(agent?.endpoint || agent?.provider || ''),
    model: String(agent?.model_parameters?.model || agent?.model || ''),
    effort: String(agent?.model_parameters?.reasoning_effort || ''),
  });
}

function buildCompactionPrompt(claim, correctionReason = '', candidate = null) {
  const payload = JSON.stringify({
    version: 1,
    sourceDigest: claim.sourceDigest,
    previousSemanticCompaction: claim.previousSemanticCompaction || null,
    acceptedOlderTurns: claim.sourceTurns || [],
    outputConstraints: claim.outputContract || mainCompactionOutputConstraints,
    ...(claim.legacyInputs?.length ? { legacyInputs: claim.legacyInputs } : {}),
    ...(candidate ? { candidate } : {}),
    ...(correctionReason ? { priorRejection: correctionReason } : {}),
  });
  // Claims batch whole turns. A single larger turn remains indivisible and goes through the
  // existing provider context-budget/error handling; never truncate accepted source here.
  return getRequiredPromptText(
    candidate ? 'main.continuity_compaction_review' : 'main.continuity_compaction',
    { evidence_json: payload },
  );
}

function compactorAgent(agent, domainEpochKey, stage = 'compaction') {
  // AgentClient receives an initialized Agent: custom OpenAI-compatible endpoints retain their
  // declared route in `endpoint`, while `provider` is normalized to the OpenAI adapter. A fresh
  // cortex initialization must start from that declared route or the custom model is sent to the
  // public OpenAI endpoint before fallback. This is provider-neutral and matches Main routing.
  const declaredProvider = String(agent?.endpoint || agent?.provider || '').trim();
  const modelParameters = { ...(agent?.model_parameters || {}) };
  // `configuration` belongs to the initialized invocation transport. It can contain live clients,
  // dispatchers, and request headers that are neither clone-safe nor valid for an isolated run.
  // Fresh initialization rematerializes provider configuration for the isolated compactor ID.
  delete modelParameters.configuration;
  const compactorId = `main-continuity-compactor-${domainEpochKey.slice(0, 24)}-${stage}`;
  const hasDeclaredFallback =
    String(agent?.fallback_llm_provider || '').trim() &&
    String(agent?.fallback_llm_model || agent?.fallback_llm_model_parameters?.model || '').trim();
  const initializedFallback = agent?.viventiumFallbackLlmAssignment;
  const initializedFallbackProvider = String(initializedFallback?.provider || '').trim();
  const initializedFallbackModel = String(initializedFallback?.model || '').trim();
  const initializedFallbackEffort = String(initializedFallback?.effort || '').trim();
  const isolatedFallback =
    !hasDeclaredFallback && initializedFallbackProvider && initializedFallbackModel
      ? {
          fallback_llm_provider: initializedFallbackProvider,
          fallback_llm_model: initializedFallbackModel,
          fallback_llm_model_parameters: {
            model: initializedFallbackModel,
            ...(initializedFallbackEffort ? { reasoning_effort: initializedFallbackEffort } : {}),
          },
        }
      : {};
  return {
    ...agent,
    ...(declaredProvider ? { provider: declaredProvider, endpoint: declaredProvider } : {}),
    ...isolatedFallback,
    id: compactorId,
    name: 'Main continuity compactor',
    instructions: '',
    agent_ids: [],
    edges: [],
    tools: [],
    declaredToolNames: [],
    toolDefinitions: [],
    toolRegistry: new Map(),
    mcp: [],
    tool_resources: {},
    tool_options: {},
    conversation_recall_agent_only: false,
    background_cortices: [],
    viventiumProviderSessionMode: 'stateless',
    model_parameters: modelParameters,
  };
}

async function defaultExecuteCompactor({
  claim,
  prompt,
  req,
  res,
  agent,
  signal,
  reportCapacityRelease,
  stage = 'compaction',
  timeoutMs,
}) {
  if (!req || !agent) throw new Error('main_compaction_runtime_unavailable');
  const { createBackgroundRes, executeCortex } = require('../BackgroundCortexService');
  const safeReq = Object.create(req);
  // This internal read-only, tool-less actor owns the accepted claim, not the triggering call.
  // Inheriting a call session would misclassify its isolated body as an unverified voice turn.
  safeReq.viventiumCallSession = null;
  safeReq.body = {
    conversationId: `main-continuity-compaction-${claim.domainEpochKey.slice(0, 24)}`,
  };
  safeReq.user = {
    ...(req.user || {}),
    personalization: {
      ...(req.user?.personalization || {}),
      conversation_recall: false,
      memories: false,
    },
  };
  safeReq.config = req.config;
  safeReq._viventiumFeelingSnapshot = null;
  const runId = `main-compact-${crypto.randomUUID()}`;
  let result;
  let capacityReleaseReported = false;
  try {
    result = await executeCortex({
      agent: compactorAgent(agent, claim.domainEpochKey, stage),
      messages: [new HumanMessage(prompt)],
      runId,
      conversationId: safeReq.body.conversationId,
      req: safeReq,
      res: res || createBackgroundRes(),
      contextMode: 'minimal',
      // The claim carries the accepted evidence; the triggering Main turn's Core context and
      // visible chain describe a different message carrier and must not be forwarded.
      mainContextBinding: 'isolated',
      completedResultPolicy: 'internal',
      insightMode: 'structured',
      // This owner is a pure text actor; reuse the signed native zero-tool capability.
      nativeTools: false,
      // A repair bounded by the claim lease never outlives it; native cancellation stays owned here.
      executionTimeoutMs:
        Number.isFinite(timeoutMs) && timeoutMs > 0
          ? Math.min(timeoutMs, COMPACTOR_TIMEOUT_MS)
          : COMPACTOR_TIMEOUT_MS,
      signal,
      onHarnessCancellationOutcome: (outcome) => {
        capacityReleaseReported = true;
        reportCapacityRelease?.(outcome?.acknowledged === true);
      },
    });
    // The native owner also seals normal terminal completion. A later Stop during store
    // promotion/rejection must consume that receipt rather than invent unresolved capacity.
    if (['ended', 'none'].includes(result?.nativeOwnership)) {
      capacityReleaseReported = true;
      reportCapacityRelease?.(true);
    }
  } finally {
    if (
      signal?.aborted &&
      !capacityReleaseReported &&
      typeof reportCapacityRelease === 'function'
    ) {
      // Settling the JavaScript execution does not prove that the native provider lease was
      // released. Only the cancellation endpoint may positively acknowledge that boundary.
      reportCapacityRelease(false);
    }
  }
  if (result?.nativeOwnership === 'unresolved') {
    // The compactor's native request may still run: no transport retry or next stage overlaps it.
    const error = new Error('main_compaction_native_release_unconfirmed');
    error.code = 'main_compaction_native_release_unconfirmed';
    throw error;
  }
  if (!result?.insight) {
    const error = new Error(String(result?.errorClass || result?.error || 'compaction_failed'));
    error.code = 'main_compaction_provider_failed';
    const errorStatus = Number(result?.errorStatus);
    if (Number.isInteger(errorStatus) && errorStatus > 0) error.errorStatus = errorStatus;
    const errorCode = String(result?.errorCode || '').trim();
    if (errorCode) error.errorCode = errorCode;
    throw error;
  }
  return result.insight;
}

async function ensureAcceptedMainCompaction(input = {}) {
  input = {
    ...input,
    outputCarrier: input.outputCarrier || input.req?._viventiumAcceptedMainOutputCarrierV1,
  };
  const ownerId = String(input.ownerId || '').trim();
  const controller = new AbortController();
  let settleActive;
  const settled = new Promise((resolve) => {
    settleActive = resolve;
  });
  // A reservation or continuity-store claim does not own provider capacity. Mark it releasable
  // until the compactor invocation starts, then require an explicit native release outcome.
  const active = { controller, settled, capacityReleaseAcknowledged: true };
  const ownerCompactions = activeCompactionsByOwnerId.get(ownerId) || new Set();
  ownerCompactions.add(active);
  activeCompactionsByOwnerId.set(ownerId, ownerCompactions);
  const inputSignal = input.signal;
  let releaseCancellationDelivery = () => {};
  const abortFromInput = () => {
    if (!controller.signal.aborted) controller.abort(inputSignal.reason);
  };
  if (inputSignal?.aborted) abortFromInput();
  else inputSignal?.addEventListener?.('abort', abortFromInput, { once: true });
  const executeCompactor = input.executeCompactor || defaultExecuteCompactor;
  /* === VIVENTIUM START ===
   * Feature: One compaction runner for accepted Main turns and legacy conversation source.
   * Purpose: A caller may supply its own claim/complete/reject store; attempts, repair, fidelity
   * review and failure memory stay identical. A foreground claim runs inside the owner's own turn,
   * which is waiting on it, so it does not yield to that turn's interactive admission fence.
   * === VIVENTIUM END === */
  const claimCompaction = input.claimCompaction || claimAcceptedMainCompaction;
  const completeCompaction = input.completeCompaction || completeAcceptedMainCompaction;
  const rejectCompaction = input.rejectCompaction || rejectAcceptedMainCompaction;
  const renewCompaction =
    input.renewCompaction || (input.claimCompaction ? null : renewAcceptedMainCompaction);
  const yieldToInteractive = () =>
    input.foreground !== true && yieldToInteractiveMainAdmission(ownerId, controller);
  const retrySleep = typeof input.sleep === 'function' ? input.sleep : sleep;
  const configuredRetryDelayMs = Number(input.retryDelayMs);
  const retryDelayMs = Number.isFinite(configuredRetryDelayMs)
    ? Math.min(MAX_TRANSIENT_RETRY_DELAY_MS, Math.max(0, configuredRetryDelayMs))
    : TRANSIENT_RETRY_DELAY_MS;
  let semanticAttempts = 0;
  let transportRetries = 0;
  let correctionReason = '';
  let terminalReason = '';
  const now = typeof input.now === 'function' ? input.now : Date.now;
  // A shrinking whole-proposal overflow may be repaired again within the store-owned claim lease.
  let sizeRepair = null;
  const deadlineAt = input.deadlineAt || input.req?.viventiumSchedulerAuthoringDeadlineAt;
  const deadlineMs = new Date(deadlineAt).getTime();
  // One enclosing budget is shared by all claims in the waiting turn. Review and Main completion
  // retain time even when a smaller claim is selected; a new claim never resets that deadline.
  const executionBudget = input.executionBudget || {};
  if (Number.isFinite(deadlineMs) && executionBudget.completionReserveMs == null)
    executionBudget.completionReserveMs = Math.min(
      COMPACTOR_TIMEOUT_MS,
      Math.max(0, Math.floor((deadlineMs - now()) / 3)),
    );
  let slowestCallMs = executionBudget.slowestCallMs || 0;
  let slowestCompactionCallMs = executionBudget.slowestCompactionCallMs || 0;
  let slowestReviewCallMs = executionBudget.slowestReviewCallMs || 0;
  try {
    releaseCancellationDelivery = retainMainCompactionCancellationDelivery({
      signal: inputSignal,
      settled,
      capacityReleased: () => active.capacityReleaseAcknowledged === true,
    });
    if (yieldToInteractive()) {
      return { status: 'degraded', attempts: 0, reason: 'interactive_priority' };
    }
    const epochKey = compactionEpochKey(input);
    if (
      Number.isFinite(deadlineMs) &&
      !mainCompactionStageBudget({
        leaseExpiresAt: deadlineAt,
        deadlineAt,
        completionReserveMs: executionBudget.completionReserveMs,
        now: now(),
        slowestCallMs,
        slowestCompactionCallMs,
        slowestReviewCallMs,
        maxCallMs: COMPACTOR_TIMEOUT_MS,
        stage: 'compaction',
      }).allowed
    )
      return { status: 'degraded', attempts: 0, reason: 'compaction_enclosing_deadline' };
    // After an unaccepted proposal the next claim takes less whole-turn source; none is dropped.
    const learnedSourceTarget = mainCompactionSourceTargetBytes(epochKey);
    const claim = await claimCompaction({
      ...input,
      ...(learnedSourceTarget < MAIN_COMPACTION_SOURCE_TARGET_BYTES
        ? { sourceTargetBytes: learnedSourceTarget }
        : {}),
    });
    if (claim.status !== 'claimed') return claim;
    const contractKey = compactionContractKey(input.agent, claim.outputContract);
    const effectiveLeaseExpiry = () =>
      Number.isFinite(deadlineMs)
        ? new Date(
            Math.min(
              new Date(claim.leaseExpiresAt).getTime(),
              deadlineMs - (executionBudget.completionReserveMs || 0),
            ),
          )
        : claim.leaseExpiresAt;
    // An identical claim that already failed under the same contract is not re-run; its
    // degraded reason stays visible until the source, contract or compactor changes.
    const repeatedReason = repeatedFailedMainCompaction({
      domainEpochKey: claim.domainEpochKey,
      sourceDigest: claim.sourceDigest,
      contractKey,
    });
    if (repeatedReason) {
      terminalReason = repeatedReason;
      logger.info('[VIVENTIUM][main-continuity] Unchanged failed compaction claim not repeated', {
        sourceBytes: claim.sourceBytes,
      });
    }
    // Eligibility alone opens the bounded third/fourth repair. Admission and any awaited
    // renewal run once inside the stage's error owner, after prompt preparation.
    const mayRepairSize = () =>
      sizeRepair?.converging === true &&
      semanticAttempts < MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS;
    // Every native call and retry wait ends within the store-owned claim lease.
    const leaseRemainingMs = () => mainCompactionLeaseRemainingMs(effectiveLeaseExpiry(), now());
    let pendingLeaseRenewalDisposition = 'not_required';
    const claimHash = crypto
      .createHash('sha256')
      .update(String(claim.leaseId))
      .digest('hex')
      .slice(0, 16);
    const runId = getTrustedInteractionContext(input.req)?.schedule_run_id;
    const runHash = runId
      ? crypto.createHash('sha256').update(runId).digest('hex').slice(0, 16)
      : undefined;
    const observeStageStart = (stage, timeoutMs) => {
      const startedMs = now();
      logger.debug('[VIVENTIUM][main-continuity] Stage call issued', {
        stage,
        timeoutMs,
        claimHash,
        ...(runHash ? { runHash } : {}),
        compactionObservedMs: slowestCompactionCallMs,
        reviewObservedMs: slowestReviewCallMs,
        compactionKnown: slowestCompactionCallMs > 0,
        reviewKnown: slowestReviewCallMs > 0,
        leaseRemainingMs: mainCompactionLeaseRemainingMs(claim.leaseExpiresAt, startedMs),
        ...(Number.isFinite(deadlineMs)
          ? {
              enclosingRemainingMs: Math.max(0, deadlineMs - startedMs),
              completionReserveMs: executionBudget.completionReserveMs,
            }
          : {}),
        leaseRenewalDisposition: pendingLeaseRenewalDisposition,
      });
      pendingLeaseRenewalDisposition = 'not_required';
      return startedMs;
    };
    const observeStageEnd = (stage, startedMs, outcome) => {
      if (startedMs === undefined) return;
      logger.debug('[VIVENTIUM][main-continuity] Stage call settled', {
        stage,
        elapsedMs: Math.max(0, now() - startedMs),
        outcome,
        claimHash,
        ...(runHash ? { runHash } : {}),
      });
    };
    const stageBudget = async (stage) => {
      const budgetInput = {
        leaseExpiresAt: claim.leaseExpiresAt,
        deadlineAt,
        completionReserveMs: executionBudget.completionReserveMs,
        now: now(),
        slowestCallMs,
        slowestCompactionCallMs,
        slowestReviewCallMs,
        maxCallMs: COMPACTOR_TIMEOUT_MS,
        stage,
      };
      const expiresAt =
        !controller.signal.aborted &&
        renewCompaction &&
        mainCompactionStageLeaseRenewal(budgetInput);
      if (expiresAt) {
        const renewed = await renewCompaction({
          ...input,
          leaseId: claim.leaseId,
          sourceDigest: claim.sourceDigest,
          leaseExpiresAt: claim.leaseExpiresAt,
          expiresAt,
        });
        pendingLeaseRenewalDisposition = renewed.status;
        if (renewed.status === 'renewed') claim.leaseExpiresAt = renewed.leaseExpiresAt;
      }
      return mainCompactionStageBudget({
        ...budgetInput,
        leaseExpiresAt: claim.leaseExpiresAt,
        now: now(),
      });
    };
    if (yieldToInteractive()) {
      terminalReason = 'interactive_priority';
    }
    while (!terminalReason && (semanticAttempts < MAX_ATTEMPTS || mayRepairSize())) {
      if (controller.signal.aborted) {
        terminalReason =
          controller.signal.reason === 'maintenance_yield'
            ? 'interactive_priority'
            : 'compaction_cancelled';
        break;
      }
      const attempt = semanticAttempts + 1;
      let raw;
      let callStartedMs;
      try {
        const prompt = buildCompactionPrompt(claim, correctionReason);
        if (yieldToInteractive()) {
          terminalReason = 'interactive_priority';
          break;
        }
        const budget = await stageBudget('compaction');
        if (controller.signal.aborted) {
          terminalReason =
            controller.signal.reason === 'maintenance_yield'
              ? 'interactive_priority'
              : 'compaction_cancelled';
          break;
        }
        // Use the current lease after the final admission/renewal await. A timeout saved
        // before prompt preparation can otherwise cap a newly admitted whole-source repair.
        const sizeBudget =
          attempt > MAX_ATTEMPTS
            ? mainCompactionSizeRepairBudget({
                state: sizeRepair,
                attempts: semanticAttempts,
                leaseExpiresAt: effectiveLeaseExpiry(),
                now: now(),
                slowestCallMs,
                slowestCompactionCallMs,
                slowestReviewCallMs,
                maxCallMs: COMPACTOR_TIMEOUT_MS,
              })
            : { allowed: true, timeoutMs: COMPACTOR_TIMEOUT_MS };
        const callTimeoutMs = Math.min(budget.timeoutMs, sizeBudget.timeoutMs);
        if (!budget.allowed || !sizeBudget.allowed || callTimeoutMs <= 0) {
          terminalReason = Number.isFinite(deadlineMs)
            ? 'compaction_enclosing_deadline'
            : 'compaction_lease_expired';
          break;
        }
        active.capacityReleaseAcknowledged = null;
        callStartedMs = observeStageStart('compaction', callTimeoutMs);
        raw = await executeCompactor({
          claim,
          prompt,
          attempt,
          timeoutMs: callTimeoutMs,
          req: input.req,
          res: input.res,
          agent: input.agent,
          signal: controller.signal,
          reportCapacityRelease: (acknowledged) => {
            active.capacityReleaseAcknowledged = acknowledged === true;
          },
        });
        observeStageEnd('compaction', callStartedMs, 'completed');
        slowestCompactionCallMs = Math.max(slowestCompactionCallMs, now() - callStartedMs);
        executionBudget.slowestCompactionCallMs = slowestCompactionCallMs;
        slowestCallMs = Math.max(slowestCallMs, slowestCompactionCallMs);
        executionBudget.slowestCallMs = slowestCallMs;
      } catch (error) {
        observeStageEnd(
          'compaction',
          callStartedMs,
          controller.signal.aborted ? 'cancelled' : providerErrorReason(error),
        );
        if (controller.signal.aborted) {
          terminalReason =
            controller.signal.reason === 'maintenance_yield'
              ? 'interactive_priority'
              : 'compaction_cancelled';
          break;
        }
        const errorClass = providerErrorReason(error);
        const errorStatus = providerErrorStatus(error);
        const willRetryTransport =
          isTransientProviderError(error) &&
          transportRetries < MAX_TRANSPORT_RETRIES &&
          leaseRemainingMs() > retryDelayMs;
        logger.warn('[VIVENTIUM][main-continuity] Compactor transport attempt failed', {
          attempt,
          transportRetries,
          errorClass,
          ...(errorStatus ? { errorStatus } : {}),
          retryingTransport: willRetryTransport,
        });
        if (willRetryTransport) {
          transportRetries += 1;
          await retrySleep(retryDelayMs);
          continue;
        }
        terminalReason = errorClass;
        break;
      }
      semanticAttempts += 1;
      const proposal = parseSemanticCompactionOutput(raw);
      let prepared = inspectMainCompactionCandidate(proposal, claim.outputContract);
      if (prepared.ok && claim.outputContract) {
        const fit =
          typeof input.inspectCandidateCarrier === 'function'
            ? await input.inspectCandidateCarrier({ claim, candidate: prepared.candidate })
            : inspectMainCompactionCarrier(prepared.candidate, claim.outputContract);
        if (!fit.ok) prepared = fit;
      }
      if (!prepared.ok) {
        sizeRepair = recordMainCompactionRejection(
          sizeRepair,
          prepared.issue,
          semanticAttempts,
          proposal,
        );
        correctionReason = { code: 'schema_invalid', issue: prepared.issue, candidate: raw };
        // The source owner proves an actual smaller whole prefix. Do not spend serial size
        // correction calls on this same source when that existing planner can reduce it now.
        if (
          prepared.issue?.constraint === 'max_bytes' &&
          ['', 'summary', '$carrier'].includes(prepared.issue.path) &&
          claim.canReduceSource === true
        )
          break;
        continue;
      }
      sizeRepair = null;
      const parsed = prepared.candidate;
      let review;
      let reviewStartedMs;
      try {
        const reviewPrompt = buildCompactionPrompt(claim, '', parsed);
        if (yieldToInteractive()) continue;
        const reviewBudget = await stageBudget('review');
        if (controller.signal.aborted) {
          terminalReason =
            controller.signal.reason === 'maintenance_yield'
              ? 'interactive_priority'
              : 'compaction_cancelled';
          break;
        }
        const reviewTimeoutMs = reviewBudget.timeoutMs;
        if (!reviewBudget.allowed || reviewTimeoutMs <= 0) {
          terminalReason = Number.isFinite(deadlineMs)
            ? 'compaction_enclosing_deadline'
            : 'compaction_lease_expired';
          break;
        }
        active.capacityReleaseAcknowledged = null;
        reviewStartedMs = observeStageStart('review', reviewTimeoutMs);
        review = parseSemanticCompactionOutput(
          await executeCompactor({
            claim,
            prompt: reviewPrompt,
            attempt,
            stage: 'review',
            timeoutMs: reviewTimeoutMs,
            req: input.req,
            res: input.res,
            agent: input.agent,
            signal: controller.signal,
            reportCapacityRelease: (acknowledged) => {
              active.capacityReleaseAcknowledged = acknowledged === true;
            },
          }),
        );
        observeStageEnd('review', reviewStartedMs, 'completed');
        slowestReviewCallMs = Math.max(slowestReviewCallMs, now() - reviewStartedMs);
        executionBudget.slowestReviewCallMs = slowestReviewCallMs;
        slowestCallMs = Math.max(slowestCallMs, slowestReviewCallMs);
        executionBudget.slowestCallMs = slowestCallMs;
      } catch (error) {
        observeStageEnd(
          'review',
          reviewStartedMs,
          controller.signal.aborted ? 'cancelled' : providerErrorReason(error),
        );
        terminalReason = `review_${providerErrorReason(error)}`;
        if (controller.signal.aborted) {
          terminalReason =
            controller.signal.reason === 'maintenance_yield'
              ? 'interactive_priority'
              : 'compaction_cancelled';
        }
        break;
      }
      if (controller.signal.aborted) {
        terminalReason =
          controller.signal.reason === 'maintenance_yield'
            ? 'interactive_priority'
            : 'compaction_cancelled';
        break;
      }
      if (review?.approved !== true || typeof review.reason !== 'string') {
        correctionReason = {
          code: 'semantic_fidelity',
          candidate: raw,
          ...(review?.approved === false && typeof review.reason === 'string'
            ? { reason: review.reason.slice(0, 2000) }
            : {}),
        };
        continue;
      }
      const completed = await completeCompaction({
        ...input,
        leaseId: claim.leaseId,
        sourceDigest: claim.sourceDigest,
        outputContract: claim.outputContract,
        semanticCompaction: parsed,
        semanticReview: {
          version: 1,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(parsed),
          approved: true,
          ...(claim.outputContract
            ? { outputContractDigest: mainCompactionOutputContractDigest(claim.outputContract) }
            : {}),
        },
      });
      if (completed.status === 'compacted') {
        recordAcceptedMainCompactionClaim(epochKey);
        forgetFailedMainCompaction(claim.domainEpochKey);
        return {
          ...completed,
          attempts: semanticAttempts,
          ...(transportRetries ? { transportRetries } : {}),
        };
      }
      if (completed.status === 'invalid_summary') {
        correctionReason = { code: completed.reason || 'quality_gate', candidate: raw };
        continue;
      }
      return {
        ...completed,
        attempts: semanticAttempts,
        ...(transportRetries ? { transportRetries } : {}),
      };
    }
    const finalReason =
      terminalReason ||
      (typeof correctionReason === 'string'
        ? correctionReason
        : correctionReason.reason
          ? `${correctionReason.code}: ${correctionReason.reason}`
          : correctionReason.code) ||
      'quality_gate';
    let nextSourceTargetBytes;
    if (!terminalReason) {
      // Return the existing learned target so a bounded caller can try a smaller whole claim now.
      nextSourceTargetBytes = recordUnacceptedMainCompactionClaim({
        key: epochKey,
        sourceBytes: claim.sourceBytes,
      });
      rememberFailedMainCompaction({
        domainEpochKey: claim.domainEpochKey,
        sourceDigest: claim.sourceDigest,
        contractKey,
        reason: finalReason,
      });
    }
    await rejectCompaction({
      ...input,
      leaseId: claim.leaseId,
      reason: finalReason,
    });
    return {
      status: 'degraded',
      attempts: semanticAttempts,
      ...(transportRetries ? { transportRetries } : {}),
      ...(nextSourceTargetBytes ? { nextSourceTargetBytes } : {}),
      reason: finalReason,
    };
  } finally {
    inputSignal?.removeEventListener?.('abort', abortFromInput);
    ownerCompactions.delete(active);
    if (
      ownerCompactions.size === 0 &&
      activeCompactionsByOwnerId.get(ownerId) === ownerCompactions
    ) {
      activeCompactionsByOwnerId.delete(ownerId);
    }
    settleActive();
    releaseCancellationDelivery();
  }
}

/** Thin service binding for the shared typed admission recovery owner. */
function loadAcceptedMainContextForAdmission(input = {}) {
  const pinned = input.req?._viventiumAcceptedMainCarrierContextV1;
  let usePinned =
    !input.loadContext &&
    pinned &&
    ['ownerId', 'agentId', 'stableAuthoritySha256'].every(
      (key) => pinned.identity[key] === input[key],
    );
  return recoverMainContinuityCarrierForAdmission({
    request: input.req,
    identityKey: `${input.agentId}:${input.stableAuthoritySha256}`,
    load: () => {
      if (usePinned) {
        usePinned = false;
        return Promise.resolve(
          renderAcceptedMainContextForCarrier(pinned.context, input.outputCarrier),
        );
      }
      return (input.loadContext || loadAcceptedMainContext)(input);
    },
    ensure: () =>
      (input.ensureCompaction || ensureAcceptedMainCompaction)({
        ...input,
        trigger: 'context_carrier',
        foreground: true,
        reallocateOutputCarrier: true,
      }),
  });
}

module.exports = {
  acquireInteractiveMainAdmissionFence,
  buildCompactionPrompt,
  compactorAgent,
  ensureAcceptedMainCompaction,
  loadAcceptedMainContextForAdmission,
  parseSemanticCompactionOutput,
  yieldAcceptedMainCompaction,
};
