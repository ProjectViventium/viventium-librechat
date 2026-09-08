import { getSessionCookieName } from './sessionCookies';

const original = process.env;
afterEach(() => {
  process.env = original;
});

test.each(['', '.', '..', '../other', ' name', 'name/child'])(
  'invalid active dev scope cannot use daily cookies: %s',
  (name) => {
    process.env = { ...original, VIVENTIUM_DEV_ENV_ENABLED: 'true', VIVENTIUM_DEV_ENV_NAME: name };
    expect(() => getSessionCookieName('refreshToken')).toThrow('environment name');
  },
);

test('preserves distinct configured names without lossy normalization', () => {
  const names = ['qa-one', 'qa_one', 'QA-One', 'équipe', 'equipe'];
  const keys = names.map((name) => {
    process.env = { ...original, VIVENTIUM_DEV_ENV_ENABLED: 'true', VIVENTIUM_DEV_ENV_NAME: name };
    return getSessionCookieName('oauth_session');
  });
  expect(new Set(keys).size).toBe(names.length);
  expect(keys).not.toContain('oauth_session');
});
