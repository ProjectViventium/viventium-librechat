/* === VIVENTIUM START ===
 * Feature: Connected channel health policy.
 * Purpose: Keep transient provider failures retryable while fencing credential/scope failures for repair.
 * === VIVENTIUM END === */

const RETRYABLE_ISSUES = new Set([
  'rate_limited',
  'connection_unavailable',
  'connection_timeout',
  'delivery_uncertain',
]);
const REAUTH_ISSUES = new Set(['invalid_credentials', 'missing_permission', 'account_mismatch']);

function classifyChannelHealth(issueCode) {
  if (RETRYABLE_ISSUES.has(issueCode)) {
    return { keepConnected: true, issueCode };
  }
  return {
    keepConnected: false,
    state: REAUTH_ISSUES.has(issueCode) ? 'reauth_required' : 'degraded',
    issueCode,
  };
}

async function updateOwnedChannelHealth({
  channel,
  accountId,
  issueCode,
  ownerId,
  sourceGeneration,
  leaseModel,
  connectionModel,
  stopStale,
}) {
  if (!sourceGeneration) {
    return false;
  }
  const lease = await leaseModel
    .findOne({
      channel,
      accountId,
      ownerId,
      configGeneration: sourceGeneration,
      expiresAt: { $gt: new Date() },
    })
    .lean();
  if (!lease || lease.configGeneration !== sourceGeneration) {
    await stopStale(sourceGeneration);
    return false;
  }
  const health = classifyChannelHealth(issueCode);
  const update = health.keepConnected
    ? { $set: { issueCode } }
    : { $set: { state: health.state, issueCode } };
  const result = await connectionModel.updateOne(
    {
      channel,
      accountId,
      state: 'connected',
      configGeneration: sourceGeneration,
      activeGeneration: sourceGeneration,
    },
    update,
  );
  if (!result.matchedCount) {
    await stopStale(sourceGeneration);
    return false;
  }
  return true;
}

module.exports = { classifyChannelHealth, updateOwnedChannelHealth };
