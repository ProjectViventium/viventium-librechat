'use strict';

/* === VIVENTIUM START === Typed source-component graph-start compatibility adapter. */
const {
  installLibreChatAgentsGraphStartPatch: installTypedGraphStartPatch,
  sourceComponentStartAgentIds,
} = require('@librechat/api');

function installLibreChatAgentsGraphStartPatch(agentsModule = require('@librechat/agents')) {
  return installTypedGraphStartPatch(agentsModule);
}

module.exports = {
  installLibreChatAgentsGraphStartPatch,
  sourceComponentStartAgentIds,
};
/* === VIVENTIUM END === */
