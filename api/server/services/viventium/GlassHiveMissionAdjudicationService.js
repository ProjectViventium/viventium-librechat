/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication.
 * Purpose:
 * - Keep worker callbacks as neutral lifecycle/status events.
 * - Persist terminal worker evidence before acknowledgement.
 * - Coalesce terminal evidence for two seconds per account, then feed it into the existing
 *   configured Main/Phase-B follow-up machinery. Semantic {NTA}/redundancy may stay silent, but a
 *   useful mission result is not discarded merely because presentation moved to a newer turn.
 * - Leave a restart-safe pending/failed ledger that can be reconciled without replaying prose.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { getConvo, getUserById, saveConvo } = require('~/models');
const { getAgent } = require('~/models/Agent');
const { getAppConfig } = require('~/server/services/Config');
const {
  createCortexFollowUpMessage,
} = require('~/server/services/viventium/BackgroundCortexFollowUpService');
const {
  isGlassHiveWorkTerminalCallback,
  recordGlassHiveAdjudicationOutcome,
} = require('./GlassHiveCallbackBindingService');
const { sanitizeGlassHiveCallbackText } = require('./GlassHiveCallbackSanitizer');

const COLLECTION = 'viventium_glasshive_mission_evidence';
const COALESCE_MS = 2000;
const MAX_EVIDENCE_CHARS = 64_000;
const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';
const ownerTimers = new Map();

function collection() {
  return mongoose.connection.collection(COLLECTION);
}

