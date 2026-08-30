/* === VIVENTIUM START === Thin adapter for the typed production Voice trace producer. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { createVoiceOrchestrationTraceService } = require('@librechat/api');

module.exports = createVoiceOrchestrationTraceService({
  logger,
  recordOrchestrationTraceEvent: (...args) =>
    require('./OrchestrationTraceLedgerService').recordOrchestrationTraceEvent(...args),
  orchestrationRuntimeTraceBinding: (...args) =>
    require('./ViventiumOrchestrationMode').orchestrationRuntimeTraceBinding(...args),
});
