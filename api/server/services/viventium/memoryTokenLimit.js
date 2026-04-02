/* === VIVENTIUM START ===
 * Feature: Memory token limit runtime override
 *
 * Purpose:
 * - Allow fast operational tuning of memory token budget without waiting for
 *   deployed librechat.yaml propagation.
 * - Keep fallback behavior unchanged when override is not provided.
 *
 * Added: 2026-02-20
 * === VIVENTIUM END === */

'use strict';

function parsePositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return null;
}

function resolveMemoryTokenLimit(configTokenLimit) {
  const override = parsePositiveInt(process.env.VIVENTIUM_MEMORY_TOKEN_LIMIT_OVERRIDE);
  if (override != null) {
    return override;
  }
  const fromConfig = Number(configTokenLimit);
  if (Number.isFinite(fromConfig) && fromConfig > 0) {
    return fromConfig;
  }
  return null;
}

module.exports = {
  resolveMemoryTokenLimit,
};
