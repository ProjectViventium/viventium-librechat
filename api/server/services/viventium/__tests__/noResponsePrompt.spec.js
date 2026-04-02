/* === VIVENTIUM START ===
 * Tests: No Response Tag ({NTA}) prompt injection (env-gated)
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const {
  NO_RESPONSE_ENABLED_ENV,
  isNoResponsePromptEnabled,
  resolveNoResponsePromptText,
  buildNoResponseInstructions,
} = require('../noResponsePrompt');

describe('noResponsePrompt', () => {
  const originalEnv = process.env[NO_RESPONSE_ENABLED_ENV];

  afterEach(() => {
    if (originalEnv == null) {
      delete process.env[NO_RESPONSE_ENABLED_ENV];
    } else {
      process.env[NO_RESPONSE_ENABLED_ENV] = originalEnv;
    }
  });

  test('isNoResponsePromptEnabled defaults to false', () => {
    delete process.env[NO_RESPONSE_ENABLED_ENV];
    expect(isNoResponsePromptEnabled()).toBe(false);
  });

  test('buildNoResponseInstructions returns empty string when disabled', () => {
    delete process.env[NO_RESPONSE_ENABLED_ENV];
    expect(buildNoResponseInstructions({ config: {} })).toBe('');
  });

  test('buildNoResponseInstructions returns default prompt when enabled', () => {
    process.env[NO_RESPONSE_ENABLED_ENV] = '1';
    const text = buildNoResponseInstructions({ config: {} });
    expect(typeof text).toBe('string');
    expect(text).toContain('{NTA}');
    expect(text.toLowerCase()).toContain('output only');
  });

  test('resolveNoResponsePromptText uses config override', () => {
    const req = {
      config: {
        viventium: {
          no_response: {
            prompt: 'CUSTOM PROMPT {NTA}\n',
          },
        },
      },
    };
    expect(resolveNoResponsePromptText(req)).toBe('CUSTOM PROMPT {NTA}');
  });

  test('buildNoResponseInstructions uses config override when enabled', () => {
    process.env[NO_RESPONSE_ENABLED_ENV] = 'true';
    const req = {
      config: {
        viventium: {
          no_response: {
            prompt: 'CUSTOM PROMPT {NTA}',
          },
        },
      },
    };
    expect(buildNoResponseInstructions(req)).toBe('CUSTOM PROMPT {NTA}');
  });
});
