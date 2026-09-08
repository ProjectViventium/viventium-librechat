/* === VIVENTIUM START ===
 * Typed productivity scope resolves declared ownership. Model instructions and output
 * cannot select runtime scope or remove otherwise authorized context.
 * === VIVENTIUM END === */
'use strict';
const PRODUCTIVITY_SCOPE_KEYS = new Set(['google_workspace', 'ms365']);

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeProductivityScopeOverride(scope) {
  const normalized = normalizeText(scope)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('productivity_')) {
    const stripped = normalized.slice('productivity_'.length);
    return PRODUCTIVITY_SCOPE_KEYS.has(stripped) ? stripped : null;
  }
  return PRODUCTIVITY_SCOPE_KEYS.has(normalized) ? normalized : null;
}

function resolveProductivitySpecialistScope(agent, { scope = null } = {}) {
  return (
    normalizeProductivityScopeOverride(scope) ??
    normalizeProductivityScopeOverride(
      agent?.activation?.intent_scope ?? agent?.activationScope ?? agent?.activation_scope ?? null,
    )
  );
}

module.exports = { resolveProductivitySpecialistScope };
