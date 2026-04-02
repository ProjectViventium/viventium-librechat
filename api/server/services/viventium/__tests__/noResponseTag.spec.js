/* === VIVENTIUM START ===
 * Tests: No Response Tag ({NTA})
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const {
  NO_RESPONSE_TAG,
  isNoResponseTag,
  isNoResponseOnly,
  normalizeNoResponseText,
} = require('../noResponseTag');

describe('noResponseTag', () => {
  test('isNoResponseTag matches {NTA} variants', () => {
    expect(isNoResponseTag('{NTA}')).toBe(true);
    expect(isNoResponseTag('{ nta }')).toBe(true);
    expect(isNoResponseTag('  {NTA}\n')).toBe(true);
  });

  test('isNoResponseOnly matches legacy phrases (exact)', () => {
    expect(isNoResponseOnly('Nothing new to add.')).toBe(true);
    expect(isNoResponseOnly('nothing to add')).toBe(true);
    expect(isNoResponseOnly('Nothing new to add for now.')).toBe(true);
    expect(isNoResponseOnly('Nothing to add (yet).')).toBe(true);
    expect(isNoResponseOnly('Nothing to add, thanks!')).toBe(true);
    expect(isNoResponseOnly('Nothing new to add. What next?')).toBe(false);
    expect(isNoResponseOnly('Nothing to add: Actually, I found something.')).toBe(false);
  });

  test('normalizeNoResponseText coerces to {NTA}', () => {
    expect(normalizeNoResponseText('Nothing new to add.')).toBe(NO_RESPONSE_TAG);
    expect(normalizeNoResponseText('{NTA}')).toBe(NO_RESPONSE_TAG);
    expect(normalizeNoResponseText('hello')).toBe('hello');
  });
});
