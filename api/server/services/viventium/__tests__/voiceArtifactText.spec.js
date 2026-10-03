'use strict';

const {
  sanitizeVoiceAssistantMessageForPersistence,
  sanitizeVoiceSurfaceTextForDisplay,
} = require('../voiceArtifactText');

describe('voice linked-chat formatting', () => {
  test.each([
    '[Download report](https://files.example.test/api/files/download/report_01.pdf)',
    'See https://docs.example.test/Guide/A_B?part=One&section=Two#Result.',
    'Sources: [Documentation](https://docs.example.test/reference)\nhttps://docs.example.test/guide',
  ])('preserves complete public links in display and persisted content: %s', (text) => {
    expect(sanitizeVoiceSurfaceTextForDisplay(text)).toBe(text);
    const message = { text, content: [{ type: 'text', text }] };
    expect(
      sanitizeVoiceAssistantMessageForPersistence({ body: { voiceMode: true } }, message),
    ).toEqual(message);
  });

  test('preserves URL bytes while stripping adjacent display controls', () => {
    const url = 'https://docs.example.test/_Section_/File.PDF?part=A_B#Result';
    expect(sanitizeVoiceSurfaceTextForDisplay(`<soft>**Done.**</soft> [Report](${url}) {NTA}`)).toBe(
      `Done. [Report](${url})`,
    );
  });

  test.each([
    ['**[Report](https://docs.example.test/a_b)**', '[Report](https://docs.example.test/a_b)'],
    ['_[Report](https://docs.example.test/a_b)_', '[Report](https://docs.example.test/a_b)'],
    ['~~[Report](https://docs.example.test/a_b)~~', '[Report](https://docs.example.test/a_b)'],
    ['**https://docs.example.test/_Section_**', 'https://docs.example.test/_Section_'],
    ['_https://docs.example.test/a_b_', 'https://docs.example.test/a_b'],
    ['**Read https://docs.example.test/_Section_ now.**', 'Read https://docs.example.test/_Section_ now.'],
  ])('strips outer Markdown while preserving the public URL: %s', (text, expected) => {
    expect(sanitizeVoiceSurfaceTextForDisplay(text)).toBe(expected);
    expect(
      sanitizeVoiceAssistantMessageForPersistence(
        { body: { voiceMode: true } },
        { text, content: [{ type: 'text', text }] },
      ),
    ).toEqual({ text: expected, content: [{ type: 'text', text: expected }] });
  });

  test('preserves email query bytes inside a public link', () => {
    const text = '[Report](https://docs.example.test/report?contact=qa@example.test)';
    expect(sanitizeVoiceSurfaceTextForDisplay(text)).toBe(text);
  });

  test('continues to mask standalone email text beside a public link', () => {
    const text = 'Email qa@example.test or open https://docs.example.test/report.';
    expect(sanitizeVoiceSurfaceTextForDisplay(text)).toBe(
      'Email address available or open https://docs.example.test/report.',
    );
  });

  test('preserves a lowercase Markdown label while stripping a standalone stage direction', () => {
    expect(
      sanitizeVoiceSurfaceTextForDisplay(
        '[thinking] See [report](https://docs.example.test/report).',
      ),
    ).toBe('See [report](https://docs.example.test/report).');
  });

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

    expect(
      sanitizeVoiceAssistantMessageForPersistence({ body: { voiceMode: true } }, message),
    ).toEqual(message);
  });

  test('keeps paragraph boundaries while stripping transport controls and private reasoning', () => {
    const authored = `{SKIP_VOICE}\n<soft>${markdown}</soft>`;
    const result = sanitizeVoiceAssistantMessageForPersistence(
      { body: { voiceMode: true } },
      {
        text: '',
        content: [
          { type: 'reasoning', text: 'Private reasoning.' },
          { type: 'text', text: authored },
        ],
      },
    );

    expect(result.text).toBe(markdown);
    expect(result.content).toEqual([{ type: 'text', text: markdown }]);
  });

  test('does not consume a line break next to punctuation during display cleanup', () => {
    expect(sanitizeVoiceSurfaceTextForDisplay('First line\n; second line. Next , word.')).toBe(
      'First line\n; second line. Next, word.',
    );
  });

  test('preserves nested-list indentation and Markdown hard breaks', () => {
    const text =
      '## Tasks\n\n- Prepare the room.\n    - Clear the entrance.\n\nFirst line.  \nSecond line.';
    expect(
      sanitizeVoiceAssistantMessageForPersistence({ body: { voiceMode: true } }, { text }).text,
    ).toBe(text);
  });

  test('preserves indented code layout while removing existing fence artifacts', () => {
    const text = 'Example:\n\n```text\n    first\n        second\n    ; comment\n```\n\nDone.';
    expect(sanitizeVoiceSurfaceTextForDisplay(text)).toBe(
      'Example:\n\n\n    first\n        second\n    ; comment\n\n\nDone.',
    );
  });
});
