const {
  backgroundWorkerResources,
  resolveBackgroundWorkerRoute,
  mainDelegationJsonSchema,
} = require('@librechat/api');
/* === VIVENTIUM START ===
 * Feature: GlassHive capability broker service
 * Purpose:
 * - Re-export reviewed LibreChat MCP tools to GlassHive workers through one broker MCP surface.
 * - Invoke underlying MCP tools as the authenticated LibreChat user without exposing provider tokens.
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { loadWebSearchAuth, reportCortexHostToolResult } = require('@librechat/api');
const {
  audioTranscriptionDefinition,
  transcribeAttachedAudio,
  transcriptionAttachmentReferences,
} = require('@librechat/api');
const { getFiles } = require('~/models');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPManager, getMCPServersRegistry, getFlowStateManager } = require('~/config');
const { findToken, createToken, updateToken, deleteToken, getUserById } = require('~/models');
const { getLogStores } = require('~/cache');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const {
  createFileSearchTool,
  fileSearchJsonSchema,
} = require('~/app/clients/tools/util/fileSearch');
const { createViventiumSearchTool } = require('~/app/clients/tools/util/viventiumSearchTool');
const {
  buildMcpOAuthRecovery,
  inspectStoredOAuthCredentialState,
  reinitMCPServer,
} = require('~/server/services/Tools/mcp');
const {
  auditSafeToolSummary,
  collisionSafeBrokerToolName,
  collectAllowedServers,
  evaluateToolCallPolicy,
  getPolicy,
  helperToolDefinitions,
  isTrustedServerConfig,
  logOmission,
  mcpToolAnnotations,
} = require('./GlassHiveCapabilityPolicyService');
const {
  BROKER_AUTHORITY_KINDS,
  grantReplayTtlMs,
  rememberInvocation,
  verifyWriteConfirmation,
} = require('./GlassHiveCapabilityBrokerAuth');
const {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_LIST_DESCRIPTION,
  ACTIVE_WORK_LIST_JSON_SCHEMA,
  DELEGATION_TOOL_NAME,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  canonicalConversationOrchestrationArguments,
  isConversationOrchestrationMutationTool,
  isConversationOrchestrationTool,
} = require('./GlassHiveConversationOrchestration');
const {
  NativeOrchestrationOperationError,
  commitNativeOrchestrationOperation,
  nativeMutationInputSchema,
  operationTokenFromArgs,
  verifyNativeOrchestrationOperation,
} = require('./GlassHiveNativeOrchestrationOperation');
const {
  getActiveWorkPage,
  getActiveWorkHistoryPage,
  invalidateActiveWorkSnapshot,
} = require('./GlassHiveAccountService');
const { readActiveWork } = require('@librechat/api');
const { getGlassHiveWorkResult } = require('./GlassHiveWorkResultService');
const { executeGlassHiveWorkAction } = require('./GlassHiveWorkActionService');
const {
  markGlassHiveLaunchDispatchUnknown,
  markGlassHiveLaunchDispatchRejected,
  reconcileGlassHiveLaunchResult,
} = require('./GlassHiveCallbackBindingService');
const { maybeInjectGlassHiveCapabilityBroker } = require('./GlassHiveCapabilityBootstrapService');
const {
  selectTrustedLaunchRequestBody,
  trustedUploadedFilesFromRequestBody,
} = require('./GlassHiveSourceSelection');

const { activeMemoryWriterTool } = require('./memoryWriterCoordinator');

const DEFAULT_PROVIDER = 'openai';
const DEFAULT_DISCOVERY_CACHE_TTL_MS = 2 * 60 * 1000;
const MAX_DISCOVERY_CACHE_GRANTS = 256;
const GRANT_DISCOVERY_CACHE = new Map();
const WORK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const ACTIVE_WORK_ACTIONS = new Set(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.action.enum);

function hostToolAnnotations({ access, riskClass, openWorldDefault }) {
  return Object.freeze({
    ...mcpToolAnnotations({ access, openWorldDefault }),
    access,
    riskClass,
  });
}

const HOST_TOOL_DEFINITIONS = Object.freeze({
  transcribe_audio: Object.freeze({
    ...audioTranscriptionDefinition,
    annotations: Object.freeze(mcpToolAnnotations({ access: 'read', openWorldDefault: false })),
  }),
  file_search: Object.freeze({
    name: 'file_search',
    description:
      'Search the files and conversation-recall resources resolved by the host for this exact Agent turn. Results include source provenance when available; degraded recall is reported explicitly.',
    inputSchema: fileSearchJsonSchema,
    annotations: Object.freeze(mcpToolAnnotations({ access: 'read', openWorldDefault: false })),
  }),
  web_search: Object.freeze({
    name: 'web_search',
    description:
      'Search the configured live web provider through the authenticated host. Provider failures and successful empty results are returned explicitly.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'A concise search query.' },
        date: {
          type: 'string',
          enum: ['h', 'd', 'w', 'm', 'y'],
          description: 'Optional result age: hour, day, week, month, or year.',
        },
        country: { type: 'string', description: 'Optional two-letter country code.' },
        images: { type: 'boolean', description: 'Also search images.' },
        videos: { type: 'boolean', description: 'Also search videos.' },
        news: { type: 'boolean', description: 'Also search news.' },
      },
      required: ['query'],
    }),
    annotations: Object.freeze(mcpToolAnnotations({ access: 'read', openWorldDefault: true })),
  }),
  /* === VIVENTIUM START ===
   * Feature: Main-only durable orchestration facades.
   * Purpose: Give native conversation Main the canonical Core launch/list/action paths without
   * accepting owner authority or execution mode from model-controlled input.
   * === VIVENTIUM END === */
  [DELEGATION_TOOL_NAME]: Object.freeze({
    name: DELEGATION_TOOL_NAME,
    description: MAIN_DELEGATION_DESCRIPTION,
    inputSchema: MAIN_DELEGATION_JSON_SCHEMA,
    annotations: hostToolAnnotations({
      access: 'write',
      riskClass: 'durable_work_control',
      openWorldDefault: false,
    }),
  }),
  active_work_list: Object.freeze({
    name: 'active_work_list',
    description: ACTIVE_WORK_LIST_DESCRIPTION,
    inputSchema: ACTIVE_WORK_LIST_JSON_SCHEMA,
    annotations: hostToolAnnotations({
      access: 'read',
      riskClass: 'durable_work_read',
      openWorldDefault: false,
    }),
  }),
  active_work_action: Object.freeze({
    name: 'active_work_action',
    description: ACTIVE_WORK_ACTION_DESCRIPTION,
    inputSchema: ACTIVE_WORK_ACTION_JSON_SCHEMA,
    annotations: hostToolAnnotations({
      access: 'write',
      riskClass: 'durable_work_control',
      openWorldDefault: false,
    }),
  }),
});

