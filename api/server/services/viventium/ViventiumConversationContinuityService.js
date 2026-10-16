'use strict';

/* === VIVENTIUM START ===
 * Feature: Conversation legacy continuity.
 * Purpose: A conversation whose visible history holds answers without a Core Main context stamp
 * must carry that history intact through the protected source guard. Native body routes defer
 * opportunistic prefix migration to the existing idle runner only after a positive fit against
 * discovered native replay floors; unknown, over-budget and header-only routes reconcile first
 * when required. The existing Main compaction runner reviews each oldest whole-turn prefix on the
 * configured Main route and binds it to the exact covered rows. Main receives only that accepted
 * summary plus every newer row, or all original rows until review completes. Stored history is
 * never rewritten, truncated or reset. Carrier bounds remain unchanged; covered source changes
 * invalidate the summary and restore full protection.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { logger } = require('@librechat/data-schemas');
const {
  MAIN_COMPACTION_SOURCE_TARGET_BYTES,
  MAIN_COMPACTION_LEASE_MS,
  boundedMainCompactionLeaseRenewal,
  conversationMainCompactionOutputContract,
  inspectMainCompactionCandidate,
  inspectMainCompactionCarrier,
  mainCompactionCandidateDigest,
  mainCompactionOutputContractDigest,
  renderConversationMainContinuityCapsule,
} = require('@librechat/api');
const { hasUnreconciledMainHistory, messageContentText } = require('./ViventiumMainContextService');

/** Newer visible rows always carried intact after a reconciliation. */
const TAIL_TARGET_ROWS = 48;
/** Reconcile only once the unsummarized visible rows clearly exceed that tail. */
const RECONCILE_ABOVE_ROWS = 96;
const MAX_CLAIMS_PER_TURN = 6;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function isInternalRow(message) {
  return message?.metadata?.viventium?.visibility === 'internal';
}

function isAssistantRow(message) {
  const role = String(
    message?.role || (message?.isCreatedByUser === true ? 'user' : 'assistant'),
  ).toLowerCase();
  return role === 'assistant';
}

/** Identity of one visible source row as the protected carrier sees it. */
function rowDigest(message) {
  return sha256(
    JSON.stringify([
      String(message?.messageId || ''),
      isAssistantRow(message) ? 'assistant' : 'user',
      messageContentText(message),
    ]),
  );
}

function coveredSourceDigest(coveredSource) {
  return sha256(JSON.stringify(coveredSource.map((row) => [row.id, row.sha256])));
}

function renderConversationContinuityCapsule(record, coveredRows) {
  return renderConversationMainContinuityCapsule(record.semanticCompaction, coveredRows);
}

/**
 * Replace the exact covered prefix of this turn's visible chain with its reviewed summary.
 * `orderedMessages` runs oldest to newest and ends with the current input, which is never covered.
 */
function projectConversationContinuity(record, orderedMessages) {
  const rows = Array.isArray(orderedMessages) ? orderedMessages : [];
  const unprojected = { messages: rows, coveredIds: [], capsule: '', record: null, stale: false };
  if (
    !record ||
    record.status !== 'ready' ||
    !record.throughMessageId ||
    !record.semanticCompaction ||
    !Array.isArray(record.coveredSource) ||
    record.coveredSource.length === 0
  ) {
    return unprojected;
  }
  // New accepted state carries its server-owned allocation outside the semantic fields. Reload
  // validates the complete candidate and contract; it never silently clips accepted context.
  if (record.semanticCompactionContract) {
    const prepared = inspectMainCompactionCandidate(
      record.semanticCompaction,
      record.semanticCompactionContract,
    );
    if (
      !prepared.ok ||
      !inspectMainCompactionCarrier(prepared.candidate, record.semanticCompactionContract).ok ||
      record.semanticReview?.approved !== true ||
      record.semanticReview?.candidateDigest !==
        mainCompactionCandidateDigest(prepared.candidate) ||
      record.semanticReview?.outputContractDigest !==
        mainCompactionOutputContractDigest(record.semanticCompactionContract)
    )
      return { ...unprojected, stale: true };
  }
  const throughIndex = rows.findIndex(
    (message) => String(message?.messageId || '') === record.throughMessageId,
  );
  if (throughIndex < 0 || throughIndex >= rows.length - 1) return { ...unprojected, stale: true };
  const span = rows.slice(0, throughIndex + 1);
  const visible = span.filter((message) => !isInternalRow(message));
  const exact =
    visible.length === record.coveredSource.length &&
    visible.every(
      (message, index) =>
        String(message.messageId) === record.coveredSource[index].id &&
        rowDigest(message) === record.coveredSource[index].sha256,
    ) &&
    coveredSourceDigest(record.coveredSource) === record.coveredDigest;
  if (!exact) return { ...unprojected, stale: true };
  return {
    messages: rows.slice(throughIndex + 1),
    coveredIds: span.map((message) => String(message.messageId)),
    capsule: renderConversationContinuityCapsule(record, visible.length),
    record,
    stale: false,
  };
}

