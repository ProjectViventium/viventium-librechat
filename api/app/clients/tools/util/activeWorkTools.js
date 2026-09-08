/* === VIVENTIUM START === Thin adapter for typed owner-scoped Active work tools. === VIVENTIUM END === */

const { createActiveWorkTools: createTypedActiveWorkTools } = require('@librechat/api');
const {
  getActiveWorkPage,
  getActiveWorkHistoryPage,
} = require('~/server/services/viventium/GlassHiveAccountService');
const {
  getGlassHiveWorkResult,
} = require('~/server/services/viventium/GlassHiveWorkResultService');
const {
  executeGlassHiveWorkAction,
} = require('~/server/services/viventium/GlassHiveWorkActionService');

function createActiveWorkTools(options) {
  return createTypedActiveWorkTools(options, {
    getActiveWorkPage,
    getActiveWorkHistoryPage,
    getGlassHiveWorkResult,
    executeGlassHiveWorkAction,
  });
}

module.exports = { createActiveWorkTools };
