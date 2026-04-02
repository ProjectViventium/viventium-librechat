/* === VIVENTIUM START ===
 * Feature: Background cortex follow-up grace window
 *
 * Purpose:
 * - Allow follow-up "realizations" to surface even if the user sends new input
 *   shortly after the original request.
 * - Default behavior remains unchanged when env is unset or <= 0.
 *
 * Env:
 * - VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S (seconds)
 * === VIVENTIUM END === */

const DEFAULT_GRACE_S = 0;

function parseFloatEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') {
    return fallback;
  }
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function getCortexFollowupGraceMs() {
  const seconds = parseFloatEnv('VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S', DEFAULT_GRACE_S);
  if (seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

module.exports = {
  getCortexFollowupGraceMs,
};
