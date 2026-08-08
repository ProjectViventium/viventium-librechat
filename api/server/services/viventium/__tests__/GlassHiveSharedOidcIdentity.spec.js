/* === VIVENTIUM START ===
 * Feature: Shared-OIDC GlassHive opaque-principal regressions.
 */
const {
  glassHivePrincipalIdFromClaims,
} = require('../GlassHiveSharedOidcIdentity');

describe('GlassHive shared OIDC identity', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_SHARED_OIDC_ISSUER: 'https://identity.example.test/tenant/v2.0/',
      VIVENTIUM_GLASSHIVE_SHARED_OIDC_PRINCIPAL_CLAIM: 'oid',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('derives the exact opaque GlassHive issuer-plus-subject principal', () => {
    expect(
      glassHivePrincipalIdFromClaims({
        iss: 'https://identity.example.test/tenant/v2.0',
        oid: 'stable-subject-a',
      }),
    ).toBe(
      'usr_af9431cb40eb3f7689177813cb841b28',
    );
  });

  test('never falls back to email or another claim', () => {
    expect(
      glassHivePrincipalIdFromClaims({
        iss: 'https://identity.example.test/tenant/v2.0',
        sub: 'different-subject',
        email: 'user@example.test',
      }),
    ).toBe('');
  });

  test('refuses an otherwise valid principal claim from the wrong issuer', () => {
    expect(
      glassHivePrincipalIdFromClaims({
        iss: 'https://different-identity.example.test/tenant/v2.0',
        oid: 'stable-subject-a',
      }),
    ).toBe('');
  });
});
/* === VIVENTIUM END === */
