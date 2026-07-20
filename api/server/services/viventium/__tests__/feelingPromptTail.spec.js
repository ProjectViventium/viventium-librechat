/* === VIVENTIUM START ===
 * Feature: Final Feeling capsule placement regression coverage.
 * Purpose: Prove the private capsule is pinned once at the final behavioral instruction boundary.
 * === VIVENTIUM END === */

const {
  pinFeelingCapsuleLast,
} = require('~/server/services/viventium/feelingPromptTail');

describe('Feeling prompt tail', () => {
  const capsule = [
    '<viventium_feeling_state>',
    'synthetic private cause',
    '</viventium_feeling_state>',
  ].join('\n');

  test('moves the exact capsule after later structural instructions without duplicating it', () => {
    const result = pinFeelingCapsuleLast({
      instructions: `base instructions\n\n${capsule}\n\nstructural output contract`,
      capsule,
    });

    expect(result.endsWith(capsule)).toBe(true);
    expect(result.match(/<viventium_feeling_state>/g)).toHaveLength(1);
    expect(result).toContain('structural output contract');
    expect(result.indexOf('structural output contract')).toBeLessThan(result.indexOf(capsule));
  });

  test('is idempotent and leaves instructions unchanged when there is no capsule', () => {
    const once = pinFeelingCapsuleLast({ instructions: `base\n\n${capsule}`, capsule });
    const twice = pinFeelingCapsuleLast({ instructions: once, capsule });

    expect(twice).toBe(once);
    expect(pinFeelingCapsuleLast({ instructions: 'base', capsule: '' })).toBe('base');
  });
});
