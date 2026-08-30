'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned personal-account cleanup ledger compatibility adapter.
 * Purpose: Keep the legacy API import stable while packages/api owns verified ledger behavior.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createViventiumPersonalAccountCleanupReceiptModel } = require('@librechat/api');

module.exports = function createViventiumPersonalAccountCleanupReceipt(db, options) {
  return createViventiumPersonalAccountCleanupReceiptModel(db || mongoose, options);
};