function nativeConversationMutationDefinition(definition) {
  return Object.freeze({
    ...definition,
    description:
      `${definition.description} Native conversation providers commit this mutation in one exact ` +
      'call. Exact retries in the same authenticated turn reuse the same Core-derived operation.',
    inputSchema: nativeMutationInputSchema(definition.inputSchema),
  });
}

function brokerDiscoveryRetryDelayMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 500;
}

function brokerProviderTimeoutMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS);
  // Bound a single underlying provider call below the per-server MCP timeout (ms-365 = 120000)
  // so a slow/unavailable provider becomes a clean blocker rather than a hang.
  return Number.isFinite(raw) && raw > 0 ? raw : 45000;
}

/* === VIVENTIUM START ===
 * Feature: grant-scoped broker discovery reuse
 * Purpose: `tools/list` already proves the provider schemas for this short-lived signed grant.
 * Reuse only that successful schema discovery during the ensuing tool calls so an MCP client's
 * request deadline is spent on the real provider operation, while user existence and current
 * policy authorization are still revalidated on every request. */
function brokerDiscoveryCacheTtlMs() {
  const raw = Number(process.env.VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DISCOVERY_CACHE_TTL_MS;
}

function discoveryCacheKey(grant = {}) {
  const grantId = String(grant.grant_id || '').trim();
  const userId = String(grant.user_id || '').trim();
  const nonce = String(grant.nonce || '').trim();
  return grantId && userId && nonce ? `${grantId}:${userId}:${nonce}` : '';
}

function pruneDiscoveryCache(nowMs = Date.now()) {
  for (const [key, record] of GRANT_DISCOVERY_CACHE.entries()) {
    if (!record || Number(record.expiresAtMs) <= nowMs) {
      GRANT_DISCOVERY_CACHE.delete(key);
    }
  }
  while (GRANT_DISCOVERY_CACHE.size > MAX_DISCOVERY_CACHE_GRANTS) {
    GRANT_DISCOVERY_CACHE.delete(GRANT_DISCOVERY_CACHE.keys().next().value);
  }
}

function cachedServerDiscovery(grant, serverName, nowMs = Date.now()) {
  pruneDiscoveryCache(nowMs);
  const key = discoveryCacheKey(grant);
  if (!key) {
    return null;
  }
  return GRANT_DISCOVERY_CACHE.get(key)?.servers?.get(serverName) || null;
}

function rememberServerDiscovery(grant, serverName, discovered, nowMs = Date.now()) {
  if (!discovered?.success || !Array.isArray(discovered.tools) || discovered.tools.length === 0) {
    return;
  }
  const key = discoveryCacheKey(grant);
  if (!key) {
    return;
  }
  const grantExpiryMs = Number(grant.exp) * 1000;
  const expiresAtMs = Math.min(
    nowMs + brokerDiscoveryCacheTtlMs(),
    Number.isFinite(grantExpiryMs) ? grantExpiryMs : nowMs + brokerDiscoveryCacheTtlMs(),
  );
  if (expiresAtMs <= nowMs) {
    return;
  }
  const existing = GRANT_DISCOVERY_CACHE.get(key);
  const record =
    existing && Number(existing.expiresAtMs) > nowMs
      ? existing
      : { expiresAtMs, servers: new Map() };
  record.expiresAtMs = Math.min(record.expiresAtMs, expiresAtMs);
  record.servers.set(serverName, discovered);
  GRANT_DISCOVERY_CACHE.set(key, record);
  pruneDiscoveryCache(nowMs);
}
/* === VIVENTIUM END === */

async function userForGrant(grant) {
  const userId = String(grant?.user_id || '').trim();
  if (!userId) {
    throw new Error('GlassHive capability broker grant is missing user id');
  }
  const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes').catch(
    () => null,
  );
  if (!user) {
    throw new Error('GlassHive capability broker user no longer exists');
  }
  return {
    ...user,
    id: String(user?.id || user?._id || userId),
    _id: user._id || userId,
    role: user?.role || grant.user_role || 'USER',
  };
}

async function requestedServersFromGrant(grant, user, registry, requestedServerNames) {
  /* === VIVENTIUM START ===
   * Feature: Deferred connected-account projection.
   * Purpose: Initial catalog construction is limited to the signed eager set. A helper call may
   * request an exact signed deferred server without waking every connected account.
   */
  const allowedServers = new Set(
    (grant?.allowed_servers || []).map((server) => String(server || '').trim()).filter(Boolean),
  );
  const eagerServers = Array.isArray(grant?.eager_servers)
    ? grant.eager_servers
    : grant?.allowed_servers || [];
  const requested = Array.isArray(requestedServerNames)
    ? requestedServerNames.map((server) => String(server || '').trim()).filter(Boolean)
    : null;
  const servers = new Set(
    (requested || eagerServers).filter((server) => allowedServers.has(server)),
  );
  if (grant?.allow_dynamic_policy_servers === true && registry?.getAllServerConfigs) {
    const mcpConfig = await registry.getAllServerConfigs(user.id).catch((error) => {
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] Failed to resolve dynamic policy servers',
        {
          message: error?.message,
        },
      );
      return null;
    });
    for (const serverName of collectAllowedServers({
      mcpConfig: mcpConfig || {},
      executionMode: grant.execution_mode,
      reqUser: user,
    })) {
      if (!requested || requested.includes(serverName)) {
        servers.add(serverName);
      }
    }
  }
  return Array.from(servers).sort();
  /* === VIVENTIUM END === */
}

async function discoverServerTools({ user, serverName, serverConfig, signal } = {}) {
  const requiresOAuth = Boolean(serverConfig?.requiresOAuth || serverConfig?.oauthMetadata);
  if (requiresOAuth) {
    let credentialState = null;
    try {
      credentialState = await inspectStoredOAuthCredentialState(user?.id, serverName);
    } catch (error) {
      // Readiness inspection is advisory when it cannot run. Continue through the normal MCP
      // path so a telemetry outage cannot falsely delete a working capability.
      logger.warn(
        '[VIVENTIUM][glasshive-capability-broker] OAuth readiness inspection unavailable',
        { serverName, errorType: typeOfError(error) },
      );
    }
    if (credentialState?.status && credentialState.status !== 'credential_present') {
      // A background/native harness cannot complete an interactive OAuth redirect. Return the
      // exact structured blocker immediately; do not start an OAuth flow, wait on flow-state
      // polling, or repeat the same unavailable initialization on describe then invoke.
      return {
        tools: [],
        oauthRequired: true,
        success: false,
        credentialStatus: credentialState.status,
        message: 'Connected account requires reconnection before this worker can use it.',
        recovery: buildMcpOAuthRecovery(serverName),
      };
    }
  }
  const discoverOnce = () =>
    reinitMCPServer({
      user,
      signal,
      forceNew: false,
      serverName,
      serverConfig,
      returnOnOAuth: true,
      allowOAuthInitiation: false,
      oauthStart: async () => {
        // Worker-side OAuth starts are intentionally not launched from the sandbox.
      },
    });

  /* === VIVENTIUM START ===
   * Feature: Stable GlassHive broker MCP reuse.
   * Purpose: Catalog resolution runs before every brokered tool call. Replacing a healthy
   *   user-scoped MCP connection here can invalidate the connection immediately before the
   *   actual call, especially when a harness retries in parallel. Reuse first; only force a
   *   fresh connection when discovery proves the cached connection stale or empty.
   */
  let result = await discoverOnce();
  const toolCount = () => (Array.isArray(result?.tools) ? result.tools.length : 0);
  const shouldRetry =
    !signal?.aborted && !result?.oauthRequired && (!result?.success || toolCount() === 0);

  if (shouldRetry) {
    const delayMs = brokerDiscoveryRetryDelayMs();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!signal?.aborted) {
      result = await discoverOnce();
    }
  }
  /* === VIVENTIUM END === */

  return {
    tools: Array.isArray(result?.tools) ? result.tools : [],
    oauthRequired: Boolean(result?.oauthRequired),
    success: Boolean(result?.success),
    message: result?.message || '',
    credentialStatus: String(result?.credentialState?.status || '').trim(),
    recovery: result?.recovery || null,
  };
}