/** Whole visible turns, in order, as the compaction runner's accepted-source evidence. */
function buildClaimTurns(spanRows) {
  const turns = [];
  const answered = new Set();
  const provenance = (message) => message?.metadata?.viventium?.interactionContext || {};
  for (let index = 0; index < spanRows.length; index += 1) {
    const message = spanRows[index];
    if (isInternalRow(message)) continue;
    if (!isAssistantRow(message)) {
      const answer = spanRows
        .slice(index + 1)
        .find(
          (row) =>
            !isInternalRow(row) &&
            isAssistantRow(row) &&
            String(row.parentMessageId || '') === String(message.messageId),
        );
      if (answer) answered.add(String(answer.messageId));
      const context = { ...provenance(message), ...provenance(answer) };
      turns.push({
        logicalTurnId: String(context.logical_turn_id || message.messageId),
        revision: Number(context.revision) || 1,
        conversationId: String(message.conversationId || ''),
        userMessageId: String(message.messageId),
        assistantMessageId: answer ? String(answer.messageId) : '',
        origin: String(context.origin || 'interactive'),
        userText: messageContentText(message),
        assistantText: answer ? messageContentText(answer) : '',
        toolPairs: [],
        committedAt: new Date(answer?.createdAt || message.createdAt || 0).toISOString(),
      });
      continue;
    }
    if (answered.has(String(message.messageId))) continue;
    // An answer whose trigger is internal (a trusted scheduler envelope) keeps its provenance but
    // contributes no user-authored text.
    const context = provenance(message);
    turns.push({
      logicalTurnId: String(context.logical_turn_id || message.messageId),
      revision: Number(context.revision) || 1,
      conversationId: String(message.conversationId || ''),
      userMessageId: '',
      assistantMessageId: String(message.messageId),
      origin: String(context.origin || 'scheduler'),
      userText: '',
      assistantText: messageContentText(message),
      toolPairs: [],
      committedAt: new Date(message.createdAt || 0).toISOString(),
    });
  }
  return turns;
}

/**
 * Plan the next claim: keep the newest visible rows intact and cover the oldest uncovered whole
 * turns within the source target. A stale record restarts from the conversation's first row.
 */
