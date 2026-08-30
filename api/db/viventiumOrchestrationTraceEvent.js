'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned orchestration trace compatibility adapter.
 * Purpose: Keep the legacy API import stable while packages/data-schemas owns the ledger.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createViventiumOrchestrationTraceEventModel } = require('@librechat/data-schemas');

module.exports = function createViventiumOrchestrationTraceEvent(db) {
  return createViventiumOrchestrationTraceEventModel(db || mongoose);
};
