'use strict';

/* === VIVENTIUM START === Typed source-component graph-start compatibility adapter. */
const {
  installLibreChatAgentsGraphStartPatch: installTypedGraphStartPatch,
  sourceComponentStartAgentIds,
  installLibreChatAgentsHandoffResultPatch,
} = require('@librechat/api');

function installLibreChatAgentsGraphStartPatch(agentsModule = require('@librechat/agents')) {
  installLibreChatAgentsHandoffResultPatch(agentsModule);
  return installTypedGraphStartPatch(agentsModule);
}

module.exports = {
  installLibreChatAgentsGraphStartPatch,
  sourceComponentStartAgentIds,
};
/* === VIVENTIUM END === */
