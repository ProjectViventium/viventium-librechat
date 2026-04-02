/* === VIVENTIUM START ===
 * Tests: Optional tool auth fields should stay silent when omitted.
 * Purpose:
 * - Prevent local-only optional auth slots (for example `SEARXNG_API_KEY`) from
 *   being logged as hard plugin-auth failures during tool loading.
 * Added: 2026-03-08
 * === VIVENTIUM END === */

const mockGetUserPluginAuthValue = jest.fn();

jest.mock('~/server/services/PluginService', () => ({
  getUserPluginAuthValue: (...args) => mockGetUserPluginAuthValue(...args),
}));

const { loadAuthValues } = require('./credentials');

describe('loadAuthValues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SEARXNG_API_KEY;
    delete process.env.REQUIRED_TOOL_KEY;
  });

  test('does not throw or log for missing optional auth fields', async () => {
    mockGetUserPluginAuthValue.mockResolvedValueOnce(null);

    const result = await loadAuthValues({
      userId: 'user-1',
      authFields: ['SEARXNG_API_KEY'],
      optional: new Set(['SEARXNG_API_KEY']),
    });

    expect(result).toEqual({});
    expect(mockGetUserPluginAuthValue).toHaveBeenCalledWith('user-1', 'SEARXNG_API_KEY', false);
  });

  test('still throws for missing required auth fields', async () => {
    const error = new Error('missing required auth');
    mockGetUserPluginAuthValue.mockRejectedValueOnce(error);

    await expect(
      loadAuthValues({
        userId: 'user-1',
        authFields: ['REQUIRED_TOOL_KEY'],
      }),
    ).rejects.toThrow('missing required auth');

    expect(mockGetUserPluginAuthValue).toHaveBeenCalledWith('user-1', 'REQUIRED_TOOL_KEY', true);
  });
});
