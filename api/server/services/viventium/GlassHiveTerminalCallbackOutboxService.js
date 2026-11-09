/* === VIVENTIUM START === Thin legacy adapter for typed terminal-callback outbox. === */
const mongoose = require('mongoose');
const {
  createGlassHiveTerminalCallbackOutboxService,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
} = require('@librechat/api');
const {
  acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease,
  fenceGlassHiveTerminalCallbackEffectTransaction,
  logger,
  releaseGlassHiveTerminalCallbackEffectLease,
} = require('@librechat/data-schemas');
const {
  GlassHiveTerminalCallbackResult,
  ViventiumGlassHiveCallbackEffectOutbox,
} = require('~/db/models');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');

module.exports = createGlassHiveTerminalCallbackOutboxService({
  readScheduleAdmission: (filter) =>
    mongoose.connection
      .collection('viventium_scheduler_dispatch_intents')
      .findOne(filter, { maxTimeMS: 5000 }),
  ResultModel: GlassHiveTerminalCallbackResult,
  OutboxModel: ViventiumGlassHiveCallbackEffectOutbox,
  fenceAcceptedOperation: fenceGlassHiveTerminalCallbackAcceptedOperation,
  acquireAcceptedOperationEffectLease: acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease,
  fenceEffectTransaction: fenceGlassHiveTerminalCallbackEffectTransaction,
  releaseEffectLease: releaseGlassHiveTerminalCallbackEffectLease,
  runTransaction: runGlassHiveTerminalCallbackTransaction,
  logger,
});
/* === VIVENTIUM END === */
