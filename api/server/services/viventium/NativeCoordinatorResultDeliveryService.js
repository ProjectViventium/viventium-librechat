/* === VIVENTIUM START === Thin read-only Native/Main receipt join for Active work. === */
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createNativeCoordinatorResultDeliveryProjection } = require('@librechat/api');
const { Message, ViventiumCortexInsightDelivery } = require('~/db/models');
const { requestAccountApi } = require('./GlassHiveAccountService');

const project = createNativeCoordinatorResultDeliveryProjection({
  readMessages: (ownerId, targets) =>
    Message.find({
      user: ownerId,
      isCreatedByUser: false,
      error: { $ne: true },
      unfinished: { $ne: true },
      deletedAt: null,
      $or: targets.map((target) => {
        const { binding } = target;
        const subject = target.turn || target.goal;
        return {
          conversationId: binding.conversationId,
          'metadata.viventium.mainGenerationPresentation.version': 2,
          'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.bindingRef':
            binding._id,
          'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.nativeConversationId':
            binding.nativeConversationId,
          ...(target.turn
            ? {
                'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.kind':
                  'native_coordinator_turn',
                'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.turnId':
                  target.turn.turn_id,
                'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.requestId':
                  target.turn.request_id,
              }
            : {
                'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.goalId':
                  target.goal.goal_id,
              }),
          'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.runId':
            subject.run_id,
          'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.resultRevision':
            subject.result_revision,
          'metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult.sourceTurnId':
            subject.source_turn_id,
        };
      }),
    })
      .select(
        'messageId user conversationId parentMessageId isCreatedByUser text error unfinished deletedAt metadata.viventium.mainGenerationPresentation metadata.viventium.cortexInsightDeliveryIds metadata.viventium.cortexPresentationParentMessageId metadata.viventium.cortexPresentationGeneration metadata.viventium.cortexPresentationClaimToken',
      )
      .lean(),
  readSources: (_ownerId, targets) =>
    mongoose.connection
      .collection('viventium_glasshive_callback_bindings')
      .find({
        kind: 'native_coordinator_source',
        $or: targets.map((target) => {
          const { binding } = target;
          const subject = target.turn || target.goal;
          return {
            _id: `${binding._id}:${subject.source_turn_id}`,
            bindingRef: binding._id,
            turnId: subject.source_turn_id,
          };
        }),
      })
      .toArray(),
  readRows: (ownerId, ids) =>
    ViventiumCortexInsightDelivery.find({ userId: ownerId, deliveryId: { $in: ids } })
      .select(
        'deliveryId userId conversationId parentMessageId persistedMessageId persistenceStatus status claimGeneration surface insightHash graphResultHash requiredSurfaces presentedSurfaces presentationReceiptHashes dropReason +insight +events',
      )
      .lean(),
  readResult: (ownerId, cid, gid, runId) =>
    requestAccountApi({
      ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(cid)}/goals/${encodeURIComponent(gid)}/result?run_id=${encodeURIComponent(runId)}&offset=0&max_chars=1`,
    }),
  readTurnResult: (ownerId, cid, tid, requestId, runId) =>
    requestAccountApi({
      ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(cid)}/turns/${encodeURIComponent(tid)}/result?request_id=${encodeURIComponent(requestId)}&run_id=${encodeURIComponent(runId)}&offset=0&max_chars=1`,
    }),
  readDestinations: (ownerId, requestBody) =>
    require('./GlassHiveCallbackBindingService').resolveConfiguredGlassHiveDestinations({
      ownerId,
      requestBody,
    }),
});

module.exports = async (input) => {
  try {
    return await project(input);
  } catch (error) {
    logger.warn('[native-coordinator] Result delivery receipt unavailable', {
      code: error?.code || error?.name,
    });
    return input.roster;
  }
};
/* === VIVENTIUM END === */
