/* === VIVENTIUM START ===
 * Feature: Final Feeling capsule placement regression coverage.
 * Purpose: Prove the private capsule is pinned once at the final behavioral instruction boundary.
 * === VIVENTIUM END === */

const {
  VIVENTIUM_USER_FACT_GUARD,
  buildViventiumDynamicTail,
  pinFeelingCapsuleLast,
  pinViventiumDynamicTailLast,
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
  test('repins the capsule after context appended for a speculative nevermind rerun', () => {
    const firstRun = pinFeelingCapsuleLast({ instructions: 'base instructions', capsule });
    const rerun = pinFeelingCapsuleLast({
      instructions: `${firstRun}\n\nActivated Background Agents:\n- synthetic cortex result`,
      capsule,
    });

    expect(rerun.endsWith(capsule)).toBe(true);
    expect(rerun.match(/<viventium_feeling_state>/g)).toHaveLength(1);
    expect(rerun.indexOf('Activated Background Agents:')).toBeLessThan(rerun.indexOf(capsule));
  });

  test('keeps a concise user-fact guard at the final developer layer even when Feelings are off', () => {
    expect(buildViventiumDynamicTail({ capsule: '' })).toBe(VIVENTIUM_USER_FACT_GUARD);
    expect(VIVENTIUM_USER_FACT_GUARD).toBe(
      "Use only facts from the user's current request, prepared My World context (including saved memory and authorized /Life sources), or verified tool results. Keep supplied facts literal and intact; add style around them, never substitute them. When sources conflict, name the conflict instead of choosing or inventing. Own your choice without assigning the user any motive, desire, problem, preference, or history.",
    );
  });

  test('keeps the user-fact guard before the exact final Feeling capsule without duplicates', () => {
    const tail = buildViventiumDynamicTail({ capsule });
    const once = pinViventiumDynamicTailLast({
      instructions: `base\n\n${VIVENTIUM_USER_FACT_GUARD}\n\n${capsule}`,
      capsule,
    });
    const twice = pinViventiumDynamicTailLast({ instructions: once, capsule });

    expect(tail).toBe(`${VIVENTIUM_USER_FACT_GUARD}\n\n${capsule}`);
    expect(twice).toBe(once);
    expect(twice.endsWith(capsule)).toBe(true);
    expect(twice.match(/Use only facts from the user's current request/g)).toHaveLength(1);
    expect(twice.match(/<viventium_feeling_state>/g)).toHaveLength(1);
  });
});
