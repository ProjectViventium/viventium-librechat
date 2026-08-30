/* === VIVENTIUM START === Thin adapter for typed owner-scoped Active work tools. === VIVENTIUM END === */

const { createActiveWorkTools: createTypedActiveWorkTools } = require('@librechat/api');
const { getActiveWorkPage } = require('~/server/services/viventium/GlassHiveAccountService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');

function createActiveWorkTools(options) {
  return createTypedActiveWorkTools(options, {
    getActiveWorkPage,
    executeGlassHiveWorkAction,
  });
}

module.exports = { createActiveWorkTools };
