/* === VIVENTIUM START ===
 * Feature: Canonical account-wide Parallel work mode resolution.
 * Purpose: Keep Web, Telegram, Voice, and Main on the same availability/default/user-override rule.
 * === VIVENTIUM END === */

function parallelWorkAvailable() {
  const {
    orchestrationReadinessSnapshot,
  } = require('./GlassHiveOrchestrationReadinessService');
  return orchestrationReadinessSnapshot().available;
}

function configuredOrchestrationDefault() {
  return process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE === 'parallel'
    ? 'parallel'
    : 'focused';
}

function effectiveOrchestrationMode(user, { available = parallelWorkAvailable() } = {}) {
  if (!available) return 'focused';
  const explicit = user?.personalization?.orchestration_mode;
  if (explicit === 'parallel' || explicit === 'focused') return explicit;
  return configuredOrchestrationDefault();
}

module.exports = {
  configuredOrchestrationDefault,
  effectiveOrchestrationMode,
  parallelWorkAvailable,
};
