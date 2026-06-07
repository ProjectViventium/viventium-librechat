const {
  countDuplicateArtifacts,
  normalizeHistoricalVoiceText,
  normalizeHistoricalVoiceMessageForRead,
} = require('../historicalVoiceTextRepair');

describe('historical voice text repair', () => {
  it('hides malformed no-response markers from historical persisted voice rows', () => {
    expect(normalizeHistoricalVoiceText('{N{NTATA}}')).toBe('');
    expect(normalizeHistoricalVoiceText('{NTA}')).toBe('');
  });

  it('normalizes obvious cumulative snapshot word duplication', () => {
    expect(
      normalizeHistoricalVoiceText(
        "I'mI'm here here.. Tell Tell me me what's what's going going on on..",
      ),
    ).toBe("I'm here. Tell me what's going on.");
    expect(
      normalizeHistoricalVoiceText(
        'ThatThat hits hits hard hard.. Leaving Leaving a a place place you you love love.',
      ),
    ).toBe('That hits hard. Leaving a place you love.');
  });

  it('does not rewrite ordinary emphasis with a single repeated word', () => {
    expect(normalizeHistoricalVoiceText('I really really mean it.')).toBe(
      'I really really mean it.',
    );
  });

  it('preserves repeated words inside quoted text', () => {
    const text =
      'The line was "no no no no no no", and the repetition is the point. Then continue.';

    expect(countDuplicateArtifacts(text)).toBe(0);
    expect(normalizeHistoricalVoiceText(text)).toBe(text);
  });

  it('preserves repeated words inside curly quotes and markdown blockquotes', () => {
    const curly = 'She wrote, “go go go go go go,” and meant the rhythm.';
    const blockquote = [
      'The note was:',
      '> wait wait wait wait wait wait',
      'Then the assistant summarized it.',
    ].join('\n');

    expect(normalizeHistoricalVoiceText(curly)).toBe(curly);
    expect(normalizeHistoricalVoiceText(blockquote)).toBe(blockquote);
  });

  it('preserves repeated tokens inside inline and fenced code', () => {
    const inline = 'The code sample was `echo echo echo echo`, not a speech artifact.';
    const fenced = ['Here is the fixture:', '```', 'ping ping ping ping', '```'].join('\n');

    expect(normalizeHistoricalVoiceText(inline)).toBe(inline);
    expect(normalizeHistoricalVoiceText(fenced)).toBe(fenced);
  });

  it('repairs unquoted corruption while preserving quoted repetition', () => {
    expect(
      normalizeHistoricalVoiceText(
        'Tell Tell me me what what happened happened. She said "no no no no no no."',
      ),
    ).toBe('Tell me what happened. She said "no no no no no no."');
  });

  it('repairs assistant message text and text content parts without touching cortex cards', () => {
    const original = {
      isCreatedByUser: false,
      text: 'Tell Tell me me what what happened happened.',
      content: [
        { type: 'cortex_insight', insight: 'keep me' },
        { type: 'text', text: 'Tell Tell me me what what happened happened.' },
      ],
    };

    expect(normalizeHistoricalVoiceMessageForRead(original)).toEqual({
      isCreatedByUser: false,
      text: 'Tell me what happened.',
      content: [
        { type: 'cortex_insight', insight: 'keep me' },
        { type: 'text', text: 'Tell me what happened.' },
      ],
    });
  });
});
