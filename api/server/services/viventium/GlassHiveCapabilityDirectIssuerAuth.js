/* === VIVENTIUM START ===
 * Feature: Direct GlassHive connected-capability issuer authentication.
 * Purpose: Authenticate short-lived, tenant/user/worker/run-bound S2S requests from the
 * GlassHive runtime without trusting browser-supplied ownership or exposing provider secrets.
 */

const crypto = require('crypto');

const DIRECT_ISSUER_AUDIENCE = 'glasshive-capability-grant-issuer';
const DIRECT_ISSUER_MAX_TTL_SECONDS = 60;
const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

function issuerSecret() {
  return String(
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_ISSUER_SECRET ||
      process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET ||
      '',
  ).trim();
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64urlDecode(value) {
  return Buffer.from(String(value || ''), 'base64url').toString('utf8');
}

function derivedSecret(secret) {
  return crypto
    .createHmac('sha256', secret)
    .update('viventium-glasshive-capability:issuer:v1')
    .digest();
}

function signatureFor(claims, secret) {
  return crypto
    .createHmac('sha256', derivedSecret(secret))
    .update(stableJson(claims))
    .digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validScope(value) {
  return SCOPE_PATTERN.test(String(value || '').trim());
}

function verifyDirectIssuerAssertion(token, { action, expectedTenantId, nowMs = Date.now() } = {}) {
  const secret = issuerSecret();
  if (secret.length < 32) {
    throw new Error('GlassHive direct capability issuer secret is not configured');
  }
  let claims;
  try {
    claims = JSON.parse(base64urlDecode(token));
  } catch {
    throw new Error('Invalid GlassHive direct capability issuer assertion');
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('Invalid GlassHive direct capability issuer assertion');
  }
  const signature = String(claims.sig || '');
  const unsigned = { ...claims };
  delete unsigned.sig;
  if (!signature || !safeEqual(signature, signatureFor(unsigned, secret))) {
    throw new Error('Invalid GlassHive direct capability issuer signature');
  }
  const now = Math.floor(nowMs / 1000);
  const issuedAt = Number(claims.iat);
  const expiresAt = Number(claims.exp);
  if (
    claims.aud !== DIRECT_ISSUER_AUDIENCE ||
    claims.action !== action ||
    !['operator_verified', 'shared_oidc_subject'].includes(String(claims.binding_proof || '')) ||
    String(claims.tenant_id || '') !== String(expectedTenantId || '') ||
    !validScope(claims.user_id) ||
    !validScope(claims.nonce) ||
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    issuedAt > now + 30 ||
    expiresAt < now ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > DIRECT_ISSUER_MAX_TTL_SECONDS
  ) {
    throw new Error('Invalid GlassHive direct capability issuer scope');
  }
  if (action !== 'status') {
    if (
      !validScope(claims.worker_id) ||
      !validScope(claims.run_id) ||
      !['host', 'docker'].includes(String(claims.execution_mode || ''))
    ) {
      throw new Error('Invalid GlassHive direct capability run scope');
    }
  }
  return claims;
}

module.exports = {
  DIRECT_ISSUER_AUDIENCE,
  issuerSecret,
  signatureFor,
  verifyDirectIssuerAssertion,
};
/* === VIVENTIUM END === */
