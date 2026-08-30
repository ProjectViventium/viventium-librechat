'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned GlassHive callback effect outbox compatibility adapter.
 * Purpose: Keep the legacy API import stable while packages/data-schemas owns the model.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createViventiumGlassHiveCallbackEffectOutboxModel } = require('@librechat/data-schemas');

module.exports = function createViventiumGlassHiveCallbackEffectOutbox(db) {
  return createViventiumGlassHiveCallbackEffectOutboxModel(db || mongoose);
};