function typeOfError(error) {
  return String(error?.name || error?.constructor?.name || 'Error');
}

function omissionReasonForDiscovery(discovered) {
  if (discovered.credentialStatus) {
    return discovered.credentialStatus;
  }
  if (discovered.oauthRequired && discovered.tools.length === 0) {
    return 'oauth_required';
  }
  if (!discovered.success) {
    return 'server_unavailable';
  }
  if (discovered.tools.length === 0) {
    return 'no_tools_discovered';
  }
  return '';
}

async function buildCapabilityCatalog({ grant, signal, requestedServerNames, appConfig } = {}) {
  const user = await userForGrant(grant);
  const registry = getMCPServersRegistry();
  const tools = [];
  const servers = [];
  const omissions = [];
  const hostTools = [];
  const claimedBrokerToolNames = new Map();

  for (const toolName of grant?.allowed_host_tools || []) {
    if (
      isConversationOrchestrationTool(toolName) &&
      grant?.authority_kind !== BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR
    ) {
      omissions.push({ reason: 'orchestration_authority_required', tool: toolName });
      continue;
    }
    const memoryBinding = activeMemoryWriterTool(grant);
    const resources = grant?.host_tool_resources?.[toolName];
    const declaredDefinition =
      memoryBinding?.definition.name === toolName
        ? memoryBinding.definition
        : HOST_TOOL_DEFINITIONS[toolName];
    const baseDefinition =
      toolName === DELEGATION_TOOL_NAME && declaredDefinition
        ? { ...declaredDefinition, inputSchema: mainDelegationJsonSchema(resources?.request_body) }
        : declaredDefinition;
    const definition =
      baseDefinition &&
      grant?.authority_kind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR &&
      isConversationOrchestrationMutationTool(toolName)
        ? nativeConversationMutationDefinition(baseDefinition)
        : baseDefinition;
    if (!definition) {
      omissions.push({ reason: 'unsupported_host_tool', tool: toolName });
      continue;
    }
    if (toolName === 'file_search' && !Array.isArray(resources?.files)) {
      omissions.push({ reason: 'missing_host_tool_resources', tool: toolName });
      continue;
    }
    if (toolName === DELEGATION_TOOL_NAME && resources?.version !== 1) {
      omissions.push({ reason: 'missing_host_tool_resources', tool: toolName });
      continue;
    }
    if (toolName === 'transcribe_audio') {
      const files = transcriptionAttachmentReferences(
        Array.isArray(resources?.files) ? resources.files : [],
      );
      if (files.length === 0) {
        omissions.push({ reason: 'missing_host_tool_resources', tool: toolName });
        continue;
      }
      hostTools.push({
        toolName,
        resources: { files },
        definition: {
          ...definition,
          inputSchema: {
            ...definition.inputSchema,
            properties: {
              file_id: {
                ...definition.inputSchema.properties.file_id,
                oneOf: files.map((file) => ({
                  const: file.file_id,
                  title: file.filename || file.file_id,
                })),
              },
            },
          },
        },
      });
      continue;
    }
    hostTools.push({ toolName, definition, resources });
  }

  for (const serverName of await requestedServersFromGrant(
    grant,
    user,
    registry,
    requestedServerNames,
  )) {
    const serverConfig = await registry.getServerConfig(serverName, user.id).catch(() => null);
    const policy = getPolicy(serverConfig);
    if (!serverConfig || !policy || !isTrustedServerConfig(serverConfig)) {
      omissions.push(logOmission('policy_not_authorized', serverName));
      continue;
    }
    const explicitDeferredRequest = Array.isArray(requestedServerNames);
    let discovered = explicitDeferredRequest ? null : cachedServerDiscovery(grant, serverName);
    if (discovered) {
      logger.info('[VIVENTIUM][glasshive-capability-broker] Reused grant-scoped discovery', {
        grantId: grant.grant_id,
        serverName,
        toolCount: discovered.tools.length,
      });
    } else {
      try {
        discovered = await discoverServerTools({ user, serverName, serverConfig, signal });
        if (!explicitDeferredRequest) {
          rememberServerDiscovery(grant, serverName, discovered);
        }
      } catch (error) {
        omissions.push(logOmission('discovery_failed', serverName, { message: error?.message }));
        continue;
      }
    }
    const omissionReason = omissionReasonForDiscovery(discovered);
    if (omissionReason) {
      const omission = logOmission(omissionReason, serverName, {
        message: discovered.message,
        ...(discovered.recovery ? { recovery: discovered.recovery } : {}),
      });
      omissions.push(
        discovered.recovery ? { ...omission, recovery: discovered.recovery } : omission,
      );
    }
    servers.push({
      name: serverName,
      riskClass: policy.riskClass,
      available: discovered.success && discovered.tools.length > 0,
      oauthRequired: discovered.oauthRequired,
      toolCount: discovered.tools.length,
      message: discovered.message,
      ...(discovered.credentialStatus ? { credentialStatus: discovered.credentialStatus } : {}),
      ...(discovered.recovery ? { recovery: discovered.recovery } : {}),
    });
    for (const tool of discovered.tools) {
      if (policy.reexportNativeTools === false) {
        continue;
      }
      const name = String(tool?.name || '').trim();
      if (!name) {
        continue;
      }
      const brokerName = collisionSafeBrokerToolName(serverName, name, claimedBrokerToolNames);
      tools.push({
        serverName,
        toolName: name,
        brokerName,
        policy,
        mcpTool: tool,
        definition: auditSafeToolSummary({
          serverName,
          toolName: name,
          brokerName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          policy,
          tool,
        }),
      });
    }
  }

  return {
    user,
    authorityKind:
      grant?.authority_kind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR
        ? BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR
        : BROKER_AUTHORITY_KINDS.MISSION_WORKER,
    servers,
    omissions,
    tools,
    hostTools,
    appConfig,
    helperTools: helperToolDefinitions(),
    deferredServers: (grant?.deferred_servers || [])
      .map((server) => String(server || '').trim())
      .filter(Boolean)
      .sort(),
  };
}

