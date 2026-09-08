'use strict';

const {
  sanitizeVoiceAssistantMessageForPersistence,
  sanitizeVoiceSurfaceTextForDisplay,
} = require('../voiceArtifactText');

describe('voice linked-chat formatting', () => {
  const markdown = [
    '## Repair checklist',
    '',
    '### Preparation',
    'Bring a pencil and a sheet of paper.',
    '',
    '1. Record the issue.',
    '2. Compare the options.',
    '',
    '### Result',
    'Choose the next step.',
  ].join('\n');

  test.each([
    ['string', (text) => text],
    ['value', (text) => ({ value: text, annotations: [] })],
    ['text', (text) => ({ text })],
  ])('preserves authored line breaks in persisted text and %s content', (_kind, wrap) => {
    const message = {
      messageId: 'response-synthetic',
      text: markdown,
      content: [{ type: 'text', text: wrap(markdown) }],
      metadata: { source: 'synthetic' },
    };

    expect(sanitizeVoiceAssistantMessageForPersistence({ body: { voiceMode: true } }, message))
      .toEqual(message);
  });

  test('keeps paragraph boundaries while stripping transport controls and private reasoning', () => {
    const authored = `{SKIP_VOICE}\n<soft>${markdown}</soft>`;
    const result = sanitizeVoiceAssistantMessageForPersistence(
      { body: { voiceMode: true } },
      { text: '', content: [
        { type: 'reasoning', text: 'Private reasoning.' },
        { type: 'text', text: authored },
      ] },
    );

    expect(result.text).toBe(markdown);
    expect(result.content).toEqual([{ type: 'text', text: markdown }]);
  });

  test('does not consume a line break next to punctuation during display cleanup', () => {
    expect(sanitizeVoiceSurfaceTextForDisplay('First line\n; second line. Next , word.'))
      .toBe('First line\n; second line. Next, word.');
  });

  test('preserves nested-list indentation and Markdown hard breaks', () => {
    const text = '## Tasks\n\n- Prepare the room.\n    - Clear the entrance.\n\nFirst line.  \nSecond line.';
    expect(sanitizeVoiceAssistantMessageForPersistence(
      { body: { voiceMode: true } }, { text },
    ).text).toBe(text);
  });

  test('preserves indented code layout while removing existing fence artifacts', () => {
    const text = 'Example:\n\n```text\n    first\n        second\n    ; comment\n```\n\nDone.';
    expect(sanitizeVoiceSurfaceTextForDisplay(text))
      .toBe('Example:\n\n\n    first\n        second\n    ; comment\n\n\nDone.');
  });
});
