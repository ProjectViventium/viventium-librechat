/* === VIVENTIUM START ===
 * Feature: Parallel Work surface handoff health.
 * Purpose: Keep Telegram and other detached adapters from accepting turns while Core is healthy
 * but the exact isolated orchestration boundary is still warming or unavailable.
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const {
  refreshOrchestrationReadiness,
  refreshStartupOrchestrationReadiness,
} = require('~/server/services/viventium/GlassHiveOrchestrationReadinessService');
const {
  parallelWorkReleaseGateSnapshotAsync,
} = require('~/server/services/viventium/ViventiumOrchestrationMode');

const router = express.Router();

function configuredSecret() {
  return String(
    process.env.VIVENTIUM_TELEGRAM_SECRET || process.env.VIVENTIUM_CALL_SESSION_SECRET || '',
  );
}

function securelyEqual(expected, supplied) {
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    crypto.timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function authorized(req) {
  const expected = configuredSecret();
  const supplied = String(req.get('X-VIVENTIUM-TELEGRAM-SECRET') || '');
  return securelyEqual(expected, supplied);
}

function authenticatedOwnerId(req) {
  const ownerId = String(req.get('X-VIVENTIUM-OWNER-ID') || '').trim();
  const signature = String(req.get('X-VIVENTIUM-OWNER-SIGNATURE') || '')
    .trim()
    .toLowerCase();
  if (!ownerId && !signature) return { accepted: true, ownerId: '' };
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(ownerId) || !/^[a-f0-9]{64}$/.test(signature)) {
    return { accepted: false, ownerId: '' };
  }
  const expected = crypto
    .createHmac('sha256', configuredSecret())
    .update(`parallel-work-health:v1:${ownerId}`)
    .digest('hex');
  return { accepted: securelyEqual(expected, signature), ownerId };
}

router.get('/', async (req, res) => {
  if (!authorized(req)) {
    res.set('Cache-Control', 'no-store, private');
    return res.status(401).json({ ready: false });
  }
  const owner = authenticatedOwnerId(req);
  if (!owner.accepted) {
    res.set('Cache-Control', 'no-store, private');
    return res.status(401).json({ ready: false });
  }
  const snapshot = owner.ownerId
    ? await refreshOrchestrationReadiness({ ownerId: owner.ownerId })
    : await refreshStartupOrchestrationReadiness();
  const releaseGate = await parallelWorkReleaseGateSnapshotAsync();
  const ready =
    snapshot.requested !== true || (snapshot.available === true && releaseGate.available === true);
  const blockers = [
    ...releaseGate.blockers,
    ...(snapshot.available === true
      ? []
      : [String(snapshot.reason || snapshot.status || 'readiness_unavailable')]),
  ];
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  return res.status(ready ? 200 : 503).json({
    ready,
    releaseReady: releaseGate.releaseReady === true,
    scope: owner.ownerId ? 'owner' : 'deployment',
    requested: snapshot.requested === true,
    status: String(snapshot.status || 'unknown'),
    reason: ready
      ? releaseGate.releaseReady === true
        ? ''
        : 'local_qa_override'
      : snapshot.available !== true
        ? String(snapshot.reason || 'readiness_unavailable')
        : 'release_gate_not_ready',
    label:
      releaseGate.label === 'PRE-GATE / NOT READY'
        ? releaseGate.label
        : snapshot.available === true && releaseGate.available === true
          ? releaseGate.label
          : releaseGate.available
            ? 'NOT READY'
            : releaseGate.label,
    blockers: [...new Set(blockers.filter(Boolean))],
    storagePressure: snapshot.storagePressure || {
      status: 'unknown',
      reason: 'storage_capability_missing',
    },
    promptLayers: snapshot.promptLayers || {
      status: 'unknown',
      reason: 'prompt_layer_capability_missing',
    },
    ...(snapshot.sourceOrder ? { sourceOrder: snapshot.sourceOrder } : {}),
  });
});

module.exports = router;
