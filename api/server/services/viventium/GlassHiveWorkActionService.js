/* === VIVENTIUM START ===
 * Feature: Shared owner-scoped GlassHive work action executor.
 * Purpose:
 * - Keep web, Telegram, and Main-tool controls on one exact action path.
 * - Reauthorize only a trusted auth-attention Resume, preserving the reviewed scope.
 * - Carry Core-owned refresh metadata over the service-asserted account API; clients never set it.
 * === VIVENTIUM END === */

const {
  buildTrustedActionIdempotencyKey,
  getActiveWorkSnapshot,
  invalidateActiveWorkSnapshot,
  requestAccountApi,
} = require('./GlassHiveAccountService');
const {
  reauthorizeCapabilityAuthorization,
} = require('./GlassHiveCapabilityAuthorizationService');
const {
  dismissCoreOnlyPreDispatchAttention,
  getCoreWorkDelivery,
} = require('./GlassHiveActiveWorkProjectionService');

const REAUTH_ACTIONS = new Set(['resume']);
const REAUTH_FAILURE_CODES = new Set(['capability_authorization_horizon_expired']);
const DISMISS_SAFE_DELIVERY_STATES = new Set(['delivered', 'acknowledged', 'silent']);

function normalizedFailureCode(detail = {}) {
  return String(
    detail?.attention?.code ||
      detail?.failureCode ||
      detail?.failureClass ||
      detail?.failure?.code ||
      '',
  )
    .trim()
    .toLowerCase();
}

function needsCapabilityReauthorization(detail = {}) {
  // `auth` is an attention category, not a refresh grant. Policy, registry, and connected-account
  // repair all Resume through ordinary GH re-admission; only the exact expired-horizon code may
  // extend the previously reviewed same-scope authorization envelope.
  return REAUTH_FAILURE_CODES.has(normalizedFailureCode(detail));
}

async function trustedCapabilityRefresh({ ownerId, workRef, action }) {
  if (!REAUTH_ACTIONS.has(action)) return null;
  const detail = await requestAccountApi({
    ownerId,
    path: `/v1/work/${encodeURIComponent(workRef)}`,
  });
  if (!needsCapabilityReauthorization(detail)) return null;
  const refreshed = await reauthorizeCapabilityAuthorization({ ownerId, workRef });
  return {
    version: 1,
    authorizationRef: refreshed.authorizationRef,
    maxExpiresAt: refreshed.maxExpiresAt,
    scopeFingerprint: refreshed.scopeFingerprint,
  };
}

async function executeGlassHiveWorkAction({
  ownerId,
  workRef,
  action,
  instruction,
  operationId,
} = {}) {
  if (action === 'dismiss') {
    const coreOnlyReceipt = await dismissCoreOnlyPreDispatchAttention({
      ownerId,
      originRef: workRef,
      operationId,
    });
    if (coreOnlyReceipt) {
      invalidateActiveWorkSnapshot({ ownerId });
      await getActiveWorkSnapshot({ ownerId, forceRefresh: true });
      return coreOnlyReceipt;
    }
    // Core owns delivery truth. Resolve the exact owner/work row directly so an older terminal
    // card remains dismissible even when it is no longer on GlassHive's first roster page.
    const delivery = await getCoreWorkDelivery({ ownerId, workRef });
    const deliveryState = String(delivery?.state || '').trim().toLowerCase();
    if (!DISMISS_SAFE_DELIVERY_STATES.has(deliveryState)) {
      const error = new Error('glasshive_dismiss_delivery_not_settled');
      error.code = 'glasshive_dismiss_delivery_not_settled';
      error.status = 409;
      throw error;
    }
  }
  const capabilityReauthorization = await trustedCapabilityRefresh({
    ownerId,
    workRef,
    action,
  });
  const idempotencyKey = buildTrustedActionIdempotencyKey({
    ownerId,
    workRef,
    action,
    operationId,
  });
  const result = await requestAccountApi({
    ownerId,
    path: `/v1/work/${encodeURIComponent(workRef)}/actions`,
    method: 'POST',
    body: {
      action,
      ...(instruction ? { instruction } : {}),
      idempotencyKey,
      ...(capabilityReauthorization ? { capabilityReauthorization } : {}),
    },
  });
  // Every accepted mutation makes the owner's cached roster obsolete. Keep this owner-scoped:
  // another account's snapshot and in-flight request remain valid.
  invalidateActiveWorkSnapshot({ ownerId });
  if (action === 'dismiss') {
    // A second fresh snapshot observes the post-dismiss roster; only that authoritative empty
    // result may clear Core's conservative known-work hint.
    await getActiveWorkSnapshot({ ownerId, forceRefresh: true });
  }
  return result;
}

module.exports = {
  executeGlassHiveWorkAction,
  needsCapabilityReauthorization,
};
