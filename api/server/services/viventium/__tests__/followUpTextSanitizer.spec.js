/* === VIVENTIUM START ===
 * Tests: Follow-up text sanitization.
 * Added: 2026-03-08
 * === VIVENTIUM END === */

const {
  sanitizeFollowUpDisplayText,
  stripCitationArtifacts,
  stripLeadingReasoningArtifacts,
} = require('../followUpTextSanitizer');

describe('followUpTextSanitizer', () => {
  test('strips leaked no-response tags when content is present', () => {
    expect(sanitizeFollowUpDisplayText('{NTA} Useful follow-up')).toBe('Useful follow-up');
    expect(sanitizeFollowUpDisplayText('Useful follow-up {NTA}')).toBe('Useful follow-up');
  });

  test('preserves pure no-response output for suppression logic', () => {
    expect(sanitizeFollowUpDisplayText('{NTA}')).toBe('{NTA}');
  });

  test('removes LibreChat citation artifacts from follow-up text', () => {
    const raw = 'Hello \ue202turn0search0 world [12] done';
    expect(stripCitationArtifacts(raw)).toBe('Hello world done');
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
    expect(stripLeadingReasoningArtifacts('<think>Reason privately.</think>\nVisible answer.')).toBe(
      'Visible answer.',
    );
    expect(stripLeadingReasoningArtifacts(':::thinking\nReason privately.\n:::\nVisible answer.')).toBe(
      'Visible answer.',
    );
  });

  test('returns empty string when the follow-up only contains leaked reasoning', () => {
    const raw = '<thinking_mode>on</thinking_mode>\nHidden only.\n</thinking>';
    expect(sanitizeFollowUpDisplayText(raw)).toBe('');
  });

  test('does not strip normal visible text that merely mentions think tags later', () => {
    const raw = 'Visible answer first. Example code: <think>literal</think>';
    expect(sanitizeFollowUpDisplayText(raw)).toBe(raw);
  });
});
