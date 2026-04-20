const { logger } = require('@librechat/data-schemas');
const { isBrowserRegistrationOpen } = require('~/server/services/viventium/registrationGate');

async function validateRegistration(req, res, next) {
  if (req.invite) {
    return next();
  }

  const ldapEnabled = !!process.env.LDAP_URL && !!process.env.LDAP_USER_SEARCH_BASE;

  /* === VIVENTIUM START ===
   * Feature: Clean-install browser onboarding
   * Purpose: Fail closed if registration state cannot be resolved during startup,
   *          instead of throwing a 500 while Mongo/user state is still warming.
   */
  try {
    if (await isBrowserRegistrationOpen({ ldapEnabled })) {
      return next();
    }
  } catch (error) {
    logger.error('[validateRegistration] Failed to resolve browser registration state', error);
  }
  /* === VIVENTIUM END === */

  return res.status(403).json({
    message: 'Registration is not allowed.',
  });
}

module.exports = validateRegistration;
