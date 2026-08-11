/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker bootstrap injection
 * Purpose:
 * - Add one broker MCP to GlassHive worker bootstrap bundles without relying on the chat model
 *   to predict which declared capability should satisfy the request.
 * - Keep the worker's prompt context compact while machine-readable MCP setup lives in bootstrap.
 * === VIVENTIUM END === */

/* === VIVENTIUM START === Scheduled/direct exact-scope grant identifiers. === */
const crypto = require('crypto');
/* === VIVENTIUM END === */
const { logger } = require('@librechat/data-schemas');
const { getMCPServersRegistry } = require('~/config');
/* === VIVENTIUM START === Fire-time user-scoped OAuth readiness. === */
const { inspectStoredOAuthCredentialState } = require('~/server/services/Tools/mcp');
/* === VIVENTIUM END === */
const {
  collectAllowedServerEntries,
  collectServerProjection,
  isBrokerProjectionEnabled,
  shouldGrantContentReadScope,
} = require('./GlassHiveCapabilityPolicyService');
/* === VIVENTIUM START === Scheduled/direct mint and exact revoke boundary. === */
const {
  mintBrokerGrant,
  persistBrokerGrantResources,
  revokeBrokerGrant,
  resolveBrokerTenantId,
} = require('./GlassHiveCapabilityBrokerAuth');
/* === VIVENTIUM END === */
const { pinFeelingCapsuleLast } = require('./feelingPromptTail');
const { logFeelingsEvent, summarizeFeelingCapsulePlacement } = require('./feelingsTelemetry');

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
  let host = 'host.docker.internal';
  if (mode === 'host') {
    const configuredHostIsRoutable =
      configuredHost &&
      configuredHost !== 'localhost' &&
      configuredHost !== '0.0.0.0' &&
      configuredHost !== '::';
    host = configuredHostIsRoutable ? configuredHost : '127.0.0.1';
  }
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

