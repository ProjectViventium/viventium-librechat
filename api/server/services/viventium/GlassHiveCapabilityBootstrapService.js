/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker bootstrap injection
 * Purpose:
 * - Add one broker MCP to GlassHive worker bootstrap bundles without relying on the chat model
 *   to choose Google/MS365 tools.
 * - Keep the worker's prompt context compact while machine-readable MCP setup lives in bootstrap.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { getMCPServersRegistry } = require('~/config');
const {
  collectAllowedServers,
  isBrokerProjectionEnabled,
} = require('./GlassHiveCapabilityPolicyService');
const { mintBrokerGrant } = require('./GlassHiveCapabilityBrokerAuth');

const GLASSHIVE_LAUNCH_TOOLS = new Set([
  'workspace_launch',
  'workspace_schedule',
  'worker_delegate_once',
  'worker_create',
  'worker_find_or_resume',
  'worker_run',
  'worker_schedule',
  'workspace_continue',
]);

const GLASSHIVE_SCHEDULE_TOOLS = new Set(['workspace_schedule', 'worker_schedule']);

function configuredGlassHiveServerNames() {
  return String(process.env.VIVENTIUM_GLASSHIVE_MCP_SERVER_NAMES || 'glasshive-workers-projects')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function shouldInjectForTool({ serverName, toolName } = {}) {
  return (
    isBrokerProjectionEnabled() &&
    configuredGlassHiveServerNames().includes(String(serverName || '').trim()) &&
    GLASSHIVE_LAUNCH_TOOLS.has(String(toolName || '').trim())
  );
}

function parseToolArguments(toolArguments) {
  if (typeof toolArguments === 'string') {
    try {
      const parsed = JSON.parse(toolArguments);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (toolArguments && typeof toolArguments === 'object' && !Array.isArray(toolArguments)) {
    return { ...toolArguments };
  }
  return null;
}

function normalizeBootstrapBundle(raw) {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
}

function appendText(existing, addition) {
  const left = String(existing || '').trim();
  const right = String(addition || '').trim();
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  if (left.includes(right)) {
    return left;
  }
  return `${left}\n\n${right}`;
}

function truthyFlag(value) {
  if (value === true) {
    return true;
  }
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
}

function normalizeExecutionMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === 'host' || mode === 'docker' ? mode : '';
}

function defaultExecutionModeForBroker() {
  return (
    normalizeExecutionMode(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_DEFAULT_EXECUTION_MODE) ||
    normalizeExecutionMode(process.env.VIVENTIUM_GLASSHIVE_DEFAULT_EXECUTION_MODE) ||
    normalizeExecutionMode(process.env.WPR_DEFAULT_EXECUTION_MODE) ||
    normalizeExecutionMode(process.env.GLASSHIVE_DEFAULT_EXECUTION_MODE) ||
    'docker'
  );
}

function executionModeForBroker(args = {}) {
  return normalizeExecutionMode(args.execution_mode || args.executionMode) || defaultExecutionModeForBroker();
}

function resolveBrokerUrl(executionMode = '') {
  const explicit = String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL || '').trim();
  if (explicit) {
    return explicit;
  }
  const port = String(process.env.PORT || process.env.LIBRECHAT_PORT || '3080').trim();
  const mode = normalizeExecutionMode(executionMode) || defaultExecutionModeForBroker();
  const configuredHost = String(process.env.HOST || '').trim();
  const host =
    mode === 'host'
      ? configuredHost &&
        configuredHost !== 'localhost' &&
        configuredHost !== '0.0.0.0' &&
        configuredHost !== '::'
        ? configuredHost
        : '127.0.0.1'
      : 'host.docker.internal';
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${urlHost}:${port}/api/viventium/glasshive/capabilities/mcp`;
}

function intEnv(name, defaultValue) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultValue;
}

function grantTtlSecondsForTool(toolName, args = {}) {
  if (!GLASSHIVE_SCHEDULE_TOOLS.has(String(toolName || '').trim())) {
    return intEnv('VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_TTL_SECONDS', 10 * 60);
  }
  const scheduleDefault = intEnv('VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SCHEDULE_TTL_SECONDS', 60 * 60);
  const scheduleMax = intEnv('VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS', 24 * 60 * 60);
  let desired = scheduleDefault;
  const delaySeconds = Number(args.delay_seconds ?? args.delaySeconds);
  if (Number.isFinite(delaySeconds) && delaySeconds >= 0) {
    desired = Math.max(desired, Math.floor(delaySeconds) + 10 * 60);
  }
  const runAt = Date.parse(String(args.run_at || args.runAt || ''));
  if (Number.isFinite(runAt)) {
    desired = Math.max(desired, Math.ceil((runAt - Date.now()) / 1000) + 10 * 60);
  }
  return Math.max(60, Math.min(desired, scheduleMax));
}

function grantRenewableTtlSecondsForTool(toolName, args = {}) {
  const base = grantTtlSecondsForTool(toolName, args);
  const defaultRenewable = intEnv('VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RENEWABLE_TTL_SECONDS', 60 * 60);
  const maxRenewable = intEnv('VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS', 24 * 60 * 60);
  return Math.max(base, Math.min(Math.max(base, defaultRenewable), maxRenewable));
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function brokerContextBrief(allowedServers, { contentReadIntent = false } = {}) {
  const serverList = allowedServers.length ? allowedServers.join(', ') : 'none';
  return [
    'GlassHive connected capability broker [v2]:',
    '- A broker MCP named `glasshive-user-capabilities` is available in this workspace when the local MCP client loads project MCP config.',
    '- The broker exposes the current user/run authorized MCP tools from the host application; treat it as an available capability option for Google Workspace, Microsoft 365, and other connected-account facts.',
    '- Prefer MCP/tools for connected-account facts and actions when they can satisfy the task. Use browser or computer UI when MCP/tools are missing, unavailable, auth-blocked, explicitly required, or when visual/manual QA is genuinely the better route.',
    '- If a non-broker host connector is also available, including a built-in Codex app connector, prefer the brokered `glasshive-user-capabilities` tool when it covers the same connected-account provider. Use non-broker connectors only after the broker path is missing, unavailable, auth-blocked, or explicitly required.',
    '- Do not treat memory, recall, or prior chat text as live Google/MS365 evidence. Ask the broker when current provider truth is needed.',
    `- Content-read intent for this run is ${contentReadIntent ? 'host-authorized' : 'not host-authorized'}. If a needed content read is blocked by broker policy, report that blocker instead of self-authorizing with worker-authored flags.`,
    `- Authorized capability servers for this run: ${serverList}. If a needed server is missing, report the broker omission/auth limitation rather than fabricating.`,
  ].join('\n');
}

function workerMemoryBlock(memory) {
  const text = String(memory || '').trim();
  if (!text) {
    return '';
  }
  return [
    'What you already know about the user (saved memory — the same user context the main assistant has):',
    text,
    'Use this to judge relevance, priority, and alignment for this user. It is background context, not live provider evidence — verify current facts via the broker/tools.',
  ].join('\n');
}

function contentReadIntentForArgs(args = {}) {
  return (
    truthyFlag(args.connected_account_content_intent) ||
    truthyFlag(args.connectedAccountContentIntent) ||
    truthyFlag(args.content_read_intent) ||
    truthyFlag(args.contentReadIntent)
  );
}

function mergeBrokerBundle({
  existingBundle,
  brokerUrl,
  grantToken,
  grantPayload,
  allowedServers,
  contentReadIntent = false,
  workerMemory = '',
}) {
  const bundle = { ...existingBundle };
  const codexTokenEnvVar = 'GLASSHIVE_CAPABILITY_BROKER_TOKEN';
  const serverConfig = {
    type: 'http',
    transport: 'http',
    url: brokerUrl,
    headers: {
      Authorization: `Bearer \${${codexTokenEnvVar}}`,
    },
  };
  bundle.version = bundle.version || 1;
  bundle.glasshive_capability_broker = {
    version: 1,
    name: 'glasshive-user-capabilities',
    url: brokerUrl,
    grant_id: grantPayload.grant_id,
    grant_expires_at: grantPayload.exp,
    grant_renewable_until: grantPayload.renewable_until,
    allowed_servers: allowedServers,
    scopes: grantPayload.scopes || {},
    projection: 'all_user_enabled_policy_gated',
  };
  bundle.glasshive_capability_intent = {
    ...(bundle.glasshive_capability_intent || {}),
    content_read: contentReadIntent,
  };
  bundle.claude_project_mcp = {
    ...(bundle.claude_project_mcp || {}),
    'glasshive-user-capabilities': serverConfig,
  };
  const codexBlock = [
    '[mcp_servers.glasshive-user-capabilities]',
    `url = ${tomlString(brokerUrl)}`,
    `bearer_token_env_var = ${tomlString(codexTokenEnvVar)}`,
  ].join('\n');
  bundle.codex_config_append = appendText(bundle.codex_config_append, codexBlock);
  bundle.env = {
    ...(bundle.env || {}),
    [codexTokenEnvVar]: grantToken,
  };
  const instruction = brokerContextBrief(allowedServers, { contentReadIntent });
  bundle.agents_md = appendText(bundle.agents_md, instruction);
  bundle.claude_md = appendText(bundle.claude_md, instruction);
  bundle.codex_md = appendText(bundle.codex_md, instruction);
  const memoryBlock = workerMemoryBlock(workerMemory);
  if (memoryBlock) {
    bundle.agents_md = appendText(bundle.agents_md, memoryBlock);
    bundle.claude_md = appendText(bundle.claude_md, memoryBlock);
    bundle.codex_md = appendText(bundle.codex_md, memoryBlock);
  }
  return bundle;
}

function applyContextBrief(args, toolName, allowedServers, { contentReadIntent = false } = {}) {
  const brief = brokerContextBrief(allowedServers, { contentReadIntent });
  if (toolName === 'workspace_launch' || toolName === 'workspace_schedule') {
    args.context = appendText(args.context, brief);
  } else if (toolName === 'workspace_continue') {
    args.additional_instructions = appendText(args.additional_instructions, brief);
  } else if (toolName === 'worker_delegate_once' || toolName === 'worker_run' || toolName === 'worker_schedule') {
    args.instruction = appendText(args.instruction, brief);
  }
}

async function maybeInjectGlassHiveCapabilityBroker({ serverName, toolName, toolArguments, config } = {}) {
  if (!shouldInjectForTool({ serverName, toolName })) {
    return toolArguments;
  }
  const args = parseToolArguments(toolArguments);
  if (!args) {
    return toolArguments;
  }
  const user = config?.configurable?.user;
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    return toolArguments;
  }
  const registry = getMCPServersRegistry();
  const mcpConfig = await registry.getAllServerConfigs(userId).catch((error) => {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Failed to load MCP config for bootstrap', {
      message: error?.message,
    });
    return null;
  });
  if (!mcpConfig) {
    return toolArguments;
  }
  const executionMode = executionModeForBroker(args);
  const allowedServers = collectAllowedServers({ mcpConfig, executionMode });
  if (allowedServers.length === 0) {
    return toolArguments;
  }
  const requestBody = config?.configurable?.requestBody || {};
  const existingBundle = normalizeBootstrapBundle(args.bootstrap_bundle_json);
  const contentReadIntent = contentReadIntentForArgs(args);
  const requestContext = {
    conversation_id: requestBody.conversationId,
    parent_message_id: requestBody.parentMessageId,
    message_id: requestBody.messageId,
    execution_mode: executionMode,
  };
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      allowedServers,
      requestContext,
      executionMode,
      ttlSeconds: grantTtlSecondsForTool(toolName, args),
      renewableTtlSeconds: grantRenewableTtlSecondsForTool(toolName, args),
      scopes: { content_read: contentReadIntent },
    });
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Skipping bootstrap injection', {
      reason: 'grant_mint_failed',
      message: error?.message,
    });
    return toolArguments;
  }
  const { token, payload } = mintedGrant;
  const workerMemory = String(config?.configurable?.glasshive_worker_memory || '').trim();
  args.bootstrap_bundle_json = mergeBrokerBundle({
    existingBundle,
    brokerUrl: resolveBrokerUrl(executionMode),
    grantToken: token,
    grantPayload: payload,
    allowedServers,
    contentReadIntent,
    workerMemory,
  });
  applyContextBrief(args, toolName, allowedServers, { contentReadIntent });
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
}

module.exports = {
  GLASSHIVE_LAUNCH_TOOLS,
  brokerContextBrief,
  configuredGlassHiveServerNames,
  contentReadIntentForArgs,
  grantTtlSecondsForTool,
  grantRenewableTtlSecondsForTool,
  maybeInjectGlassHiveCapabilityBroker,
  mergeBrokerBundle,
  executionModeForBroker,
  resolveBrokerUrl,
  shouldInjectForTool,
};
