/* === VIVENTIUM START ===
 * Regression coverage for the connected-account Anthropic OAuth fast path:
 * non-blocking near-expiry refresh + negative-cache that prevents a broken refresh_token from
 * fanning out into multiple blocking failing fetches across main + cortex agent inits.
 * Added: 2026-05-29
 * === VIVENTIUM END === */
jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { resolveAnthropicSubscriptionUserValues } from './oauthSubscription';

const SUB_TOKEN = ['sk', 'ant', 'oat01', 'current'].join('-');

const baseValues = (overrides: Record<string, unknown> = {}) => ({
  oauthProvider: 'anthropic',
  oauthType: 'subscription',
  authToken: SUB_TOKEN,
  apiKey: SUB_TOKEN,
  refreshToken: 'refresh-token-abc',
  oauthExpiresAt: Date.now() + 60 * 60 * 1000,
  ...overrides,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('resolveAnthropicSubscriptionUserValues — connected-account OAuth fast path', () => {
  let db: { updateUserKey: jest.Mock };

  beforeEach(() => {
    db = { updateUserKey: jest.fn().mockResolvedValue(undefined) };
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn();
    delete process.env.VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH;
  });

  it('uses the current token immediately for a near-expiry valid token, refreshing in the background', async () => {
    const vals = baseValues({ oauthExpiresAt: Date.now() + 60 * 1000 }); // within 5-min buffer, not expired
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'refreshed-token', expires_in: 3600 }),
    });

    const result = await resolveAnthropicSubscriptionUserValues('user-near-expiry', vals, db as never);

    // hot path returns the CURRENT token without waiting for the refresh
    expect((result as { authToken?: string }).authToken).toBe(SUB_TOKEN);
    // background refresh fires after the turn returns
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('negative-caches a failing refresh so repeated inits in a turn do not re-fetch (no fan-out)', async () => {
    const vals = baseValues({ oauthExpiresAt: Date.now() - 1000 }); // expired, has refresh token
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: 'invalid_grant' }),
    });

    const r1 = await resolveAnthropicSubscriptionUserValues('user-broken-refresh', vals, db as never);
    const r2 = await resolveAnthropicSubscriptionUserValues('user-broken-refresh', vals, db as never);
    const r3 = await resolveAnthropicSubscriptionUserValues('user-broken-refresh', vals, db as never);

    // only the FIRST init hits the network; the rest are short-circuited by the negative cache
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // stale token preserved so the downstream 401 is surfaced honestly, not swallowed
    expect((r1 as { authToken?: string }).authToken).toBe(SUB_TOKEN);
    expect(r2).toBeTruthy();
    expect(r3).toBeTruthy();
  });

  it('falls back to legacy blocking refresh when VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH=0', async () => {
    process.env.VIVENTIUM_ANTHROPIC_OAUTH_FAST_PATH = '0';
    const vals = baseValues({ oauthExpiresAt: Date.now() + 60 * 1000 }); // near-expiry
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: 'blocking-refreshed', expires_in: 3600 }),
    });

    const result = await resolveAnthropicSubscriptionUserValues('user-legacy', vals, db as never);

    // blocking path awaits the refresh and returns the NEW token
    expect((result as { authToken?: string }).authToken).toBe('blocking-refreshed');
  });

  it('passes through non-subscription user values untouched', async () => {
    const apiKeyValues = { apiKey: 'anthropic-api-key-test', oauthProvider: 'anthropic', oauthType: 'api_key' };
    const result = await resolveAnthropicSubscriptionUserValues('user-apikey', apiKeyValues as never, db as never);
    expect(result).toBe(apiKeyValues);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