function safeText(value, maxLength = 512) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function legacyEvidenceId(body = {}) {
  const callbackId = safeText(body.callback_id, 160);
  if (callbackId) return callbackId;
  return `ghe_${crypto
    .createHash('sha256')
    .update(
      [body.origin_ref, body.work_ref, body.worker_id, body.run_id, body.event, body.callback_ts]
        .map((value) => safeText(value, 4096))
        .join('\0'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function evidenceId({ ownerId, originRef, body = {} }) {
  // A GlassHive callback id is stable within its producer, but it is not a global tenant-scoped
  // identity. Hash it with the verified Core owner/origin so one tenant cannot suppress another
  // tenant's terminal evidence by reusing the same vendor callback id.
  return `ghe_${crypto
    .createHash('sha256')
    .update(
      [safeText(ownerId, 160), safeText(originRef, 160), legacyEvidenceId(body)].join('\0'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

function terminalEvidence(body = {}) {
  const event = safeText(body.event, 64);
  if (!['run.completed', 'run.failed'].includes(event)) return '';
  if (!isGlassHiveWorkTerminalCallback(body)) return '';
  const full = sanitizeGlassHiveCallbackText(body.full_message, {
    maxLength: MAX_EVIDENCE_CHARS,
  });
  const preview = sanitizeGlassHiveCallbackText(body.message, {
    maxLength: MAX_EVIDENCE_CHARS,
  });
  const text = full || preview;
  if (text) return text;
  if (event === 'run.failed') {
    const code = safeText(
      body.failure_code || body.failure_class || body.error_code || body?.error?.code,
      120,
    );
    return code ? `Mission failed with structured code ${code}.` : 'Mission failed.';
  }
  return 'Mission completed without additional textual evidence.';
}

function normalizedSurface(binding = {}) {
  const surfaces = (Array.isArray(binding.destinations) ? binding.destinations : [])
    .map((destination) => safeText(destination?.surface, 32).toLowerCase())
    .filter(Boolean);
  return surfaces.includes('voice')
    ? 'voice'
    : surfaces.includes('telegram')
      ? 'telegram'
      : 'web';
}

function safeDestinations(binding = {}) {
  return (Array.isArray(binding.destinations) ? binding.destinations : [])
    .filter((destination) => ['telegram', 'voice'].includes(safeText(destination?.surface, 32)))
    .map((destination) => ({
      surface: safeText(destination.surface, 32),
      telegramChatId: safeText(destination.telegramChatId, 160),
      telegramUserId: safeText(destination.telegramUserId, 160),
      telegramMessageId: safeText(destination.telegramMessageId, 160),
      voiceCallSessionId: safeText(destination.voiceCallSessionId, 160),
      voiceRequestId: safeText(destination.voiceRequestId, 160),
      unresolvedReason: safeText(destination.unresolvedReason, 120),
    }));
}

async function persistGlassHiveMissionEvidence({ binding, body = {} } = {}) {
  const evidence = terminalEvidence(body);
  const originRef = safeText(binding?.originRef || body.origin_ref, 160);
  const ownerId = safeText(binding?.ownerId, 160);
  const conversationId = safeText(binding?.conversationId, 160);
  const anchorMessageId = safeText(binding?.anchorMessageId, 160);
  if (!evidence || !originRef || !ownerId || !conversationId || !anchorMessageId) return null;
  const now = new Date();
  const id = evidenceId({ ownerId, originRef, body });
  const legacyId = legacyEvidenceId(body);
  const row = {
    _id: id,
    evidenceId: id,
    originRef,
    workRef: safeText(binding?.workRef || body.work_ref, 160),
    workerId: safeText(body.worker_id, 160),
    runId: safeText(body.run_id, 160),
    event: safeText(body.event, 64),
    ownerId,
    conversationId,
    anchorMessageId,
    mainAgentId: safeText(binding?.mainAgentId, 160),
    surface: normalizedSurface(binding),
    destinations: safeDestinations(binding),
    evidence,
    state: 'pending',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  await collection().updateOne(
    {
      $or: [
        { _id: id },
        // VIVENTIUM: Reuse a pre-upgrade unscoped row only for the exact verified owner+origin.
        // A bare legacy callback id is never sufficient association or authorization.
        { _id: legacyId, ownerId, originRef },
      ],
    },
    { $setOnInsert: row },
    { upsert: true },
  );
  return row;
}

function scheduleOwnerAdjudication(ownerId) {
  const key = safeText(ownerId, 160);
  if (!key || ownerTimers.has(key)) return;
  const timer = setTimeout(() => {
    ownerTimers.delete(key);
    flushGlassHiveMissionAdjudications({ ownerId: key }).catch((error) => {
      logger.warn('[VIVENTIUM][glasshive-adjudication] Account flush failed', {
        code: safeText(error?.code || error?.name || 'flush_failed', 120),
      });
    });
  }, COALESCE_MS);
  timer.unref?.();
  ownerTimers.set(key, timer);
}

async function enqueueGlassHiveMissionAdjudication({ binding, body = {} } = {}) {
  const row = await persistGlassHiveMissionEvidence({ binding, body });
  if (row) scheduleOwnerAdjudication(row.ownerId);
  return row;
}

function groupKey(row) {
  return [
    row.ownerId,
    row.conversationId,
    row.mainAgentId,
    row.surface,
    row.followUpMessageId || 'new',
  ].join('\0');
}

async function claimRows(rows) {
  const claimed = [];
  for (const row of rows) {
    const result = await collection().findOneAndUpdate(
      { _id: row._id, state: 'pending' },
      {
        $set: { state: 'processing', processingAt: new Date(), updatedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { returnDocument: 'after' },
    );
    const value = result?.value || result;
    if (value?._id) claimed.push(value);
  }
  return claimed;
}

async function loadMainAuthorContext(first) {
  const [user, agent] = await Promise.all([
    getUserById(first.ownerId, '-password -__v -totpSecret -backupCodes'),
    first.mainAgentId ? getAgent({ id: first.mainAgentId }) : null,
  ]);
  if (!user || !agent) {
    const error = new Error('mission_main_author_unavailable');
    error.code = 'mission_main_author_unavailable';
    throw error;
  }
  return {
    user,
    agent,
    req: {
      user,
      body: { viventiumSurface: first.surface },
      headers: { 'x-viventium-surface': first.surface },
      config: await getAppConfig({ role: user.role }),
    },
  };
}

async function resolveMissionContinuationTarget(rows) {
  const first = rows[rows.length - 1];
  const originConversation = await getConvo(
    first.ownerId,
    first.conversationId,
    'conversationId',
  );
  if (originConversation) {
    return {
      conversationId: first.conversationId,
      parentMessageId: first.anchorMessageId,
      accountContinuation: false,
    };
  }

  const persistedConversationId = rows
    .map((row) => safeText(row.accountContinuationConversationId, 160))
    .find(Boolean);
  const conversationId = persistedConversationId || crypto.randomUUID();
  const now = new Date();
  await Promise.all(
    rows.map(async (row) => {
      row.accountContinuationConversationId = conversationId;
      row.accountContinuationAnchorMessageId = NO_PARENT_MESSAGE_ID;
      await collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            accountContinuationConversationId: conversationId,
            accountContinuationAnchorMessageId: NO_PARENT_MESSAGE_ID,
            originConversationDeletedAt: row.originConversationDeletedAt || now,
            updatedAt: now,
          },
        },
      );
    }),
  );
  return {
    conversationId,
    parentMessageId: NO_PARENT_MESSAGE_ID,
    accountContinuation: true,
  };
}

async function synthesizeGroup(rows, { target, authorContext }) {
  // The owner-wide timer opens one coalescing window. Keep conversation/surface boundaries safe,
  // and anchor the combined continuation to the latest mission turn within that destination.
  const { req, agent } = authorContext;
  return createCortexFollowUpMessage({
    req,
    conversationId: target.conversationId,
    parentMessageId: target.parentMessageId,
    agent,
    insightsData: {
      insights: rows.map((row) => ({
        cortexName: 'Mission evidence',
        insight: row.evidence,
        maxPromptChars: 12_000,
      })),
      errors: [],
      cortexCount: rows.length,
    },
    recentResponse: '',
    forceVisibleFollowUp: false,
    allowMovedOnUsefulFollowUp: true,
  });
}

async function ensureAccountContinuationConversation({ target, authorContext, followUp }) {
  if (!target.accountContinuation || !followUp?.messageId) return;
  const saved = await saveConvo(
    authorContext.req,
    {
      conversationId: target.conversationId,
      title: 'Background work',
      endpoint: 'agents',
      agent_id: authorContext.agent?.id,
      model: authorContext.agent?.id || authorContext.agent?.model || '',
    },
    {
      context:
        'viventium/services/GlassHiveMissionAdjudicationService.accountContinuation',
    },
  );
  if (!saved || saved.message === 'Error saving conversation') {
    const error = new Error('mission_account_continuation_persist_failed');
    error.code = 'mission_account_continuation_persist_failed';
    throw error;
  }
}

async function finishRows(rows, { state, followUpMessageId = '', errorCode = '' }) {
  const now = new Date();
  await Promise.all(
    rows.map(async (row) => {
      await collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            state,
            followUpMessageId,
            errorCode,
            updatedAt: now,
            ...(['failed', 'delivery_pending'].includes(state)
              ? { nextAttemptAt: new Date(Date.now() + 30_000) }
              : {}),
          },
        },
      );
      await recordGlassHiveAdjudicationOutcome({
        originRef: row.originRef,
        state: state === 'delivery_pending' ? 'failed' : state,
        followUpMessageId,
        errorCode,
      });
    }),
  );
}

async function persistAuthoredFollowUp(rows, followUp) {
  const followUpMessageId = safeText(followUp?.messageId, 160);
  const followUpText = safeText(followUp?.text, MAX_EVIDENCE_CHARS);
  if (!followUpMessageId) return;
  await Promise.all(
    rows.map((row) =>
      collection().updateOne(
        { _id: row._id, state: 'processing' },
        {
          $set: {
            followUpMessageId,
            followUpText,
            authoredAt: new Date(),
            updatedAt: new Date(),
          },
        },
      ),
    ),
  );
}

async function enqueueMainAuthoredFollowUpDelivery({ row, followUp, target }) {
  if (!followUp?.messageId) return null;
  const { enqueueGlassHiveCallbackDelivery } = require('./GlassHiveCallbackDeliveryService');
  const summary = await enqueueGlassHiveCallbackDelivery({
    body: {
      callback_id: `main:${row.originRef}:${followUp.messageId}`,
      event: 'main.followup',
      origin_ref: row.originRef,
      work_ref: row.workRef,
      worker_id: row.workerId,
      run_id: row.runId,
    },
    message: followUp,
    text: safeText(followUp.text, MAX_EVIDENCE_CHARS),
    fullText: '',
    deliveryContext: {
      ownerId: row.ownerId,
      originRef: row.originRef,
      workRef: row.workRef,
      conversationId: target?.conversationId || row.conversationId,
      anchorMessageId: target?.parentMessageId || row.anchorMessageId,
      requestedParentMessageId: target?.parentMessageId || row.anchorMessageId,
      destinations:
        Array.isArray(row.destinations) ? row.destinations : [],
    },
  });
  if (
    Number(summary?.configured) > 0 &&
    (Number(summary?.enqueued) === 0 || Number(summary?.unresolved) > 0) &&
    summary?.deferredToMain !== true
  ) {
    const error = new Error('mission_surface_delivery_unresolved');
    error.code = 'mission_surface_delivery_unresolved';
    throw error;
  }
  return summary;
}

async function persistSilentTerminalDeliveries({ rows, target }) {
  const { enqueueGlassHiveCallbackDelivery } = require('./GlassHiveCallbackDeliveryService');
  for (const row of rows) {
    const stableEvidenceId = safeText(row.evidenceId || row._id, 160);
    const messageId = `silent:${stableEvidenceId}`;
    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: `main:${row.originRef}:${messageId}`,
        event: 'main.followup',
        origin_ref: row.originRef,
        work_ref: row.workRef,
        worker_id: row.workerId,
        run_id: row.runId,
      },
      message: {
        messageId,
        text: '',
        metadata: { viventium: { callbackKey: messageId } },
      },
      text: '',
      fullText: '',
      suppress: true,
      deliveryContext: {
        ownerId: row.ownerId,
        originRef: row.originRef,
        workRef: row.workRef,
        conversationId: target?.conversationId || row.conversationId,
        anchorMessageId: target?.parentMessageId || row.anchorMessageId,
        requestedParentMessageId: target?.parentMessageId || row.anchorMessageId,
        destinations: Array.isArray(row.destinations) ? row.destinations : [],
      },
    });
    if (
      Number(summary?.configured) > 0 &&
      (Number(summary?.enqueued) === 0 || Number(summary?.unresolved) > 0)
    ) {
      const error = new Error('mission_surface_delivery_unresolved');
      error.code = 'mission_surface_delivery_unresolved';
      throw error;
    }
  }
}

