/* === VIVENTIUM START ===
 * Feature: Trusted rapid-input mission partitioning.
 * Purpose: Keep the legacy /api import surface thin while packages/api owns validation and
 * projection logic.
 * === VIVENTIUM END === */

const {
  canonicalSourceOrdinals,
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
} = require('@librechat/api');

module.exports = {
  canonicalSourceOrdinals,
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
};
