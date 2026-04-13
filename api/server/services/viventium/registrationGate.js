const { isEnabled } = require('@librechat/api');
const { countUsers } = require('~/models');

async function isBrowserRegistrationOpen({ ldapEnabled = false } = {}) {
  if (ldapEnabled) {
    return false;
  }

  if (!isEnabled(process.env.ALLOW_REGISTRATION)) {
    return false;
  }

  if (!isEnabled(process.env.VIVENTIUM_BOOTSTRAP_REGISTRATION_ONCE)) {
    return true;
  }

  return (await countUsers()) === 0;
}

module.exports = {
  isBrowserRegistrationOpen,
};
