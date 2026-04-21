describe('cortexFollowupGrace', () => {
  const ENV_NAME = 'VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S';

  afterEach(() => {
    delete process.env[ENV_NAME];
    jest.resetModules();
  });

  /* === VIVENTIUM START ===
   * Feature: Background follow-up window
   *
   * Purpose:
   * - Keep the shipped default aligned across chat, voice, and Telegram.
   * - Lock the public-facing umbrella phrase so docs, config, and tests stay in sync.
   * === VIVENTIUM END === */
  test('defaults to a 30-second background follow-up window', () => {
    const { getCortexFollowupGraceMs } = require('../cortexFollowupGrace');

    expect(getCortexFollowupGraceMs()).toBe(30000);
  });

  test('treats non-positive values as disabled', () => {
    process.env[ENV_NAME] = '0';
    let { getCortexFollowupGraceMs } = require('../cortexFollowupGrace');
    expect(getCortexFollowupGraceMs()).toBe(0);

    jest.resetModules();
    process.env[ENV_NAME] = '-3';
    ({ getCortexFollowupGraceMs } = require('../cortexFollowupGrace'));
    expect(getCortexFollowupGraceMs()).toBe(0);
  });

  test('parses positive floating-point overrides', () => {
    process.env[ENV_NAME] = '2.5';
    const { getCortexFollowupGraceMs } = require('../cortexFollowupGrace');

    expect(getCortexFollowupGraceMs()).toBe(2500);
  });
});
