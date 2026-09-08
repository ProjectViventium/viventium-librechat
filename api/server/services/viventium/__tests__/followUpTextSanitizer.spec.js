/* === VIVENTIUM START ===
 * Tests: Follow-up text sanitization.
 * Added: 2026-03-08
 * === VIVENTIUM END === */

const {
  sanitizeFollowUpDisplayText,
  stripCitationArtifacts,
  stripLeadingReasoningArtifacts,
  stripToolTranscriptArtifacts,
} = require('../followUpTextSanitizer');

describe('followUpTextSanitizer', () => {
  const originalArtifactBaseUrl = process.env.GLASSHIVE_ARTIFACT_BASE_URL;

  afterEach(() => {
    if (originalArtifactBaseUrl === undefined) {
      delete process.env.GLASSHIVE_ARTIFACT_BASE_URL;
    } else {
      process.env.GLASSHIVE_ARTIFACT_BASE_URL = originalArtifactBaseUrl;
    }
  });

  test('strips leaked no-response tags when content is present', () => {
    expect(sanitizeFollowUpDisplayText('{NTA} Useful follow-up')).toBe('Useful follow-up');
    expect(sanitizeFollowUpDisplayText('Useful follow-up {NTA}')).toBe('Useful follow-up');
  });

  test('preserves pure no-response output for suppression logic', () => {
    expect(sanitizeFollowUpDisplayText('{NTA}')).toBe('{NTA}');
  });

  test('removes LibreChat citation artifacts from follow-up text', () => {
    const raw = 'Hello \ue202turn0search0 world [12] done';
    expect(stripCitationArtifacts(raw)).toBe('Hello world [12] done');
  });

  test.each([
    'Question?\n\n1. First.\n   - Nested point.\n     - Second level.',
    '```js\nconst message = "two  spaces";\nif (ready) {\n  result[12] = "why?";\n}\n```',
    '[Source](https://docs.example.test/path?lang=en&section=one).',
    'Reference [12] remains meaningful.',
  ])('preserves user-visible Markdown, code and links %#', (raw) => {
    expect(sanitizeFollowUpDisplayText(raw)).toBe(raw);
  });

  test('strips malformed leaked thinking-mode wrappers and keeps the visible continuation', () => {
    const raw = [
      '<thinking_mode>on</thinking_mode>',
      '',
      'Internal reasoning that should stay hidden.',
      '</thinking>',
      '',
      'Visible Phase B follow-up.',
    ].join('\n');

    expect(sanitizeFollowUpDisplayText(raw)).toBe('Visible Phase B follow-up.');
  });

  test('strips legacy and modern leading think blocks', () => {
    expect(
      stripLeadingReasoningArtifacts('<think>Reason privately.</think>\nVisible answer.'),
    ).toBe('Visible answer.');
    expect(
      stripLeadingReasoningArtifacts(':::thinking\nReason privately.\n:::\nVisible answer.'),
    ).toBe('Visible answer.');
  });

  test('returns empty string when the follow-up only contains leaked reasoning', () => {
    const raw = '<thinking_mode>on</thinking_mode>\nHidden only.\n</thinking>';
    expect(sanitizeFollowUpDisplayText(raw)).toBe('');
  });

  test('does not strip normal visible text that merely mentions think tags later', () => {
    const raw = 'Visible answer first. Example code: <think>literal</think>';
    expect(sanitizeFollowUpDisplayText(raw)).toBe(raw);
  });

  test('strips leaked MCP tool transcript lines from follow-up display text', () => {
    const raw = [
      'Tool: worker_live_mcp_glasshive-workers-projects, [{"type":"text","text":"internal"}]',
      '',
      'The task finished.',
    ].join('\n');

    expect(stripToolTranscriptArtifacts(raw)).toBe('The task finished.');
    expect(sanitizeFollowUpDisplayText(raw)).toBe('The task finished.');
  });

  test('uses the configured artifact origin for an opaque GlassHive link reference', () => {
    process.env.GLASSHIVE_ARTIFACT_BASE_URL = 'http://127.0.0.1:8780';
    const ref = 'ghr_1234567890abcdef12345678';
    const raw = `[Preview](https://glasshive.example.test/v1/link-refs/${ref})`;

    expect(sanitizeFollowUpDisplayText(raw)).toBe(
      `[Preview](http://127.0.0.1:8780/v1/link-refs/${ref})`,
    );
  });
});
