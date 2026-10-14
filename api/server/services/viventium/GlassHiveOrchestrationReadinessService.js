/* === VIVENTIUM START === Thin adapter for typed Parallel readiness probes. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  authoringOrchestrationReadiness,
  configureOrchestrationReadiness,
  observeOrchestrationOwner: observeNativeOrchestrationOwner,
  orchestrationDeploymentReadinessSnapshot,
  orchestrationReadinessSnapshot,
  parallelWorkRequested,
  refreshOrchestrationReadiness,
  refreshStartupOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  startOrchestrationReadinessWatcher,
  waitForOrchestrationReadiness,
} = require('@librechat/api');
const { findUser } = require('~/models');
const { getAgent } = require('~/models/Agent');
const { checkPermission } = require('~/server/services/PermissionService');
const { getActiveWorkSnapshot, requestAccountApi } = require('./GlassHiveAccountService');
const { promptLayerIntegritySnapshot } = require('./promptFrameTelemetry');

configureOrchestrationReadiness({
  logger,
  getSourceOrderCapabilities: (...args) => GenerationJobManager.getSourceOrderCapabilities(...args),
  findUser,
  getAgent,
  checkPermission,
  requestAccountApi,
  promptLayerIntegritySnapshot,
});

function observeOrchestrationOwner(ownerId) {
  const snapshot = observeNativeOrchestrationOwner(ownerId);
  const normalizedOwnerId = String(ownerId || '').trim();
  if (normalizedOwnerId && parallelWorkRequested()) {
    void getActiveWorkSnapshot({ ownerId: normalizedOwnerId }).catch(() => undefined);
  }
  return snapshot;
}

module.exports = {
  authoringOrchestrationReadiness,
  observeOrchestrationOwner,
  orchestrationDeploymentReadinessSnapshot,
  orchestrationReadinessSnapshot,
  parallelWorkRequested,
  refreshOrchestrationReadiness,
  refreshStartupOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  startOrchestrationReadinessWatcher,
  waitForOrchestrationReadiness,
};
