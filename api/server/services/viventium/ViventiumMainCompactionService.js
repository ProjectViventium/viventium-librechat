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
  mainCompactionOutputConstraints,
  mainCompactionCandidateDigest,
  MAIN_COMPACTION_SOURCE_TARGET_BYTES,
  forgetFailedMainCompaction,
  mainCompactionLeaseRemainingMs,
  mainCompactionSizeRepairBudget,
  mainCompactionSourceTargetBytes,
  recordAcceptedMainCompactionClaim,
  recordMainCompactionRejection,
  recordUnacceptedMainCompactionClaim,
  rememberFailedMainCompaction,
  repeatedFailedMainCompaction,
} = require('@librechat/api');
const { getRequiredPromptText } = require('./promptRegistry');
const { logger } = require('@librechat/data-schemas');
const {
  claimAcceptedMainCompaction,
  completeAcceptedMainCompaction,
  rejectAcceptedMainCompaction,
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
function compactionContractKey(agent) {
  return JSON.stringify({
    constraints: mainCompactionOutputConstraints,
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
    outputConstraints: mainCompactionOutputConstraints,
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
  let sizeRepairTimeoutMs = 0;
  let slowestCallMs = 0;
  try {
    if (yieldToInteractive()) {
      return { status: 'degraded', attempts: 0, reason: 'interactive_priority' };
    }
    const epochKey = compactionEpochKey(input);
    // After an unaccepted proposal the next claim takes less whole-turn source; none is dropped.
    const learnedSourceTarget = mainCompactionSourceTargetBytes(epochKey);
    const claim = await claimCompaction({
      ...input,
      ...(learnedSourceTarget < MAIN_COMPACTION_SOURCE_TARGET_BYTES
        ? { sourceTargetBytes: learnedSourceTarget }
        : {}),
    });
    if (claim.status !== 'claimed') return claim;
    const contractKey = compactionContractKey(input.agent);
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
    const mayRepairSize = () => {
      const budget = mainCompactionSizeRepairBudget({
        state: sizeRepair,
        attempts: semanticAttempts,
        leaseExpiresAt: claim.leaseExpiresAt,
        now: now(),
        slowestCallMs,
        maxCallMs: COMPACTOR_TIMEOUT_MS,
      });
      sizeRepairTimeoutMs = budget.timeoutMs;
      return budget.allowed;
    };
    // Every native call and retry wait ends within the store-owned claim lease.
    const leaseRemainingMs = () => mainCompactionLeaseRemainingMs(claim.leaseExpiresAt, now());
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
      try {
        const prompt = buildCompactionPrompt(claim, correctionReason);
        if (yieldToInteractive()) {
          terminalReason = 'interactive_priority';
          break;
        }
        const callTimeoutMs = attempt > MAX_ATTEMPTS ? sizeRepairTimeoutMs : leaseRemainingMs();
        if (callTimeoutMs <= 0) {
          terminalReason = 'compaction_lease_expired';
          break;
        }
        active.capacityReleaseAcknowledged = null;
        const callStartedMs = now();
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
        slowestCallMs = Math.max(slowestCallMs, now() - callStartedMs);
      } catch (error) {
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
      const prepared = inspectMainCompactionCandidate(proposal);
      if (!prepared.ok) {
        sizeRepair = recordMainCompactionRejection(
          sizeRepair,
          prepared.issue,
          semanticAttempts,
          proposal,
        );
        correctionReason = { code: 'schema_invalid', issue: prepared.issue, candidate: raw };
        continue;
      }
      sizeRepair = null;
      const parsed = prepared.candidate;
      let review;
      const reviewTimeoutMs = leaseRemainingMs();
      if (reviewTimeoutMs <= 0) {
        terminalReason = 'compaction_lease_expired';
        break;
      }
      try {
        if (yieldToInteractive()) continue;
        active.capacityReleaseAcknowledged = null;
        review = parseSemanticCompactionOutput(
          await executeCompactor({
            claim,
            prompt: buildCompactionPrompt(claim, '', parsed),
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
      } catch (error) {
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
        semanticCompaction: parsed,
        semanticReview: {
          version: 1,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(parsed),
          approved: true,
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
    if (!terminalReason) {
      // The bounded model-owned attempts ended without an accepted proposal.
      recordUnacceptedMainCompactionClaim({ key: epochKey, sourceBytes: claim.sourceBytes });
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
  }
}

module.exports = {
  acquireInteractiveMainAdmissionFence,
  buildCompactionPrompt,
  compactorAgent,
  ensureAcceptedMainCompaction,
  parseSemanticCompactionOutput,
  yieldAcceptedMainCompaction,
};
