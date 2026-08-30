/* === VIVENTIUM START === Thin adapter for the typed Main orchestration facade. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  appendGlassHiveMainOrchestrationFacade,
  availableGlassHiveMainOrchestrationTools,
  canExposeGlassHiveMainDelegation,
  canExposeGlassHiveMainWorkControls,
  createGlassHiveMainDelegationTool: createTypedGlassHiveMainDelegationTool,
  glassHiveMainOrchestrationDefinitions,
} = require('@librechat/api');

function createGlassHiveMainDelegationTool(options) {
  return createTypedGlassHiveMainDelegationTool(options, {
    logger,
    executeMainDelegation: (...args) =>
      require('~/server/services/viventium/GlassHiveCapabilityBrokerService').executeMainDelegation(
        ...args,
      ),
  });
}

module.exports = {
  appendGlassHiveMainOrchestrationFacade,
  availableGlassHiveMainOrchestrationTools,
  canExposeGlassHiveMainDelegation,
  canExposeGlassHiveMainWorkControls,
  createGlassHiveMainDelegationTool,
  glassHiveMainOrchestrationDefinitions,
};