function planConversationContinuityClaim({
  record,
  orderedMessages,
  sourceTargetBytes = MAIN_COMPACTION_SOURCE_TARGET_BYTES,
}) {
  const rows = Array.isArray(orderedMessages) ? orderedMessages : [];
  const projection = projectConversationContinuity(record, rows);
  const base = projection.record;
  const remaining = base ? projection.messages : rows;
  const prior = remaining.slice(0, -1);
  const priorVisible = prior.filter((message) => !isInternalRow(message));
  if (priorVisible.length <= RECONCILE_ABOVE_ROWS || !hasUnreconciledMainHistory(remaining)) {
    return null;
  }
  const keepFrom = priorVisible.length - TAIL_TARGET_ROWS;
  let visibleIndex = -1;
  let bytes = 0;
  let boundary = -1;
  let boundaryBytes = 0;
  for (let index = 0; index < prior.length; index += 1) {
    const message = prior[index];
    if (isInternalRow(message)) continue;
    visibleIndex += 1;
    if (visibleIndex >= keepFrom) break;
    bytes += Buffer.byteLength(messageContentText(message), 'utf8');
    if (bytes > sourceTargetBytes && boundary >= 0) break;
    if (isAssistantRow(message)) {
      boundary = index;
      boundaryBytes = bytes;
    }
  }
  if (boundary < 0) return null;
  const spanRows = prior.slice(0, boundary + 1);
  const newlyCovered = spanRows
    .filter((message) => !isInternalRow(message))
    .map((message) => ({ id: String(message.messageId), sha256: rowDigest(message) }));
  const coveredSource = [
    ...(base ? base.coveredSource.map((row) => ({ id: row.id, sha256: row.sha256 })) : []),
    ...newlyCovered,
  ];
  const sourceTurns = buildClaimTurns(spanRows);
  const previousSemanticCompaction = base ? base.semanticCompaction : null;
  return {
    recordVersion: record ? Number(record.version) || 0 : null,
    throughMessageId: String(spanRows[boundary].messageId),
    coveredSource,
    coveredDigest: coveredSourceDigest(coveredSource),
    previousSemanticCompaction,
    sourceTurns,
    sourceBytes: boundaryBytes,
    sourceDigest: sha256(
      JSON.stringify({
        version: 1,
        previousCoveredDigest: base ? base.coveredDigest : '',
        coveredSource: newlyCovered,
        sourceTurns,
      }),
    ),
  };
}

