import { glassHiveAccountUrl } from './accountUrl';

describe('glassHiveAccountUrl', () => {
  const baseUrl = 'http://127.0.0.1:8766/v1';

  it('resolves an account path under the configured provider base', () => {
    expect(glassHiveAccountUrl(baseUrl, '/v1/active-work?limit=50')).toBe(
      'http://127.0.0.1:8766/v1/active-work?limit=50',
    );
  });

  it.each([
    '/v1///attacker.invalid/collect',
    '/v1/http://attacker.invalid/collect',
    '/v1/https://attacker.invalid/collect',
    '/v1/\\\\attacker.invalid/collect',
  ])('rejects a path that could escape the configured origin: %s', (path) => {
    expect(() => glassHiveAccountUrl(baseUrl, path)).toThrow('glasshive_account_path_invalid');
  });

  it('rejects non-account paths and non-HTTP provider URLs', () => {
    expect(() => glassHiveAccountUrl(baseUrl, '/health')).toThrow('glasshive_account_path_invalid');
    expect(() => glassHiveAccountUrl('file:///tmp/provider/v1', '/v1/active-work')).toThrow(
      'glasshive_account_base_url_invalid',
    );
  });
});
