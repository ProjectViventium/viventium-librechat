/* === VIVENTIUM START ===
 * Feature: Trusted GlassHive account API and active-work snapshot client.
 * Purpose: Keep /api as thin database/projection wiring while packages/api owns behavior.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const {
  buildTrustedActionIdempotencyKey,
  buildTrustedDelegationIdentity,
  createGlassHiveActiveWorkService,
  createServiceAssertion,
  hasKnownExternalWork: queryKnownExternalWork,
  requestAccountApi,
  signTrustedDelegationIdentity,
} = require('@librechat/api');

const externalWorkCollection = mongoose.connection.collection('viventium_external_work');
const activeWorkService = createGlassHiveActiveWorkService({
  getUserParallelWorkKnownEpoch: (...args) =>
    require('~/models').getUserParallelWorkKnownEpoch(...args),
  markUserParallelWorkKnown: (...args) => require('~/models').markUserParallelWorkKnown(...args),
  clearUserParallelWorkKnownIfEpoch: (...args) =>
    require('~/models').clearUserParallelWorkKnownIfEpoch(...args),
  enrichActiveWorkSnapshot: (...args) =>
    require('./GlassHiveActiveWorkProjectionService').enrichActiveWorkSnapshot(...args),
  hasKnownExternalWork: ({ ownerId }) =>
    queryKnownExternalWork({ ownerId, collection: externalWorkCollection }),
});

module.exports = {
  buildTrustedActionIdempotencyKey,
  buildTrustedDelegationIdentity,
  createServiceAssertion,
  requestAccountApi,
  signTrustedDelegationIdentity,
  ...activeWorkService,
};
