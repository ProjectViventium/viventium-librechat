/* === VIVENTIUM START ===
 * Feature: Owner-authenticated reviewed synthetic-QA cleanup route adapter.
 * Purpose: Bind Express authentication to package-owned typed HTTP handlers.
 * === VIVENTIUM END === */

'use strict';

const express = require('express');
const { createPersonalAccountCleanupHttpHandlers } = require('@librechat/api');
const { checkAdmin, requireJwtAuth } = require('~/server/middleware');
const cleanupRuntime = require('~/server/services/viventium/PersonalAccountCleanupExecutionService');

const router = express.Router();
const handlers = createPersonalAccountCleanupHttpHandlers(cleanupRuntime);

router.use(requireJwtAuth, checkAdmin);
router.use(handlers.noStore);
router.post('/execute', handlers.execute);
router.post('/sweep', handlers.sweep);

module.exports = router;

/* === VIVENTIUM END === */