function toolDefinitionsForMcp(catalog) {
  return [
    ...catalog.helperTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    })),
    ...catalog.hostTools.map((item) => item.definition),
    ...catalog.tools.map((item) => item.definition),
  ];
}

function publicCatalog(catalog) {
  return {
    servers: catalog.servers,
    tools: catalog.tools.map((item) => ({
      name: item.brokerName,
      server: item.serverName,
      tool: item.toolName,
      description: item.mcpTool?.description || '',
      access: item.definition.annotations.access,
      riskClass: item.definition.annotations.riskClass,
    })),
    hostTools: catalog.hostTools.map((item) => ({
      name: item.toolName,
      access: item.definition?.annotations?.access || 'read',
      ...(item.definition?.annotations?.riskClass
        ? { riskClass: item.definition.annotations.riskClass }
        : {}),
      transport: 'host',
    })),
    omissions: catalog.omissions,
    deferredServers: catalog.deferredServers || [],
  };
}

function findHostTool(catalog, toolName) {
  return catalog.hostTools.find((item) => item.toolName === toolName);
}

function cleanBoundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

const GLASSHIVE_MCP_RESULT_MAX_CHARS = 1024 * 1024;
const GLASSHIVE_MCP_RESULT_MAX_DEPTH = 8;
const SAFE_DELEGATION_FAILURE_CODE = /^[a-z][a-z0-9_]{0,119}$/;
const GLASSHIVE_RESULT_CONTAINER_KEYS = Object.freeze([
  'structuredContent',
  'structured_content',
  'result',
  'output',
  'data',
  'content',
  'artifacts',
]);

function parseBoundedJsonObject(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > GLASSHIVE_MCP_RESULT_MAX_CHARS) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isGlassHiveDispatchResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['status', 'work_ref', 'workRef', 'failure_class', 'failureClass'].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function decodedGlassHiveMcpResult(value, depth = 0, visited = new Set()) {
  if (depth > GLASSHIVE_MCP_RESULT_MAX_DEPTH || value == null) return null;
  if (typeof value === 'string') {
    const parsed = parseBoundedJsonObject(value);
    return parsed ? decodedGlassHiveMcpResult(parsed, depth + 1, visited) : null;
  }
  if (typeof value !== 'object' || visited.has(value)) return null;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const decoded = decodedGlassHiveMcpResult(item, depth + 1, visited);
      if (decoded) return decoded;
    }
    return null;
  }
  if (isGlassHiveDispatchResult(value)) return value;
  if (value.type === 'text') {
    const decodedText = decodedGlassHiveMcpResult(value.text, depth + 1, visited);
    if (decodedText) return decodedText;
  }
  for (const key of GLASSHIVE_RESULT_CONTAINER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const decoded = decodedGlassHiveMcpResult(value[key], depth + 1, visited);
    if (decoded) return decoded;
  }
  return null;
}

function glassHiveMcpToolError(value, depth = 0, visited = new Set()) {
  if (depth > GLASSHIVE_MCP_RESULT_MAX_DEPTH || value == null || typeof value !== 'object') {
    return false;
  }
  if (visited.has(value)) return false;
  visited.add(value);
  if (!Array.isArray(value) && (value.isError === true || value.is_error === true)) return true;
  if (Array.isArray(value)) {
    return value.some((item) => glassHiveMcpToolError(item, depth + 1, visited));
  }
  return GLASSHIVE_RESULT_CONTAINER_KEYS.some(
    (key) =>
      Object.prototype.hasOwnProperty.call(value, key) &&
      glassHiveMcpToolError(value[key], depth + 1, visited),
  );
}

function safeDelegationFailureCode(result) {
  for (const value of [result?.failure_class, result?.failureClass, result?.reason]) {
    const code = cleanBoundedString(value, 120).toLowerCase();
    if (SAFE_DELEGATION_FAILURE_CODE.test(code)) return code;
  }
  return 'glasshive_delegation_blocked';
}

function safeDelegationDiagnosticCode(error, fallback) {
  for (const value of [error?.code, error?.name]) {
    const code = cleanBoundedString(value, 120).toLowerCase();
    if (code !== 'error' && SAFE_DELEGATION_FAILURE_CODE.test(code)) return code;
  }
  return fallback;
}

function glassHiveDelegationRetryable(result) {
  for (const value of [result?.retryable, result?.failure_retryable, result?.failureRetryable]) {
    if (typeof value === 'boolean') return value;
  }
  return [408, 429].includes(Number(result?.status)) || Number(result?.status) >= 500;
}

function glassHiveDelegationNeedsInput(result) {
  return result?.needs_input === true || result?.needsInput === true;
}

function validActiveWorkActionArgs(args = {}) {
  const canonical = canonicalConversationOrchestrationArguments('active_work_action', args);
  const { workRef, action, instruction = '' } = canonical;
  if (!WORK_REF_PATTERN.test(workRef) || !ACTIVE_WORK_ACTIONS.has(action)) return null;
  if (['queue', 'message', 'steer'].includes(action) && !instruction) return null;
  return { workRef, action, ...(instruction ? { instruction } : {}) };
}

function glassHiveMissionServerName() {
  return (
    String(process.env.VIVENTIUM_GLASSHIVE_MCP_SERVER_NAMES || 'glasshive-workers-projects')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)[0] || 'glasshive-workers-projects'
  );
}

function delegationToolArguments(args = {}) {
  const canonical = canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, args);
  if (!canonical.title || !canonical.instruction) return null;
  const optional = {
    goal: canonical.goal,
    worker_name: canonical.workerName,
    worker_role: canonical.workerRole,
    profile: canonical.profile,
    effort: canonical.effort,
    resource_class: canonical.resourceClass,
    long_mission: canonical.longMission,
  };
  return {
    title: canonical.title,
    instruction: canonical.instruction,
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
    reuse_existing_workspace: false,
    require_callback: true,
    execution_mode:
      process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE === 'host' ? 'host' : 'docker',
    expose_diagnostics: false,
  };
}

