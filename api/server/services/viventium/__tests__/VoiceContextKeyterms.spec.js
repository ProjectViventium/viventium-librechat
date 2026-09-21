const {
  MAX_VOICE_CONTEXT_KEYTERMS,
  MAX_VOICE_CONTEXT_KEYTERM_LENGTH,
  voiceContextKeytermsFromFiles,
  voiceContextKeytermsFromNativeFiles,
} = require('../VoiceContextKeyterms');

describe('voice context keyterms', () => {
  test('projects owner-visible display names and stable titles without file bodies or paths', () => {
    const keyterms = voiceContextKeytermsFromFiles([
      {
        filename: 'Example Planning Notes.pdf',
        filepath: '/private/owner/secret/Example Planning Notes.pdf',
        text: 'do not send document contents to STT',
        metadata: { meetingTranscriptDisplayTitle: 'Example Review' },
      },
      {
        filename: 'Example Reference Table.xlsx',
        metadata: { meetingTranscriptDisplayTitle: 'Example Meeting' },
      },
      {
        filename: 'example planning notes.pdf',
      },
    ]);

    expect(keyterms).toEqual([
      'Example Planning Notes.pdf',
      'Example Review',
      'Example Reference Table.xlsx',
      'Example Meeting',
    ]);
    expect(keyterms.join(' ')).not.toContain('secret');
    expect(keyterms.join(' ')).not.toContain('document contents');
  });

  test('deduplicates, bounds, and rejects path-shaped display values', () => {
    const longName = 'Meaningful-term-'.repeat(20);
    const keyterms = voiceContextKeytermsFromFiles([
      { filename: longName },
      { filename: 'Shared Term' },
      { filename: 'shared term' },
      { filename: 'folder/should-not-pass.txt' },
      { filename: 'folder\\should-not-pass.txt' },
      ...Array.from({ length: MAX_VOICE_CONTEXT_KEYTERMS + 4 }, (_, index) => ({
        filename: `unrelated-term-${index}.txt`,
      })),
    ]);

    expect(keyterms.length).toBeLessThanOrEqual(MAX_VOICE_CONTEXT_KEYTERMS);
    expect(keyterms.every((term) => term.length <= MAX_VOICE_CONTEXT_KEYTERM_LENGTH)).toBe(true);
    expect(keyterms.filter((term) => term.toLowerCase() === 'shared term')).toHaveLength(1);
    expect(keyterms.some((term) => term.includes('/'))).toBe(false);
    expect(keyterms.some((term) => term.includes('\\'))).toBe(false);
  });

  test('projects only native artifact filenames', () => {
    const keyterms = voiceContextKeytermsFromNativeFiles([
      {
        filename: 'example-checklist.txt',
        filepath: '/private/body/path',
        sha256: 'not-forwarded',
      },
      { filename: 'Example_Reference_Table.xlsx', body: 'not-forwarded' },
      { filename: 'example-checklist.txt' },
    ]);

    expect(keyterms).toEqual(['example-checklist.txt', 'Example_Reference_Table.xlsx']);
    expect(keyterms.join(' ')).not.toContain('private');
    expect(keyterms.join(' ')).not.toContain('not-forwarded');
  });
});
