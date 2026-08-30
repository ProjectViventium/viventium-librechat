/* === VIVENTIUM START === Thin legacy adapter for typed terminal-callback outbox. === */
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