async function invokeConversationDelegation({
  grant,
  catalog,
  hostTool,
  args,
  invocationId,
  trustedToolCall,
  signal,
}) {
  let canonicalArgs;
  try {
    canonicalArgs = canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, args);
  } catch {
    return {
      status: 'blocked',
      reason: 'invalid_arguments',
      tool: hostTool.toolName,
      retryable: false,
      needsInput: false,
    };
  }
  if (
    canonicalArgs.requiresHostAccess === true &&
    process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE !== 'host'
  ) {
    return {
      status: 'blocked',
      reason: 'host_access_unavailable_in_parallel',
      tool: hostTool.toolName,
      needsInput: true,
      retryable: false,
    };
  }
  const resources = hostTool.resources || {};
  const { args: routedArgs, authority: workerRouteAuthority } = resolveBackgroundWorkerRoute(
    canonicalArgs,
    resources,
  );
  const toolArguments = delegationToolArguments(routedArgs);
  const stableInvocationId = cleanBoundedString(invocationId, 192);
  if (!toolArguments || !stableInvocationId) {
    return { status: 'blocked', reason: 'invalid_arguments', tool: hostTool.toolName };
  }
  const baseRequestBody =
    resources.request_body &&
    typeof resources.request_body === 'object' &&
    !Array.isArray(resources.request_body)
      ? resources.request_body
      : {};
  const selection = selectTrustedLaunchRequestBody(baseRequestBody, routedArgs.sourceOrdinals);
  if (selection.error) {
    return { status: 'blocked', reason: selection.error, tool: hostTool.toolName };
  }
  const requestBody = selection.requestBody;
  const trustedUploadedFiles = trustedUploadedFilesFromRequestBody(requestBody);
  if (trustedUploadedFiles.length > 0) {
    toolArguments.uploaded_files = trustedUploadedFiles;
  }
  const config = {
    signal,
    toolCall: {
      id: cleanBoundedString(trustedToolCall?.id, 256) || stableInvocationId,
      stepId: cleanBoundedString(trustedToolCall?.stepId, 256),
      name: 'worker_delegate_once',
      turn: Number.isInteger(Number(trustedToolCall?.turn)) ? Number(trustedToolCall.turn) : 0,
    },
    configurable: {
      user: catalog.user,
      requestBody,
      glasshive_worker_memory: cleanBoundedString(resources.worker_memory, 200000),
      glasshive_worker_feelings: cleanBoundedString(resources.worker_feelings, 200000),
      glasshive_worker_feelings_enabled: resources.worker_feelings_enabled === true,
      glasshive_worker_feelings_hash: cleanBoundedString(resources.worker_feelings_hash, 256),
      glasshive_worker_feelings_scope: cleanBoundedString(resources.worker_feelings_scope, 64),
      glasshive_worker_feelings_range_prompt_override_count: Number(
        resources.worker_feelings_range_prompt_override_count || 0,
      ),
      glasshive_worker_feelings_active_range_prompt_override_count: Number(
        resources.worker_feelings_active_range_prompt_override_count || 0,
      ),
      glasshive_worker_feelings_active_range_prompt_override_chars: Number(
        resources.worker_feelings_active_range_prompt_override_chars || 0,
      ),
      glasshive_host_tools: Array.isArray(resources.mission_host_tools)
        ? resources.mission_host_tools
        : [],
      glasshive_host_tool_resources:
        resources.mission_host_tool_resources &&
        typeof resources.mission_host_tool_resources === 'object' &&
        !Array.isArray(resources.mission_host_tool_resources)
          ? resources.mission_host_tool_resources
          : {},
      glasshive_capability_dependency:
        resources.capability_dependency &&
        typeof resources.capability_dependency === 'object' &&
        !Array.isArray(resources.capability_dependency)
          ? resources.capability_dependency
          : {},
      glasshive_launch_authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      glasshive_worker_route: workerRouteAuthority,
    },
  };
  let effectiveToolArguments = null;
  let dispatchStage = 'launch_preparation';
  try {
    const serverName = glassHiveMissionServerName();
    effectiveToolArguments = await maybeInjectGlassHiveCapabilityBroker({
      serverName,
      toolName: 'worker_delegate_once',
      toolArguments,
      config,
    });
    const mcpManager = getMCPManager(catalog.user.id);
    if (requestBody.viventiumVoiceCallSessionId) {
      if (
        requestBody.viventiumVoiceWorkAuthority?.callSessionId !==
        requestBody.viventiumVoiceCallSessionId
      ) {
        throw Object.assign(new Error('voice_work_authority_stale'), {
          code: 'voice_work_authority_stale',
          status: 409,
          retryable: false,
        });
      }
      await require('./VoiceWorkAuthorityService').assertVoiceWorkAuthority(
        requestBody.viventiumVoiceWorkAuthority,
        catalog.user.id,
      );
    }
    dispatchStage = 'mcp_transport';
    const rawResult = await mcpManager.callTool({
      serverName,
      toolName: 'worker_delegate_once',
      provider: DEFAULT_PROVIDER,
      toolArguments: effectiveToolArguments,
      options: { signal },
      user: catalog.user,
      requestBody,
      flowManager: getFlowStateManager(getLogStores(CacheKeys.FLOWS)),
      tokenMethods: { findToken, createToken, updateToken, deleteToken },
      oauthStart: async () => {
        throw new Error('OAuth authentication required for the GlassHive mission service');
      },
      oauthEnd: async () => {},
      graphTokenResolver: getGraphApiToken,
      returnRawResponse: true,
    });
    dispatchStage = 'mcp_result_classification';
    const result = decodedGlassHiveMcpResult(rawResult);
    const dispatchStatus = cleanBoundedString(result?.status, 64).toLowerCase();
    if (['blocked', 'failed', 'rejected'].includes(dispatchStatus)) {
      const blockedError = new Error(safeDelegationFailureCode(result));
      blockedError.code = blockedError.message;
      try {
        await markGlassHiveLaunchDispatchRejected(effectiveToolArguments, blockedError);
      } catch (cleanupError) {
        await markGlassHiveLaunchDispatchUnknown(effectiveToolArguments).catch(() => {});
        logger.warn(
          '[VIVENTIUM][glasshive-capability-broker] Main delegation rejection cleanup deferred',
          { code: safeDelegationDiagnosticCode(cleanupError, 'launch_rejection_cleanup_failed') },
        );
      }
      return {
        status: 'blocked',
        reason: blockedError.code,
        tool: hostTool.toolName,
        retryable: glassHiveDelegationRetryable(result),
        needsInput: glassHiveDelegationNeedsInput(result),
      };
    }
    if (glassHiveMcpToolError(rawResult) && !result?.work_ref && !result?.workRef) {
      await markGlassHiveLaunchDispatchUnknown(effectiveToolArguments).catch(() => {});
      return {
        status: 'blocked',
        reason: 'glasshive_delegation_tool_error',
        tool: hostTool.toolName,
        retryable: false,
        needsInput: false,
      };
    }
    dispatchStage = 'receipt_reconciliation';
    const receipt = await reconcileGlassHiveLaunchResult({
      toolArguments: effectiveToolArguments,
      result,
    });
    if (!receipt?.workRef) {
      const error = new Error('glasshive_delegation_receipt_unconfirmed');
      error.code = 'glasshive_delegation_receipt_unconfirmed';
      throw error;
    }
    invalidateActiveWorkSnapshot({ ownerId: catalog.user.id });
    return {
      status: 'ok',
      tool: hostTool.toolName,
      workRef: receipt.workRef,
      dispatch: result,
    };
  } catch (error) {
    if (dispatchStage === 'launch_preparation') {
      return {
        status: 'blocked',
        reason: safeDelegationDiagnosticCode(error, 'glasshive_delegation_rejected'),
        tool: hostTool.toolName,
        retryable: glassHiveDelegationRetryable(error),
        needsInput: error?.needsInput === true,
      };
    }
    if (effectiveToolArguments) {
      await markGlassHiveLaunchDispatchUnknown(effectiveToolArguments).catch(() => {});
    }
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Main delegation unconfirmed', {
      stage: dispatchStage,
      code: safeDelegationDiagnosticCode(error, 'delegation_dispatch_unconfirmed'),
    });
    return {
      status: 'blocked',
      reason: 'delegation_dispatch_unconfirmed',
      tool: hostTool.toolName,
      retryable: true,
    };
  }
}

