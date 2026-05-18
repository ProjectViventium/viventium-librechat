const { ContentTypes } = require('librechat-data-provider');
const {
  extractVisibleTextFromContentParts,
  repairMissedVoiceMessageDelta,
} = require('../voiceDeltaAggregation');

describe('voiceDeltaAggregation', () => {
  test('repairs an emitted voice delta when upstream aggregation did not advance text', () => {
    const contentParts = [];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear you.' }] } },
      beforeText: '',
      afterText: '',
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'I hear you.' }]);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });

  test('does not duplicate text when upstream aggregation already advanced', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'I hear you.' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear you.' }] } },
      beforeText: '',
      afterText: 'I hear you.',
    });

    expect(repaired).toBe(false);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'I hear you.' }]);
  });

  test('preserves streamed whitespace across repaired deltas', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'I' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: ' hear you.' }] } },
      beforeText: 'I',
      afterText: 'I',
    });

    expect(repaired).toBe(true);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });
});
