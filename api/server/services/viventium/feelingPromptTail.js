/* === VIVENTIUM START ===
 * Feature: Final Feeling prompt authority.
 * Purpose: Keep one exact, structured Feeling capsule at the final instruction layer after
 * request-specific delivery contracts have been assembled. This never interprets prompt text.
 * === VIVENTIUM END === */

'use strict';

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

module.exports = { pinFeelingCapsuleLast };
