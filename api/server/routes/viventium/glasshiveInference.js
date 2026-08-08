/* === VIVENTIUM START ===
 * Feature: GlassHive per-user inference broker route adapter.
 * Purpose: Wire LibreChat-owned encrypted credentials and durable broker state into the typed
 * inference broker without exposing raw credentials to GlassHive or workers.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const {
  createGlassHiveInferenceBrokerRouter,
  isUserProvided,
  resolveConnectedAccountCredentialPolicy,
} = require('@librechat/api');
const { getUserById, getUserKey, getUserKeyValues } = require('~/models');
const {
  assertBrokerGrantActive,
  rememberBrokerRequest,
  resolveBrokerTenantId,
  revokeBrokerGrant,
} = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');

function enterpriseRoute() {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_REVERSE_PROXY || '').trim();
  if (
    !apiKey ||
    !baseUrl ||
    isUserProvided(apiKey) ||
    isUserProvided(baseUrl) ||
    apiKey.startsWith('${') ||
    baseUrl.startsWith('${')
  ) {
    return null;
  }
  return { apiKey, baseUrl };
}

module.exports = createGlassHiveInferenceBrokerRouter({
  secret: String(process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET || '').trim(),
  tenantId: resolveBrokerTenantId(),
  proxyBaseUrl: String(process.env.VIVENTIUM_GLASSHIVE_INFERENCE_PROXY_URL || '').trim(),
  isUserActive: async (userId) => {
    const user = await getUserById(userId, '_id expiresAt');
    if (!user) {
      return false;
    }
    const expiresAt = user.expiresAt ? new Date(user.expiresAt).getTime() : null;
    return expiresAt == null || (Number.isFinite(expiresAt) && expiresAt > Date.now());
  },
  getCredentialPolicy: (userId) =>
    resolveConnectedAccountCredentialPolicy({
      userId,
      provider: 'openai',
      db: { getUserKey },
    }),
  getUserKeyValues,
  getEnterpriseRoute: enterpriseRoute,
  assertGrantActive: async (grant) => {
    await assertBrokerGrantActive(grant);
  },
  revokeGrant: async (grant) => {
    await revokeBrokerGrant(grant);
  },
  rememberGrantRequest: (grant) => rememberBrokerRequest({ grant }),
  fetch: (...args) => globalThis.fetch(...args),
  upstreamTimeoutMs: Number(
    process.env.VIVENTIUM_GLASSHIVE_INFERENCE_UPSTREAM_TIMEOUT_MS || 120000,
  ),
  log: (event, context) => logger.info(`[VIVENTIUM][glasshive-inference-broker] ${event}`, context),
});
/* === VIVENTIUM END === */
