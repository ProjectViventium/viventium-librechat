/* === VIVENTIUM START === Thin adapter for the typed production Voice trace producer. === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { createVoiceOrchestrationTraceService, writeBoundedVoiceTraceLog } = require('@librechat/api');

module.exports = createVoiceOrchestrationTraceService({
  logger,
  recordOrchestrationTraceEvent: (...args) =>
    require('./OrchestrationTraceLedgerService').recordOrchestrationTraceEvent(...args),
  orchestrationRuntimeTraceBinding: (...args) =>
    require('./ViventiumOrchestrationMode').orchestrationRuntimeTraceBinding(...args),
  logLocalTrace: (event) => writeBoundedVoiceTraceLog(logger, event),
});
