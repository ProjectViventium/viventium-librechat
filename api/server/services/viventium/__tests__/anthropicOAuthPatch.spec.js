/* === VIVENTIUM START ===
 * Tests: Anthropic connected-account Claude Code system prompt patch.
 *
 * Purpose:
 * - Anthropic subscription bearer tokens reject requests that omit the
 *   Claude Code system block.
 * - Ensure the runtime normalizer prepends the required block without
 *   duplicating it.
 *
 * Added: 2026-03-19
 * === VIVENTIUM END === */

const {
  ANTHROPIC_OAUTH_SYSTEM_TEXT,
  ensureAnthropicOAuthSystemPrompt,
} = require('../anthropicOAuthPatch');

describe('anthropicOAuthPatch', () => {
  test('prepends the Claude Code system block when system blocks are missing it', () => {
    const result = ensureAnthropicOAuthSystemPrompt({
      system: [{ type: 'text', text: 'Current time: now' }],
    });

    expect(result.system).toEqual([
      { type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT },
      { type: 'text', text: 'Current time: now' },
    ]);
  });

  test('does not duplicate the Claude Code system block when already present', () => {
    const result = ensureAnthropicOAuthSystemPrompt({
      system: [
        { type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT },
        { type: 'text', text: 'Current time: now' },
      ],
    });

    expect(result.system).toEqual([
      { type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT },
      { type: 'text', text: 'Current time: now' },
    ]);
  });

  test('converts string system prompts into Anthropic text blocks with Claude Code first', () => {
    const result = ensureAnthropicOAuthSystemPrompt({
      system: 'Current time: now',
    });

    expect(result.system).toEqual([
      { type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT },
      { type: 'text', text: 'Current time: now' },
    ]);
  });
});
