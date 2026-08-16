/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker bootstrap injection
 * Purpose:
 * - Add one broker MCP to GlassHive worker bootstrap bundles without relying on the chat model
 *   to predict which declared capability should satisfy the request.
 * - Keep the worker's prompt context compact while machine-readable MCP setup lives in bootstrap.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { getMCPServersRegistry } = require('~/config');
const {
  collectAllowedServerEntries,
  collectServerProjection,
  isBrokerProjectionEnabled,
  shouldGrantContentReadScope,
} = require('./GlassHiveCapabilityPolicyService');
const { mintBrokerGrant, persistBrokerGrantResources } = require('./GlassHiveCapabilityBrokerAuth');
const { BROKER_AUTHORITY_KINDS } = require('./GlassHiveCapabilityBrokerAuth');
const {
  DELEGATION_TOOL_NAME,
  hasTrustedKnownWork,
  isConversationOrchestrationControlTool,
} = require('./GlassHiveConversationOrchestration');
const {
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
} = require('./GlassHiveSourceSelection');
const {
  orchestrationReadinessSnapshot,
  refreshOrchestrationReadiness,
} = require('./GlassHiveOrchestrationReadinessService');
const { createCapabilityAuthorization } = require('./GlassHiveCapabilityAuthorizationService');
const { pinFeelingCapsuleLast } = require('./feelingPromptTail');
const { logFeelingsEvent, summarizeFeelingCapsulePlacement } = require('./feelingsTelemetry');
const {
  attachGlassHiveTrustedLaunchMetadata,
  markGlassHiveLaunchDispatchReady,
  markGlassHiveLaunchPreDispatchFailed,
  registerGlassHiveLaunchContext,
} = require('./GlassHiveCallbackBindingService');

const WORKER_INSTRUCTION_FIELDS = Object.freeze(['agents_md', 'claude_md', 'codex_md']);

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
const MAX_SCHEDULE_GRANT_TTL_SECONDS = 24 * 60 * 60;
const NEW_CONVERSATION_PLACEHOLDER = 'new';
const NO_PARENT_MESSAGE_ID = '00000000-0000-0000-0000-000000000000';

