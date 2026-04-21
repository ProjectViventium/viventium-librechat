/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Purpose: Viventium background follow-up window tests.
 * Details: docs/requirements_and_learnings/02_Background_Agents.md
 * === VIVENTIUM NOTE === */

const { getCortexFollowupGraceMs } = require('~/server/services/viventium/cortexFollowupGrace');

describe('cortexFollowupGrace', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('defaults to a 30-second background follow-up window when env is unset', () => {
    delete process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S;
    expect(getCortexFollowupGraceMs()).toBe(30000);
  });

  test('returns 0 when env is zero or negative', () => {
    process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S = '0';
    expect(getCortexFollowupGraceMs()).toBe(0);
    process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S = '-2';
    expect(getCortexFollowupGraceMs()).toBe(0);
  });

  test('converts seconds to milliseconds', () => {
    process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S = '1.5';
    expect(getCortexFollowupGraceMs()).toBe(1500);
  });
});
