/* === VIVENTIUM START === Thin adapter for typed Cortex insight delivery. === VIVENTIUM END === */

const mongoose = require('mongoose');
const {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS,
  buildCortexInsightDeliveryCandidates,
  cortexInsightPersistenceEnvelopeIdentity,
  createCortexInsightDeliveryService,
  confirmVoiceCortexPresentation,
  prepareVoiceCortexPresentation,
  normalizeCortexFeelingSnapshot,
  requireExactCortexInsightDeliveryAcceptance,
  requireExactCortexInsightPersistenceEnvelope,
  requireExactCortexInsightDeliverySettlement,
  requiredSurfacesFor,
  selectClaimedCortexInsights,
  resolveCortexRuntimeSlotIdentity,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Message, ViventiumCortexInsightDelivery } = require('~/db/models');

/* === VIVENTIUM START ===
 * Fix: A persisted Cortex follow-up records its delivery as `pending` in its own and its parent's
 * decision metadata. Once the ledger settles every row that message presents, that metadata takes
 * the ledger's exact terminal outcome (`sent`, or `dropped` with its reason), so stored state agrees
 * with what was delivered. S0215's dropped correction still read `pending`. The ledger remains the
 * authority: this reflection only follows a settlement and never changes one.
 * === VIVENTIUM END === */
const TERMINAL_DELIVERY_STATUSES = new Set(['sent', 'dropped']);
const TERMINAL_SETTLEMENTS = [
  'markPresented',
  'finalizePresented',
  'markSent',
  'markPresentationByParent',
  'markDropped',
];

