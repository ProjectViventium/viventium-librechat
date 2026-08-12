const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  memoryContinuityUserHash,
  recordMemoryContinuityHealth,
} = require('../memoryContinuityHealthLedger');

describe('memoryContinuityHealthLedger', () => {
  let appSupport;

  beforeEach(() => {
    appSupport = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-memory-health-'));
    process.env.VIVENTIUM_APP_SUPPORT_DIR = appSupport;
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_APP_SUPPORT_DIR;
    fs.rmSync(appSupport, { recursive: true, force: true });
  });

  test('writes one private, atomic, identifier-free receipt per user and path', async () => {
    const userId = 'synthetic-user-id';
    await recordMemoryContinuityHealth({
      userId,
      path: 'writer',
      status: 'degraded',
      reason: 'provider_auth',
      provider: 'openAI',
      model: 'gpt-test',
      effort: 'medium',
    });

    const userHash = memoryContinuityUserHash(userId);
    const receiptPath = path.join(
      appSupport,
      'state',
      'memory-continuity-health',
      `${userHash}.writer.json`,
    );
    const text = fs.readFileSync(receiptPath, 'utf8');
    const receipt = JSON.parse(text);

    expect(receipt).toEqual(
      expect.objectContaining({
        schemaVersion: 2,
        userHash,
        path: 'writer',
        status: 'degraded',
        reason: 'provider_auth',
        provider: 'openAI',
        model: 'gpt-test',
        effort: 'medium',
      }),
    );
    expect(text).not.toContain(userId);
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
  });
});
