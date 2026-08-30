/* === VIVENTIUM START ===
 * Feature: Restart-safe GlassHive launch reconciliation scheduling.
 * Purpose: Run one bounded repair scan at startup and periodically without overlap.
 * === VIVENTIUM END === */

export interface GlassHiveLaunchReconciliationDependencies {
  ensureGlassHiveExternalWorkIndexes(): Promise<void>;
  reconcileUnknownGlassHiveLaunches(input: { limit: number }): Promise<object>;
  reconcileKnownExternalWorkHints(input: { limit: number }): Promise<object>;
  reconcileUnresolvedGlassHiveCallbackDeliveries(input: { limit: number }): Promise<object>;
  reconcileGlassHiveSurfaceDeliveryProjections(input: { limit: number }): Promise<object>;
  logger: { warn(message: string, details: { code: string }): void };
  environment?: NodeJS.ProcessEnv;
}

export interface GlassHiveLaunchReconciliationResult {
  launches: object;
  hints: object;
  deliveries: object;
  deliveryProjections: object;
}

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 15 * 60_000;
const RECONCILIATION_BATCH = 25;

function safeErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String(error.code || '').slice(0, 120);
    if (code) return code;
  }
  if (error instanceof Error && error.name) return error.name.slice(0, 120);
  return 'launch_reconciliation_failed';
}

export function createGlassHiveLaunchReconciliationService(
  dependencies: GlassHiveLaunchReconciliationDependencies,
) {
  const environment = dependencies.environment ?? process.env;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<GlassHiveLaunchReconciliationResult> | null = null;

  function launchReconciliationIntervalMs(): number {
    const configured = Number(environment.VIVENTIUM_GLASSHIVE_LAUNCH_RECONCILIATION_INTERVAL_MS);
    if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_INTERVAL_MS;
    return Math.max(MIN_INTERVAL_MS, Math.min(Math.floor(configured), MAX_INTERVAL_MS));
  }

  async function runGlassHiveLaunchReconciliation(): Promise<
    GlassHiveLaunchReconciliationResult | { skipped: 'in_flight' }
  > {
    if (inFlight) return { skipped: 'in_flight' };
    inFlight = dependencies
      .ensureGlassHiveExternalWorkIndexes()
      .then(() =>
        Promise.all([
          dependencies.reconcileUnknownGlassHiveLaunches({ limit: RECONCILIATION_BATCH }),
          dependencies.reconcileKnownExternalWorkHints({ limit: 100 }),
          dependencies.reconcileUnresolvedGlassHiveCallbackDeliveries({
            limit: RECONCILIATION_BATCH,
          }),
          dependencies.reconcileGlassHiveSurfaceDeliveryProjections({
            limit: RECONCILIATION_BATCH,
          }),
        ]),
      )
      .then(([launches, hints, deliveries, deliveryProjections]) => ({
        launches,
        hints,
        deliveries,
        deliveryProjections,
      }));
    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function logFailure(phase: 'Startup' | 'Periodic', error: unknown): void {
    dependencies.logger.warn(`[VIVENTIUM][glasshive-launch-reconciliation] ${phase} scan failed`, {
      code: safeErrorCode(error),
    });
  }

  function startGlassHiveLaunchReconciliation(): { started: boolean; intervalMs: number } {
    const intervalMs = launchReconciliationIntervalMs();
    if (timer) return { started: false, intervalMs };
    void runGlassHiveLaunchReconciliation().catch((error) => logFailure('Startup', error));
    timer = setInterval(() => {
      void runGlassHiveLaunchReconciliation().catch((error) => logFailure('Periodic', error));
    }, intervalMs);
    timer.unref?.();
    return { started: true, intervalMs };
  }

  function stopGlassHiveLaunchReconciliationForTests(): void {
    if (timer) clearInterval(timer);
    timer = null;
    inFlight = null;
  }

  return {
    launchReconciliationIntervalMs,
    runGlassHiveLaunchReconciliation,
    startGlassHiveLaunchReconciliation,
    stopGlassHiveLaunchReconciliationForTests,
  };
}

/* === VIVENTIUM END === */
