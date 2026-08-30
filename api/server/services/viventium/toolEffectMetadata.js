/* === VIVENTIUM START ===
 * Feature: Structural tool-effect metadata for provider fallback.
 * Purpose: Keep the legacy /api import surface thin while packages/api owns runtime logic.
 * Added: 2026-08-18
 */

const {
  TOOL_EFFECT_CLASSES,
  toolEffectMetadata,
  isFallbackReplaySafeToolMetadata,
} = require('@librechat/api');

module.exports = {
  TOOL_EFFECT_CLASSES,
  toolEffectMetadata,
  isFallbackReplaySafeToolMetadata,
};

/* === VIVENTIUM END === */
