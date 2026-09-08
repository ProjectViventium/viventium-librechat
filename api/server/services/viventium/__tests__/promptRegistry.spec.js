/* === VIVENTIUM START ===
 * Tests: Prompt registry runtime lookup contract.
 * Added: 2026-05-09
 * === VIVENTIUM END === */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  PROMPT_BUNDLE_ENV,
  getPromptBundleStatus,
  getRequiredPromptText,
  getPromptText,
  resetPromptRegistryForTests,
} = require('../promptRegistry');

describe('promptRegistry', () => {
  const originalBundlePath = process.env[PROMPT_BUNDLE_ENV];

  afterEach(() => {
    if (originalBundlePath == null) {
      delete process.env[PROMPT_BUNDLE_ENV];
    } else {
      process.env[PROMPT_BUNDLE_ENV] = originalBundlePath;
    }
    resetPromptRegistryForTests();
  });

  function writeBundle(payload) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-bundle-'));
    const filePath = path.join(dir, 'prompt-bundle.json');
    fs.writeFileSync(filePath, JSON.stringify(payload), 'utf8');
    process.env[PROMPT_BUNDLE_ENV] = filePath;
    resetPromptRegistryForTests();
    return filePath;
  }

  test('uses fallback when no compiled bundle is configured', () => {
    delete process.env[PROMPT_BUNDLE_ENV];
    resetPromptRegistryForTests();

    expect(getPromptText('surface.web', 'fallback prompt')).toBe('fallback prompt');
    expect(getPromptBundleStatus().loaded).toBe(false);
  });

  test('authoritative emotional-reaction prompt defines proportional strengths without minimum bias', () => {
    const promptPath = path.resolve(
      __dirname,
      '../../../../../viventium/source_of_truth/prompts/cortex/emotional_reaction/execution.md',
    );
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).not.toContain('smallest accurate strength');
    expect(prompt).toContain('Slight means a subtle but real movement');
    expect(prompt).toContain('Clear means an unmistakable movement');
    expect(prompt).toContain('Strong means a pronounced movement');
    expect(prompt).toContain('Do not default to `slight`');
  });

  test('renders compiled prompt with includes and variables from memory only', () => {
    writeBundle({
      schema_version: 1,
      prompt_count: 2,
      prompts: {
        base: {
          metadata: {},
          body: 'BASE',
        },
        child: {
          metadata: {
            includes: ['base'],
          },
          body: 'Hello {{name}}',
        },
      },
    });

    expect(getPromptText('child', 'fallback', { name: 'Viv' })).toBe('BASE\n\nHello Viv');
    expect(getPromptBundleStatus()).toEqual(
      expect.objectContaining({
        loaded: true,
        promptCount: 2,
      }),
    );
  });

  test('preserves known runtime placeholders for non-strict prompts', () => {
    writeBundle({
      schema_version: 1,
      prompt_count: 1,
      prompts: {
        child: {
          metadata: {},
          body: 'Hello {{current_user}}',
        },
      },
    });

    expect(getPromptText('child', 'fallback')).toBe('Hello {{current_user}}');
  });

  test('falls back on unknown non-strict placeholders instead of leaking typos to the model', () => {
    writeBundle({
      schema_version: 1,
      prompt_count: 1,
      prompts: {
        child: {
          metadata: {},
          body: 'Hello {{currnet_user}}',
        },
      },
    });

    expect(getPromptText('child', 'fallback')).toBe('fallback');
  });

  test('falls back on missing strict variables instead of breaking a user request', () => {
    writeBundle({
      schema_version: 1,
      prompt_count: 1,
      prompts: {
        child: {
          metadata: {
            strict_variables: true,
          },
          body: 'Hello {{name}}',
        },
      },
    });

    expect(getPromptText('child', 'fallback')).toBe('fallback');
  });

  test('reloads when the prompt bundle path changes', () => {
    const firstPath = writeBundle({
      schema_version: 1,
      prompt_count: 1,
      prompts: {
        child: {
          metadata: {},
          body: 'First',
        },
      },
    });
    expect(firstPath).toBe(process.env[PROMPT_BUNDLE_ENV]);
    expect(getPromptText('child', 'fallback')).toBe('First');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-prompt-bundle-'));
    const secondPath = path.join(dir, 'prompt-bundle.json');
    fs.writeFileSync(
      secondPath,
      JSON.stringify({
        schema_version: 1,
        prompt_count: 1,
        prompts: {
          child: {
            metadata: {},
            body: 'Second',
          },
        },
      }),
      'utf8',
    );
    process.env[PROMPT_BUNDLE_ENV] = secondPath;

    expect(getPromptText('child', 'fallback')).toBe('Second');
  });

  test.each(['replace', 'overwrite'])('reloads a same-path %s and rollback without a process restart', (mode) => {
    const original = JSON.stringify({ prompt_count: 1, prompts: { child: { body: 'First' } } });
    const replacement = JSON.stringify({ prompt_count: 1, prompts: { child: { body: 'Other' } } });
    const bundlePath = writeBundle(JSON.parse(original));
    const initialStat = fs.statSync(bundlePath);
    expect(getRequiredPromptText('child')).toBe('First');
    const publish = (bytes) => {
      if (mode === 'replace') {
        fs.writeFileSync(`${bundlePath}.next`, bytes);
        fs.utimesSync(`${bundlePath}.next`, initialStat.atime, initialStat.mtime);
        fs.renameSync(`${bundlePath}.next`, bundlePath);
      } else {
        fs.writeFileSync(bundlePath, bytes);
        fs.utimesSync(bundlePath, initialStat.atime, initialStat.mtime);
      }
    };
    publish(replacement);
    expect(getRequiredPromptText('child')).toBe('Other');
    expect(getPromptBundleStatus().sha256).toBe(crypto.createHash('sha256').update(replacement).digest('hex'));
    publish(original);
    expect(getRequiredPromptText('child')).toBe('First');
    expect(getPromptBundleStatus().sha256).toBe(crypto.createHash('sha256').update(original).digest('hex'));
  });

  test('fails closed on a removed or corrupt current bundle and recovers after valid publication', () => {
    const payload = { prompt_count: 1, prompts: { child: { body: 'Current' } } };
    const bundlePath = writeBundle(payload);
    expect(getRequiredPromptText('child')).toBe('Current');
    fs.unlinkSync(bundlePath);
    expect(() => getRequiredPromptText('child')).toThrow('prompt_bundle_unavailable');
    expect(getPromptBundleStatus()).toMatchObject({ loaded: false, sha256: '' });
    fs.writeFileSync(bundlePath, '{invalid');
    expect(() => getRequiredPromptText('child')).toThrow('prompt_bundle_unavailable');
    fs.writeFileSync(bundlePath, JSON.stringify(payload));
    expect(getRequiredPromptText('child')).toBe('Current');
  });

  test('keeps parsed bundle bytes cached while the artifact identity is unchanged', () => {
    const bundlePath = writeBundle({ prompt_count: 1, prompts: { child: { body: 'Current' } } });
    const read = jest.spyOn(fs, 'readFileSync');
    try {
      expect(getRequiredPromptText('child')).toBe('Current');
      expect(getRequiredPromptText('child')).toBe('Current');
      expect(getPromptBundleStatus().loaded).toBe(true);
      expect(read.mock.calls.filter(([file]) => file === bundlePath)).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });
});
