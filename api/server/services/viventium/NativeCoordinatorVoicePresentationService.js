/* === VIVENTIUM START === Read-only source proof for the existing Main result speaker. === */
const mongoose = require('mongoose');
const {
  createNativeCoordinatorResultSourceVerifier,
  readNativeCoordinatorGoalSnapshot,
} = require('@librechat/api');
const { ViventiumCortexInsightDelivery } = require('~/db/models');
const { requestAccountApi } = require('./GlassHiveAccountService');

module.exports = createNativeCoordinatorResultSourceVerifier({
  tenantId: () => process.env.VIVENTIUM_TENANT_ID || 'local',
  readBinding: (id, session) =>
    mongoose.connection
      .collection('viventium_glasshive_callback_bindings')
      .findOne({ _id: id, kind: 'native_coordinator_binding' }, { session }),
  readSource: (bindingRef, turnId, session) =>
    mongoose.connection
      .collection('viventium_glasshive_callback_bindings')
      .findOne(
        { _id: `${bindingRef}:${turnId}`, kind: 'native_coordinator_source', bindingRef, turnId },
        { session },
      ),
  readGoal: (ownerId, conversationId, goalId) =>
    readNativeCoordinatorGoalSnapshot({ ownerId, conversationId, goalId }, (ownerId, path) =>
      requestAccountApi({ ownerId, path }),
    ),
  readResult: (ownerId, cid, gid, runId) =>
    requestAccountApi({
      ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(cid)}/goals/${encodeURIComponent(gid)}/result?run_id=${encodeURIComponent(runId)}&offset=0&max_chars=1`,
    }),
  readTurnResult: (ownerId, cid, turnId, requestId, runId) =>
    requestAccountApi({
      ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(cid)}/turns/${encodeURIComponent(turnId)}/result?request_id=${encodeURIComponent(requestId)}&run_id=${encodeURIComponent(runId)}&offset=0&max_chars=1`,
    }),
  readCortexRows: (ownerId, deliveryIds, session) =>
    ViventiumCortexInsightDelivery.find({
      userId: ownerId,
      deliveryId: { $in: deliveryIds },
    })
      .select('+insight +events')
      .session(session || null)
      .lean(),
  readDestinations: (ownerId, requestBody) =>
    require('./GlassHiveCallbackBindingService').resolveConfiguredGlassHiveDestinations({
      ownerId,
      requestBody,
    }),
});
/* === VIVENTIUM END === */
