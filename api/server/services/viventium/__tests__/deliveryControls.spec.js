'use strict';

const {
  DELIVERY_CONTROL_VERSION,
  MESSAGE_BREAK_TOKEN,
  SKIP_VOICE_TOKEN,
  parseDeliveryControls,
  stripDeliveryControlsForPreview,
} = require('../deliveryControls');

describe('deliveryControls', () => {
  test('builds one clean logical turn with bounded semantic segments', () => {
    const parsed = parseDeliveryControls(
      ['First thought.', '{MSG_BREAK}', 'Second thought.', '{SKIP_VOICE}'].join('\n'),
    );

    expect(parsed.contractVersion).toBe(DELIVERY_CONTROL_VERSION);
    expect(parsed.skipVoice).toBe(true);
    expect(parsed.messageBreakCount).toBe(1);
    expect(parsed.mergedBreakCount).toBe(0);
    expect(parsed.cleanText).toBe('First thought.\n\nSecond thought.');
    expect(parsed.segments).toEqual(['First thought.', 'Second thought.']);
    expect(SKIP_VOICE_TOKEN).toBe('{SKIP_VOICE}');
    expect(MESSAGE_BREAK_TOKEN).toBe('{MSG_BREAK}');
  });

  test('protects code, quotes, and inline prose', () => {
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

  test('caps semantic delivery at three messages', () => {
    const parsed = parseDeliveryControls(
      ['One.', '{MSG_BREAK}', 'Two.', '{MSG_BREAK}', 'Three.', '{MSG_BREAK}', 'Four.'].join('\n'),
    );

    expect(parsed.segments).toEqual(['One.', 'Two.', 'Three.\n\nFour.']);
    expect(parsed.messageBreakCount).toBe(2);
    expect(parsed.mergedBreakCount).toBe(1);
  });

  test('hides incomplete reserved streaming suffixes without hiding protected examples', () => {
    expect(stripDeliveryControlsForPreview('Draft ready.\n{')).toBe('Draft ready.');
    expect(stripDeliveryControlsForPreview('Draft ready.\n{SKIP_')).toBe('Draft ready.');
    expect(stripDeliveryControlsForPreview('First.\n{MSG_BREAK}\nSec')).toBe('First.\n\nSec');
    expect(stripDeliveryControlsForPreview('~~~text\n{MSG_\n~~~')).toBe('~~~text\n{MSG_\n~~~');
    expect(stripDeliveryControlsForPreview('> {SKIP_')).toBe('> {SKIP_');
    expect(stripDeliveryControlsForPreview('Literal {MSG_ in prose')).toBe(
      'Literal {MSG_ in prose',
    );
  });
});
