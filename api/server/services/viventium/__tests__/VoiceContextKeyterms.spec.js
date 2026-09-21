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
        filename: 'Quarterly Roadmap 2026.pdf',
        filepath: '/private/owner/secret/Quarterly Roadmap 2026.pdf',
        text: 'do not send document contents to STT',
        metadata: { meetingTranscriptDisplayTitle: 'Q4 Planning Review' },
      },
      {
        filename: 'EIN-Migration Plan.xlsx',
        metadata: { meetingTranscriptDisplayTitle: 'Finance Migration' },
      },
      {
        filename: 'quarterly roadmap 2026.pdf',
      },
    ]);

    expect(keyterms).toEqual([
      'Quarterly Roadmap 2026.pdf',
      'Q4 Planning Review',
      'EIN-Migration Plan.xlsx',
      'Finance Migration',
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
        filename: 'winter-boat-checklist.txt',
        filepath: '/private/body/path',
        sha256: 'not-forwarded',
      },
      { filename: 'Finance_Migration_Plan.xlsx', body: 'not-forwarded' },
      { filename: 'winter-boat-checklist.txt' },
    ]);

    expect(keyterms).toEqual(['winter-boat-checklist.txt', 'Finance_Migration_Plan.xlsx']);
    expect(keyterms.join(' ')).not.toContain('private');
    expect(keyterms.join(' ')).not.toContain('not-forwarded');
  });
});