function configuredGlassHiveServerNames() {
  return String(process.env.VIVENTIUM_GLASSHIVE_MCP_SERVER_NAMES || 'glasshive-workers-projects')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

async function requireIsolatedParallelPolicy({ ownerId } = {}) {
  // Most launches consume the fresh process-local watcher snapshot. A provider can legitimately
  // spend longer authoring than that snapshot's freshness window, though, so recover exactly that
  // stale/unavailable launch once with the authenticated owner instead of returning a false
  // isolation failure. Focused/off turns and fresh launches remain zero-network; GlassHive still
  // enforces the deployment invariant atomically at admission.
  let snapshot = orchestrationReadinessSnapshot();
  const normalizedOwnerId = String(ownerId || '').trim();
  if (!snapshot.available && snapshot.requested && normalizedOwnerId) {
    snapshot = await refreshOrchestrationReadiness({ ownerId: normalizedOwnerId });
  }
  if (!snapshot.available) {
    const error = new Error('glasshive_parallel_isolation_unavailable');
    error.code = 'glasshive_parallel_isolation_unavailable';
    error.status = 503;
    error.needsInput = true;
    throw error;
  }
  return snapshot;
}

function shouldInjectForTool({ serverName, toolName } = {}) {
  return (
    isBrokerProjectionEnabled() &&
    configuredGlassHiveServerNames().includes(String(serverName || '').trim()) &&
    GLASSHIVE_LAUNCH_TOOLS.has(String(toolName || '').trim())
  );
}

function isGlassHiveLaunchTool({ serverName, toolName } = {}) {
  return (
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

const RESERVED_BROKER_CONTROL_KEYS = new Set([
  'glasshivecapabilitybroker',
  'glasshivecapabilityauthorization',
  'glasshivecapabilityintent',
  'glasshivecapabilityrequirement',
  'glasshivecapabilitybrokerstatus',
  'viventiumlaunchauthority',
]);
const RESERVED_BROKER_MCP_NAME = 'glasshiveusercapabilities';
const RESERVED_BROKER_TOKEN_ENV = 'GLASSHIVE_CAPABILITY_BROKER_TOKEN';

function canonicalControlKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Remove all model-influenced broker authority before Core decides whether/how to add it. */
function stripReservedBrokerControls(existingBundle = {}) {
  const bundle = {};
  for (const [key, value] of Object.entries(existingBundle || {})) {
    if (RESERVED_BROKER_CONTROL_KEYS.has(canonicalControlKey(key))) continue;
    bundle[key] = value;
  }

  if (bundle.env && typeof bundle.env === 'object' && !Array.isArray(bundle.env)) {
    bundle.env = Object.fromEntries(
      Object.entries(bundle.env).filter(
        ([key]) => String(key || '').toUpperCase() !== RESERVED_BROKER_TOKEN_ENV,
      ),
    );
  }

  if (
    bundle.claude_project_mcp &&
    typeof bundle.claude_project_mcp === 'object' &&
    !Array.isArray(bundle.claude_project_mcp)
  ) {
    bundle.claude_project_mcp = Object.fromEntries(
      Object.entries(bundle.claude_project_mcp).filter(([name, config]) => {
        if (canonicalControlKey(name) === RESERVED_BROKER_MCP_NAME) return false;
        const serialized = JSON.stringify(config || {});
        return (
          !serialized.includes(RESERVED_BROKER_TOKEN_ENV) &&
          !serialized.toLowerCase().includes('glasshive-user-capabilities')
        );
      }),
    );
  }

  if (
    typeof bundle.codex_config_append === 'string' &&
    (bundle.codex_config_append.includes(RESERVED_BROKER_TOKEN_ENV) ||
      bundle.codex_config_append.toLowerCase().includes('glasshive-user-capabilities'))
  ) {
    delete bundle.codex_config_append;
  }
  return bundle;
}

// VIVENTIUM START: automatic Parallel launches accept context, never model-owned authority.
const AUTOMATIC_PARALLEL_MODEL_AUTHORITY_KEYS = new Set([
  'codexconfigappend',
  'claudeprojectmcp',
  'env',
  'executionpolicy',
  'files',
]);

function stripAutomaticParallelModelAuthority(existingBundle = {}) {
  return Object.fromEntries(
    Object.entries(existingBundle || {}).filter(
      ([key]) => !AUTOMATIC_PARALLEL_MODEL_AUTHORITY_KEYS.has(canonicalControlKey(key)),
    ),
  );
}
// VIVENTIUM END: automatic Parallel launches accept context, never model-owned authority.

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

function sliceWithoutSplittingSurrogate(value, maxLength) {
  let bounded = String(value || '').slice(0, Math.max(0, Number(maxLength) || 0));
  if (!bounded) return '';
  const finalCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

function appendTextBounded(existing, addition, maxLength) {
  const limit = Math.max(0, Number(maxLength) || 0);
  const left = String(existing || '').trim();
  const right = String(addition || '').trim();
  const boundedLeft = sliceWithoutSplittingSurrogate(left, limit);
  if (!right || left.includes(right) || boundedLeft.length + 2 >= limit) {
    return boundedLeft;
  }
  const boundedRight = sliceWithoutSplittingSurrogate(right, limit - boundedLeft.length - 2);
  return boundedRight ? `${boundedLeft}\n\n${boundedRight}` : boundedLeft;
}

function normalizeExecutionMode(value) {
  const mode = String(value || '')
    .trim()
    .toLowerCase();
  return mode === 'host' || mode === 'docker' ? mode : '';
}

function defaultExecutionModeForBroker() {
  return (
    normalizeExecutionMode(
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_DEFAULT_EXECUTION_MODE,
    ) ||
    normalizeExecutionMode(process.env.VIVENTIUM_GLASSHIVE_DEFAULT_EXECUTION_MODE) ||
    normalizeExecutionMode(process.env.WPR_DEFAULT_EXECUTION_MODE) ||
    normalizeExecutionMode(process.env.GLASSHIVE_DEFAULT_EXECUTION_MODE) ||
    'docker'
  );
}

function executionModeForBroker(args = {}) {
  return (
    normalizeExecutionMode(args.execution_mode || args.executionMode) ||
    defaultExecutionModeForBroker()
  );
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
  const scheduleDefault = intEnv(
    'VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SCHEDULE_TTL_SECONDS',
    60 * 60,
  );
  const configuredScheduleMax = intEnv(
    'VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS',
    MAX_SCHEDULE_GRANT_TTL_SECONDS,
  );
  const scheduleMax = Math.min(configuredScheduleMax, MAX_SCHEDULE_GRANT_TTL_SECONDS);
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

function brokerTurnScope(requestBody = {}) {
  const normalizedId = (value, placeholders = []) => {
    const id = String(value || '').trim();
    return placeholders.includes(id) ? '' : id;
  };
  const conversationId = normalizedId(requestBody.conversationId || requestBody.conversation_id, [
    NEW_CONVERSATION_PLACEHOLDER,
  ]);
  const parentMessageId = normalizedId(
    requestBody.parentMessageId || requestBody.parent_message_id,
    [NO_PARENT_MESSAGE_ID],
  );
  const requestMessageId = normalizedId(requestBody.messageId || requestBody.message_id, [
    NO_PARENT_MESSAGE_ID,
  ]);
  const responseMessageId = normalizedId(
    requestBody.responseMessageId || requestBody.response_message_id,
    [NO_PARENT_MESSAGE_ID],
  );
  const explicitTurnId = normalizedId(requestBody.turnId || requestBody.turn_id);
  // Provider fallback bundles can be prepared before the assistant response id exists. The signed
  // parent user-message id is still an exact, immutable scope for an already-persisted conversation.
  const messageId = requestMessageId || parentMessageId || responseMessageId;
  // A first browser turn has an exact client-minted user message id before either the conversation
  // or assistant response exists. Bind that same immutable id as the pre-persistence turn scope;
  // never infer a turn from a placeholder or substitute this for a real conversation boundary.
  const turnId =
    explicitTurnId ||
    responseMessageId ||
    (!conversationId && requestMessageId ? requestMessageId : '');
  return {
    conversation_id: conversationId,
    parent_message_id: parentMessageId,
    message_id: messageId,
    turn_id: turnId,
  };
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function brokerContextBrief(
  allowedServers,
  { contentReadScope = false, allowedHostTools = [] } = {},
) {
  const serverList = allowedServers.length ? allowedServers.join(', ') : 'none';
  const hostToolList = allowedHostTools.length ? allowedHostTools.join(', ') : 'none';
  return [
    'GlassHive connected capability broker [v2]:',
    '- A broker MCP named `glasshive-user-capabilities` is available in this workspace when the local MCP client loads project MCP config.',
    '- The broker catalog exposes exactly the current user/run authorized host capabilities. Treat the catalog as capability truth; do not infer availability from this prose.',
    '- Prefer callable broker tools for live connected-service facts and actions when they can satisfy the task. A missing, unavailable, revoked, approval-blocked, or auth-blocked broker capability does not authorize a browser, computer, filesystem, shell, or native connector workaround to the same protected provider. Surface the exact blocker so the mission can enter needs_input.',
    '- A separately authorized native tool may still handle unrelated work inside the run envelope, or a user-explicit UI task that does not bypass connected-account authority. Never infer new authority merely because a native tool is technically callable.',
    '- Do not treat memory, recall, or prior chat text as live connected-service evidence. Ask the broker when current provider truth is needed.',
    `- Content-read broker scope for this run is ${contentReadScope ? 'authorized by reviewed host policy' : 'not authorized'}. If a needed content read is blocked by broker policy, report that blocker instead of self-authorizing with worker-authored flags.`,
    `- Authorized capability servers for this run: ${serverList}. If a needed server is missing, report the broker omission/auth limitation rather than fabricating.`,
    `- Authorized host tools for this run: ${hostToolList}. These are the same resolved host capabilities available to the main Agent; absence means the host did not resolve or authorize them for this turn.`,
    '- Host-tool resources are virtual service evidence, not workspace paths. Never pass their labels to shell/filesystem tools or search for copies by filename. When an authorized host tool covers the needed evidence, call it before any filesystem discovery; resource labels are not proof of mounted files.',
  ].join('\n');
}

function providerProjectionBoundary(omissions = []) {
  if (!omissions.length) {
    return '';
  }
  const omittedList = omissions.map(({ server, reason }) => `${server} (${reason})`).join(', ');
  return [
    `Declared but unavailable capability servers for this turn: ${omittedList}.`,
    'Do not claim or plan to use those unavailable capabilities. Continue with genuinely callable tools when they can still complete the request; otherwise report the exact capability limitation.',
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

function workerFeelingBlock(feelings) {
  return String(feelings || '').trim();
}

function brokerUnavailableBrief(reason) {
  const safeReason = String(reason || 'unavailable').trim() || 'unavailable';
  return [
    `GlassHive host capability broker is unavailable for this run (${safeReason}).`,
    'Do not claim that brokered host capabilities are available or substitute memory/recall for live provider evidence.',
    'Continue only with unrelated work that stays inside separately declared run authority. Do not use browser, computer, filesystem, shell, or native connectors to reach the same protected provider. If the objective depends on brokered access, report the exact blocker so the mission can enter needs_input.',
  ].join('\n');
}

function pinWorkerFeelingBlockLast(bundle, feelingBlock) {
  if (!feelingBlock) {
    return bundle;
  }
  for (const field of WORKER_INSTRUCTION_FIELDS) {
    bundle[field] = pinFeelingCapsuleLast({
      instructions: bundle[field],
      capsule: feelingBlock,
    });
  }
  return bundle;
}

function logWorkerFeelingPlacement({
  requestBody,
  bundle,
  feelingBlock,
  snapshotHash,
  scope,
  rangePromptOverrideCount,
  activeRangePromptOverrideCount,
  activeRangePromptOverrideChars,
  reason,
}) {
  for (const field of WORKER_INSTRUCTION_FIELDS) {
    const placement = summarizeFeelingCapsulePlacement({
      instructions: bundle?.[field],
      capsule: feelingBlock,
    });
    logFeelingsEvent(logger, { body: requestBody || {} }, 'feelings.inject.final_run', {
      route: `glasshive_worker_${field}`,
      enabled: Boolean(feelingBlock),
      scope,
      snapshotHash,
      rangePromptOverrideCount,
      activeRangePromptOverrideCount,
      activeRangePromptOverrideChars,
      injected: placement.presentInFinalRun,
      reason,
      ...placement,
    });
  }
}

function trustedCapabilityDependency(config = {}) {
  const packet = config?.configurable?.glasshive_capability_dependency;
  if (
    !packet ||
    packet.version !== 1 ||
    packet.source !== 'turn_tool_activation' ||
    !Array.isArray(packet.server_names) ||
    !Array.isArray(packet.host_tools)
  ) {
    return { required: false, serverNames: [], hostTools: [] };
  }
  const glassHiveNames = new Set(configuredGlassHiveServerNames());
  const serverNames = Array.from(
    new Set(
      packet.server_names
        .map((value) => String(value || '').trim())
        .filter((value) => value && !glassHiveNames.has(value)),
    ),
  ).sort();
  const hostTools = Array.from(
    new Set(packet.host_tools.map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
  return {
    required:
      packet.connected_auth_present === true || serverNames.length > 0 || hostTools.length > 0,
    serverNames,
    hostTools,
  };
}

function mergeWorkerContextBundle({
  existingBundle,
  workerMemory = '',
  workerFeelings = '',
  brokerUnavailableReason = '',
}) {
  const bundle = stripReservedBrokerControls(existingBundle);
  const memoryBlock = workerMemoryBlock(workerMemory);
  if (memoryBlock) {
    bundle.agents_md = appendText(bundle.agents_md, memoryBlock);
    bundle.claude_md = appendText(bundle.claude_md, memoryBlock);
    bundle.codex_md = appendText(bundle.codex_md, memoryBlock);
  }
  const feelingBlock = workerFeelingBlock(workerFeelings);
  if (feelingBlock) {
    bundle.agents_md = appendText(bundle.agents_md, feelingBlock);
    bundle.claude_md = appendText(bundle.claude_md, feelingBlock);
    bundle.codex_md = appendText(bundle.codex_md, feelingBlock);
  }
  if (brokerUnavailableReason) {
    const unavailableBrief = brokerUnavailableBrief(brokerUnavailableReason);
    bundle.glasshive_capability_broker_status = {
      status: 'unavailable',
      reason: brokerUnavailableReason,
    };
    bundle.agents_md = appendText(bundle.agents_md, unavailableBrief);
    bundle.claude_md = appendText(bundle.claude_md, unavailableBrief);
    bundle.codex_md = appendText(bundle.codex_md, unavailableBrief);
  }
  return pinWorkerFeelingBlockLast(bundle, feelingBlock);
}

function mergeBrokerBundle({
  existingBundle,
  brokerUrl,
  grantToken,
  grantPayload,
  allowedServers,
  allowedHostTools = [],
  contentReadScope = false,
  workerMemory = '',
  workerFeelings = '',
}) {
  const bundle = mergeWorkerContextBundle({ existingBundle, workerMemory, workerFeelings });
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
    authority_kind: grantPayload.authority_kind || BROKER_AUTHORITY_KINDS.MISSION_WORKER,
    allowed_servers: allowedServers,
    allowed_host_tools: allowedHostTools,
    scopes: grantPayload.scopes || {},
    projection: 'all_user_enabled_policy_gated',
  };
  bundle.glasshive_capability_intent = {
    ...(bundle.glasshive_capability_intent || {}),
    content_read: contentReadScope,
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
  const instruction = brokerContextBrief(allowedServers, { contentReadScope, allowedHostTools });
  bundle.agents_md = appendText(bundle.agents_md, instruction);
  bundle.claude_md = appendText(bundle.claude_md, instruction);
  bundle.codex_md = appendText(bundle.codex_md, instruction);
  return pinWorkerFeelingBlockLast(bundle, workerFeelingBlock(workerFeelings));
}

function mergePendingBrokerAuthorizationBundle({
  existingBundle,
  authorization,
  brokerUrl,
  allowedServers,
  allowedHostTools = [],
  contentReadScope = false,
  workerMemory = '',
  workerFeelings = '',
  launchAuthorityKind = '',
}) {
  const bundle = mergeWorkerContextBundle({ existingBundle, workerMemory, workerFeelings });
  const tokenEnvVar = 'GLASSHIVE_CAPABILITY_BROKER_TOKEN';
  const serverConfig = {
    type: 'http',
    transport: 'http',
    url: brokerUrl,
    headers: {
      Authorization: `Bearer \${${tokenEnvVar}}`,
    },
  };
  bundle.version = bundle.version || 1;
  bundle.glasshive_capability_authorization = {
    version: 1,
    status: 'pending_admission',
    authorization_ref: authorization.authorizationRef,
    origin_ref: authorization.originRef,
    scope_fingerprint: authorization.scopeFingerprint,
    max_expires_at: new Date(authorization.maxExpiresAt).toISOString(),
  };
  bundle.glasshive_capability_broker = {
    version: 1,
    status: 'pending_admission',
    name: 'glasshive-user-capabilities',
    url: brokerUrl,
    allowed_servers: allowedServers,
    allowed_host_tools: allowedHostTools,
    scopes: { content_read: contentReadScope },
    projection: 'all_user_enabled_policy_gated',
  };
  if (launchAuthorityKind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR) {
    bundle.viventium_launch_authority = {
      version: 1,
      kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      execution_mode: 'docker',
    };
  }
  bundle.glasshive_capability_intent = {
    ...(bundle.glasshive_capability_intent || {}),
    content_read: contentReadScope,
  };
  bundle.claude_project_mcp = {
    ...(bundle.claude_project_mcp || {}),
    'glasshive-user-capabilities': serverConfig,
  };
  const codexBlock = [
    '[mcp_servers.glasshive-user-capabilities]',
    `url = ${tomlString(brokerUrl)}`,
    `bearer_token_env_var = ${tomlString(tokenEnvVar)}`,
  ].join('\n');
  bundle.codex_config_append = appendText(bundle.codex_config_append, codexBlock);
  bundle.env = { ...(bundle.env || {}) };
  // A launch payload is model-influenced. Never accept a stale or caller-supplied
  // bearer; the host overlays the exact run-bound token after admission.
  delete bundle.env[tokenEnvVar];
  const instruction = brokerContextBrief(allowedServers, { contentReadScope, allowedHostTools });
  bundle.agents_md = appendText(bundle.agents_md, instruction);
  bundle.claude_md = appendText(bundle.claude_md, instruction);
  bundle.codex_md = appendText(bundle.codex_md, instruction);
  return pinWorkerFeelingBlockLast(bundle, workerFeelingBlock(workerFeelings));
}

function applyContextBrief(
  args,
  toolName,
  allowedServers,
  { contentReadScope = false, allowedHostTools = [] } = {},
) {
  const brief = brokerContextBrief(allowedServers, { contentReadScope, allowedHostTools });
  if (toolName === 'workspace_launch' || toolName === 'workspace_schedule') {
    args.context = appendText(args.context, brief);
  } else if (toolName === 'workspace_continue') {
    args.additional_instructions = appendText(args.additional_instructions, brief);
  } else if (
    toolName === 'worker_delegate_once' ||
    toolName === 'worker_run' ||
    toolName === 'worker_schedule'
  ) {
    args.instruction = appendTextBounded(args.instruction, brief, 100_000);
  }
}

function applyUnavailableContextBrief(args, toolName, reason) {
  const brief = brokerUnavailableBrief(reason);
  if (toolName === 'workspace_launch' || toolName === 'workspace_schedule') {
    args.context = appendText(args.context, brief);
  } else if (toolName === 'workspace_continue') {
    args.additional_instructions = appendText(args.additional_instructions, brief);
  } else if (
    toolName === 'worker_delegate_once' ||
    toolName === 'worker_run' ||
    toolName === 'worker_schedule'
  ) {
    args.instruction = appendTextBounded(args.instruction, brief, 100_000);
  }
}

async function maybeInjectGlassHiveCapabilityBroker({
  serverName,
  toolName,
  toolArguments,
  config,
} = {}) {
  if (!isGlassHiveLaunchTool({ serverName, toolName })) {
    return toolArguments;
  }
  const args = parseToolArguments(toolArguments);
  if (!args) {
    return toolArguments;
  }
  const launchAuthorityKind = String(
    config?.configurable?.glasshive_launch_authority_kind || '',
  ).trim();
  let trustedRequestBody = config?.configurable?.requestBody || {};
  if (launchAuthorityKind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR) {
    if (args.requiresHostAccess === true || args.requires_host_access === true) {
      const error = new Error('glasshive_parallel_host_access_unavailable');
      error.code = 'glasshive_parallel_host_access_unavailable';
      error.status = 409;
      error.needsInput = true;
      throw error;
    }
    await requireIsolatedParallelPolicy({
      ownerId: config?.configurable?.user?.id || config?.configurable?.user?._id,
    });
    const selection = selectTrustedLaunchRequestBody(
      trustedRequestBody,
      args.sourceOrdinals ?? args.source_ordinals,
    );
    if (selection.error) {
      const error = new Error(selection.error);
      error.code = selection.error;
      error.status = 409;
      error.needsInput = false;
      throw error;
    }
    trustedRequestBody = selection.requestBody;
    const selectedFiles = trustedUploadedFilesFromRequestBody(trustedRequestBody);
    if (selectedFiles.length) args.uploaded_files = selectedFiles;
    else delete args.uploaded_files;
    // The model cannot select a same-uid host root. This overwrite happens before objective
    // identity registration, authorization fingerprinting, or the GlassHive transport boundary.
    args.execution_mode = 'docker';
    delete args.executionMode;
    args.bootstrap_profile = 'clean-room';
    delete args.bootstrapProfile;
    delete args.workspace_root;
    delete args.workspaceRoot;
    args.bootstrap_bundle_json = stripAutomaticParallelModelAuthority(
      normalizeBootstrapBundle(args.bootstrap_bundle_json),
    );
    delete args.requiresHostAccess;
    delete args.requires_host_access;
    delete args.sourceOrdinals;
    delete args.source_ordinals;
  }
  // Persist callback ownership and delivery targets before the MCP launch can leave this process.
  // A callback can arrive immediately, so launch must fail closed if a complete trusted turn
  // cannot be durably bound.
  const launchContext = await registerGlassHiveLaunchContext({
    user: config?.configurable?.user,
    requestBody: trustedRequestBody,
    toolName,
    toolArguments: args,
    toolCall: config?.toolCall || {},
  });
  if (!launchContext?.originRef || !launchContext?.delegationIdentity) {
    throw new Error('glasshive_launch_origin_not_bound');
  }
  const originalWasString = typeof toolArguments === 'string';
  try {
    const finalizeTrustedLaunchArgs = () => {
      const trustedLaunchArgs = attachGlassHiveTrustedLaunchMetadata(args, launchContext);
      Object.assign(args, trustedLaunchArgs);
      return originalWasString ? JSON.stringify(args) : args;
    };
    const workerMemory = String(config?.configurable?.glasshive_worker_memory || '').trim();
    // Durable mission roots are specialist executors, not additional instances of Main's persona.
    // Preserve factual context, but never project Main's request-pinned Feeling capsule into them.
    const workerFeelings = '';
    const allowedHostTools = Array.from(
      new Set(
        (config?.configurable?.glasshive_host_tools || [])
          .map((value) => String(value || '').trim())
          .filter(Boolean),
      ),
    ).sort();
    const hostToolResources = config?.configurable?.glasshive_host_tool_resources || {};
    const workerFeelingsHash = String(
      config?.configurable?.glasshive_worker_feelings_hash || '',
    ).trim();
    const configuredWorkerScope = String(
      config?.configurable?.glasshive_worker_feelings_scope || '',
    ).trim();
    const workerFeelingsScope = ['all_agents', 'conscious_agent'].includes(configuredWorkerScope)
      ? configuredWorkerScope
      : 'unknown';
    const workerFeelingRangeTelemetry = {
      rangePromptOverrideCount: Number(
        config?.configurable?.glasshive_worker_feelings_range_prompt_override_count || 0,
      ),
      activeRangePromptOverrideCount: Number(
        config?.configurable?.glasshive_worker_feelings_active_range_prompt_override_count || 0,
      ),
      activeRangePromptOverrideChars: Number(
        config?.configurable?.glasshive_worker_feelings_active_range_prompt_override_chars || 0,
      ),
    };
    const capabilityDependency = trustedCapabilityDependency(config);
    const returnWorkerContextOnly = async (reason) => {
      const requiredProtectedCapability = capabilityDependency.required;
      args.bootstrap_bundle_json = mergeWorkerContextBundle({
        existingBundle: normalizeBootstrapBundle(args.bootstrap_bundle_json),
        workerMemory,
        workerFeelings,
        brokerUnavailableReason: reason,
      });
      args.bootstrap_bundle_json.glasshive_capability_requirement = {
        version: 1,
        required: requiredProtectedCapability,
        status: 'unavailable',
        reason,
      };
      if (launchAuthorityKind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR) {
        args.bootstrap_bundle_json.viventium_launch_authority = {
          version: 1,
          kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
          execution_mode: 'docker',
        };
      }
      applyUnavailableContextBrief(args, toolName, reason);
      logWorkerFeelingPlacement({
        requestBody: config?.configurable?.requestBody,
        bundle: args.bootstrap_bundle_json,
        feelingBlock: workerFeelingBlock(workerFeelings),
        snapshotHash: workerFeelingsHash,
        scope: workerFeelingsScope,
        ...workerFeelingRangeTelemetry,
        reason,
      });
      logger.info('[VIVENTIUM][Feelings]', {
        event: 'feelings.worker.inject',
        injected: Boolean(workerFeelings),
        snapshotHash: workerFeelingsHash || null,
        toolName,
        brokerStatus: reason,
      });
      if (requiredProtectedCapability) {
        const error = new Error('glasshive_required_capability_unavailable');
        error.code = 'glasshive_required_capability_unavailable';
        error.reason = reason;
        throw error;
      }
      const result = finalizeTrustedLaunchArgs();
      await markGlassHiveLaunchDispatchReady(launchContext);
      return result;
    };
    if (!shouldInjectForTool({ serverName, toolName })) {
      return await returnWorkerContextOnly('broker_disabled');
    }
    const user = config?.configurable?.user;
    const userId = String(user?.id || user?._id || '').trim();
    if (!userId) {
      return await returnWorkerContextOnly('missing_user');
    }
    const registry = getMCPServersRegistry();
    const mcpConfig = await registry.getAllServerConfigs(userId).catch((error) => {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Failed to load MCP config for bootstrap',
        {
          message: error?.message,
        },
      );
      return null;
    });
    if (!mcpConfig && allowedHostTools.length === 0) {
      return await returnWorkerContextOnly('broker_config_unavailable');
    }
    const executionMode = executionModeForBroker(args);
    const allowedServerEntries = mcpConfig
      ? collectAllowedServerEntries({ mcpConfig, executionMode, reqUser: user })
      : [];
    const allowedServers = allowedServerEntries.map(({ serverName }) => serverName);
    if (allowedServers.length === 0 && allowedHostTools.length === 0) {
      return await returnWorkerContextOnly('no_broker_servers');
    }
    const requestBody = config?.configurable?.requestBody || {};
    const existingBundle = normalizeBootstrapBundle(args.bootstrap_bundle_json);
    const contentReadScope = shouldGrantContentReadScope(allowedServerEntries);
    const workerTurnScope = brokerTurnScope(requestBody);
    const requestContext = {
      ...workerTurnScope,
      execution_mode: executionMode,
    };
    let authorization;
    const brokerUrl = resolveBrokerUrl(executionMode);
    try {
      authorization = await createCapabilityAuthorization({
        user,
        originRef: launchContext.originRef,
        allowedServers,
        allowedHostTools,
        hostToolResources,
        contentReadScope,
        requestContext,
        executionMode,
        brokerUrl,
      });
    } catch (error) {
      logger.error('[VIVENTIUM][glasshive-capability-authorization] Launch preparation failed', {
        reason: 'authorization_prepare_failed',
        message: error?.message,
      });
      throw error;
    }
    args.bootstrap_bundle_json = mergePendingBrokerAuthorizationBundle({
      existingBundle,
      authorization,
      brokerUrl,
      allowedServers,
      allowedHostTools,
      contentReadScope,
      workerMemory,
      workerFeelings,
      launchAuthorityKind,
    });
    args.bootstrap_bundle_json.glasshive_capability_requirement = {
      version: 1,
      required: capabilityDependency.required,
      source: 'core_turn_tool_activation',
    };
    logWorkerFeelingPlacement({
      requestBody,
      bundle: args.bootstrap_bundle_json,
      feelingBlock: workerFeelingBlock(workerFeelings),
      snapshotHash: workerFeelingsHash,
      scope: workerFeelingsScope,
      ...workerFeelingRangeTelemetry,
      reason: 'injected',
    });
    logger.info('[VIVENTIUM][Feelings]', {
      event: 'feelings.worker.inject',
      injected: Boolean(workerFeelings),
      snapshotHash: workerFeelingsHash || null,
      toolName,
      brokerStatus: 'authorization_prepared',
    });
    if (capabilityDependency.required && !contentReadScope) {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Host requested connected-account content scope but reviewed policy did not grant it',
        { allowedServers },
      );
    }
    applyContextBrief(args, toolName, allowedServers, { contentReadScope, allowedHostTools });
    const result = finalizeTrustedLaunchArgs();
    await markGlassHiveLaunchDispatchReady(launchContext);
    return result;
  } catch (error) {
    try {
      await markGlassHiveLaunchPreDispatchFailed(launchContext, error);
    } catch (cleanupError) {
      logger.error('[VIVENTIUM][glasshive-binding] Failed to close pre-dispatch launch', {
        originRef: launchContext.originRef,
        code: String(cleanupError?.code || cleanupError?.name || 'launch_cleanup_failed').slice(
          0,
          120,
        ),
      });
    }
    throw error;
  }
}

/* === VIVENTIUM START ===
 * Feature: Core-provider conversation capability bundle.
 * Purpose: Reuse the existing signed capability broker for a harness selected directly as an
 * Agent provider. Only MCP servers represented by that Agent's declared tools are projected.
 * === VIVENTIUM END === */
async function buildConversationProviderBootstrapBundle({
  user,
  requestBody = {},
  allowedServerNames = [],
  allowedHostTools = [],
  hostToolResources = {},
  allowedConversationOrchestrationTools = [],
  workerMemory = '',
  capabilityDependency = {},
} = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  const declaredServers = new Set(
    (allowedServerNames || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  const declaredHostTools = Array.from(
    new Set((allowedHostTools || []).map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
  const declaredConversationOrchestrationTools = Array.from(
    new Set(
      (allowedConversationOrchestrationTools || [])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).sort();
  // Native mutations are occurrence-attested by the broker's signed prepare/commit operation
  // token. Keep this projection structural; provider/RPC ids and prompt inference never decide it.
  let authorizedConversationOrchestrationTools = declaredConversationOrchestrationTools;
  if (declaredConversationOrchestrationTools.length > 0) {
    // Bundle construction is on Main's authoring path. The startup/periodic watcher owns remote
    // readiness probes; this call only consumes its fail-closed local snapshot.
    let readiness = orchestrationReadinessSnapshot();
    if (!readiness.available && userId) {
      // Normal turns stay zero-network. On startup/staleness, use the authenticated turn owner to
      // recover once instead of silently stripping mission creation for an otherwise-ready system.
      readiness = await refreshOrchestrationReadiness({ ownerId: userId });
    }
    if (!readiness.available) {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Conversation orchestration unavailable',
        { status: orchestrationReadinessSnapshot().status },
      );
      authorizedConversationOrchestrationTools = hasTrustedKnownWork(user)
        ? declaredConversationOrchestrationTools.filter(isConversationOrchestrationControlTool)
        : [];
    }
  }
  const allProviderHostTools = Array.from(
    new Set([...declaredHostTools, ...authorizedConversationOrchestrationTools]),
  ).sort();
  const orchestrationResources = authorizedConversationOrchestrationTools.includes(
    DELEGATION_TOOL_NAME,
  )
    ? {
        [DELEGATION_TOOL_NAME]: {
          version: 1,
          request_body: requestBody,
          worker_memory: String(workerMemory || ''),
          mission_host_tools: declaredHostTools,
          mission_host_tool_resources: hostToolResources,
          capability_dependency:
            capabilityDependency &&
            typeof capabilityDependency === 'object' &&
            !Array.isArray(capabilityDependency)
              ? capabilityDependency
              : {},
        },
      }
    : {};
  const allProviderHostToolResources = {
    ...hostToolResources,
    ...orchestrationResources,
  };
  const brokerProjectionEnabled = isBrokerProjectionEnabled();
  logger.info(
    '[VIVENTIUM][glasshive-capability-broker] Building provider capability bundle ' +
      `(enabled=${brokerProjectionEnabled} user_scope=${Boolean(userId)} ` +
      `servers=${declaredServers.size} host_tools=${declaredHostTools.length} ` +
      `orchestration_tools=${authorizedConversationOrchestrationTools.length})`,
  );
  if (
    !brokerProjectionEnabled ||
    !userId ||
    (declaredServers.size === 0 && allProviderHostTools.length === 0)
  ) {
    const reason = !brokerProjectionEnabled
      ? 'broker_disabled'
      : !userId
        ? 'missing_user_scope'
        : 'no_declared_capabilities';
    logger.warn(
      `[VIVENTIUM][glasshive-capability-broker] Provider bundle unavailable before mint: ${reason}`,
    );
    return {};
  }
  // This is the execution environment of Main's provider request. Every mission launched by its
  // conversation-orchestrator facade is independently overwritten to isolated `docker` below.
  const executionMode = 'host';
  let allowedServerEntries = [];
  let projectionOmissions = [];
  if (declaredServers.size > 0) {
    const registry = getMCPServersRegistry();
    const mcpConfig = await registry.getAllServerConfigs(userId).catch((error) => {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Provider bundle MCP config unavailable',
        { message: error?.message },
      );
      return null;
    });
    if (mcpConfig) {
      const projection = collectServerProjection({
        mcpConfig,
        executionMode,
        serverNames: Array.from(declaredServers),
        reqUser: user,
      });
      allowedServerEntries = projection.allowedEntries;
      projectionOmissions = projection.omissions;
    } else {
      projectionOmissions = Array.from(declaredServers)
        .sort()
        .map((server) => ({ server, reason: 'server_registry_unavailable' }));
    }
  }
  const allowedServers = allowedServerEntries.map(({ serverName }) => serverName);
  const projectionStatus = projectionOmissions.length
    ? allowedServers.length || allProviderHostTools.length
      ? 'partial'
      : 'empty'
    : 'complete';
  const projection = {
    status: projectionStatus,
    declared_servers: Array.from(declaredServers).sort(),
    authorized_servers: allowedServers,
    omitted_servers: projectionOmissions,
    declared_host_tools: declaredHostTools,
    authorized_host_tools: allProviderHostTools,
    ...(declaredConversationOrchestrationTools.length > 0
      ? {
          declared_conversation_orchestration_tools: declaredConversationOrchestrationTools,
          conversation_orchestration_tools: authorizedConversationOrchestrationTools,
        }
      : {}),
  };
  const projectionLog = {
    event: 'glasshive.provider_capability_projection',
    status: projectionStatus,
    declaredServerCount: declaredServers.size,
    authorizedServerCount: allowedServers.length,
    omittedServerCount: projectionOmissions.length,
    declaredHostToolCount: declaredHostTools.length,
    authorizedHostToolCount: allProviderHostTools.length,
    omittedServers: projectionOmissions,
  };
  if (projectionOmissions.length) {
    logger.warn(
      `[VIVENTIUM][glasshive-capability-broker] Provider capability projection ${projectionStatus}`,
      projectionLog,
    );
  } else {
    logger.info(
      '[VIVENTIUM][glasshive-capability-broker] Provider capability projection complete',
      projectionLog,
    );
  }
  if (allowedServers.length === 0 && allProviderHostTools.length === 0) {
    return {
      glasshive_capability_projection: projection,
      conversation_provider_instructions: providerProjectionBoundary(projectionOmissions),
    };
  }
  const contentReadScope = shouldGrantContentReadScope(allowedServerEntries);
  const providerTurnScope = brokerTurnScope(requestBody);
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      allowedServers,
      allowedHostTools: allProviderHostTools,
      hostToolResources: allProviderHostToolResources,
      authorityKind:
        authorizedConversationOrchestrationTools.length > 0
          ? BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR
          : BROKER_AUTHORITY_KINDS.MISSION_WORKER,
      allowDynamicPolicyServers: false,
      executionMode,
      requestContext: {
        ...providerTurnScope,
        execution_mode: executionMode,
      },
      ttlSeconds: intEnv('VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS', 10 * 60),
      scopes: { content_read: contentReadScope },
    });
    await persistBrokerGrantResources(mintedGrant);
  } catch (error) {
    logger.warn(
      `[VIVENTIUM][glasshive-capability-broker] Provider bundle grant unavailable: ${error?.message || error}`,
    );
    return {};
  }
  const bundle = mergeBrokerBundle({
    existingBundle: {},
    brokerUrl: resolveBrokerUrl(executionMode),
    grantToken: mintedGrant.token,
    grantPayload: mintedGrant.payload,
    allowedServers,
    allowedHostTools: allProviderHostTools,
    contentReadScope,
  });
  // Conversation-mode workers deliberately do not rewrite the user's workspace instruction
  // files. Carry the capability routing contract separately so LibreChat can place it in the
  // provider's real developer-authority message for this turn.
  bundle.conversation_provider_instructions = brokerContextBrief(allowedServers, {
    contentReadScope,
    allowedHostTools: allProviderHostTools,
  });
  bundle.glasshive_capability_projection = projection;
  bundle.conversation_provider_instructions = [
    bundle.conversation_provider_instructions,
    providerProjectionBoundary(projectionOmissions),
  ]
    .filter(Boolean)
    .join('\n\n');
  return bundle;
}

module.exports = {
  GLASSHIVE_LAUNCH_TOOLS,
  appendTextBounded,
  brokerContextBrief,
  buildConversationProviderBootstrapBundle,
  configuredGlassHiveServerNames,
  grantTtlSecondsForTool,
  maybeInjectGlassHiveCapabilityBroker,
  mergeBrokerBundle,
  mergeWorkerContextBundle,
  providerProjectionBoundary,
  isGlassHiveLaunchTool,
  executionModeForBroker,
  resolveBrokerUrl,
  shouldInjectForTool,
  trustedCapabilityDependency,
  stripReservedBrokerControls,
};
