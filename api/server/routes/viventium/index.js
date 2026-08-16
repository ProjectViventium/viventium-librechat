/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: LibreChat Voice Calls - Viventium Routes
 * Added: 2026-01-08
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const express = require('express');

const calls = require('./calls');
const voice = require('./voice');
const telegram = require('./telegram');
const scheduler = require('./scheduler');
const interactions = require('./interactions');
/* === VIVENTIUM NOTE ===
 * Feature: Generic multi-channel gateway routes (OpenClaw channel bridge contract).
 * === VIVENTIUM NOTE === */
const gateway = require('./gateway');
/* === VIVENTIUM NOTE ===
 * Feature: Telegram account linking
 * === VIVENTIUM NOTE === */
const telegramLink = require('./telegram_link');
/* === VIVENTIUM NOTE ===
 * Feature: Registration approval + credits request routes.
 * === VIVENTIUM NOTE === */
const registration = require('./registration');
const credits = require('./credits');
/* === VIVENTIUM NOTE ===
 * Feature: Operator-issued password reset links.
 * === VIVENTIUM NOTE === */
const auth = require('./auth');
/* === VIVENTIUM NOTE ===
 * Feature: Local Skyvern provider bridge routes.
 * === VIVENTIUM NOTE === */
const skyvern = require('./skyvern');
/* === VIVENTIUM NOTE ===
 * Feature: GlassHive host-worker callback receiver.
 * === VIVENTIUM NOTE === */
const glasshive = require('./glasshive');
/* === VIVENTIUM NOTE ===
 * Feature: GlassHive connected-account capability broker MCP endpoint.
 * === VIVENTIUM NOTE === */
const glasshiveCapabilities = require('./glasshiveCapabilities');
/* === VIVENTIUM NOTE === Run-scoped connected-model provider broker. */
const glasshiveProvider = require('./glasshiveProvider');
/* === VIVENTIUM NOTE ===
 * Feature: Prompt Workbench local launcher route.
 * === VIVENTIUM NOTE === */
const promptWorkbench = require('./promptWorkbench');
/* === VIVENTIUM NOTE === Feelings / Emotional Cortex */
const feelings = require('./feelings');
/* === VIVENTIUM NOTE === Account-wide adaptive parallel-work preference */
const orchestration = require('./orchestration');

const router = express.Router();

router.use('/calls', calls);
router.use('/voice', voice);
router.use('/telegram', telegram);
router.use('/scheduler', scheduler);
router.use('/interactions', interactions);
router.use('/gateway', gateway);
// Telegram account linking routes are mounted under /telegram/*.
router.use('/telegram', telegramLink);
router.use('/registration', registration);
router.use('/credits', credits);
router.use('/auth', auth);
router.use('/skyvern', skyvern);
router.use('/glasshive', glasshive);
router.use('/glasshive/capabilities', glasshiveCapabilities);
router.use('/glasshive/providers', glasshiveProvider);
router.use('/prompt-workbench', promptWorkbench);
router.use('/feelings', feelings);
router.use('/orchestration', orchestration);

module.exports = router;
