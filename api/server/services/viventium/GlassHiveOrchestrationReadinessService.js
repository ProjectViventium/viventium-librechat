/* === VIVENTIUM START === Thin adapter for typed Parallel readiness probes. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  configureOrchestrationReadiness,
  observeOrchestrationOwner,
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
const { requestAccountApi } = require('./GlassHiveAccountService');
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

module.exports = {
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