async function flushGlassHiveMissionAdjudications({ ownerId, limit = 50 } = {}) {
  const key = safeText(ownerId, 160);
  if (!key) return { claimed: 0, groups: 0, visible: 0, silent: 0, failed: 0 };
  const cursor = collection()
    .find({ ownerId: key, state: 'pending' })
    .sort({ createdAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 50, 100)));
  const pending = await cursor.toArray();
  const claimed = await claimRows(pending);
  const groups = new Map();
  for (const row of claimed) {
    const group = groupKey(row);
    groups.set(group, [...(groups.get(group) || []), row]);
  }
  const summary = { claimed: claimed.length, groups: groups.size, visible: 0, silent: 0, failed: 0 };
  for (const rows of groups.values()) {
    let followUp = null;
    try {
      const target = await resolveMissionContinuationTarget(rows);
      let authorContext = null;
      const storedMessageId = safeText(rows[0]?.followUpMessageId, 160);
      if (storedMessageId && rows.every((row) => row.followUpMessageId === storedMessageId)) {
        followUp = {
          messageId: storedMessageId,
          text: safeText(rows[0]?.followUpText, MAX_EVIDENCE_CHARS),
        };
      } else {
        authorContext = await loadMainAuthorContext(rows[rows.length - 1]);
        followUp = await synthesizeGroup(rows, { target, authorContext });
        await persistAuthoredFollowUp(rows, followUp);
      }
      const state = followUp?.messageId ? 'completed' : 'silent';
      if (followUp?.messageId) {
        if (target.accountContinuation) {
          authorContext ||= await loadMainAuthorContext(rows[rows.length - 1]);
          await ensureAccountContinuationConversation({ target, authorContext, followUp });
        }
        await enqueueMainAuthoredFollowUpDelivery({
          row: rows[rows.length - 1],
          followUp,
          target,
        });
      } else {
        // Semantic silence still owns one durable per-surface ledger row. This keeps terminal
        // delivery truth independent from generated `{NTA}` prose and makes replay insert-once.
        await persistSilentTerminalDeliveries({ rows, target });
      }
      await finishRows(rows, { state, followUpMessageId: safeText(followUp?.messageId, 160) });
      summary[state === 'completed' ? 'visible' : 'silent'] += rows.length;
    } catch (error) {
      const errorCode = safeText(error?.code || error?.name || 'mission_adjudication_failed', 120);
      await finishRows(rows, {
        state: followUp?.messageId ? 'delivery_pending' : 'failed',
        followUpMessageId: safeText(followUp?.messageId, 160),
        errorCode,
      });
      summary.failed += rows.length;
    }
  }
  return summary;
}

