/* === VIVENTIUM START === Native application wiring for typed progress publication. === */
const { createNativeCoordinatorProgressService } = require('@librechat/api');
const failure = (code) => Object.assign(new Error(code), { code, status: 503 });
const defaultDependencies = () => {
  const mongoose = require('mongoose');
  const { Message, ViventiumCortexInsightDelivery } = require('~/db/models');
  const { requestAccountApi } = require('./GlassHiveAccountService');
  const ledger = require('./CortexInsightDeliveryService');
  const bindings = () => mongoose.connection.collection('viventium_glasshive_callback_bindings');
  const request = (ownerId, path) => requestAccountApi({ ownerId, path, maxResponseBytes: null });
  return {
    trace: (record) => {
      const { logger } = require('~/config');
      if (record.stage.endsWith('.reject'))
        logger.warn('[native-coordinator-progress] ' + JSON.stringify(record));
      else logger.info('[native-coordinator-progress] ' + JSON.stringify(record));
    },
    tenantId: () => process.env.VIVENTIUM_TENANT_ID || 'local',
    readBinding: (_id) =>
      bindings().findOne({ _id, kind: 'native_coordinator_binding', active: true }),
    readSource: (bindingRef, turnId) =>
      bindings().findOne({
        _id: `${bindingRef}:${turnId}`,
        kind: 'native_coordinator_source',
        bindingRef,
        turnId,
      }),
    readBindings: (ownerId, conversationId) =>
      bindings()
        .find({
          kind: 'native_coordinator_binding',
          tenantId: process.env.VIVENTIUM_TENANT_ID || 'local',
          ownerId,
          conversationId,
          active: true,
        })
        .toArray(),
    readRun: (ownerId, runId) => request(ownerId, `/v1/runs/${encodeURIComponent(runId)}`),
    readSubject: async (binding, value) => {
      const path = `/v1/coordinator/conversations/${encodeURIComponent(binding.nativeConversationId)}`;
      if (value.turnId)
        return request(binding.ownerId, `${path}/turns/${encodeURIComponent(value.turnId)}`);
      const snapshot = await request(binding.ownerId, `${path}?include_history=false`);
      return snapshot.goals?.find((goal) => goal.goal_id === value.goalId);
    },
    readRows: async ({ ownerId, conversationId, parentMessageId, deliveryIds }) => {
      const admitted = await ledger.getCortexInsightDeliveriesForParent({
        ownerId,
        parentMessageId,
        deliveryIds,
      });
      if (!admitted.length) return [];
      if (
        admitted.length !== deliveryIds.length ||
        admitted.some(
          (row) => row.conversationId !== conversationId || !deliveryIds.includes(row.deliveryId),
        )
      )
        throw failure('coordinator_progress_batch_invalid');
      return ViventiumCortexInsightDelivery.find({
        userId: ownerId,
        conversationId,
        parentMessageId,
        deliveryId: { $in: admitted.map((row) => row.deliveryId) },
      })
        .select('+publicationId +insight +insightHash +graphResultHash +events')
        .lean();
    },
    readMessage: ({ ownerId, conversationId, deliveryIds, rows }) => {
      const persistedIds = [...new Set(rows.map((row) => row.persistedMessageId).filter(Boolean))];
      if (persistedIds.length > 1) throw failure('coordinator_progress_presentation_conflict');
      return Message.findOne({
        user: ownerId,
        conversationId,
        isCreatedByUser: false,
        deletedAt: null,
        error: { $ne: true },
        unfinished: { $ne: true },
        ...(persistedIds.length ? { messageId: persistedIds[0] } : {}),
        'metadata.viventium.cortexInsightDeliveryIds': { $all: deliveryIds },
      }).lean();
    },
    claimPending: (parent) => ledger.claimPendingCortexInsightDeliveriesForParent(parent),
    markDropped: (input) => ledger.markCortexInsightDeliveryBatchDropped(input),
    prepare: (input) =>
      require('./NativeCoordinatorContextService').prepareNativeCoordinatorProgressContext(input),
    createFollowUp: (input) =>
      require('./NativeCoordinatorContextService').createNativeCoordinatorFollowUp(input),
    enqueue: (input) =>
      require('./NativeCoordinatorContextService').enqueueSavedNativeCoordinatorPresentation(input),
    readPublications: (binding) =>
      require('./NativeCoordinatorPresentationService').readPublications(binding),
    settleRows: (...args) => require('./NativeCoordinatorPresentationService').settleRows(...args),
  };
};
let defaultService;
const service = () =>
  (defaultService ||= createNativeCoordinatorProgressService(defaultDependencies()));
module.exports = {
  createNativeCoordinatorProgressService,
  ...Object.fromEntries(
    [
      'source',
      'publish',
      'verify',
      'recover',
      'insightsCurrent',
      'bindForSave',
      'persistAuthority',
      'voiceTurnId',
      'settleLinkedWeb',
    ].map((name) => [name, (...args) => service()[name](...args)]),
  ),
};
/* === VIVENTIUM END === */
