/* === VIVENTIUM START ===
 * Tests: Prompt registry runtime lookup contract.
 * Added: 2026-05-09
 * === VIVENTIUM END === */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PROMPT_BUNDLE_ENV,
  getPromptBundleStatus,
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
});
