/* === VIVENTIUM START ===
 * Feature: Fail-closed isolated Parallel readiness watcher.
 * Purpose: Keep host-mission mutual exclusion a GlassHive deployment invariant without adding a
 * GlassHive round trip to Main's per-turn authoring path. Consumers read only this bounded local
 * snapshot; startup/periodic refresh owns the service-authenticated probe.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { findUser } = require('~/models');
const { requestAccountApi } = require('./GlassHiveAccountService');

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_MAX_AGE_MS = 30_000;
let readiness = { status: 'unknown', reason: '', checkedAtMs: 0, ownerId: '' };
let inFlight = null;
let timer = null;

function parallelWorkRequested() {
  return process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true';
}

function positiveBoundedMs(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(min, Math.min(Math.floor(value), max)) : fallback;
}

function readinessIntervalMs() {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_READINESS_INTERVAL_MS',
    DEFAULT_INTERVAL_MS,
    1_000,
    5 * 60_000,
  );
}

function readinessMaxAgeMs() {
  return positiveBoundedMs(
    'VIVENTIUM_PARALLEL_WORK_READINESS_MAX_AGE_MS',
    DEFAULT_MAX_AGE_MS,
    2_000,
    10 * 60_000,
  );
}

function validReadyCapability(value) {
  return (
    value?.policyVersion === 1 &&
    value?.isolatedParallelReady === true &&
    value?.hostMissionsAllowed === false &&
    Number(value?.hostMissionsActive) === 0
  );
}

function safeReadinessReason(value, fallback = 'isolated_parallel_unready') {
  const reason = String(value || '').trim();
  return /^[a-z0-9_.-]{1,120}$/.test(reason) ? reason : fallback;
}

function orchestrationReadinessSnapshot({ nowMs = Date.now() } = {}) {
  const requested = parallelWorkRequested();
  const fresh = readiness.checkedAtMs > 0 && nowMs - readiness.checkedAtMs <= readinessMaxAgeMs();
  const available = requested && fresh && readiness.status === 'ready';
  return Object.freeze({
    requested,
    available,
    status: requested ? (fresh ? readiness.status : 'stale') : 'disabled',
    reason: requested && fresh ? readiness.reason : '',
    checkedAtMs: readiness.checkedAtMs,
  });
}

async function refreshOrchestrationReadiness({ ownerId } = {}) {
  if (!parallelWorkRequested()) {
    readiness = { status: 'unknown', reason: '', checkedAtMs: 0, ownerId: '' };
    return orchestrationReadinessSnapshot();
  }
  const normalizedOwnerId = String(ownerId || readiness.ownerId || '').trim();
  if (!normalizedOwnerId) return orchestrationReadinessSnapshot();
  if (inFlight) return inFlight;
  inFlight = requestAccountApi({
    ownerId: normalizedOwnerId,
    path: '/v1/orchestration-capabilities',
    timeoutMs: 1000,
  })
    .then((capability) => {
      const ready = validReadyCapability(capability);
      readiness = {
        status: ready ? 'ready' : 'unready',
        reason: ready
          ? ''
          : safeReadinessReason(capability?.isolatedParallelReason),
        checkedAtMs: Date.now(),
        ownerId: normalizedOwnerId,
      };
      return orchestrationReadinessSnapshot();
    })
    .catch((error) => {
      readiness = {
        status: 'unavailable',
        reason: 'readiness_unavailable',
        checkedAtMs: Date.now(),
        ownerId: normalizedOwnerId,
      };
      logger.warn('[VIVENTIUM][parallel-work] Isolation readiness refresh failed', {
        code: String(error?.code || error?.name || 'readiness_unavailable').slice(0, 120),
      });
      return orchestrationReadinessSnapshot();
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

function observeOrchestrationOwner(ownerId) {
  if (!parallelWorkRequested()) return orchestrationReadinessSnapshot();
  const normalizedOwnerId = String(ownerId || '').trim();
  const snapshot = orchestrationReadinessSnapshot();
  if (normalizedOwnerId && (!snapshot.available || snapshot.status === 'stale')) {
    void refreshOrchestrationReadiness({ ownerId: normalizedOwnerId });
  }
  return snapshot;
}

async function resolveStartupOwnerId() {
  const user = await findUser({}, '_id').catch(() => null);
  return String(user?._id || user?.id || '').trim();
}

async function refreshKnownOrDiscoverableOwner() {
  const ownerId = readiness.ownerId || (await resolveStartupOwnerId());
  return refreshOrchestrationReadiness({ ownerId });
}

function startOrchestrationReadinessWatcher() {
  const intervalMs = readinessIntervalMs();
  if (!parallelWorkRequested()) return { started: false, reason: 'disabled', intervalMs };
  if (timer) return { started: false, reason: 'already_started', intervalMs };
  // Mongo/user discovery can legitimately be empty during startup. Retry discovery on every tick
  // until an owner is known; otherwise one early miss leaves Parallel unavailable forever.
  void refreshKnownOrDiscoverableOwner();
  timer = setInterval(() => {
    void refreshKnownOrDiscoverableOwner();
  }, intervalMs);
  timer.unref?.();
  return { started: true, intervalMs };
}

function resetOrchestrationReadinessForTests(value = {}) {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = null;
  readiness = {
    status: value.status || 'unknown',
    reason: safeReadinessReason(value.reason, ''),
    checkedAtMs: Number(value.checkedAtMs) || 0,
    ownerId: String(value.ownerId || ''),
  };
}

module.exports = {
  observeOrchestrationOwner,
  orchestrationReadinessSnapshot,
  parallelWorkRequested,
  refreshOrchestrationReadiness,
  resetOrchestrationReadinessForTests,
  startOrchestrationReadinessWatcher,
};