function grantRenewableTtlSecondsForTool(toolName, args = {}) {
  const base = grantTtlSecondsForTool(toolName, args);
  const defaultRenewable = intEnv(
    'VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RENEWABLE_TTL_SECONDS',
    60 * 60,
  );
  const maxRenewable = intEnv(
    'VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS',
    24 * 60 * 60,
  );
  return Math.max(base, Math.min(Math.max(base, defaultRenewable), maxRenewable));
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

/* === VIVENTIUM START ===
 * Feature: Fire-time scheduled and direct worker capability grants.
 * Purpose: Re-evaluate the authenticated user's current reviewed MCP policy and OAuth readiness
 * when a schedule fires; no broker token is persisted in Scheduling Cortex.
 */
class ScheduledGlassHiveCapabilityError extends Error {
  constructor(message, { code, status = 400, serverNames = [] } = {}) {
    super(message);
    this.name = 'ScheduledGlassHiveCapabilityError';
    this.code = String(code || 'scheduled_capability_error');
    this.status = Number(status) || 400;
    this.serverNames = Array.from(
      new Set((serverNames || []).map((value) => String(value || '').trim()).filter(Boolean)),
    ).sort();
  }
}

function normalizeScheduleScope(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new ScheduledGlassHiveCapabilityError(`${fieldName} is invalid`, {
      code: `invalid_${fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      status: 400,
    });
  }
  return normalized;
}

function scheduledGrantId({ userId, scheduleId, scheduledRunId, executionMode }) {
  const tenantId = resolveBrokerTenantId();
  const digest = crypto
    .createHash('sha256')
    .update(
      [tenantId, userId, scheduleId, scheduledRunId, executionMode].map(String).join('\u0000'),
    )
    .digest('hex');
  return `ghcb_sched_${digest}`;
}

function normalizeRequiredServerNames(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(values.map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
}

class DirectGlassHiveCapabilityError extends Error {
  constructor(message, { code, status = 400, serverNames = [] } = {}) {
    super(message);
    this.name = 'DirectGlassHiveCapabilityError';
    this.code = String(code || 'direct_capability_error');
    this.status = Number(status) || 400;
    this.serverNames = normalizeRequiredServerNames(serverNames);
  }
}

function normalizeDirectScope(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200 || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new DirectGlassHiveCapabilityError(`${fieldName} is invalid`, {
      code: `invalid_${fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      status: 400,
    });
  }
  return normalized;
}

function directGrantId({ userId, workerId, runId, executionMode }) {
  const tenantId = resolveBrokerTenantId();
  const digest = crypto
    .createHash('sha256')
    .update([tenantId, userId, workerId, runId, executionMode].map(String).join('\u0000'))
    .digest('hex');
  return `ghcb_direct_${digest}`;
}

async function directCapabilityReadiness({ user, executionMode = 'docker' } = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    throw new DirectGlassHiveCapabilityError('GlassHive capability owner is not mapped', {
      code: 'owner_binding_required',
      status: 409,
    });
  }
  const cleanExecutionMode = normalizeExecutionMode(executionMode);
  if (!cleanExecutionMode) {
    throw new DirectGlassHiveCapabilityError('executionMode must be host or docker', {
      code: 'invalid_execution_mode',
      status: 400,
    });
  }
  if (!isBrokerProjectionEnabled()) {
    return { status: 'broker_unavailable', reason: 'broker_disabled', connections: [] };
  }

  let mcpConfig;
  try {
    mcpConfig = await getMCPServersRegistry().getAllServerConfigs(userId);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Direct readiness unavailable', {
      userId,
      message: error?.message,
    });
    return { status: 'broker_unavailable', reason: 'registry_unavailable', connections: [] };
  }
  const reviewedEntries = collectAllowedServerEntries({
    mcpConfig: mcpConfig || {},
    executionMode: cleanExecutionMode,
  });
  const connections = [];
  const readyEntries = [];
  for (const entry of reviewedEntries) {
    const requiresOAuth = Boolean(
      entry?.serverConfig?.requiresOAuth || entry?.serverConfig?.oauthMetadata,
    );
    let status = 'ready';
    if (requiresOAuth) {
      try {
        const credential = await inspectStoredOAuthCredentialState(userId, entry.serverName);
        status = credential?.status === 'credential_present' ? 'ready' : 'action_required';
      } catch (error) {
        logger.warn('[VIVENTIUM][glasshive-capability-broker] Direct OAuth readiness failed', {
          userId,
          serverName: entry.serverName,
          message: error?.message,
        });
        status = 'action_required';
      }
    }
    if (status === 'ready') {
      readyEntries.push(entry);
    }
    connections.push({
      connection_id: `librechat:${entry.serverName}`,
      label: String(entry?.serverConfig?.title || entry?.serverConfig?.name || entry.serverName),
      kind: String(entry.serverName),
      adapter: 'librechat_capability_broker',
      status,
    });
  }
  let status = 'ready';
  if (connections.length === 0) {
    status = 'no_connections';
  } else if (connections.some((item) => item.status === 'action_required')) {
    status = readyEntries.length ? 'degraded' : 'action_required';
  }
  return {
    status,
    reason: status === 'action_required' ? 'connected_account_action_required' : '',
    connections,
    readyEntries,
  };
}

