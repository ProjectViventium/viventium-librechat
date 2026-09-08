/* === VIVENTIUM START === Typed GlassHive launch-reconciliation compatibility adapter. */

const { logger } = require('@librechat/data-schemas');
const { createGlassHiveLaunchReconciliationService } = require('@librechat/api');
const {
  reconcileKnownExternalWorkHints,
  reconcileUnknownGlassHiveLaunches,
} = require('./GlassHiveCallbackBindingService');
const {
  reconcileGlassHiveSurfaceDeliveryProjections,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
} = require('./GlassHiveCallbackDeliveryService');
const { ensureGlassHiveExternalWorkIndexes } = require('./GlassHiveActiveWorkProjectionService');
const { reconcilePendingGlassHiveMissionAdjudications } = require('./GlassHiveMissionAdjudicationService');

module.exports = createGlassHiveLaunchReconciliationService({
  logger,
  ensureGlassHiveExternalWorkIndexes,
  reconcileKnownExternalWorkHints,
  reconcileUnknownGlassHiveLaunches,
  reconcileGlassHiveSurfaceDeliveryProjections,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
  reconcilePendingGlassHiveMissionAdjudications,
  environment: process.env,
});

/* === VIVENTIUM END === */