async function reconcilePendingGlassHiveMissionAdjudications({ limit = 100 } = {}) {
  const rows = await collection()
    .find({
      $or: [
        { state: 'pending' },
        { state: 'failed', nextAttemptAt: { $lte: new Date() } },
        { state: 'delivery_pending', nextAttemptAt: { $lte: new Date() } },
        { state: 'processing', processingAt: { $lte: new Date(Date.now() - 5 * 60_000) } },
      ],
    })
    .sort({ updatedAt: 1 })
    .limit(Math.max(1, Math.min(Number(limit) || 100, 500)))
    .toArray();
  const owners = new Set();
  for (const row of rows) {
    const ownerId = safeText(row.ownerId, 160);
    if (!ownerId) continue;
    owners.add(ownerId);
    if (row.state !== 'pending') {
      await collection().updateOne(
        { _id: row._id, state: row.state },
        { $set: { state: 'pending', updatedAt: new Date() } },
      );
    }
    scheduleOwnerAdjudication(ownerId);
  }
  return { rows: rows.length, owners: owners.size };
}

function clearAdjudicationTimersForTests() {
  for (const timer of ownerTimers.values()) clearTimeout(timer);
  ownerTimers.clear();
}

module.exports = {
  COALESCE_MS,
  clearAdjudicationTimersForTests,
  enqueueGlassHiveMissionAdjudication,
  flushGlassHiveMissionAdjudications,
  persistGlassHiveMissionEvidence,
  reconcilePendingGlassHiveMissionAdjudications,
};
