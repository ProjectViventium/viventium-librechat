/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const { shouldSkipTelegramTools } = require('~/server/services/viventium/telegramToolGuard');

describe('telegramToolGuard', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.VIVENTIUM_TELEGRAM_TOOL_GUARD_ENABLED = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const buildReq = (text, extraBody = {}) => ({
    _viventiumTelegram: true,
    body: {
      text,
      ...extraBody,
    },
  });

  it('skips tools for short greeting', () => {
    const req = buildReq('hi');
    expect(shouldSkipTelegramTools(req)).toBe(true);
  });

  it('does not skip tools for non-telegram requests', () => {
    const req = { body: { text: 'hi' } };
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('does not skip tools when tool keyword is present', () => {
    const req = buildReq('email');
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('does not skip tools when files are attached', () => {
    const req = buildReq('hi', { files: [{ id: 'file-1' }] });
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('does not skip tools for non-tiny chatter without keywords', () => {
    const req = buildReq('going to gym with taylor');
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('does not skip tools when short message includes scheduling keyword', () => {
    const req = buildReq('tomorrow');
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('respects max word override', () => {
    process.env.VIVENTIUM_TELEGRAM_TOOL_GUARD_MAX_WORDS = '2';
    const req = buildReq('going to the gym');
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });

  it('does not skip actionable scheduling request (Outlook case)', () => {
    const req = buildReq('Check Outlook has Lisa been scheduled');
    expect(shouldSkipTelegramTools(req)).toBe(false);
  });
});