async function buildDirectGlassHiveCapabilityBundle({ user, workerId, runId, executionMode } = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  const cleanWorkerId = normalizeDirectScope(workerId, 'workerId');
  const cleanRunId = normalizeDirectScope(runId, 'runId');
  const cleanExecutionMode = normalizeExecutionMode(executionMode);
  if (!cleanExecutionMode) {
    throw new DirectGlassHiveCapabilityError('executionMode must be host or docker', {
      code: 'invalid_execution_mode',
      status: 400,
    });
  }
  const readiness = await directCapabilityReadiness({ user, executionMode: cleanExecutionMode });
  if (readiness.status === 'broker_unavailable') {
    throw new DirectGlassHiveCapabilityError('Connected capability broker is unavailable', {
      code: readiness.reason || 'broker_unavailable',
      status: 503,
    });
  }
  const readyEntries = readiness.readyEntries || [];
  const allowedServers = readyEntries.map(({ serverName }) => serverName);
  if (!allowedServers.length) {
    const reason =
      readiness.status === 'action_required'
        ? 'connected_account_action_required'
        : 'no_reviewed_capabilities';
    return {
      bootstrapBundle: degradedConversationCapabilityBundle(reason),
      grantRef: null,
      capabilityStatus: {
        status: readiness.status,
        reason,
        connections: readiness.connections,
      },
    };
  }
  const contentReadScope = shouldGrantContentReadScope(readyEntries);
  const grantId = directGrantId({
    userId,
    workerId: cleanWorkerId,
    runId: cleanRunId,
    executionMode: cleanExecutionMode,
  });
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      grantId,
      allowedServers,
      eagerServers: allowedServers,
      deferredServers: [],
      executionMode: cleanExecutionMode,
      requestContext: {
        worker_id: cleanWorkerId,
        run_id: cleanRunId,
        execution_mode: cleanExecutionMode,
      },
      ttlSeconds: intEnv('VIVENTIUM_GLASSHIVE_DIRECT_BROKER_TTL_SECONDS', 10 * 60),
      renewableTtlSeconds: intEnv(
        'VIVENTIUM_GLASSHIVE_DIRECT_BROKER_RENEWABLE_TTL_SECONDS',
        24 * 60 * 60,
      ),
      allowDynamicPolicyServers: false,
      scopes: { content_read: contentReadScope },
    });
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Direct grant mint failed', {
      userId,
      message: error?.message,
    });
    throw new DirectGlassHiveCapabilityError('Connected capability grant is unavailable', {
      code: 'grant_unavailable',
      status: 503,
    });
  }
  return {
    bootstrapBundle: mergeBrokerBundle({
      existingBundle: {},
      brokerUrl: resolveBrokerUrl(cleanExecutionMode),
      grantToken: mintedGrant.token,
      grantPayload: mintedGrant.payload,
      allowedServers,
      eagerServers: allowedServers,
      deferredServers: [],
      contentReadScope,
    }),
    grantRef: {
      grant_id: mintedGrant.payload.grant_id,
      tenant_id: mintedGrant.payload.tenant_id,
      user_id: userId,
      worker_id: cleanWorkerId,
      run_id: cleanRunId,
      execution_mode: cleanExecutionMode,
      exp: mintedGrant.payload.exp,
      renewable_until: mintedGrant.payload.renewable_until,
    },
    capabilityStatus: {
      status: readiness.status,
      connections: readiness.connections,
    },
  };
}

async function revokeDirectGlassHiveCapabilityGrant({
  user,
  workerId,
  runId,
  executionMode,
  grantId,
  renewableUntil,
} = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    throw new DirectGlassHiveCapabilityError('GlassHive capability owner is not mapped', {
      code: 'owner_binding_required',
      status: 409,
    });
  }
  const cleanWorkerId = normalizeDirectScope(workerId, 'workerId');
  const cleanRunId = normalizeDirectScope(runId, 'runId');
  const cleanExecutionMode = normalizeExecutionMode(executionMode);
  if (!cleanExecutionMode) {
    throw new DirectGlassHiveCapabilityError('executionMode must be host or docker', {
      code: 'invalid_execution_mode',
      status: 400,
    });
  }
  const expectedGrantId = directGrantId({
    userId,
    workerId: cleanWorkerId,
    runId: cleanRunId,
    executionMode: cleanExecutionMode,
  });
  if (String(grantId || '').trim() && String(grantId).trim() !== expectedGrantId) {
    throw new DirectGlassHiveCapabilityError('Direct capability revoke scope mismatch', {
      code: 'grant_scope_mismatch',
      status: 409,
    });
  }
  return revokeBrokerGrant({
    grant_id: expectedGrantId,
    renewable_until: Number(renewableUntil) || Math.floor(Date.now() / 1000) + 24 * 60 * 60,
  });
}

