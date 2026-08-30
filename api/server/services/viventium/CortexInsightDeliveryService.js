/* === VIVENTIUM START === Thin adapter for typed Cortex insight delivery. === VIVENTIUM END === */

const mongoose = require('mongoose');
const {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS,
  buildCortexInsightDeliveryCandidates,
  cortexInsightPersistenceEnvelopeIdentity,
  createCortexInsightDeliveryService,
  normalizeCortexFeelingSnapshot,
  requireExactCortexInsightDeliveryAcceptance,
  requireExactCortexInsightPersistenceEnvelope,
  requireExactCortexInsightDeliverySettlement,
  requiredSurfacesFor,
  selectClaimedCortexInsights,
  resolveCortexRuntimeSlotIdentity,
} = require('@librechat/api');
const { ViventiumCortexInsightDelivery } = require('~/db/models');

const defaultService = createCortexInsightDeliveryService({
  DeliveryModel: ViventiumCortexInsightDelivery,
  mongooseInstance: mongoose,
  consumeFault: (...args) =>
    require('./LocalQaCortexFaultService').consumeLocalQaCortexFault(...args),
});

module.exports = {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS,
  buildCortexInsightDeliveryCandidates,
  cortexInsightPersistenceEnvelopeIdentity,
  createCortexInsightDeliveryService,
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
  recordCompletedCortexInsightDeliveryBatch: defaultService.recordBatch,
  resolveCortexRuntimeSlotIdentity,
  renewCortexInsightDeliveryBatchClaim: defaultService.renewClaim,
  cortexInsightDeliveryService: defaultService,
};