async function executeMainDelegation({
  user,
  requestBody,
  workerMemory = '',
  workerFeelings = '',
  workerFeelingsEnabled = false,
  workerFeelingsHash = '',
  workerFeelingsScope = 'unknown',
  workerFeelingsRangePromptOverrideCount = 0,
  workerFeelingsActiveRangePromptOverrideCount = 0,
  workerFeelingsActiveRangePromptOverrideChars = 0,
  missionHostTools = [],
  missionHostToolResources = {},
  capabilityDependency = {},
  args,
  invocationId,
  toolCall,
  signal,
  workerProfile = '',
  workerModel = '',
  workerReasoningEffort = '',
  fallbackWorkerProfile = '',
  fallbackWorkerModel = '',
  fallbackWorkerReasoningEffort = '',
} = {}) {
  const ownerId = cleanBoundedString(user?.id || user?._id, 160);
  if (!ownerId) {
    return {
      status: 'blocked',
      reason: 'delegation_owner_unavailable',
      tool: DELEGATION_TOOL_NAME,
    };
  }
  return invokeConversationDelegation({
    grant: { grant_id: `core_main_${cleanBoundedString(invocationId, 192)}` },
    catalog: { user: { ...user, id: ownerId } },
    hostTool: {
      toolName: DELEGATION_TOOL_NAME,
      resources: {
        request_body: requestBody,
        worker_memory: workerMemory,
        worker_feelings: workerFeelings,
        worker_feelings_enabled: workerFeelingsEnabled === true,
        worker_feelings_hash: workerFeelingsHash,
        worker_feelings_scope: workerFeelingsScope,
        worker_feelings_range_prompt_override_count: workerFeelingsRangePromptOverrideCount,
        worker_feelings_active_range_prompt_override_count:
          workerFeelingsActiveRangePromptOverrideCount,
        worker_feelings_active_range_prompt_override_chars:
          workerFeelingsActiveRangePromptOverrideChars,
        mission_host_tools: missionHostTools,
        mission_host_tool_resources: missionHostToolResources,
        capability_dependency: capabilityDependency,
        ...backgroundWorkerResources({
          workerProfile,
          workerModel,
          workerReasoningEffort,
          fallbackWorkerProfile,
          fallbackWorkerModel,
          fallbackWorkerReasoningEffort,
        }),
      },
    },
    args,
    invocationId,
    trustedToolCall: toolCall,
    signal,
  });
}

async function invokeConversationOrchestrationTool({
  grant,
  catalog,
  hostTool,
  args = {},
  invocationId,
  signal,
}) {
  if (hostTool.toolName === DELEGATION_TOOL_NAME) {
    return invokeConversationDelegation({
      grant,
      catalog,
      hostTool,
      args,
      invocationId,
      signal,
    });
  }
  if (hostTool.toolName === 'active_work_list') {
    const result = await readActiveWork(catalog.user.id, args, {
      getActiveWorkPage,
      getActiveWorkHistoryPage,
      getGlassHiveWorkResult,
    });
    return { status: 'ok', tool: hostTool.toolName, result };
  }
  if (hostTool.toolName === 'active_work_action') {
    if (hostTool.resources?.version !== 1) {
      return {
        status: 'blocked',
        reason: 'invalid_capability_contract',
        tool: hostTool.toolName,
        retryable: false,
      };
    }
    const input = validActiveWorkActionArgs(args);
    const stableInvocationId = cleanBoundedString(invocationId, 192);
    if (!input || !stableInvocationId) {
      return { status: 'blocked', reason: 'invalid_arguments', tool: hostTool.toolName };
    }
    try {
      const result = await executeGlassHiveWorkAction({
        ownerId: catalog.user.id,
        ...input,
        operationId: stableInvocationId,
        ...(hostTool.resources.request_body?.viventiumVoiceCallSessionId
          ? {
              voiceAuthorityContext: {
                callSessionId: hostTool.resources.request_body.viventiumVoiceCallSessionId,
                binding: hostTool.resources.request_body.viventiumVoiceWorkAuthority,
              },
            }
          : {}),
      });
      return { status: 'ok', tool: hostTool.toolName, result };
    } catch (error) {
      return {
        status: 'blocked',
        reason: cleanBoundedString(error?.code || error?.message, 120) || 'work_action_rejected',
        tool: hostTool.toolName,
        retryable: Number(error?.status) >= 500,
      };
    }
  }
  return { status: 'not_found', tool: hostTool.toolName };
}

