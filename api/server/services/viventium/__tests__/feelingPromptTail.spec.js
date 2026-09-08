/* === VIVENTIUM START ===
 * Feature: Final Feeling capsule placement regression coverage.
 * Purpose: Prove the private capsule is pinned once at the final behavioral instruction boundary.
 * === VIVENTIUM END === */

const {
  getViventiumUserFactGuard,
  buildViventiumDynamicTail,
  pinFeelingCapsuleLast,
  pinViventiumDynamicTailLast,
} = require('~/server/services/viventium/feelingPromptTail');

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildPromptBundleFixture,
} = require('../../../../../scripts/test-support/promptBundle.cjs');

describe('Feeling prompt tail', () => {
  const root = path.resolve(__dirname, '../../../../..');
  const previous = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  let directory;
  let source;
  let bundle;
  function compile() {
    fs.writeFileSync(bundle, JSON.stringify(buildPromptBundleFixture(directory)));
    process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundle;
  }
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feeling-tail-source-'));
    source = path.join(directory, 'guard.md');
    bundle = path.join(directory, 'bundle.json');
    fs.copyFileSync(
      path.join(root, 'viventium/source_of_truth/prompts/main/user_fact_guard.md'),
      source,
    );
    compile();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });

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
    expect(buildViventiumDynamicTail({ capsule: '' })).toBe(getViventiumUserFactGuard());
    expect(getViventiumUserFactGuard()).toBe(
      "Use only facts from the user's current request, prepared My World context (including saved memory and authorized /Life sources), or verified tool results. Keep supplied facts literal and intact; add style around them, never substitute them. When sources conflict, name the conflict instead of choosing or inventing. Own your choice without assigning the user any motive, desire, problem, preference, or history.",
    );
  });

  test('uses the compiled fact source on the next call and never an inline fallback', () => {
    const original = getViventiumUserFactGuard();
    fs.writeFileSync(
      source,
      fs.readFileSync(source, 'utf8').replace(original, 'Synthetic edited fact guard.'),
    );
    expect(buildViventiumDynamicTail({})).toBe(original);
    compile();
    expect(buildViventiumDynamicTail({})).toBe('Synthetic edited fact guard.');
    fs.unlinkSync(bundle);
    expect(() => buildViventiumDynamicTail({})).toThrow('prompt_bundle_unavailable');
  });

  test('keeps the user-fact guard before the exact final Feeling capsule without duplicates', () => {
    const tail = buildViventiumDynamicTail({ capsule });
    const once = pinViventiumDynamicTailLast({
      instructions: `base\n\n${getViventiumUserFactGuard()}\n\n${capsule}`,
      capsule,
    });
    const twice = pinViventiumDynamicTailLast({ instructions: once, capsule });

    expect(tail).toBe(`${getViventiumUserFactGuard()}\n\n${capsule}`);
    expect(twice).toBe(once);
    expect(twice.endsWith(capsule)).toBe(true);
    expect(twice.match(/Use only facts from the user's current request/g)).toHaveLength(1);
    expect(twice.match(/<viventium_feeling_state>/g)).toHaveLength(1);
  });
});
