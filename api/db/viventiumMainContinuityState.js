'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned Main continuity state compatibility adapter.
 * Purpose: Keep the legacy API import stable while packages/data-schemas owns the model.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createViventiumMainContinuityStateModel } = require('@librechat/data-schemas');

module.exports = function createViventiumMainContinuityState(db) {
  return createViventiumMainContinuityStateModel(db || mongoose);
};