async function buildScheduledGlassHiveCapabilityBundle({
  user,
  scheduleId,
  scheduledRunId,
  executionMode,
  requiredServerNames = [],
} = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    throw new ScheduledGlassHiveCapabilityError('Scheduled capability grant requires a user', {
      code: 'user_scope_unavailable',
      status: 401,
    });
  }
  const cleanScheduleId = normalizeScheduleScope(scheduleId, 'scheduleId');
  const cleanScheduledRunId = normalizeScheduleScope(scheduledRunId, 'scheduledRunId');
  const cleanExecutionMode = normalizeExecutionMode(executionMode);
  if (!cleanExecutionMode) {
    throw new ScheduledGlassHiveCapabilityError('executionMode must be host or docker', {
      code: 'invalid_execution_mode',
      status: 400,
    });
  }
  const required = normalizeRequiredServerNames(requiredServerNames);
  if (!isBrokerProjectionEnabled()) {
    if (!required.length) {
      return {
        bootstrapBundle: degradedConversationCapabilityBundle('broker_disabled'),
        grantRef: null,
        capabilityStatus: { status: 'degraded', reason: 'broker_disabled' },
      };
    }
    throw new ScheduledGlassHiveCapabilityError('Connected capability broker is disabled', {
      code: 'broker_disabled',
      status: 503,
    });
  }

  let registry;
  let mcpConfig;
  try {
    registry = getMCPServersRegistry();
    mcpConfig = await registry.getAllServerConfigs(userId);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Scheduled policy refresh failed', {
      userId,
      message: error?.message,
    });
    if (!required.length) {
      return {
        bootstrapBundle: degradedConversationCapabilityBundle('registry_unavailable'),
        grantRef: null,
        capabilityStatus: { status: 'degraded', reason: 'registry_unavailable' },
      };
    }
    throw new ScheduledGlassHiveCapabilityError(
      'Current connected capability policy is unavailable',
      {
        code: 'registry_unavailable',
        status: 503,
      },
    );
  }
  const reviewedEntries = collectAllowedServerEntries({
    mcpConfig: mcpConfig || {},
    executionMode: cleanExecutionMode,
  });
  const reviewedByName = new Map(
    reviewedEntries.map((entry) => [String(entry.serverName || ''), entry]),
  );
  const unauthorizedRequired = required.filter((serverName) => !reviewedByName.has(serverName));
  if (unauthorizedRequired.length) {
    throw new ScheduledGlassHiveCapabilityError(
      'A required connected capability is no longer authorized for this worker',
      {
        code: 'connected_capability_not_authorized',
        status: 403,
        serverNames: unauthorizedRequired,
      },
    );
  }

  const candidates = required.length
    ? required.map((serverName) => reviewedByName.get(serverName)).filter(Boolean)
    : reviewedEntries;
  const availableEntries = [];
  const unavailableOAuthServers = [];
  for (const entry of candidates) {
    const requiresOAuth = Boolean(
      entry?.serverConfig?.requiresOAuth || entry?.serverConfig?.oauthMetadata,
    );
    if (!requiresOAuth) {
      availableEntries.push(entry);
      continue;
    }
    let credentialState;
    try {
      credentialState = await inspectStoredOAuthCredentialState(userId, entry.serverName);
    } catch (error) {
      logger.warn('[VIVENTIUM][glasshive-capability-broker] Scheduled OAuth readiness failed', {
        userId,
        serverName: entry.serverName,
        message: error?.message,
      });
      credentialState = { status: 'unreadable_credential' };
    }
    if (credentialState?.status === 'credential_present') {
      availableEntries.push(entry);
    } else {
      unavailableOAuthServers.push(entry.serverName);
    }
  }
  const unavailableRequired = unavailableOAuthServers.filter((serverName) =>
    required.includes(serverName),
  );
  if (unavailableRequired.length) {
    throw new ScheduledGlassHiveCapabilityError(
      'A required connected account must be reconnected before this schedule can run',
      {
        code: 'connected_account_action_required',
        status: 409,
        serverNames: unavailableRequired,
      },
    );
  }

  const allowedServers = availableEntries.map(({ serverName }) => serverName);
  if (!allowedServers.length) {
    const reason = unavailableOAuthServers.length
      ? 'connected_accounts_unavailable'
      : 'no_reviewed_capabilities';
    return {
      bootstrapBundle: degradedConversationCapabilityBundle(reason),
      grantRef: null,
      capabilityStatus: {
        status: 'degraded',
        reason,
        unavailableServerNames: unavailableOAuthServers.sort(),
      },
    };
  }
  const contentReadScope = shouldGrantContentReadScope(availableEntries);
  const grantId = scheduledGrantId({
    userId,
    scheduleId: cleanScheduleId,
    scheduledRunId: cleanScheduledRunId,
    executionMode: cleanExecutionMode,
  });
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      grantId,
      allowedServers,
      eagerServers: allowedServers,
      deferredServers: [],
      executionMode: cleanExecutionMode,
      requestContext: {
        schedule_id: cleanScheduleId,
        run_id: cleanScheduledRunId,
        execution_mode: cleanExecutionMode,
      },
      ttlSeconds: intEnv('VIVENTIUM_GLASSHIVE_SCHEDULED_BROKER_TTL_SECONDS', 10 * 60),
      renewableTtlSeconds: intEnv(
        'VIVENTIUM_GLASSHIVE_SCHEDULED_BROKER_RENEWABLE_TTL_SECONDS',
        60 * 60,
      ),
      allowDynamicPolicyServers: false,
      scopes: { content_read: contentReadScope },
    });
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Scheduled grant mint failed', {
      userId,
      message: error?.message,
    });
    if (!required.length) {
      return {
        bootstrapBundle: degradedConversationCapabilityBundle('grant_unavailable'),
        grantRef: null,
        capabilityStatus: { status: 'degraded', reason: 'grant_unavailable' },
      };
    }
    throw new ScheduledGlassHiveCapabilityError(
      'Scheduled connected capability authorization is unavailable',
      {
        code: 'grant_unavailable',
        status: 503,
        serverNames: required,
      },
    );
  }
  return {
    bootstrapBundle: mergeBrokerBundle({
      existingBundle: {},
      brokerUrl: resolveBrokerUrl(cleanExecutionMode),
      grantToken: mintedGrant.token,
      grantPayload: mintedGrant.payload,
      allowedServers,
      eagerServers: allowedServers,
      deferredServers: [],
      contentReadScope,
    }),
    grantRef: {
      grant_id: mintedGrant.payload.grant_id,
      tenant_id: mintedGrant.payload.tenant_id,
      user_id: userId,
      schedule_id: cleanScheduleId,
      run_id: cleanScheduledRunId,
      execution_mode: cleanExecutionMode,
      exp: mintedGrant.payload.exp,
      renewable_until: mintedGrant.payload.renewable_until,
    },
    capabilityStatus: {
      status: unavailableOAuthServers.length ? 'degraded' : 'ready',
      unavailableServerNames: unavailableOAuthServers.sort(),
    },
  };
}