function createConversationContinuityStore({ Model, MessageModel, now = () => new Date() }) {
  async function load(ownerId, conversationId) {
    return Model.findOne({ ownerId, conversationId }).lean();
  }

  async function claim({ ownerId, conversationId, plan, leaseId }) {
    const checkedAt = now();
    const lease = {
      leaseId,
      sourceDigest: plan.sourceDigest,
      throughMessageId: plan.throughMessageId,
      expiresAt: new Date(checkedAt.getTime() + MAIN_COMPACTION_LEASE_MS),
      ...(plan.outputContract ? { outputContract: plan.outputContract } : {}),
    };
    if (plan.recordVersion == null) {
      try {
        await Model.create({ ownerId, conversationId, version: 1, status: 'empty', lease });
        return lease;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        return null;
      }
    }
    const result = await Model.updateOne(
      {
        ownerId,
        conversationId,
        version: plan.recordVersion,
        $or: [{ lease: null }, { 'lease.expiresAt': { $lte: checkedAt } }],
      },
      { $set: { lease }, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1 ? lease : null;
  }

  async function renew({
    ownerId,
    conversationId,
    leaseId,
    sourceDigest,
    leaseExpiresAt,
    expiresAt: requestedExpiresAt,
  }) {
    const checkedAt = now();
    const expiresAt = boundedMainCompactionLeaseRenewal({
      leaseExpiresAt,
      requestedExpiresAt,
      now: checkedAt.getTime(),
    });
    if (!expiresAt) return { status: 'stale_lease' };
    const result = await Model.updateOne(
      {
        ownerId,
        conversationId,
        'lease.leaseId': leaseId,
        'lease.sourceDigest': sourceDigest,
        'lease.expiresAt': new Date(leaseExpiresAt),
        $expr: { $gt: ['$lease.expiresAt', '$$NOW'] },
      },
      { $set: { 'lease.expiresAt': expiresAt }, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1
      ? { status: 'renewed', leaseExpiresAt: expiresAt }
      : { status: 'stale_lease' };
  }

  async function complete({
    ownerId,
    conversationId,
    plan,
    leaseId,
    semanticCompaction,
    review,
    inspectCandidateCarrier,
  }) {
    if (plan.outputContract) {
      const prepared = inspectMainCompactionCandidate(semanticCompaction, plan.outputContract);
      const fit =
        prepared.ok &&
        (inspectCandidateCarrier
          ? await inspectCandidateCarrier({
              candidate: prepared.candidate,
              claim: { outputContract: plan.outputContract },
            })
          : inspectMainCompactionCarrier(prepared.candidate, plan.outputContract));
      if (
        !prepared.ok ||
        !fit.ok ||
        review?.approved !== true ||
        review.sourceDigest !== plan.sourceDigest ||
        review.candidateDigest !== mainCompactionCandidateDigest(prepared.candidate) ||
        review.outputContractDigest !== mainCompactionOutputContractDigest(plan.outputContract)
      )
        return { status: 'invalid_summary', reason: 'context_budget' };
    }
    // Promote only while every covered row still has the exact content the summary was built on.
    const ids = plan.coveredSource.map((row) => row.id);
    const stored = await MessageModel.find({
      user: ownerId,
      conversationId,
      messageId: { $in: ids },
    })
      .select('messageId role isCreatedByUser text content metadata')
      .lean();
    const byId = new Map((stored || []).map((row) => [String(row.messageId), row]));
    const unchanged = plan.coveredSource.every((row) => {
      const message = byId.get(row.id);
      return message && rowDigest(message) === row.sha256;
    });
    if (!unchanged) {
      await Model.updateOne(
        { ownerId, conversationId, 'lease.leaseId': leaseId },
        { $set: { lease: null, lastError: 'stale_source' }, $inc: { version: 1 } },
      );
      return { status: 'stale_source' };
    }
    const result = await Model.updateOne(
      {
        ownerId,
        conversationId,
        'lease.leaseId': leaseId,
        'lease.sourceDigest': plan.sourceDigest,
      },
      {
        $set: {
          status: 'ready',
          throughMessageId: plan.throughMessageId,
          coveredSource: plan.coveredSource,
          coveredDigest: plan.coveredDigest,
          semanticCompaction,
          ...(plan.outputContract ? { semanticCompactionContract: plan.outputContract } : {}),
          semanticReview: { ...review, reviewedAt: now().toISOString() },
          lease: null,
          lastError: '',
        },
        $inc: { version: 1 },
      },
    );
    return result.modifiedCount === 1 ? { status: 'compacted' } : { status: 'lease_lost' };
  }

  async function reject({ ownerId, conversationId, leaseId, reason }) {
    const lastError = String(reason || 'compaction_rejected').slice(0, 500);
    // A reviewed summary from an earlier claim stays valid for its own prefix.
    await Model.updateOne(
      { ownerId, conversationId, 'lease.leaseId': leaseId, status: { $ne: 'ready' } },
      { $set: { status: 'degraded' } },
    );
    await Model.updateOne(
      { ownerId, conversationId, 'lease.leaseId': leaseId },
      { $set: { lease: null, lastError }, $inc: { version: 1 } },
    );
  }

  return { load, claim, renew, complete, reject };
}

/**
 * Reconcile this conversation's legacy prefix with the existing compaction runner until its
 * unsummarized visible rows fit, an unaccepted claim cannot shrink, or the per-turn budget ends.
 */
async function ensureConversationLegacyContinuity({
  req,
  res,
  agent,
  ownerId,
  conversationId,
  orderedMessages,
  Model,
  MessageModel,
  compaction = require('./ViventiumMainCompactionService'),
  executeCompactor,
  signal,
  resolveOutputCarrier,
  deadlineAt = req?.viventiumSchedulerAuthoringDeadlineAt,
  maxClaims = MAX_CLAIMS_PER_TURN,
  foreground = true,
} = {}) {
  const store = createConversationContinuityStore({ Model, MessageModel });
  let record = await store.load(ownerId, conversationId);
  const domainEpochKey = sha256(['conversation-continuity', ownerId, conversationId].join('\n'));
  let sourceTargetBytes = MAIN_COMPACTION_SOURCE_TARGET_BYTES;
  const executionBudget = {};
  const contractFor = async (plan) => {
    const carrier = resolveOutputCarrier
      ? await resolveOutputCarrier()
      : { carrierMaxUtf8Bytes: 16 * 1024, reservedContextUtf8Bytes: 0 };
    return conversationMainCompactionOutputContract({
      ...carrier,
      coveredRows: plan.coveredSource.length,
    });
  };
  for (let index = 0; index < maxClaims; index += 1) {
    if (signal?.aborted) break;
    if (!planConversationContinuityClaim({ record, orderedMessages, sourceTargetBytes })) break;
    let plan = null;
    const result = await compaction.ensureAcceptedMainCompaction({
      trigger: 'conversation_legacy',
      foreground,
      ownerId,
      agentId: String(agent?.id || ''),
      // Keeps this conversation's learned claim size separate from the Main domain's.
      stableAuthoritySha256: `conversation-continuity:${sha256(conversationId)}`,
      req,
      res,
      agent,
      signal,
      deadlineAt,
      executionBudget,
      ...(executeCompactor ? { executeCompactor } : {}),
      claimCompaction: async (input) => {
        record = await store.load(ownerId, conversationId);
        plan = planConversationContinuityClaim({
          record,
          orderedMessages,
          sourceTargetBytes: input?.sourceTargetBytes || sourceTargetBytes,
        });
        if (!plan) return { status: 'not_needed' };
        const outputContract = await contractFor(plan);
        if (!outputContract) return { status: 'degraded', reason: 'context_budget' };
        plan = { ...plan, outputContract };
        const smaller = planConversationContinuityClaim({
          record,
          orderedMessages,
          sourceTargetBytes: Math.max(1, Math.floor(plan.sourceBytes / 2)),
        });
        const canReduceSource = Boolean(
          smaller &&
          smaller.sourceBytes < plan.sourceBytes &&
          smaller.sourceDigest !== plan.sourceDigest,
        );
        const lease = await store.claim({
          ownerId,
          conversationId,
          plan,
          leaseId: crypto.randomUUID(),
        });
        if (!lease) return { status: 'busy' };
        return {
          status: 'claimed',
          leaseId: lease.leaseId,
          leaseExpiresAt: lease.expiresAt,
          domainEpochKey,
          sourceDigest: plan.sourceDigest,
          sourceBytes: plan.sourceBytes,
          previousSemanticCompaction: plan.previousSemanticCompaction,
          sourceTurns: plan.sourceTurns,
          outputContract,
          canReduceSource,
        };
      },
      renewCompaction: (input) => store.renew({ ...input, ownerId, conversationId }),
      inspectCandidateCarrier: async ({ candidate }) => {
        const currentContract = await contractFor(plan);
        return inspectMainCompactionCarrier(candidate, currentContract);
      },
      completeCompaction: async (input) => {
        const result = await store.complete({
          ownerId,
          conversationId,
          plan,
          leaseId: input.leaseId,
          semanticCompaction: input.semanticCompaction,
          review: input.semanticReview,
          inspectCandidateCarrier: async ({ candidate }) =>
            inspectMainCompactionCarrier(candidate, await contractFor(plan)),
        });
        if (foreground || result.status !== 'compacted') return result;
        record = await store.load(ownerId, conversationId);
        return {
          ...result,
          continuationPending: Boolean(
            planConversationContinuityClaim({
              record,
              orderedMessages,
            }),
          ),
        };
      },
      rejectCompaction: (input) =>
        store.reject({ ownerId, conversationId, leaseId: input.leaseId, reason: input.reason }),
    });
    record = await store.load(ownerId, conversationId);
    if (!foreground) break;
    if (result?.status !== 'compacted') {
      logger.warn('[VIVENTIUM][conversation-continuity] Legacy history not reconciled', {
        status: String(result?.status || 'unknown').slice(0, 80),
        reason: String(result?.reason || '').slice(0, 160),
      });
      // A model-owned rejection may shrink the next whole-turn prefix within this same bounded
      // wake. Transport, lease and unchanged indivisible-source failures do not start another claim.
      const nextTarget = result?.nextSourceTargetBytes;
      const smaller =
        Number.isInteger(nextTarget) && nextTarget > 0 && plan
          ? planConversationContinuityClaim({
              record,
              orderedMessages,
              sourceTargetBytes: nextTarget,
            })
          : null;
      if (
        !smaller ||
        smaller.sourceBytes >= plan.sourceBytes ||
        smaller.sourceDigest === plan.sourceDigest
      )
        break;
      sourceTargetBytes = nextTarget;
      continue;
    }
    sourceTargetBytes = MAIN_COMPACTION_SOURCE_TARGET_BYTES;
  }
  return record;
}

/**
 * Resolve this turn's carried history: an exact reviewed prefix summary plus intact newer rows,
 * deferring migration while the existing Native admission guard carries all unreconciled rows.
 */
async function resolveConversationContinuity({
  req,
  res,
  agent,
  ownerId,
  conversationId,
  orderedMessages,
  Model = require('~/db/models').ViventiumConversationContinuity,
  MessageModel = require('~/db/models').Message,
  nativeBodyCarrier = false,
  nativeReplayBudgetKnown = false,
  ...options
} = {}) {
  const rows = Array.isArray(orderedMessages) ? orderedMessages : [];
  if (!ownerId || !conversationId || conversationId === 'new' || !agent?.id) return null;
  // Short or fully Core-stamped histories are carried as they are.
  if (rows.length <= TAIL_TARGET_ROWS || !hasUnreconciledMainHistory(rows)) return null;
  let record = await Model.findOne({ ownerId, conversationId }).lean();
  const existing = projectConversationContinuity(record, rows);
  // A positive conservative fit permits reuse of an exact reviewed prefix and intact tail.
  // False or unavailable estimates retain the existing reconciliation/admission owners;
  // this estimate is not the Native rendered-source limit and cannot reject a turn.
  const fits =
    typeof options.canCarryWholeHistory === 'function' &&
    (await options.canCarryWholeHistory(
      existing.record ? existing.messages : rows,
      existing.record ? existing.capsule : '',
    )) === true;
  if (fits && !(nativeBodyCarrier === true && nativeReplayBudgetKnown === true)) {
    return existing.record ? existing : null;
  }
  if (planConversationContinuityClaim({ record, orderedMessages: rows })) {
    if (nativeBodyCarrier === true && nativeReplayBudgetKnown === true && fits) {
      const compaction = options.compaction || require('./ViventiumMainCompactionService');
      compaction.scheduleMainContinuityMaintenance({
        ownerId,
        agentId: String(agent.id),
        stableAuthoritySha256: `conversation-continuity:${sha256(conversationId)}`,
        schedule: () => {
          // The idle owner has its own response and budget, independent of the finished request.
          const backgroundReq = Object.create(req || null);
          backgroundReq.viventiumSchedulerAuthoringDeadlineAt = undefined;
          return ensureConversationLegacyContinuity({
            ...options,
            req: backgroundReq,
            res: undefined,
            agent,
            ownerId,
            conversationId,
            orderedMessages: rows,
            Model,
            MessageModel,
            compaction,
            foreground: false,
            signal: undefined,
            deadlineAt: undefined,
          });
        },
      });
    } else {
      record = await ensureConversationLegacyContinuity({
        req,
        res,
        agent,
        ownerId,
        conversationId,
        orderedMessages: rows,
        Model,
        MessageModel,
        ...options,
      });
    }
  }
  const projection = projectConversationContinuity(record, rows);
  return projection.coveredIds.length > 0 ? projection : null;
}

module.exports = {
  RECONCILE_ABOVE_ROWS,
  TAIL_TARGET_ROWS,
  buildClaimTurns,
  createConversationContinuityStore,
  ensureConversationLegacyContinuity,
  planConversationContinuityClaim,
  projectConversationContinuity,
  renderConversationContinuityCapsule,
  resolveConversationContinuity,
  rowDigest,
};
