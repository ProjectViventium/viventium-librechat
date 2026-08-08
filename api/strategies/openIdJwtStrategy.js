const cookies = require('cookie');
const jwksRsa = require('jwks-rsa');
const { logger } = require('@librechat/data-schemas');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { get } = require('lodash');
const { SystemRoles } = require('librechat-data-provider');
const { isEnabled, findOpenIDUser, isEmailDomainAllowed, math } = require('@librechat/api');
const { Strategy: JwtStrategy, ExtractJwt } = require('passport-jwt');
const { getOpenIdEmail } = require('./openidStrategy');
const { updateUser, findUser } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
/* === VIVENTIUM START ===
 * Feature: Shared-OIDC GlassHive principal backfill on authenticated JWT login.
 */
const {
  glassHivePrincipalIdFromClaims,
} = require('~/server/services/viventium/GlassHiveSharedOidcIdentity');
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Fail-closed admission parity for reused OpenID bearer tokens.
 * Purpose: bearer reuse must preserve the issuer/audience/algorithm, domain, and role gates used by
 * the interactive OpenID login instead of becoming a weaker authentication path.
 */
function reusedTokenHasRequiredRole(payload) {
  const configured = String(process.env.OPENID_REQUIRED_ROLE || '').trim();
  if (!configured) {
    return true;
  }
  const path = String(process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH || '').trim();
  if (!path) {
    return false;
  }
  const required = configured
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  const actual = get(payload, path);
  if (typeof actual === 'string') {
    return required.some((role) => actual === role || actual.split(/[ ,]+/).includes(role));
  }
  if (Array.isArray(actual)) {
    return required.some((role) => actual.includes(role));
  }
  return false;
}
/* === VIVENTIUM END === */

/**
 * @function openIdJwtLogin
 * @param {import('openid-client').Configuration} openIdConfig - Configuration object for the JWT strategy.
 * @returns {JwtStrategy}
 * @description This function creates a JWT strategy for OpenID authentication.
 * It uses the jwks-rsa library to retrieve the signing key from a JWKS endpoint.
 * The strategy extracts the JWT from the Authorization header as a Bearer token.
 * The JWT is then verified using the signing key, and the user is retrieved from the database.
 *
 * Includes email fallback mechanism:
 * 1. Primary lookup: Search user by openidId (sub claim)
 * 2. Fallback lookup: If not found, search by email claim
 * 3. User migration: If found by email without openidId, migrate the user by adding openidId
 * 4. Provider validation: Ensures users registered with other providers cannot use OpenID
 *
 * This enables seamless migration for existing users when SharePoint integration is enabled.
 */
const openIdJwtLogin = (openIdConfig) => {
  /* === VIVENTIUM START === Reused-token verifier boundary. === */
  const metadata = openIdConfig.serverMetadata();
  const expectedIssuer = String(metadata.issuer || process.env.OPENID_ISSUER || '').replace(
    /\/$/,
    '',
  );
  const expectedAudience = String(
    process.env.OPENID_AUDIENCE || process.env.OPENID_CLIENT_ID || '',
  ).trim();
  if (!expectedIssuer || !expectedAudience) {
    throw new Error('OpenID token reuse requires an exact issuer and audience');
  }
  /* === VIVENTIUM END === */
  let jwksRsaOptions = {
    cache: isEnabled(process.env.OPENID_JWKS_URL_CACHE_ENABLED) || true,
    cacheMaxAge: math(process.env.OPENID_JWKS_URL_CACHE_TIME, 60000),
    jwksUri: openIdConfig.serverMetadata().jwks_uri,
  };

  if (process.env.PROXY) {
    jwksRsaOptions.requestAgent = new HttpsProxyAgent(process.env.PROXY);
  }

  return new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKeyProvider: jwksRsa.passportJwtSecret(jwksRsaOptions),
      passReqToCallback: true,
      /* === VIVENTIUM START === Pin the token class before the verify callback runs. === */
      issuer: expectedIssuer,
      audience: expectedAudience,
      algorithms: ['RS256'],
      /* === VIVENTIUM END === */
    },
    /**
     * @param {import('@librechat/api').ServerRequest} req
     * @param {import('openid-client').IDToken} payload
     * @param {import('passport-jwt').VerifyCallback} done
     */
    async (req, payload, done) => {
      try {
        /* === VIVENTIUM START === Reapply interactive OpenID admission gates. === */
        const appConfig = await getAppConfig();
        const email = payload ? getOpenIdEmail(payload) : undefined;
        if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
          logger.warn('[openIdJwtLogin] Reused token email domain is not allowed');
          done(null, false, { message: 'OpenID account is not authorized' });
          return;
        }
        if (!reusedTokenHasRequiredRole(payload || {})) {
          logger.warn('[openIdJwtLogin] Reused token is missing an approved role');
          done(null, false, { message: 'OpenID account is not authorized' });
          return;
        }
        /* === VIVENTIUM END === */
        const authHeader = req.headers.authorization;
        const rawToken = authHeader?.replace('Bearer ', '');

        const { user, error, migration } = await findOpenIDUser({
          findUser,
          email,
          openidId: payload?.sub,
          idOnTheSource: payload?.oid,
          strategyName: 'openIdJwtLogin',
        });

        if (error) {
          done(null, false, { message: error });
          return;
        }

        if (user) {
          user.id = user._id.toString();

          const updateData = {};
          /* === VIVENTIUM START === Shared-OIDC GlassHive identity. === */
          const viventiumGlassHivePrincipalId = glassHivePrincipalIdFromClaims(payload);
          if (migration) {
            updateData.provider = 'openid';
            updateData.openidId = payload?.sub;
          }
          if (!user.role) {
            user.role = SystemRoles.USER;
            updateData.role = user.role;
          }
          if (
            viventiumGlassHivePrincipalId &&
            user.viventiumGlassHivePrincipalId !== viventiumGlassHivePrincipalId
          ) {
            user.viventiumGlassHivePrincipalId = viventiumGlassHivePrincipalId;
            updateData.viventiumGlassHivePrincipalId = viventiumGlassHivePrincipalId;
          }
          /* === VIVENTIUM END === */

          if (Object.keys(updateData).length > 0) {
            await updateUser(user.id, updateData);
          }

          /** Read tokens from session (server-side) to avoid large cookie issues */
          const sessionTokens = req.session?.openidTokens;
          let accessToken = sessionTokens?.accessToken;
          let idToken = sessionTokens?.idToken;
          let refreshToken = sessionTokens?.refreshToken;

          /** Fallback to cookies for backward compatibility */
          if (!accessToken || !refreshToken || !idToken) {
            const cookieHeader = req.headers.cookie;
            const parsedCookies = cookieHeader ? cookies.parse(cookieHeader) : {};
            accessToken = accessToken || parsedCookies.openid_access_token;
            idToken = idToken || parsedCookies.openid_id_token;
            refreshToken = refreshToken || parsedCookies.refreshToken;
          }

          user.federatedTokens = {
            access_token: accessToken || rawToken,
            id_token: idToken,
            refresh_token: refreshToken,
            expires_at: payload.exp,
          };

          done(null, user);
        } else {
          logger.warn(
            '[openIdJwtLogin] openId JwtStrategy => no user found with the sub claims: ' +
              payload?.sub +
              (payload?.email ? ' or email: ' + payload.email : ''),
          );
          done(null, false);
        }
      } catch (err) {
        done(err, false);
      }
    },
  );
};

module.exports = openIdJwtLogin;
