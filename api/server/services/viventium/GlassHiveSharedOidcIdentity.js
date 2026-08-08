/* === VIVENTIUM START ===
 * Feature: Shared-OIDC GlassHive principal binding.
 * Purpose: Derive the same opaque issuer+subject principal used by GlassHive at LibreChat
 * sign-in, so enterprise users can link by identity proof without email or per-user config.
 */

const crypto = require('crypto');

function sharedOidcSettings() {
  const issuer = String(process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_ISSUER || '')
    .trim()
    .replace(/\/+$/, '');
  const principalClaim = String(
    process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_PRINCIPAL_CLAIM || '',
  ).trim();
  return { issuer, principalClaim };
}

function glassHivePrincipalIdFromClaims(claims = {}) {
  const { issuer, principalClaim } = sharedOidcSettings();
  if (!issuer || !principalClaim) {
    return '';
  }
  const tokenIssuer = String(claims?.iss || '')
    .trim()
    .replace(/\/+$/, '');
  if (!tokenIssuer || tokenIssuer !== issuer) {
    return '';
  }
  const subject = String(claims?.[principalClaim] || '').trim();
  const hasControlCharacter = Array.from(subject).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!subject || subject.length > 512 || hasControlCharacter) {
    return '';
  }
  const digest = crypto.createHash('sha256').update(`${issuer}\0${subject}`).digest('hex');
  return `usr_${digest.slice(0, 32)}`;
}

module.exports = {
  glassHivePrincipalIdFromClaims,
  sharedOidcSettings,
};
/* === VIVENTIUM END === */
