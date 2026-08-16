/* === VIVENTIUM START ===
 * Feature: Restart-safe reconciliation of unknown GlassHive dispatch outcomes.
 * Purpose: Repair the authoritative workRef by trusted origin after an atomic delegation commit
 * succeeds but the MCP response is lost. Run one bounded scan at startup and periodically.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  reconcileKnownExternalWorkHints,
  reconcileUnknownGlassHiveLaunches,
} = require('./GlassHiveCallbackBindingService');
const {
  reconcileUnresolvedGlassHiveCallbackDeliveries,
} = require('./GlassHiveCallbackDeliveryService');
const {
  ensureGlassHiveExternalWorkIndexes,
} = require('./GlassHiveActiveWorkProjectionService');

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const RECONCILIATION_BATCH = 25;
let timer = null;
let inFlight = null;

function launchReconciliationIntervalMs() {
  const configured = Number(
    process.env.VIVENTIUM_GLASSHIVE_LAUNCH_RECONCILIATION_INTERVAL_MS,
  );
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(MIN_INTERVAL_MS, Math.min(Math.floor(configured), MAX_INTERVAL_MS));
}

async function runGlassHiveLaunchReconciliation() {
  if (inFlight) return { skipped: 'in_flight' };
  inFlight = ensureGlassHiveExternalWorkIndexes()
    .then(() =>
      Promise.all([
        reconcileUnknownGlassHiveLaunches({ limit: RECONCILIATION_BATCH }),
        reconcileKnownExternalWorkHints({ limit: 100 }),
        reconcileUnresolvedGlassHiveCallbackDeliveries({ limit: RECONCILIATION_BATCH }),
      ]),
    )
    .then(([launches, hints, deliveries]) => ({ launches, hints, deliveries }));
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function startGlassHiveLaunchReconciliation() {
  const intervalMs = launchReconciliationIntervalMs();
  if (timer) return { started: false, intervalMs };
  void runGlassHiveLaunchReconciliation().catch((error) => {
    logger.warn('[VIVENTIUM][glasshive-launch-reconciliation] Startup scan failed', {
      code: String(error?.code || error?.name || 'launch_reconciliation_failed').slice(0, 120),
    });
  });
  timer = setInterval(() => {
    void runGlassHiveLaunchReconciliation().catch((error) => {
      logger.warn('[VIVENTIUM][glasshive-launch-reconciliation] Periodic scan failed', {
        code: String(error?.code || error?.name || 'launch_reconciliation_failed').slice(0, 120),
      });
    });
  }, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs };
}

function stopGlassHiveLaunchReconciliationForTests() {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = null;
}

module.exports = {
  launchReconciliationIntervalMs,
  runGlassHiveLaunchReconciliation,
  startGlassHiveLaunchReconciliation,
  stopGlassHiveLaunchReconciliationForTests,
};