async function revokeScheduledGlassHiveCapabilityGrant({
  user,
  scheduleId,
  scheduledRunId,
  executionMode,
  grantId,
  renewableUntil,
} = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    throw new ScheduledGlassHiveCapabilityError('Scheduled capability revoke requires a user', {
      code: 'user_scope_unavailable',
      status: 401,
    });
  }
  const cleanScheduleId = normalizeScheduleScope(scheduleId, 'scheduleId');
  const cleanScheduledRunId = normalizeScheduleScope(scheduledRunId, 'scheduledRunId');
  const cleanExecutionMode = normalizeExecutionMode(executionMode);
  if (!cleanExecutionMode) {
    throw new ScheduledGlassHiveCapabilityError('executionMode must be host or docker', {
      code: 'invalid_execution_mode',
      status: 400,
    });
  }
  const expectedGrantId = scheduledGrantId({
    userId,
    scheduleId: cleanScheduleId,
    scheduledRunId: cleanScheduledRunId,
    executionMode: cleanExecutionMode,
  });
  const providedGrantId = String(grantId || '').trim();
  if (providedGrantId && providedGrantId !== expectedGrantId) {
    throw new ScheduledGlassHiveCapabilityError(
      'Scheduled capability revoke grant scope mismatch',
      {
        code: 'grant_scope_mismatch',
        status: 409,
      },
    );
  }
  const originalRenewableUntil = Number(renewableUntil);
  const fallbackRevocationTtlSeconds = intEnv(
    'VIVENTIUM_GLASSHIVE_SCHEDULED_BROKER_REVOCATION_TTL_SECONDS',
    24 * 60 * 60,
  );
  return revokeBrokerGrant({
    grant_id: expectedGrantId,
    renewable_until: Number.isFinite(originalRenewableUntil)
      ? originalRenewableUntil
      : Math.floor(Date.now() / 1000) + fallbackRevocationTtlSeconds,
  });
}
/* === VIVENTIUM END === */

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function brokerContextBrief(
  allowedServers,
  { contentReadScope = false, deferredServers = [], allowedHostTools = [] } = {},
) {
  const serverList = allowedServers.length ? allowedServers.join(', ') : 'none';
  const deferredServerList = deferredServers.length ? deferredServers.join(', ') : 'none';
  const hostToolList = allowedHostTools.length ? allowedHostTools.join(', ') : 'none';
  return [
    'GlassHive connected capability broker [v2]:',
    '- A broker MCP named `glasshive-user-capabilities` is available in this workspace when the local MCP client loads project MCP config.',
    '- The broker catalog exposes exactly the current user/run authorized host capabilities. Treat the catalog as capability truth; do not infer availability from this prose.',
    '- Prefer callable broker tools for live connected-service facts and actions when they can satisfy the task. Use browser or computer UI when those tools are missing, unavailable, auth-blocked, explicitly required, or when visual/manual QA is genuinely the better route.',
    '- If a non-broker host connector is also available, including a built-in Codex app connector, prefer the brokered `glasshive-user-capabilities` tool when it covers the same connected-account provider. Use non-broker connectors only after the broker path is missing, unavailable, auth-blocked, or explicitly required.',
    '- Do not treat memory, recall, or prior chat text as live connected-service evidence. Ask the broker when current provider truth is needed.',
    `- Content-read broker scope for this run is ${contentReadScope ? 'authorized by reviewed host policy' : 'not authorized'}. If a needed content read is blocked by broker policy, report that blocker instead of self-authorizing with worker-authored flags.`,
    `- Authorized capability servers for this run: ${serverList}. If a needed server is missing, report the broker omission/auth limitation rather than fabricating.`,
    `- Deferred capability servers (discover only when the task needs them): ${deferredServerList}. Use \`capability_describe\` for one deferred server before invoking its underlying tool; do not probe deferred servers during unrelated chat.`,
    `- Authorized host tools for this run: ${hostToolList}. These are the same resolved host capabilities available to the main Agent; absence means the host did not resolve or authorize them for this turn.`,
    '- Host-tool resources are virtual service evidence, not workspace paths. Never pass their labels to shell/filesystem tools or search for copies by filename. When an authorized host tool covers the needed evidence, call it before any filesystem discovery; resource labels are not proof of mounted files.',
  ].join('\n');
}

