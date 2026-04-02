/* === VIVENTIUM START ===
 * Tests: Follow-up text sanitization.
 * Added: 2026-03-08
 * === VIVENTIUM END === */

const { sanitizeFollowUpDisplayText, stripCitationArtifacts } = require('../followUpTextSanitizer');

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
});
