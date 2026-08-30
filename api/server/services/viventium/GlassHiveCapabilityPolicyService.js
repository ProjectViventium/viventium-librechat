/* === VIVENTIUM START ===
 * Feature: GlassHive MCP capability projection policy
 * Purpose:
 * - Select only reviewed, source-of-truth MCP servers for autonomous GlassHive workers.
 * - Keep user-created DB MCP configs projection-off unless an explicit reviewed policy says otherwise.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const crypto = require('crypto');
const { canUseViventiumMCPServer } = require('./mcpAudiencePolicy');

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

function collectServerProjection({
  mcpConfig = {},
  executionMode = '',
  serverNames,
  reqUser,
} = {}) {
  const requestedServerNames = Array.from(
    new Set(
      (Array.isArray(serverNames) ? serverNames : Object.keys(mcpConfig || {}))
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).sort();
  if (!isBrokerProjectionEnabled()) {
    return {
      allowedEntries: [],
      omissions: requestedServerNames.map((server) => ({
        server,
        reason: 'broker_projection_disabled',
      })),
    };
  }

  const allowedEntries = [];
  const omissions = [];
  for (const serverName of requestedServerNames) {
    const serverConfig = mcpConfig?.[serverName];
    if (!serverConfig) {
      omissions.push({ server: serverName, reason: 'server_config_missing' });
      continue;
    }
    if (!canUseViventiumMCPServer({ serverConfig, reqUser })) {
      omissions.push({ server: serverName, reason: 'request_audience_not_authorized' });
      continue;
    }
    const policy = getPolicy(serverConfig);
    if (!policy) {
      omissions.push({ server: serverName, reason: 'policy_not_authorized' });
      continue;
    }
    if (!isTrustedServerConfig(serverConfig)) {
      omissions.push({ server: serverName, reason: 'server_config_untrusted' });
      continue;
    }
    if (!policyAllowsExecutionMode(policy, executionMode)) {
      omissions.push({ server: serverName, reason: 'execution_mode_not_authorized' });
      continue;
    }
    allowedEntries.push({ serverName, serverConfig, policy });
  }
  return { allowedEntries, omissions };
}

function collectAllowedServerEntries({ mcpConfig = {}, executionMode = '', reqUser } = {}) {
  return collectServerProjection({ mcpConfig, executionMode, reqUser }).allowedEntries;
}

function collectAllowedServers({ mcpConfig = {}, executionMode = '', reqUser } = {}) {
  return collectAllowedServerEntries({ mcpConfig, executionMode, reqUser }).map(
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
  const rawServer = String(serverName || '');
  const rawTool = String(toolName || '');
  const safeServer = rawServer.replace(/[^A-Za-z0-9_]+/g, '_');
  const safeTool = rawTool.replace(/[^A-Za-z0-9_]+/g, '_');
  const candidate = `gh_${safeServer}__${safeTool}`;
  if (candidate.length <= 120) {
    return candidate;
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${rawServer}\0${rawTool}`)
    .digest('hex')
    .slice(0, 12);
  return `${candidate.slice(0, 107)}_${digest}`;
}

function collisionSafeBrokerToolName(serverName, toolName, claimedNames = new Map()) {
  const baseName = brokerToolName(serverName, toolName);
  const identity = `${String(serverName || '')}\0${String(toolName || '')}`;
  const claimedIdentity = claimedNames.get(baseName);
  if (!claimedIdentity || claimedIdentity === identity) {
    claimedNames.set(baseName, identity);
    return baseName;
  }
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const collisionSafeName = `${baseName.slice(0, 107)}_${digest}`;
  claimedNames.set(collisionSafeName, identity);
  return collisionSafeName;
}

/* === VIVENTIUM START ===
 * Feature: truthful MCP approval metadata
 * Purpose: Project standard MCP ToolAnnotations from reviewed structured policy so non-interactive
 * workers may call proven read-only tools while write or unknown tools remain approval-gated. */
