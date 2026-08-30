/* === VIVENTIUM START === Thin legacy adapter for typed callback binding. === */
const mongoose = require('mongoose');
const {
  canonicalizeGlassHiveCallbackRef,
  createGlassHiveCallbackBindingService,
  hasKnownExternalWork: queryKnownExternalWork,
  normalizeInteractionSourceSegments,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getMessages, markUserParallelWorkKnown } = require('~/models');
const { resolveTelegramMappingByUserId } = require('~/server/services/TelegramLinkService');
const {
  buildTrustedDelegationIdentity,
  requestAccountApi,
  signTrustedDelegationIdentity,
} = require('./GlassHiveAccountService');
const {
  deferGlassHiveWorkStateReconciliation,
  reconcileAuthoritativeGlassHiveWorkState,
} = require('./GlassHiveActiveWorkProjectionService');
const { promptLayerIntegritySnapshot } = require('./promptFrameTelemetry');
const {
  recordOrchestrationTraceAcceptedLaunch,
  recordOrchestrationTraceCallback,
  recordOrchestrationTraceFailedLaunch,
  recordOrchestrationTraceLaunch,
  recordGlassHiveWorkDetailTrace,
} = require('./OrchestrationTraceLedgerService');

const externalWorkCollection = mongoose.connection.collection('viventium_external_work');
const service = createGlassHiveCallbackBindingService({
  mongoose,
  logger,
  canonicalizeGlassHiveCallbackRef,
  resolveTelegramMappingByUserId,
  getMessages,
  markUserParallelWorkKnown,
  buildTrustedDelegationIdentity,
  requestAccountApi,
  signTrustedDelegationIdentity,
  normalizeInteractionSourceSegments,
  promptLayerIntegritySnapshot,
  recordOrchestrationTraceAcceptedLaunch,
  recordOrchestrationTraceCallback,
  recordOrchestrationTraceFailedLaunch,
  recordOrchestrationTraceLaunch,
  recordGlassHiveWorkDetailTrace,
  deferGlassHiveWorkStateReconciliation,
  reconcileAuthoritativeGlassHiveWorkState,
});

module.exports = {
  ...service,
  hasKnownExternalWork: ({ ownerId } = {}) =>
    queryKnownExternalWork({ ownerId, collection: externalWorkCollection }),
};
/* === VIVENTIUM END === */