function latestTerminalAt(rows) {
  const times = rows
    .map((row) => new Date(row?.sentAt || row?.droppedAt || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0);
  return new Date(times.length > 0 ? Math.max(...times) : Date.now()).toISOString();
}

function createFollowUpTerminalOutcomeRecorder({ service, MessageModel }) {
  /** Records the ledger's terminal outcome on every follow-up of one parent whose rows all settled. */
  async function recordParent(ownerId, parentMessageId) {
    const userId = String(ownerId || '').trim();
    const parent = String(parentMessageId || '').trim();
    if (!userId || !parent || !MessageModel) return 0;
    const byMessage = new Map();
    for (const row of await service.listByParent({ ownerId: userId, parentMessageId: parent })) {
      const persistedMessageId = String(row?.persistedMessageId || '').trim();
      if (!persistedMessageId) continue;
      byMessage.set(persistedMessageId, [...(byMessage.get(persistedMessageId) || []), row]);
    }
    let recorded = 0;
    for (const [persistedMessageId, rows] of byMessage) {
      const statuses = new Set(rows.map((row) => row?.status));
      const [deliveryStatus] = statuses;
      if (statuses.size !== 1 || !TERMINAL_DELIVERY_STATUSES.has(deliveryStatus)) continue;
      const result = await MessageModel.updateMany(
        {
          user: userId,
          messageId: { $in: [persistedMessageId, parent] },
          'metadata.viventium.cortexFollowUpDecision.persistedMessageId': persistedMessageId,
          'metadata.viventium.cortexFollowUpDecision.deliveryStatus': 'pending',
        },
        {
          $set: {
            'metadata.viventium.cortexFollowUpDecision.deliveryStatus': deliveryStatus,
            'metadata.viventium.cortexFollowUpDecision.dropReason':
              deliveryStatus === 'dropped' ? String(rows[0]?.dropReason || '') : '',
            'metadata.viventium.cortexFollowUpDecision.terminalAt': latestTerminalAt(rows),
          },
        },
      );
      recorded += Number(result?.modifiedCount ?? result?.nModified ?? 0) || 0;
    }
    return recorded;
  }
  return { recordParent };
}

function withFollowUpTerminalOutcome(service, { MessageModel } = {}) {
  const { recordParent } = createFollowUpTerminalOutcomeRecorder({ service, MessageModel });

  async function recordTerminalOutcome(ownerId, settledRows) {
    const parents = new Set(
      (Array.isArray(settledRows) ? settledRows : [])
        .filter(
          (row) =>
            TERMINAL_DELIVERY_STATUSES.has(row?.status) &&
            String(row?.persistedMessageId || '').trim(),
        )
        .map((row) => String(row?.parentMessageId || '').trim())
        .filter(Boolean),
    );
    for (const parentMessageId of parents) {
      await recordParent(ownerId, parentMessageId);
    }
  }

  const reflected = { ...service };
  for (const name of TERMINAL_SETTLEMENTS) {
    const settle = service[name];
    if (typeof settle !== 'function') continue;
    reflected[name] = async (input, ...rest) => {
      const settled = await settle(input, ...rest);
      try {
        await recordTerminalOutcome(input?.ownerId, settled);
      } catch (error) {
        logger.warn(
          '[VIVENTIUM][cortex-insight-delivery] Follow-up terminal outcome not recorded',
          {
            code: String(error?.code || error?.name || 'terminal_outcome_unrecorded').slice(0, 120),
          },
        );
      }
      return settled;
    };
  }
  return reflected;
}

/* === VIVENTIUM START ===
 * Fix: A settlement and its metadata reflection are separate writes, and the reflection updates the
 * follow-up and its parent in one multi-document write, so a crash or failed write can leave either
 * one `pending`. The recovery pass walks every retained terminal ledger batch (30-day retention) with
 * a rotating ascending cursor, so each tick makes progress and none is starved by already reflected
 * rows, and it looks up both the follow-up and its parent. It only records the ledger's truth and has
 * no presentation path, so nothing is sent again.
 * === VIVENTIUM END === */
const terminalReconciliationCursors = new WeakMap();

async function reconcileFollowUpTerminalOutcomes({
  service,
  DeliveryModel,
  MessageModel,
  limit = 200,
  cursors = terminalReconciliationCursors,
} = {}) {
  if (!service || !DeliveryModel || !MessageModel) return { scanned: 0, reconciled: 0 };
  const { recordParent } = createFollowUpTerminalOutcomeRecorder({ service, MessageModel });
  const batchSize = Math.max(1, Math.min(Number(limit) || 200, 1000));
  const cursor = cursors.get(DeliveryModel) || null;
  const rows = await DeliveryModel.find({
    status: { $in: [...TERMINAL_DELIVERY_STATUSES] },
    persistedMessageId: { $nin: ['', null] },
    ...(cursor ? { _id: { $gt: cursor } } : {}),
  })
    .select('_id userId parentMessageId persistedMessageId')
    .sort({ _id: 1 })
    .limit(batchSize)
    .lean();
  // A full page continues after its last row next tick; a short page wraps to the oldest row.
  cursors.set(DeliveryModel, (rows || []).length === batchSize ? rows[rows.length - 1]._id : null);
  const followUps = new Map();
  const parents = new Map();
  for (const row of rows || []) {
    const userId = String(row?.userId || '').trim();
    const persistedMessageId = String(row?.persistedMessageId || '').trim();
    const parentMessageId = String(row?.parentMessageId || '').trim();
    if (!userId || !persistedMessageId || !parentMessageId) continue;
    const group = { userId, parentMessageId };
    followUps.set(`${userId}\u0000${persistedMessageId}`, group);
    parents.set(`${userId}\u0000${parentMessageId}\u0000${persistedMessageId}`, group);
  }
  if (followUps.size === 0) return { scanned: 0, reconciled: 0 };
  const messageIds = new Set();
  for (const key of followUps.keys()) messageIds.add(key.split('\u0000')[1]);
  for (const key of parents.keys()) messageIds.add(key.split('\u0000')[1]);
  const pending = await MessageModel.find({
    messageId: { $in: [...messageIds] },
    'metadata.viventium.cortexFollowUpDecision.deliveryStatus': 'pending',
  })
    .select('user messageId metadata.viventium.cortexFollowUpDecision.persistedMessageId')
    .lean();
  let reconciled = 0;
  const reflectedParents = new Set();
  for (const message of pending || []) {
    const user = String(message?.user || '');
    const persistedMessageId = String(
      message?.metadata?.viventium?.cortexFollowUpDecision?.persistedMessageId || '',
    );
    // Either record of the pair may be the one left pending by an interrupted reflection.
    const group =
      followUps.get(`${user}\u0000${message?.messageId}`) ||
      parents.get(`${user}\u0000${message?.messageId}\u0000${persistedMessageId}`);
    const parentKey = group && `${group.userId}\u0000${group.parentMessageId}`;
    if (!group || reflectedParents.has(parentKey)) continue;
    reflectedParents.add(parentKey);
    try {
      reconciled += await recordParent(group.userId, group.parentMessageId);
    } catch (error) {
      logger.warn(
        '[VIVENTIUM][cortex-insight-delivery] Follow-up terminal outcome not reconciled',
        {
          code: String(error?.code || error?.name || 'terminal_outcome_unreconciled').slice(0, 120),
        },
      );
    }
  }
  return { scanned: followUps.size, reconciled };
}

const defaultService = withFollowUpTerminalOutcome(
  createCortexInsightDeliveryService({
    DeliveryModel: ViventiumCortexInsightDelivery,
    mongooseInstance: mongoose,
    consumeFault: (...args) =>
      require('./LocalQaCortexFaultService').consumeLocalQaCortexFault(...args),
  }),
  { MessageModel: Message },
);

/* === VIVENTIUM START === Exact completed playout acknowledges a persisted Cortex message. === */
const voicePresentationDependencies = {
  listByParent: defaultService.listByParent,
  fencePresentationByParent: defaultService.fencePresentationByParent,
  markPresentationByParent: defaultService.markPresentationByParent,
  readMessage: ({ ownerId, conversationId, messageId }) =>
    Message.findOne({
      user: ownerId,
      conversationId,
      messageId,
    }).lean(),
  recordReceipt: async (message, receipt) => {
    const result = await Message.updateOne(
      {
        user: message.user,
        conversationId: message.conversationId,
        messageId: message.messageId,
        text: message.text,
        isCreatedByUser: false,
        error: { $ne: true },
        unfinished: { $ne: true },
        deletedAt: null,
        'metadata.viventium.messageRevision': receipt.revision,
        'metadata.viventium.cortexPresentationGeneration': receipt.generation,
        'metadata.viventium.cortexPresentationClaimToken': receipt.claimToken,
        'metadata.viventium.cortexPresentationParentMessageId': receipt.parentMessageId,
        'metadata.viventium.cortexInsightDeliveryIds':
          message.metadata.viventium.cortexInsightDeliveryIds,
        $or: [
          { 'metadata.viventium.deliveryAcknowledgement.cortexPresentation': { $exists: false } },
          { 'metadata.viventium.deliveryAcknowledgement.cortexPresentation': receipt },
        ],
      },
      { $set: { 'metadata.viventium.deliveryAcknowledgement.cortexPresentation': receipt } },
    );
    return result?.acknowledged !== false && Number(result?.matchedCount ?? result?.n ?? 0) > 0;
  },
};
const confirmCortexVoicePresentation = (input) =>
  confirmVoiceCortexPresentation(input, voicePresentationDependencies);
const prepareCortexVoicePresentation = (input) =>
  prepareVoiceCortexPresentation(input, voicePresentationDependencies);
/* === VIVENTIUM END === */

module.exports = {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS,
  buildCortexInsightDeliveryCandidates,
  cortexInsightPersistenceEnvelopeIdentity,
  createCortexInsightDeliveryService,
  confirmCortexVoicePresentation,
  prepareCortexVoicePresentation,
  withFollowUpTerminalOutcome,
  normalizeCortexFeelingSnapshot,
  requireExactCortexInsightDeliveryAcceptance,
  requireExactCortexInsightPersistenceEnvelope,
  requireExactCortexInsightDeliverySettlement,
  requiredSurfacesFor,
  selectClaimedCortexInsights,
  claimCortexInsightDeliveryBatch: defaultService.claimBatch,
  claimPendingCortexInsightDeliveriesForParent: defaultService.claimPendingByParent,
  deferRecoverableCortexInsightDeliveryParent: defaultService.deferRecoverableParent,
  fenceCortexInsightDeliveryPresentation: defaultService.fencePresentation,
  fenceCortexInsightDeliveryPresentationByParent: defaultService.fencePresentationByParent,
  finalizePresentedCortexInsightDeliveryBatch: defaultService.finalizePresented,
  listRecoverableCortexInsightDeliveryParents: defaultService.listRecoverableParents,
  repairIncompleteCortexInsightDeliveryBatches: defaultService.repairIncompleteBatches,
  getCortexInsightDeliveriesForParent: defaultService.listByParent,
  getCortexInsightDeliveryEventsForParent: defaultService.listEvents,
  markCortexInsightDeliveryBatchDropped: defaultService.markDropped,
  markCortexInsightDeliveryBatchFailed: defaultService.markFailed,
  markCortexInsightDeliveryBatchPersisted: defaultService.markPersisted,
  markCortexInsightDeliveryBatchPresented: defaultService.markPresented,
  markCortexInsightDeliveryPresentationByParent: defaultService.markPresentationByParent,
  markCortexInsightDeliveryPresentationFailedByParent:
    defaultService.markPresentationFailedByParent,
  markCortexInsightDeliveryBatchSent: defaultService.markSent,
  reconcileFollowUpTerminalOutcomes,
  reconcileCortexFollowUpTerminalOutcomes: (options = {}) =>
    reconcileFollowUpTerminalOutcomes({
      service: defaultService,
      DeliveryModel: ViventiumCortexInsightDelivery,
      MessageModel: Message,
      ...options,
    }),
  recordCompletedCortexInsightDeliveryBatch: defaultService.recordBatch,
  resolveCortexRuntimeSlotIdentity,
  renewCortexInsightDeliveryBatchClaim: defaultService.renewClaim,
  cortexInsightDeliveryService: defaultService,
};
