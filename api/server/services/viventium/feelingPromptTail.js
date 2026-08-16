/* === VIVENTIUM START ===
 * Feature: Final Feeling prompt authority.
 * Purpose: Keep one exact, structured Feeling capsule at the final instruction layer after
 * request-specific delivery contracts have been assembled. This never interprets prompt text.
 * === VIVENTIUM END === */

'use strict';

const VIVENTIUM_USER_FACT_GUARD =
  "Use only facts from the user's current request, prepared My World context (including saved memory and authorized /Life sources), or verified tool results. Keep supplied facts literal and intact; add style around them, never substitute them. When sources conflict, name the conflict instead of choosing or inventing. Own your choice without assigning the user any motive, desire, problem, preference, or history.";

function buildViventiumDynamicTail({ capsule } = {}) {
  const exactCapsule = typeof capsule === 'string' ? capsule.trim() : '';
  return [VIVENTIUM_USER_FACT_GUARD, exactCapsule].filter(Boolean).join('\n\n');
}

function pinFeelingCapsuleLast({ instructions, capsule }) {
  const current = typeof instructions === 'string' ? instructions : '';
  const exactCapsule = typeof capsule === 'string' ? capsule.trim() : '';
  if (!exactCapsule) return current;

  const withoutCapsule = current
    .split(exactCapsule)
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return [withoutCapsule, exactCapsule].filter(Boolean).join('\n\n');
}

function pinViventiumDynamicTailLast({ instructions, capsule } = {}) {
  const current = typeof instructions === 'string' ? instructions : '';
  const exactCapsule = typeof capsule === 'string' ? capsule.trim() : '';
  let withoutTail = current.split(VIVENTIUM_USER_FACT_GUARD).join('');
  if (exactCapsule) {
    withoutTail = withoutTail.split(exactCapsule).join('');
  }
  withoutTail = withoutTail.replace(/\n{3,}/g, '\n\n').trim();
  return [withoutTail, buildViventiumDynamicTail({ capsule: exactCapsule })]
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  VIVENTIUM_USER_FACT_GUARD,
  buildViventiumDynamicTail,
  pinFeelingCapsuleLast,
  pinViventiumDynamicTailLast,
};