async function invokeHostTool({ grant, catalog, hostTool, args = {}, invocationId, signal } = {}) {
  const memoryBinding = activeMemoryWriterTool(grant);
  if (memoryBinding?.definition.name === hostTool.toolName) {
    return memoryBinding.invoke(grant, args);
  }
  if (isConversationOrchestrationTool(hostTool.toolName)) {
    return invokeConversationOrchestrationTool({
      grant,
      catalog,
      hostTool,
      args,
      invocationId,
      signal,
    });
  }
  if (hostTool.toolName === 'transcribe_audio') {
    return transcribeAttachedAudio(
      {
        ownerId: catalog.user.id,
        args,
        signal,
        allowedFileIds: (hostTool.resources?.files || []).map((file) => file.file_id),
      },
      {
        readFile: async (ownerId, fileId) => {
          const [file] = await getFiles({ user: ownerId, file_id: fileId });
          if (!file) return null;
          const { getDownloadStream } = getStrategyFunctions(file.source);
          const stream = await getDownloadStream(
            { user: catalog.user, config: catalog.appConfig },
            file.filepath,
          );
          return { file, stream };
        },
      },
    );
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) {
    return { status: 'blocked', reason: 'invalid_arguments', tool: hostTool.toolName };
  }
  try {
    let content;
    let artifact;
    let resourceCount;
    if (hostTool.toolName === 'file_search') {
      const fileSearchTool = await createFileSearchTool({
        userId: catalog.user.id,
        files: hostTool.resources.files,
        entity_id: String(hostTool.resources.entity_id || '').trim() || undefined,
        conversationId: String(grant?.conversation_id || '').trim() || undefined,
        activeMessageId: String(grant?.message_id || '').trim() || undefined,
        fileCitations: false,
      });
      [content, artifact] = await fileSearchTool.func({ query });
      resourceCount = hostTool.resources.files.length;
    } else if (hostTool.toolName === 'web_search') {
      const auth = await loadWebSearchAuth({
        userId: catalog.user.id,
        loadAuthValues,
        webSearchConfig: catalog.appConfig?.webSearch,
        throwError: true,
      });
      if (!auth?.authenticated) {
        return {
          status: 'blocked',
          reason: 'missing_auth_or_config',
          tool: hostTool.toolName,
          retryable: false,
        };
      }
      const webSearchTool = createViventiumSearchTool({
        ...auth.authResult,
        logger,
      });
      [content, artifact] = await webSearchTool.func({ ...args, query }, undefined, {
        ...(signal ? { signal } : {}),
        toolCall: { id: 'broker-web-search', name: 'web_search', turn: 0 },
        metadata: {
          user_id: catalog.user.id,
          thread_id: String(grant?.conversation_id || '').trim(),
          run_id: String(grant?.message_id || '').trim(),
        },
      });
    } else {
      return { status: 'not_found', tool: hostTool.toolName };
    }
    logger.info('[VIVENTIUM][glasshive-capability-broker] Host tool invoked', {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      toolName: hostTool.toolName,
      ...(resourceCount !== undefined ? { resourceCount } : {}),
      hasArtifact: artifact != null,
      outcome: 'success',
    });
    return {
      status: 'ok',
      tool: hostTool.toolName,
      content: String(content || ''),
      ...(artifact != null ? { artifact } : {}),
    };
  } catch (error) {
    logger.warn('[VIVENTIUM][glasshive-capability-broker] Host tool call failed', {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      toolName: hostTool.toolName,
      message: error?.message,
    });
    return {
      status: 'blocked',
      reason: 'host_tool_error',
      tool: hostTool.toolName,
      retryable: true,
    };
  }
}

function findNativeTool(catalog, brokerToolNameValue) {
  return catalog.tools.find((item) => item.brokerName === brokerToolNameValue);
}

function findNativeToolByServerTool(catalog, serverName, toolName) {
  return catalog.tools.find((item) => item.serverName === serverName && item.toolName === toolName);
}

function authBlockedServerResult(catalog, serverName, toolName = '') {
  const server = catalog.servers.find((item) => item.name === serverName);
  if (!server || server.available !== false || !server.credentialStatus || !server.recovery) {
    return null;
  }
  return {
    status: 'blocked',
    reason: server.credentialStatus,
    server: serverName,
    ...(toolName ? { tool: toolName } : {}),
    oauthRequired: server.oauthRequired === true,
    recovery: server.recovery,
  };
}

function extractIntentFlags(args = {}) {
  const meta = args.__viventiumCapabilityIntent || args.__glasshiveCapabilityIntent || {};
  return {
    explicitContentIntent: meta.explicitContentIntent === true,
    invocationId: String(meta.invocation_id || args.invocation_id || '').trim(),
    writeConfirmationToken: String(
      meta.write_confirmation_token ||
        meta.confirmation_token ||
        args.write_confirmation_token ||
        args.confirmation_token ||
        '',
    ).trim(),
  };
}

function stripBrokerIntentMetadata(args = {}) {
  const {
    __viventiumCapabilityIntent,
    __glasshiveCapabilityIntent,
    invocation_id,
    confirmation_token,
    write_confirmation_token,
    ...toolArguments
  } = args || {};
  return toolArguments;
}