function degradedConversationCapabilityBundle(reason) {
  const safeReason = String(reason || 'unavailable').trim() || 'unavailable';
  const instruction = [
    'GlassHive connected capability broker is degraded for this turn.',
    `- Structured reason: ${safeReason}.`,
    '- Continue with unrelated work normally. If the request needs a connected capability, report this exact connection blocker rather than substituting memory or another account.',
  ].join('\n');
  return {
    glasshive_capability_status: { status: 'degraded', reason: safeReason },
    agents_md: instruction,
    claude_md: instruction,
    codex_md: instruction,
  };
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

function brokerUnavailableBrief(reason) {
  const safeReason = String(reason || 'unavailable').trim() || 'unavailable';
  return [
    `GlassHive host capability broker is unavailable for this run (${safeReason}).`,
    'Do not claim that brokered host capabilities are available for this run.',
    'Continue with unrelated work normally. If the request needs a connected capability, report this exact connection blocker rather than substituting memory or another account.',
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

function contentReadIntentForArgs(args = {}) {
  return (
    truthyFlag(args.connected_account_content_intent) ||
    truthyFlag(args.connectedAccountContentIntent) ||
    truthyFlag(args.content_read_intent) ||
    truthyFlag(args.contentReadIntent)
  );
}

function mergeWorkerContextBundle({
  existingBundle,
  workerMemory = '',
  workerFeelings = '',
  brokerUnavailableReason = '',
}) {
  const bundle = { ...existingBundle };
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
  eagerServers = allowedServers,
  deferredServers = [],
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
    allowed_servers: allowedServers,
    eager_servers: eagerServers,
    deferred_servers: deferredServers,
    allowed_host_tools: allowedHostTools,
    scopes: grantPayload.scopes || {},
    projection: deferredServers.length
      ? 'signed_eager_and_deferred_policy_gated'
      : 'all_user_enabled_policy_gated',
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
  const instruction = brokerContextBrief(allowedServers, {
    contentReadScope,
    deferredServers,
    allowedHostTools,
  });
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
    args.instruction = appendText(args.instruction, brief);
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
    args.instruction = appendText(args.instruction, brief);
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
  const workerMemory = String(config?.configurable?.glasshive_worker_memory || '').trim();
  const workerFeelings = String(config?.configurable?.glasshive_worker_feelings || '').trim();
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
  const originalWasString = typeof toolArguments === 'string';
  const returnWorkerContextOnly = (reason) => {
    args.bootstrap_bundle_json = mergeWorkerContextBundle({
      existingBundle: normalizeBootstrapBundle(args.bootstrap_bundle_json),
      workerMemory,
      workerFeelings,
      brokerUnavailableReason: reason,
    });
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
    return originalWasString ? JSON.stringify(args) : args;
  };
  if (!shouldInjectForTool({ serverName, toolName })) {
    return returnWorkerContextOnly('broker_disabled');
  }
  const user = config?.configurable?.user;
  const userId = String(user?.id || user?._id || '').trim();
  if (!userId) {
    return returnWorkerContextOnly('missing_user');
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
    return returnWorkerContextOnly('broker_config_unavailable');
  }
  const executionMode = executionModeForBroker(args);
  const allowedServerEntries = mcpConfig
    ? collectAllowedServerEntries({ mcpConfig, executionMode, reqUser: user })
    : [];
  const allowedServers = allowedServerEntries.map(({ serverName }) => serverName);
  if (allowedServers.length === 0 && allowedHostTools.length === 0) {
    return returnWorkerContextOnly('no_broker_servers');
  }
  const requestBody = config?.configurable?.requestBody || {};
  const existingBundle = normalizeBootstrapBundle(args.bootstrap_bundle_json);
  const hostContentReadIntent = contentReadIntentForArgs(args);
  const contentReadScope = shouldGrantContentReadScope(allowedServerEntries);
  const workerTurnScope = brokerTurnScope(requestBody);
  const requestContext = {
    ...workerTurnScope,
    execution_mode: executionMode,
  };
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      allowedServers,
      allowedHostTools,
      hostToolResources,
      allowDynamicPolicyServers: false,
      requestContext,
      executionMode,
      ttlSeconds: grantTtlSecondsForTool(toolName, args),
      scopes: { content_read: contentReadScope },
    });
    await persistBrokerGrantResources(mintedGrant);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Skipping bootstrap injection', {
      reason: 'grant_mint_failed',
      message: error?.message,
    });
    return returnWorkerContextOnly('grant_mint_failed');
  }
  const { token, payload } = mintedGrant;
  args.bootstrap_bundle_json = mergeBrokerBundle({
    existingBundle,
    brokerUrl: resolveBrokerUrl(executionMode),
    grantToken: token,
    grantPayload: payload,
    allowedServers,
    allowedHostTools,
    contentReadScope,
    workerMemory,
    workerFeelings,
  });
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
    brokerStatus: 'injected',
  });
  if (hostContentReadIntent && !contentReadScope) {
    logger.warn(
      '[VIVENTIUM][glasshive-capability-broker] Host requested connected-account content scope but reviewed policy did not grant it',
      { allowedServers },
    );
  }
  applyContextBrief(args, toolName, allowedServers, { contentReadScope, allowedHostTools });
  return typeof toolArguments === 'string' ? JSON.stringify(args) : args;
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
  deferredServerNames = [],
  excludedServerNames = [],
  allowedHostTools = [],
  hostToolResources = {},
  capabilityResolutionStatus = '',
} = {}) {
  const userId = String(user?.id || user?._id || '').trim();
  const declaredServers = new Set(
    (allowedServerNames || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  const declaredDeferredServers = new Set(
    (deferredServerNames || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  const excludedServers = new Set(
    (excludedServerNames || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  const normalizedHostTools = Array.from(
    new Set((allowedHostTools || []).map((value) => String(value || '').trim()).filter(Boolean)),
  ).sort();
  const hasRequestedCapabilities =
    declaredServers.size > 0 || declaredDeferredServers.size > 0 || normalizedHostTools.length > 0;
  if (!hasRequestedCapabilities) {
    return capabilityResolutionStatus
      ? degradedConversationCapabilityBundle(capabilityResolutionStatus)
      : {};
  }
  if (!isBrokerProjectionEnabled() || !userId) {
    return degradedConversationCapabilityBundle(
      !userId ? 'user_scope_unavailable' : 'broker_disabled',
    );
  }
  let mcpConfig = {};
  if (declaredServers.size > 0 || declaredDeferredServers.size > 0) {
    const registry = getMCPServersRegistry();
    mcpConfig = await registry.getAllServerConfigs(userId).catch((error) => {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Provider bundle MCP config unavailable',
        {
          message: error?.message,
        },
      );
      return null;
    });
    if (!mcpConfig) {
      return degradedConversationCapabilityBundle('registry_unavailable');
    }
  }
  const executionMode = 'host';
  /* === VIVENTIUM START ===
   * Feature: Deferred connected-account projection.
   * Purpose: Resolve both scopes through current reviewed policy, but preserve which servers may
   * be discovered during initial tools/list versus only after an explicit helper request.
   */
  const reviewedEntries = collectAllowedServerEntries({ mcpConfig, executionMode, reqUser: user });
  const allowedServerEntries = reviewedEntries.filter(({ serverName }) => {
    if (excludedServers.has(serverName)) {
      return false;
    }
    return declaredServers.has(serverName) || declaredDeferredServers.has(serverName);
  });
  const allowedServers = allowedServerEntries.map(({ serverName }) => serverName);
  const eagerServers = allowedServers.filter((serverName) => declaredServers.has(serverName));
  const deferredServers = allowedServers.filter(
    (serverName) => !declaredServers.has(serverName) && declaredDeferredServers.has(serverName),
  );
  if (allowedServers.length === 0 && normalizedHostTools.length === 0) {
    return degradedConversationCapabilityBundle('no_reviewed_capabilities');
  }
  const contentReadScope = shouldGrantContentReadScope(allowedServerEntries);
  let mintedGrant;
  try {
    mintedGrant = mintBrokerGrant({
      user,
      allowedServers,
      eagerServers,
      deferredServers,
      allowedHostTools: normalizedHostTools,
      hostToolResources,
      executionMode,
      requestContext: { ...brokerTurnScope(requestBody), execution_mode: executionMode },
      ttlSeconds: intEnv('VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS', 60 * 60),
      renewableTtlSeconds: intEnv(
        'VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_RENEWABLE_TTL_SECONDS',
        24 * 60 * 60,
      ),
      // The signed allowlist is complete, but ordinary catalog construction touches only eager
      // Agent-declared servers. Servers owned by an explicit Agent handoff remain dormant until
      // the model describes or invokes one, so unrelated reviewed MCPs never become implicit grants.
      allowDynamicPolicyServers: false,
      scopes: { content_read: contentReadScope },
    });
    await persistBrokerGrantResources(mintedGrant);
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Provider bundle grant unavailable', {
      message: error?.message,
    });
    return degradedConversationCapabilityBundle('grant_unavailable');
  }
  const bundle = mergeBrokerBundle({
    existingBundle: {},
    brokerUrl: resolveBrokerUrl(executionMode),
    grantToken: mintedGrant.token,
    grantPayload: mintedGrant.payload,
    allowedServers,
    eagerServers,
    deferredServers,
    allowedHostTools: normalizedHostTools,
    contentReadScope,
  });
  if (!capabilityResolutionStatus) {
    return bundle;
  }
  const degraded = degradedConversationCapabilityBundle(capabilityResolutionStatus);
  return {
    ...bundle,
    glasshive_capability_status: degraded.glasshive_capability_status,
    ...Object.fromEntries(
      WORKER_INSTRUCTION_FIELDS.map((field) => [field, appendText(bundle[field], degraded[field])]),
    ),
  };
  /* === VIVENTIUM END === */
}

/* === VIVENTIUM START === Capability-bootstrap public export contract. === */
module.exports = {
  DirectGlassHiveCapabilityError,
  GLASSHIVE_LAUNCH_TOOLS,
  ScheduledGlassHiveCapabilityError,
  brokerContextBrief,
  buildDirectGlassHiveCapabilityBundle,
  buildConversationProviderBootstrapBundle,
  buildScheduledGlassHiveCapabilityBundle,
  configuredGlassHiveServerNames,
  contentReadIntentForArgs,
  grantTtlSecondsForTool,
  grantRenewableTtlSecondsForTool,
  directCapabilityReadiness,
  directGrantId,
  maybeInjectGlassHiveCapabilityBroker,
  mergeBrokerBundle,
  mergeWorkerContextBundle,
  providerProjectionBoundary,
  isGlassHiveLaunchTool,
  executionModeForBroker,
  resolveBrokerUrl,
  revokeDirectGlassHiveCapabilityGrant,
  revokeScheduledGlassHiveCapabilityGrant,
  scheduledGrantId,
  shouldInjectForTool,
};
/* === VIVENTIUM END === */
