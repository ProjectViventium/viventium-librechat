/* === VIVENTIUM START ===
 * Feature: Final Feeling prompt authority.
 * Purpose: Keep one exact, structured Feeling capsule at the final instruction layer after
 * request-specific delivery contracts have been assembled. This never interprets prompt text.
 * === VIVENTIUM END === */

'use strict';

const { getRequiredPromptText } = require('./promptRegistry');

function getViventiumUserFactGuard() {
  return getRequiredPromptText('main.user_fact_guard');
}

/* === VIVENTIUM START ===
 * Fix: A per-turn-header Main keeps its request-pinned saved-memory snapshot out of stable
 * authority, so it rides in this per-turn developer tail: facts first, then the fact guard, with
 * the exact Feeling capsule last.
 * === VIVENTIUM END === */
function buildViventiumDynamicTail({ memory, capsule } = {}) {
  const exactMemory = typeof memory === 'string' ? memory.trim() : '';
  const exactCapsule = typeof capsule === 'string' ? capsule.trim() : '';
  return [exactMemory, getViventiumUserFactGuard(), exactCapsule].filter(Boolean).join('\n\n');
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

function pinViventiumDynamicTailLast({ instructions, memory, capsule } = {}) {
  const current = typeof instructions === 'string' ? instructions : '';
  const exactMemory = typeof memory === 'string' ? memory.trim() : '';
  const exactCapsule = typeof capsule === 'string' ? capsule.trim() : '';
  const factGuard = getViventiumUserFactGuard();
  let withoutTail = current.split(factGuard).join('');
  if (exactMemory) {
    withoutTail = withoutTail.split(exactMemory).join('');
  }
  if (exactCapsule) {
    withoutTail = withoutTail.split(exactCapsule).join('');
  }
  withoutTail = withoutTail.replace(/\n{3,}/g, '\n\n').trim();
  return [withoutTail, [exactMemory, factGuard, exactCapsule].filter(Boolean).join('\n\n')]
    .filter(Boolean)
    .join('\n\n');
}

module.exports = {
  getViventiumUserFactGuard,
  buildViventiumDynamicTail,
  pinFeelingCapsuleLast,
  pinViventiumDynamicTailLast,
};
