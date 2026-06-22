/* === VIVENTIUM START ===
 * Feature: GlassHive MCP capability projection policy
 * Purpose:
 * - Select only reviewed, source-of-truth MCP servers for autonomous GlassHive workers.
 * - Keep user-created DB MCP configs projection-off unless an explicit reviewed policy says otherwise.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');

const BROKER_HELPER_TOOLS = new Set([
  'capabilities_list',
  'capability_describe',
  'capability_invoke',
]);
const CONTENT_READ_GRANT_REQUIRED_POLICIES = new Set([
  'require_broker_grant',
  // Legacy name kept as a compatibility alias for older local configs.
  'require_explicit_intent',
]);

function isEnabledFlag(value, defaultValue = true) {
  if (value == null || value === '') {
    return defaultValue;
  }
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function isBrokerProjectionEnabled() {
  return isEnabledFlag(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED, true);
}

function getPolicy(serverConfig = {}) {
  const policy = serverConfig?.viventiumGlassHive;
  if (!policy || policy.version !== 1 || policy.permitsAutonomousWorker !== true) {
    return null;
  }
  return {
    version: 1,
    permitsAutonomousWorker: true,
    hostAllowed: policy.hostAllowed !== false,
    sandboxAllowed: policy.sandboxAllowed !== false,
    defaultToolAccess: policy.defaultToolAccess || 'none',
    contentReadPolicy: policy.contentReadPolicy || 'deny',
    writePolicy: policy.writePolicy || 'deny',
    riskClass: String(policy.riskClass || 'unspecified'),
    reexportNativeTools: policy.reexportNativeTools !== false,
    toolPolicies: policy.toolPolicies || {},
    allowUserConfigured: policy.allowUserConfigured === true,
  };
}

function isTrustedServerConfig(serverConfig = {}) {
  const policy = getPolicy(serverConfig);
  if (!policy) {
    return false;
  }
  if (policy.allowUserConfigured) {
    return true;
  }
  return serverConfig.source !== 'user' && !serverConfig.dbId;
}

function policyAllowsExecutionMode(policy, executionMode = '') {
  const mode = String(executionMode || '')
    .trim()
    .toLowerCase();
  if (mode === 'host') {
    return policy.hostAllowed !== false;
  }
  if (mode === 'docker' || mode === 'sandbox') {
    return policy.sandboxAllowed !== false;
  }
  return policy.hostAllowed !== false || policy.sandboxAllowed !== false;
}

function collectAllowedServerEntries({ mcpConfig = {}, executionMode = '' } = {}) {
  if (!isBrokerProjectionEnabled()) {
    return [];
  }
  return Object.entries(mcpConfig)
    .map(([serverName, serverConfig]) => {
      const policy = getPolicy(serverConfig);
      return { serverName, serverConfig, policy };
    })
    .filter(({ serverConfig, policy }) => {
      return (
        policy &&
        isTrustedServerConfig(serverConfig) &&
        policyAllowsExecutionMode(policy, executionMode)
      );
    })
    .sort((left, right) => left.serverName.localeCompare(right.serverName));
}

function collectAllowedServers({ mcpConfig = {}, executionMode = '' } = {}) {
  return collectAllowedServerEntries({ mcpConfig, executionMode }).map(
    ({ serverName }) => serverName,
  );
}

function policyCanReceiveContentReadGrant(policy = {}) {
  if (!policy || policy.contentReadPolicy === 'deny') {
    return false;
  }
  if (policy.defaultToolAccess === 'content_read') {
    return true;
  }
  return Object.values(policy.toolPolicies || {}).some(
    (toolPolicy) => toolPolicy?.access === 'content_read',
  );
}

function shouldGrantContentReadScope(allowedServerEntries = []) {
  return allowedServerEntries.some(({ policy }) => policyCanReceiveContentReadGrant(policy));
}

function brokerToolName(serverName, toolName) {
  const safeServer = String(serverName || '').replace(/[^A-Za-z0-9_]+/g, '_');
  const safeTool = String(toolName || '').replace(/[^A-Za-z0-9_]+/g, '_');
  return `gh_${safeServer}__${safeTool}`.slice(0, 120);
}

function helperToolDefinitions() {
  return [
    {
      name: 'capabilities_list',
      description:
        'List the connected MCP capability servers and currently re-exported tools available to this GlassHive worker run.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'capability_describe',
      description:
        'Describe one GlassHive broker capability server or re-exported tool without invoking it.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'capability_invoke',
      description:
        'Escape hatch for invoking an allowed underlying MCP tool by server/tool name. Prefer native re-exported broker tools when listed.',
      inputSchema: {
        type: 'object',
        required: ['server', 'tool', 'arguments'],
        properties: {
          server: { type: 'string' },
          tool: { type: 'string' },
          arguments: { type: 'object' },
          invocation_id: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  ];
}

function getToolPolicy(policy, toolName, tool = {}) {
  const explicit = policy?.toolPolicies?.[toolName];
  if (explicit) {
    return {
      access: explicit.access || policy?.defaultToolAccess || 'none',
      confirmation: explicit.confirmation || 'none',
      description: explicit.description || '',
    };
  }
  const annotations = tool?.annotations || {};
  let access = policy?.defaultToolAccess || 'none';
  if (annotations.destructiveHint === true || annotations.readOnlyHint === false) {
    access = 'write';
  }
  return {
    access,
    confirmation: 'none',
    description: '',
  };
}

function evaluateToolCallPolicy({
  policy,
  toolName,
  tool,
  confirmed = false,
  explicitContentIntent = false,
  contentReadIntent = explicitContentIntent,
} = {}) {
  const toolPolicy = getToolPolicy(policy, toolName, tool);
  if (toolPolicy.access === 'none') {
    return { allowed: false, reason: 'tool_not_authorized', toolPolicy };
  }
  if (toolPolicy.access === 'content_read' && policy.contentReadPolicy === 'deny') {
    return { allowed: false, reason: 'content_read_denied', toolPolicy };
  }
  if (
    toolPolicy.access === 'content_read' &&
    CONTENT_READ_GRANT_REQUIRED_POLICIES.has(policy.contentReadPolicy) &&
    !contentReadIntent
  ) {
    return { allowed: false, reason: 'content_read_requires_broker_grant_scope', toolPolicy };
  }
  if (toolPolicy.access === 'write' && policy.writePolicy === 'deny') {
    return { allowed: false, reason: 'write_denied', toolPolicy };
  }
  if (toolPolicy.access === 'write' && policy.writePolicy === 'confirm' && !confirmed) {
    return { allowed: false, reason: 'write_requires_host_confirmation', toolPolicy };
  }
  return { allowed: true, reason: 'allowed', toolPolicy };
}

function auditSafeToolSummary({
  serverName,
  toolName,
  brokerName,
  description,
  inputSchema,
  policy,
  tool,
} = {}) {
  return {
    name: brokerName,
    title: `${serverName}:${toolName}`,
    description: description || '',
    inputSchema: inputSchema || { type: 'object', properties: {} },
    annotations: {
      server: serverName,
      tool: toolName,
      riskClass: policy?.riskClass || 'unspecified',
      access: getToolPolicy(policy, toolName, tool).access,
    },
  };
}

function logOmission(reason, serverName, extra = {}) {
  logger.debug('[VIVENTIUM][glasshive-capability-broker] MCP server omitted', {
    reason,
    serverName,
    ...extra,
  });
  return { server: serverName, reason };
}

module.exports = {
  BROKER_HELPER_TOOLS,
  auditSafeToolSummary,
  brokerToolName,
  collectAllowedServerEntries,
  collectAllowedServers,
  evaluateToolCallPolicy,
  getPolicy,
  helperToolDefinitions,
  isBrokerProjectionEnabled,
  isTrustedServerConfig,
  logOmission,
  policyCanReceiveContentReadGrant,
  shouldGrantContentReadScope,
};
