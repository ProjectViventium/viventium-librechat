/* === VIVENTIUM START ===
 * Purpose: Keep startup parity checks aligned with the owning Meili eligibility contract.
 * === VIVENTIUM END === */

const { meiliEligibleQuery } = require('../../../scripts/viventium-sync-local-search');

describe('viventium local search sync', () => {
  test('counts only documents eligible for the Meili plugin', () => {
    expect(meiliEligibleQuery).toEqual({
      expiredAt: null,
      'metadata.viventium.type': {
        $nin: ['listen_only_transcript', 'voice_ambient_transcript'],
      },
      'metadata.viventium.mode': { $ne: 'listen_only' },
      'metadata.viventium.qaRun': { $ne: true },
      'metadata.viventium.memoryEligible': { $ne: false },
    });
  });
});
