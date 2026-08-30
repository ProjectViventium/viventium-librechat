/* === VIVENTIUM START === Thin adapter for typed local-QA Cortex fault controls. === VIVENTIUM END === */

const {
  FIXTURE_CASE_ID,
  FIXTURE_PROVIDER,
  FIXTURE_TAG,
  COMPONENT_ARTIFACT_DIGEST_ENV,
  createMongoSyntheticScopeVerifier,
  createLocalQaCortexFaultService,
} = require('@librechat/api');

let defaultService;

function getDefaultService() {
  if (!defaultService) {
    defaultService = createLocalQaCortexFaultService({
      modelProvider: () => require('~/db/models').LocalQaCortexFaultControl,
      fixtureModelProvider: () => {
        const { User, Conversation, Message } = require('~/db/models');
        return { User, Conversation, Message };
      },
    });
  }
  return defaultService;
}

module.exports = {
  FIXTURE_CASE_ID,
  FIXTURE_PROVIDER,
  FIXTURE_TAG,
  COMPONENT_ARTIFACT_DIGEST_ENV,
  createMongoSyntheticScopeVerifier,
  createLocalQaCortexFaultService,
  armLocalQaCortexFault: (input) => getDefaultService().arm(input),
  queryLocalQaCortexFaults: (input) => getDefaultService().query(input),
  clearLocalQaCortexFaults: (input) => getDefaultService().clear(input),
  consumeLocalQaCortexFault: (input) => getDefaultService().consume(input),
};
