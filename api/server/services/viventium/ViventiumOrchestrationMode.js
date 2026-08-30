/* === VIVENTIUM START === Thin adapter for typed Parallel work mode resolution. === VIVENTIUM END === */

const {
  configureOrchestrationMode,
  configuredOrchestrationDefault,
  consumeTrustedParallelWorkClaimState,
  effectiveOrchestrationMode,
  orchestrationRuntimeTraceBinding,
  parallelWorkAvailable,
  parallelWorkAvailableAsync,
  parallelWorkClaimState,
  parallelWorkClaimStateAsync,
  parallelWorkDeploymentAvailable,
  parallelWorkDeploymentAvailableAsync,
  parallelWorkReleaseGateSnapshot,
  parallelWorkReleaseGateSnapshotAsync,
} = require('@librechat/api');

configureOrchestrationMode({
  orchestrationReadinessSnapshot: (...args) =>
    require('./GlassHiveOrchestrationReadinessService').orchestrationReadinessSnapshot(...args),
  orchestrationDeploymentReadinessSnapshot: (...args) =>
    require('./GlassHiveOrchestrationReadinessService').orchestrationDeploymentReadinessSnapshot(
      ...args,
    ),
});

module.exports = {
  configuredOrchestrationDefault,
  consumeTrustedParallelWorkClaimState,
  effectiveOrchestrationMode,
  orchestrationRuntimeTraceBinding,
  parallelWorkAvailable,
  parallelWorkAvailableAsync,
  parallelWorkClaimState,
  parallelWorkClaimStateAsync,
  parallelWorkDeploymentAvailable,
  parallelWorkDeploymentAvailableAsync,
  parallelWorkReleaseGateSnapshot,
  parallelWorkReleaseGateSnapshotAsync,
};
