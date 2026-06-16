const { ContentTypes } = require('librechat-data-provider');
const {
  createMessageDeltaBoundaryNormalizer,
  extractVisibleTextFromContentParts,
  repairMissedVisibleMessageDelta,
  repairMissedVoiceMessageDelta,
} = require('../voiceDeltaAggregation');

describe('voiceDeltaAggregation', () => {
  test('normalizes cumulative snapshots at the message-delta event boundary', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });
    const emitted = [];

    for (const text of ['I', 'I hear', 'I hear you.']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['I', ' hear', ' you.']);
    expect(emitted.join('')).toBe('I hear you.');
  });

  test('normalizes mid-word cumulative snapshots in auto mode', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });
    const emitted = [];

    for (const text of ['Hel', 'Hello', 'Hello world']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['Hel', 'lo', ' world']);
    expect(emitted.join('')).toBe('Hello world');
  });

  test('normalizes cumulative no-response snapshots without malformed recombination', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });
    const emitted = [];

    for (const text of ['{N', '{NTA', '{NTA}']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['{N', 'TA', '}']);
    expect(emitted.join('')).toBe('{NTA}');
  });

  test('does not collapse legitimate repeated incremental text in auto mode', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });
    const emitted = [];

    for (const text of ['ha', 'haha', '!']) {
      const result = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
      });
      emitted.push(result.data.delta.content[0].text);
    }

    expect(emitted).toEqual(['ha', 'haha', '!']);
    expect(emitted.join('')).toBe('hahaha!');
  });

  test('leaves events unchanged when explicitly configured for incremental deltas', () => {
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'incremental' });
    const result = normalize({
      event: 'on_message_delta',
      data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: 'I hear' }] } },
    });

    expect(result.normalized).toBe(false);
    expect(result.data.delta.content[0].text).toBe('I hear');
  });

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

  test('repairs an emitted visible delta for non-voice surfaces when aggregation did not advance', () => {
    const contentParts = [];

    const repaired = repairMissedVisibleMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'Already visible answer.' }] } },
      beforeText: '',
      afterText: '',
    });

    expect(repaired).toBe(true);
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Already visible answer.' }]);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('Already visible answer.');
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

  test('repairs cumulative snapshot deltas after boundary normalization', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });

    for (const snapshot of ['I', 'I hear', 'I hear you.']) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe('I hear you.');
  });

  test('does not turn normalized no-response snapshots into malformed visible text', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });

    for (const snapshot of ['{N', '{NTA', '{NTA}']) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe('{NTA}');
  });

  test('preserves quoted repeated words in cumulative snapshots after boundary normalization', () => {
    const contentParts = [];
    const normalize = createMessageDeltaBoundaryNormalizer({ mode: 'auto' });
    const snapshots = [
      'She said "no',
      'She said "no no no',
      'She said "no no no no no no" and waited.',
    ];

    for (const snapshot of snapshots) {
      const event = normalize({
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: [{ type: ContentTypes.TEXT, text: snapshot }] } },
      });
      repairMissedVoiceMessageDelta({
        contentParts,
        event: event.event,
        data: event.data,
        beforeText: extractVisibleTextFromContentParts(contentParts),
        afterText: extractVisibleTextFromContentParts(contentParts),
      });
    }

    expect(extractVisibleTextFromContentParts(contentParts)).toBe(
      'She said "no no no no no no" and waited.',
    );
  });

  test('missed-delta repair appends already-normalized repeated incremental text exactly', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'ha' }];

    const repaired = repairMissedVoiceMessageDelta({
      contentParts,
      event: 'on_message_delta',
      data: { delta: { content: [{ type: ContentTypes.TEXT, text: 'haha' }] } },
      beforeText: 'ha',
      afterText: 'ha',
    });

    expect(repaired).toBe(true);
    expect(extractVisibleTextFromContentParts(contentParts)).toBe('hahaha');
  });
});
