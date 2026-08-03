/* === VIVENTIUM START ===
 * Feature: OAuth presence cache invalidation regression coverage.
 * Purpose: A supported account disconnect must not leave a positive warm-up cache entry alive.
 * === VIVENTIUM END === */

const {
  getOAuthTokenPresence,
  invalidateOAuthTokenPresence,
  resetOAuthTokenPresenceForTests,
  setOAuthTokenPresence,
} = require('../mcpOAuthPresenceCache');

describe('MCP OAuth credential-presence cache', () => {
  beforeEach(() => resetOAuthTokenPresenceForTests());

  test('invalidates only the disconnected user and server entry immediately', () => {
    const cached = { checkedAt: Date.now(), usable: true };
    setOAuthTokenPresence('user-a', 'ms-365', cached);
    setOAuthTokenPresence('user-a', 'google_workspace', cached);
    setOAuthTokenPresence('user-b', 'ms-365', cached);

    invalidateOAuthTokenPresence('user-a', 'ms-365');

    expect(getOAuthTokenPresence('user-a', 'ms-365')).toBeUndefined();
    expect(getOAuthTokenPresence('user-a', 'google_workspace')).toEqual(cached);
    expect(getOAuthTokenPresence('user-b', 'ms-365')).toEqual(cached);
  });
});