function mcpToolAnnotations({
  access = 'none',
  upstreamAnnotations,
  openWorldDefault = true,
} = {}) {
  const upstream =
    upstreamAnnotations &&
    typeof upstreamAnnotations === 'object' &&
    !Array.isArray(upstreamAnnotations)
      ? upstreamAnnotations
      : {};
  const readOnly = access === 'read' || access === 'content_read';
  return {
    readOnlyHint: readOnly,
    destructiveHint: readOnly ? false : upstream.destructiveHint !== false,
    idempotentHint: readOnly ? true : upstream.idempotentHint === true,
    openWorldHint:
      typeof upstream.openWorldHint === 'boolean'
        ? upstream.openWorldHint
        : Boolean(openWorldDefault),
  };
}
/* === VIVENTIUM END === */

function helperToolDefinitions() {
  return [
    {
      name: 'capabilities_list',
      description:
        'Discover connected capabilities without loading every provider schema. Call with no arguments to list servers, then call with one server name to page through compact tool identities. Use capability_describe for one exact schema and capability_invoke to call it.',
      inputSchema: {
        type: 'object',
        properties: {
          server: { type: 'string', description: 'Optional exact server name to enumerate.' },
          cursor: { type: 'string', description: 'Opaque cursor returned by the prior page.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 50 },
        },
        additionalProperties: false,
      },
      annotations: mcpToolAnnotations({ access: 'read', openWorldDefault: false }),
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
      annotations: mcpToolAnnotations({ access: 'read', openWorldDefault: false }),
    },
    {
      name: 'capability_invoke',
      description:
        'Invoke one allowed underlying MCP tool by exact server/tool name after compact discovery. Use capability_describe first when its argument schema is not already known. A successful write is a real external effect: finish discovery first, make the intended effect once, and never create a replacement with a new invocation_id after success; use a provider update capability or report the blocker instead.',
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
      annotations: mcpToolAnnotations({ access: 'unknown', openWorldDefault: true }),
    },
  ];
}

function getToolPolicy(policy, toolName, tool = {}) {
  const explicit = policy?.toolPolicies?.[toolName];
  if (explicit) {
    return {
      access: explicit.access || policy?.defaultToolAccess || 'none',
      confirmation: explicit.confirmation || 'inherit',
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
    confirmation: 'inherit',
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
  if (
    toolPolicy.access === 'write' &&
    policy.writePolicy === 'confirm' &&
    toolPolicy.confirmation !== 'none' &&
    !confirmed
  ) {
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
  const toolPolicy = getToolPolicy(policy, toolName, tool);
  const sourceInputSchema =
    inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
      ? inputSchema
      : { type: 'object', properties: {} };
  const brokerInputSchema =
    toolPolicy.access === 'write'
      ? {
          ...sourceInputSchema,
          type: 'object',
          properties: {
            ...(sourceInputSchema.properties || {}),
            invocation_id: {
              type: 'string',
              description:
                'A stable unique id for this intended mutation; reuse it only when retrying the same action.',
            },
          },
          required: Array.from(new Set([...(sourceInputSchema.required || []), 'invocation_id'])),
        }
      : sourceInputSchema;
  return {
    name: brokerName,
    title: `${serverName}:${toolName}`,
    description: description || '',
    inputSchema: brokerInputSchema,
    annotations: {
      ...mcpToolAnnotations({
        access: toolPolicy.access,
        upstreamAnnotations: tool?.annotations,
        openWorldDefault: true,
      }),
      server: serverName,
      tool: toolName,
      riskClass: policy?.riskClass || 'unspecified',
      access: toolPolicy.access,
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
  collisionSafeBrokerToolName,
  collectAllowedServerEntries,
  collectAllowedServers,
  collectServerProjection,
  evaluateToolCallPolicy,
  getPolicy,
  helperToolDefinitions,
  isBrokerProjectionEnabled,
  isTrustedServerConfig,
  logOmission,
  mcpToolAnnotations,
  policyCanReceiveContentReadGrant,
  shouldGrantContentReadScope,
};
