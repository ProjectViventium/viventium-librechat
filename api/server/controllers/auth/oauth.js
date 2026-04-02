const { CacheKeys } = require('librechat-data-provider');
const { logger, DEFAULT_SESSION_EXPIRY } = require('@librechat/data-schemas');
const {
  isEnabled,
  getAdminPanelUrl,
  isAdminPanelRedirect,
  generateAdminExchangeCode,
} = require('@librechat/api');
const { syncUserEntraGroupMemberships } = require('~/server/services/PermissionService');
const { setAuthTokens, setOpenIDAuthTokens } = require('~/server/services/AuthService');
/* === VIVENTIUM START ===
 * Feature: Registration approval gate for OAuth callbacks.
 * === VIVENTIUM END === */
const {
  isRegistrationApprovalEnabled,
  isViventiumApproved,
  PENDING_APPROVAL_MESSAGE,
} = require('~/server/services/viventium/registrationApprovalService');
const getLogStores = require('~/cache/getLogStores');
const { checkBan } = require('~/server/middleware');
const { generateToken } = require('~/models');

const domains = {
  client: process.env.DOMAIN_CLIENT,
  server: process.env.DOMAIN_SERVER,
};

function createOAuthHandler(redirectUri = domains.client) {
  /**
   * A handler to process OAuth authentication results.
   * @type {Function}
   * @param {ServerRequest} req - Express request object.
   * @param {ServerResponse} res - Express response object.
   * @param {NextFunction} next - Express next middleware function.
   */
  return async (req, res, next) => {
    try {
      if (res.headersSent) {
        return;
      }

      await checkBan(req, res);
      if (req.banned) {
        return;
      }

      /* === VIVENTIUM START ===
       * Feature: OAuth registration approval gate.
       * Purpose: Prevent pending/denied users from receiving OAuth session tokens.
       * === VIVENTIUM END === */
      if (isRegistrationApprovalEnabled() && !isViventiumApproved(req.user)) {
        const loginUrl = new URL(domains.client || redirectUri);
        loginUrl.pathname = '/login';
        loginUrl.searchParams.set('redirect', 'false');
        loginUrl.searchParams.set('error', 'viventium_pending_approval');
        loginUrl.searchParams.set('error_description', PENDING_APPROVAL_MESSAGE);
        return res.redirect(loginUrl.toString());
      }

      /** Check if this is an admin panel redirect (cross-origin) */
      if (isAdminPanelRedirect(redirectUri, getAdminPanelUrl(), domains.client)) {
        /** For admin panel, generate exchange code instead of setting cookies */
        const cache = getLogStores(CacheKeys.ADMIN_OAUTH_EXCHANGE);
        const sessionExpiry = Number(process.env.SESSION_EXPIRY) || DEFAULT_SESSION_EXPIRY;
        const token = await generateToken(req.user, sessionExpiry);

        /** Get refresh token from tokenset for OpenID users */
        const refreshToken =
          req.user.tokenset?.refresh_token || req.user.federatedTokens?.refresh_token;

        const exchangeCode = await generateAdminExchangeCode(cache, req.user, token, refreshToken);

        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set('code', exchangeCode);
        logger.info(`[OAuth] Admin panel redirect with exchange code for user: ${req.user.email}`);
        return res.redirect(callbackUrl.toString());
      }

      /** Standard OAuth flow - set cookies and redirect */
      if (
        req.user &&
        req.user.provider == 'openid' &&
        isEnabled(process.env.OPENID_REUSE_TOKENS) === true
      ) {
        await syncUserEntraGroupMemberships(req.user, req.user.tokenset.access_token);
        await setOpenIDAuthTokens(req.user.tokenset, req, res, req.user._id.toString());
      } else {
        await setAuthTokens(req.user._id, res);
      }
      res.redirect(redirectUri);
    } catch (err) {
      logger.error('Error in setting authentication tokens:', err);
      next(err);
    }
  };
}

module.exports = {
  createOAuthHandler,
};
