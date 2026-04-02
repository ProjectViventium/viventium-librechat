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
 * Feature: Local Skyvern provider bridge routes.
 * === VIVENTIUM NOTE === */
const skyvern = require('./skyvern');

const router = express.Router();

router.use('/calls', calls);
router.use('/voice', voice);
router.use('/telegram', telegram);
router.use('/scheduler', scheduler);
router.use('/gateway', gateway);
// Telegram account linking routes are mounted under /telegram/*.
router.use('/telegram', telegramLink);
router.use('/registration', registration);
router.use('/credits', credits);
router.use('/skyvern', skyvern);

module.exports = router;
