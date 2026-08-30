'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned Cortex insight delivery compatibility adapter.
 * Purpose: Keep the legacy API import and constants stable while packages/data-schemas owns them.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_FAILURE_REASONS,
  CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS,
  createViventiumCortexInsightDeliveryModel,
} = require('@librechat/data-schemas');

module.exports = function createViventiumCortexInsightDelivery(db) {
  return createViventiumCortexInsightDeliveryModel(db || mongoose);
};
module.exports.DROP_REASONS = CORTEX_INSIGHT_DROP_REASONS;
module.exports.FAILURE_REASONS = CORTEX_INSIGHT_FAILURE_REASONS;
module.exports.RECOVERY_DEFERRAL_REASONS = CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS;