async function invokeUnderlyingTool({ grant, catalog, nativeTool, args = {}, signal } = {}) {
  const { invocationId, writeConfirmationToken } = extractIntentFlags(args);
  const toolArguments = stripBrokerIntentMetadata(args);
  const grantContentReadIntent = grant?.scopes?.content_read === true;
  let policyDecision = evaluateToolCallPolicy({
    policy: nativeTool.policy,
    toolName: nativeTool.toolName,
    tool: nativeTool.mcpTool,
    confirmed: false,
    contentReadIntent: grantContentReadIntent,
  });
  if (policyDecision.toolPolicy?.access === 'write' && !invocationId) {
    return {
      status: 'blocked',
      reason: 'write_requires_invocation_id',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  if (policyDecision.reason === 'write_requires_host_confirmation') {
    try {
      verifyWriteConfirmation(writeConfirmationToken, {
        grantId: grant.grant_id,
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        invocationId,
        args: toolArguments,
      });
      policyDecision = evaluateToolCallPolicy({
        policy: nativeTool.policy,
        toolName: nativeTool.toolName,
        tool: nativeTool.mcpTool,
        confirmed: true,
        contentReadIntent: grantContentReadIntent,
      });
    } catch (error) {
      return {
        status: 'blocked',
        reason: 'write_requires_host_confirmation',
        server: nativeTool.serverName,
        tool: nativeTool.toolName,
      };
    }
  }
  if (!policyDecision.allowed) {
    return {
      status: 'blocked',
      reason: policyDecision.reason,
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  const replay = await rememberInvocation({
    grantId: grant.grant_id,
    invocationId,
    ttlMs: grantReplayTtlMs(grant),
  });
  if (!replay.accepted) {
    return {
      status: 'blocked',
      reason: replay.reason || 'duplicate_invocation',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
    };
  }
  const mcpManager = getMCPManager(catalog.user.id);
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  /* === VIVENTIUM START ===
   * Feature: bounded provider-call timeout + structured degraded blocker
   * Purpose: A slow/unavailable underlying MCP (e.g. MS365) must surface a structured
   *   `provider_degraded` blocker the worker reports per its completion contract, not hang or
   *   bubble an opaque RPC error that nudges the worker into a browser fallback. */
  const providerTimeoutMs = brokerProviderTimeoutMs();
  /* Let the MCP SDK own its request timeout. Passing a broker-created AbortSignal through
   * `MCPManager.callTool` made a reusable HTTP connection behave like a one-shot connection:
   * the next call could fail locally with `This operation was aborted` before the request ever
   * reached the healthy provider. A real caller cancellation signal is still preserved. */
  const requestOptions = {
    timeout: providerTimeoutMs,
    ...(signal ? { signal } : {}),
  };
  let timedOut = false;
  let timeoutHandle = null;
  let result;
  const providerCallStartedAt = Date.now();
  logger.info(
    `[VIVENTIUM][glasshive-capability-broker] Provider tool call starting ` +
      `(parent_signal_present=${Boolean(signal)} ` +
      `parent_signal_aborted=${signal?.aborted === true} ` +
      `broker_signal_aborted=${requestOptions.signal?.aborted === true})`,
    {
      userId: catalog.user.id,
      grantId: grant.grant_id,
      serverName: nativeTool.serverName,
      toolName: nativeTool.toolName,
      parentSignalPresent: Boolean(signal),
      parentSignalAborted: signal?.aborted === true,
      brokerSignalAborted: requestOptions.signal?.aborted === true,
      timeoutMs: providerTimeoutMs,
    },
  );
  try {
    result = await Promise.race([
      mcpManager.callTool({
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        provider: DEFAULT_PROVIDER,
        toolArguments,
        options: requestOptions,
        user: catalog.user,
        requestBody: {
          conversationId: grant.conversation_id,
          parentMessageId: grant.parent_message_id,
          messageId: grant.message_id,
        },
        flowManager,
        tokenMethods: {
          findToken,
          createToken,
          updateToken,
          deleteToken,
        },
        oauthStart: async () => {
          throw new Error('OAuth authentication required for this MCP server');
        },
        oauthEnd: async () => {},
        graphTokenResolver: getGraphApiToken,
      }),
      new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          reject(new Error(`broker provider call timed out after ${providerTimeoutMs}ms`));
        }, providerTimeoutMs);
      }),
    ]);
  } catch (error) {
    const message = String((error && error.message) || '');
    const isTimeout =
      timedOut || /timed out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|abort/i.test(message);
    logger.warn(
      `[VIVENTIUM][glasshive-capability-broker] Provider tool call failed ` +
        `(elapsed_ms=${Date.now() - providerCallStartedAt} ` +
        `parent_signal_present=${Boolean(signal)} ` +
        `parent_signal_aborted=${signal?.aborted === true} ` +
        `broker_signal_aborted=${requestOptions.signal?.aborted === true})`,
      {
        userId: catalog.user.id,
        grantId: grant.grant_id,
        serverName: nativeTool.serverName,
        toolName: nativeTool.toolName,
        timedOut: isTimeout,
        timeoutMs: providerTimeoutMs,
        elapsedMs: Date.now() - providerCallStartedAt,
        parentSignalPresent: Boolean(signal),
        parentSignalAborted: signal?.aborted === true,
        brokerSignalAborted: requestOptions.signal?.aborted === true,
        message,
      },
    );
    return {
      status: 'blocked',
      reason: isTimeout ? 'provider_degraded' : 'provider_error',
      server: nativeTool.serverName,
      tool: nativeTool.toolName,
      retryable: isTimeout,
      detail: isTimeout
        ? `Connected-account provider ${nativeTool.serverName} did not respond within ${Math.round(
            providerTimeoutMs / 1000,
          )}s. Report this as a temporary provider issue; do not fall back to browser automation.`
        : `Connected-account provider ${nativeTool.serverName} returned an error for ${nativeTool.toolName}.`,
    };
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
  logger.info('[VIVENTIUM][glasshive-capability-broker] MCP tool invoked', {
    userId: catalog.user.id,
    grantId: grant.grant_id,
    serverName: nativeTool.serverName,
    toolName: nativeTool.toolName,
    outcome: 'success',
  });
  return result;
  /* === VIVENTIUM END === */
}

async function handleToolCall({
  grant,
  toolName,
  args = {},
  invocationId = '',
  signal,
  appConfig,
} = {}) {
  if (toolName === 'capabilities_list') {
    const catalog = await buildCapabilityCatalog({ grant, signal, appConfig });
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_describe') {
    const requested = args || {};
    const catalog = await buildCapabilityCatalog({
      grant,
      signal,
      appConfig,
      requestedServerNames: requested.server ? [requested.server] : undefined,
    });
    if (requested.tool) {
      const native =
        findNativeTool(catalog, requested.tool) ||
        findNativeToolByServerTool(catalog, requested.server, requested.tool);
      if (!native) {
        const blocked = authBlockedServerResult(catalog, requested.server, requested.tool);
        if (blocked) {
          return blocked;
        }
        return { status: 'not_found', server: requested.server || '', tool: requested.tool };
      }
      return native.definition;
    }
    return publicCatalog(catalog);
  }
  if (toolName === 'capability_invoke') {
    const catalog = await buildCapabilityCatalog({
      grant,
      signal,
      appConfig,
      requestedServerNames: args.server ? [args.server] : [],
    });
    const native = findNativeToolByServerTool(catalog, args.server, args.tool);
    if (!native) {
      const blocked = authBlockedServerResult(catalog, args.server, args.tool);
      if (blocked) {
        return blocked;
      }
      return { status: 'not_found', server: args.server || '', tool: args.tool || '' };
    }
    return invokeUnderlyingTool({
      grant,
      catalog,
      nativeTool: native,
      args: {
        ...(args.arguments || {}),
        ...(args.invocation_id ? { invocation_id: args.invocation_id } : {}),
      },
      signal,
    });
  }
  const catalog = await buildCapabilityCatalog({ grant, signal, appConfig });
  const hostTool = findHostTool(catalog, toolName);
  if (hostTool) {
    let effectiveArgs = args;
    let effectiveInvocationId = invocationId;
    if (
      grant?.authority_kind === BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR &&
      isConversationOrchestrationMutationTool(toolName)
    ) {
      let canonicalMutationArgs;
      try {
        canonicalMutationArgs = canonicalConversationOrchestrationArguments(toolName, args);
      } catch {
        return {
          status: 'blocked',
          reason: 'invalid_arguments',
          tool: toolName,
          retryable: false,
          needsInput: false,
        };
      }
      try {
        const operationToken = operationTokenFromArgs(args);
        const commit = operationToken
          ? verifyNativeOrchestrationOperation({
              token: operationToken,
              grant,
              toolName,
              args: canonicalMutationArgs,
            })
          : commitNativeOrchestrationOperation({
              grant,
              toolName,
              args: canonicalMutationArgs,
            });
        effectiveArgs = commit.args;
        effectiveInvocationId = commit.invocationId;
      } catch (error) {
        const reason =
          error instanceof NativeOrchestrationOperationError
            ? error.code
            : 'orchestration_operation_token_invalid';
        return { status: 'blocked', reason, tool: toolName, retryable: false };
      }
    }
    const result = await invokeHostTool({
      grant,
      catalog,
      hostTool,
      args: effectiveArgs,
      invocationId: effectiveInvocationId,
      signal,
    });
    reportCortexHostToolResult(grant.grant_id, result);
    return result;
  }
  const nativeTool = findNativeTool(catalog, toolName);
  if (!nativeTool) {
    return { status: 'not_found', tool: toolName };
  }
  return invokeUnderlyingTool({
    grant,
    catalog,
    nativeTool,
    args,
    signal,
  });
}

module.exports = {
  buildCapabilityCatalog,
  executeMainDelegation,
  handleToolCall,
  publicCatalog,
  toolDefinitionsForMcp,
};
