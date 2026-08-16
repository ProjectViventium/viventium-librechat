const {
  DELIVERY_CONTROL_VERSION,
  MESSAGE_BREAK_TOKEN,
  SKIP_VOICE_TOKEN,
  parseDeliveryControls,
  stripDeliveryControlsForPreview,
} = require('../deliveryControls');

describe('deliveryControls', () => {
  test('parses standalone controls into one clean logical turn', () => {
    const parsed = parseDeliveryControls(
      ['First thought.', '{MSG_BREAK}', 'Second thought.', '{SKIP_VOICE}'].join('\n'),
    );

    expect(parsed).toMatchObject({
      contractVersion: DELIVERY_CONTROL_VERSION,
      skipVoice: true,
      messageBreakCount: 1,
      mergedBreakCount: 0,
      cleanText: 'First thought.\n\nSecond thought.',
      segments: ['First thought.', 'Second thought.'],
    });
    expect(SKIP_VOICE_TOKEN).toBe('{SKIP_VOICE}');
    expect(MESSAGE_BREAK_TOKEN).toBe('{MSG_BREAK}');
  });

  test('preserves controls mentioned inside code, quotes, or ordinary prose', () => {
    const source = [
      'Use `{SKIP_VOICE}` in this example.',
      '```text',
      '{MSG_BREAK}',
      '```',
      '> {SKIP_VOICE}',
      'A literal {MSG_BREAK} inside a sentence stays.',
    ].join('\n');

    const parsed = parseDeliveryControls(source);

    expect(parsed.skipVoice).toBe(false);
    expect(parsed.messageBreakCount).toBe(0);
    expect(parsed.cleanText).toBe(source);
  });

  test('caps semantic delivery at three non-empty messages', () => {
    const parsed = parseDeliveryControls(
      ['One.', '{MSG_BREAK}', 'Two.', '{MSG_BREAK}', 'Three.', '{MSG_BREAK}', 'Four.'].join('\n'),
    );

    expect(parsed.segments).toEqual(['One.', 'Two.', 'Three.\n\nFour.']);
    expect(parsed.messageBreakCount).toBe(2);
    expect(parsed.mergedBreakCount).toBe(1);
  });

  test('anchors case, CRLF, and tilde-fence behavior independently', () => {
    const source = 'Before.\r\n  { skip_voice }  \r\n~~~text\r\n{MSG_BREAK}\r\n~~~\r\nAfter.';

    const parsed = parseDeliveryControls(source);

    expect(parsed.skipVoice).toBe(true);
    expect(parsed.skipVoiceCount).toBe(1);
    expect(parsed.messageBreakCount).toBe(0);
    expect(parsed.cleanText).toBe('Before.\n~~~text\n{MSG_BREAK}\n~~~\nAfter.');
  });

  test('hides an incomplete reserved control suffix during streaming', () => {
    expect(stripDeliveryControlsForPreview('Draft ready.\n{SKIP_')).toBe('Draft ready.');
    expect(stripDeliveryControlsForPreview('First.\n{MSG_BREAK}\nSec')).toBe('First.\n\nSec');
    expect(stripDeliveryControlsForPreview('Literal {MSG_ in prose')).toBe(
      'Literal {MSG_ in prose',
    );
  });
});
