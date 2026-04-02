const { EventSource } = require('eventsource');
const { Time } = require('librechat-data-provider');
const {
  MCPManager,
  FlowStateManager,
  MCPServersRegistry,
  OAuthReconnectionManager,
} = require('@librechat/api');
const logger = require('./winston');

global.EventSource = EventSource;

/** @type {MCPManager} */
let flowManager = null;

/**
 * @param {Keyv} flowsCache
 * @returns {FlowStateManager}
 */
function getFlowStateManager(flowsCache) {
  if (!flowManager) {
    const DEFAULT_FLOW_TTL_MINUTES = 10;
    const flowTtlEnv = Number.parseInt(process.env.FLOW_STATE_TTL_MINUTES ?? '', 10);
    const flowTtlMinutes =
      Number.isFinite(flowTtlEnv) && flowTtlEnv > 0 ? flowTtlEnv : DEFAULT_FLOW_TTL_MINUTES;

    flowManager = new FlowStateManager(flowsCache, {
      // OAuth flows (notably Google) can take several minutes to complete.
      ttl: Time.ONE_MINUTE * flowTtlMinutes,
    });
  }
  return flowManager;
}

module.exports = {
  logger,
  createMCPServersRegistry: MCPServersRegistry.createInstance,
  getMCPServersRegistry: MCPServersRegistry.getInstance,
  createMCPManager: MCPManager.createInstance,
  getMCPManager: MCPManager.getInstance,
  getFlowStateManager,
  createOAuthReconnectionManager: OAuthReconnectionManager.createInstance,
  getOAuthReconnectionManager: OAuthReconnectionManager.getInstance,
};
