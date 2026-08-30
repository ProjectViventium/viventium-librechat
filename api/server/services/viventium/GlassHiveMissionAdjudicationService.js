/* === VIVENTIUM START === Thin legacy adapter for typed mission adjudication. === */
const mongoose = require('mongoose');
const {
  buildVoiceWorkerCompletionPresentation,
  createGlassHiveMissionAdjudicationService,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
  sanitizeGlassHiveCallbackText,
} = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { getConvo, getUserById, saveConvo } = require('~/models');
const { getAgent } = require('~/models/Agent');
const { getAppConfig } = require('~/server/services/Config');
const { createCortexFollowUpMessage } = require('./BackgroundCortexFollowUpService');
const {
  isGlassHiveWorkTerminalCallback,
  recordGlassHiveAdjudicationOutcome,
} = require('./GlassHiveCallbackBindingService');
const { enqueueGlassHiveCallbackDelivery } = require('./GlassHiveCallbackDeliveryService');
const { recordOrchestrationTraceDelivery } = require('./OrchestrationTraceLedgerService');
const { getActiveCallSessionForConversation } = require('./CallSessionService');
const {
  deferGlassHiveTerminalCallbackAfterCommit,
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');

module.exports = createGlassHiveMissionAdjudicationService({
  mongoose,
  logger,
  buildVoiceWorkerCompletionPresentation,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
  getConvo,
  getUserById,
  saveConvo,
  getAgent,
  getAppConfig,
  createCortexFollowUpMessage,
  isGlassHiveWorkTerminalCallback,
  recordGlassHiveAdjudicationOutcome,
  recordOrchestrationTraceDelivery,
  getActiveCallSessionForConversation,
  sanitizeGlassHiveCallbackText,
  deferGlassHiveTerminalCallbackAfterCommit,
  runGlassHiveTerminalCallbackTransaction,
  enqueueGlassHiveCallbackDelivery,
  getTerminalCallbackResultModel: () => require('~/db/models').GlassHiveTerminalCallbackResult,
});
/* === VIVENTIUM END === */
