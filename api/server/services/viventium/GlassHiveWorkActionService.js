/* === VIVENTIUM START === Thin adapter for the typed GlassHive work-action service. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { GenerationJobManager, createGlassHiveWorkActionService } = require('@librechat/api');
const {
  buildTrustedActionIdempotencyKey,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
} = require('./GlassHiveAccountService');
const {
  dismissCoreOnlyPreDispatchAttention,
  getCoreWorkDelivery,
  getCoreWorkOriginRef,
} = require('./GlassHiveActiveWorkProjectionService');

module.exports = createGlassHiveWorkActionService({
  GenerationJobManager,
  logger,
  buildTrustedActionIdempotencyKey,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
  reauthorizeCapabilityAuthorization: (...args) =>
    require('./GlassHiveCapabilityAuthorizationService').reauthorizeCapabilityAuthorization(
      ...args,
    ),
  dismissCoreOnlyPreDispatchAttention,
  getCoreWorkDelivery,
  getCoreWorkOriginRef,
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    require('./VoiceOrchestrationTraceService').recordVoiceOrchestrationTraceBestEffort(...args),
});
