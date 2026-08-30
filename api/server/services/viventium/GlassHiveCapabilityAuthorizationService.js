/* === VIVENTIUM START === Thin adapter for typed GlassHive capability authorization. === VIVENTIUM END === */

const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const {
  configureCapabilityAuthorizationService,
  assertActiveCapabilityAuthorizationGrant,
  CapabilityAuthorizationError,
  admitCapabilityAuthorization,
  createAdmissionSignature,
  createCapabilityAuthorization,
  prepareScheduledProviderAuthorization,
  reauthorizeCapabilityAuthorization,
  revokeCapabilityAuthorizationGrant,
  resetCapabilityAuthorizationIndexesForTests,
  stableJson,
  verifyAndConsumeAdmission,
} = require('@librechat/api');
const { getMCPServersRegistry } = require('~/config');
const { getUserById } = require('~/models');
const { mintBrokerGrant, persistBrokerGrantResources } = require('./GlassHiveCapabilityBrokerAuth');
const {
  collectServerProjection,
  isBrokerProjectionEnabled,
  shouldGrantContentReadScope,
} = require('./GlassHiveCapabilityPolicyService');

configureCapabilityAuthorizationService({
  collection: (name) => mongoose.connection.collection(name),
  logger,
  getUserById,
  getAllServerConfigs: (ownerId) => getMCPServersRegistry().getAllServerConfigs(ownerId),
  mintBrokerGrant,
  persistBrokerGrantResources,
  collectServerProjection,
  isBrokerProjectionEnabled,
  shouldGrantContentReadScope,
});

module.exports = {
  assertActiveCapabilityAuthorizationGrant,
  CapabilityAuthorizationError,
  admitCapabilityAuthorization,
  createAdmissionSignature,
  createCapabilityAuthorization,
  prepareScheduledProviderAuthorization,
  reauthorizeCapabilityAuthorization,
  revokeCapabilityAuthorizationGrant,
  resetCapabilityAuthorizationIndexesForTests,
  stableJson,
  verifyAndConsumeAdmission,
};
