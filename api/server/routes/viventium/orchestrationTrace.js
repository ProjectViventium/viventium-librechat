/* === VIVENTIUM START === Thin Express/Mongo adapter for typed orchestration-trace HTTP behavior. === VIVENTIUM END === */

const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { createOrchestrationTraceHttpHandlers } = require('@librechat/api');
const { requireJwtAuth } = require('~/server/middleware');
const { requestAccountApi } = require('~/server/services/viventium/GlassHiveAccountService');
const {
  recordGlassHiveWorkDetailTrace,
  readOrchestrationTraceEvents,
} = require('~/server/services/viventium/OrchestrationTraceLedgerService');
const {
  promptLayerIntegritySnapshot,
} = require('~/server/services/viventium/promptFrameTelemetry');

const handlers = createOrchestrationTraceHttpHandlers({
  collection: (name) => mongoose.connection.collection(name),
  logger,
  requestAccountApi,
  readOrchestrationTraceEvents,
  recordGlassHiveWorkDetailTrace,
  promptLayerIntegritySnapshot,
});

const router = express.Router();
router.use(requireJwtAuth);
router.use(handlers.noStore);
router.get('/:originRef', handlers.getTrace);

module.exports = router;
