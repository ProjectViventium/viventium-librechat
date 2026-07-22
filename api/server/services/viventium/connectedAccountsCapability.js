const { isEnabled } = require('@librechat/api');

/* === VIVENTIUM START ===
 * Feature: Connected-account capability projection.
 * Purpose: Keep the browser setup surface independent from secret-bearing provider state.
 */
function isConnectedAccountsCapabilityEnabled(environment = process.env) {
  if (environment.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED != null) {
    return isEnabled(environment.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED);
  }
  return (
    isEnabled(environment.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH) ||
    environment.OPENAI_API_KEY === 'user_provided' ||
    environment.ANTHROPIC_API_KEY === 'user_provided'
  );
}

module.exports = { isConnectedAccountsCapabilityEnabled };
/* === VIVENTIUM END === */
