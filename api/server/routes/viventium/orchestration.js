/* === VIVENTIUM START === Thin Express adapter for typed Parallel Work HTTP behavior. === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { createOrchestrationHttpHandlers } = require('@librechat/api');
const { getUserById, updateUserViventiumOrchestrationPreferences } = require('~/models');
const { requireJwtAuth } = require('~/server/middleware');
const {
  getActiveWorkHistoryPage,
  getActiveWorkInteractiveSnapshot,
  getActiveWorkPage,
} = require('~/server/services/viventium/GlassHiveAccountService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');
const {
  effectiveOrchestrationMode,
  parallelWorkClaimStateAsync,
} = require('~/server/services/viventium/ViventiumOrchestrationMode');
const {
  observeOrchestrationOwner,
  refreshOrchestrationReadiness,
} = require('~/server/services/viventium/GlassHiveOrchestrationReadinessService');

const handlers = createOrchestrationHttpHandlers({
  logger,
  getUserById,
  updateUserViventiumOrchestrationPreferences,
  getActiveWorkHistoryPage,
  getActiveWorkInteractiveSnapshot,
  getActiveWorkPage,
  executeGlassHiveWorkAction,
  effectiveOrchestrationMode,
  parallelWorkClaimStateAsync,
  observeOrchestrationOwner,
  refreshOrchestrationReadiness,
  providerBaseUrl: () => String(process.env.GLASSHIVE_PROVIDER_BASE_URL || ''),
});

const router = express.Router();
const bodyLimit = express.json({ limit: '4kb' });
router.use(requireJwtAuth);
router.use(handlers.noStore);
router.get('/', handlers.getPreference);
router.patch('/', bodyLimit, handlers.patchPreference);
router.get('/work', handlers.getWork);
router.get('/work/history', handlers.getWorkHistory);
router.post('/work/:workRef/actions', bodyLimit, handlers.postWorkAction);

module.exports = router;
