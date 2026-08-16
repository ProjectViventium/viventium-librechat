/* === VIVENTIUM START ===
 * Feature: Provider-independent Main orchestration facade.
 * Purpose: Replace the configured raw GlassHive launch MCP with one Core-owned schema and
 * owner-scoped execution path for every Main provider. Durable mission roots never receive it.
 * === VIVENTIUM END === */

const { tool } = require('@langchain/core/tools');
const { z } = require('zod');
const {
  DELEGATION_TOOL_NAME,
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_LIST_DESCRIPTION,
  ACTIVE_WORK_LIST_JSON_SCHEMA,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  MAIN_DELEGATION_STRING_LIMITS,
  hasTrustedKnownWork,
  isDeclaredConversationOrchestrator,
  isConversationOrchestrationTool,
  isConversationOrchestrationControlTool,
  mainOrchestrationInvocationIdentity,
  recordMainDelegationOutcome,
} = require('~/server/services/viventium/GlassHiveConversationOrchestration');
const {
  parallelWorkAvailable,
} = require('~/server/services/viventium/ViventiumOrchestrationMode');

const delegationSchema = z
  .object({
    title: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.title),
    instruction: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.instruction),
    goal: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.goal).optional(),
    workerName: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.workerName).optional(),
    workerRole: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.workerRole).optional(),
    profile: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.profile).optional(),
    effort: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.effort).optional(),
    requiresHostAccess: z.boolean().optional(),
    sourceOrdinals: z.array(z.number().int().min(1).max(32)).max(32).optional(),
  })
  .strict();

function canExposeGlassHiveMainDelegation(
  agent,
  { available = parallelWorkAvailable() } = {},
) {
  return isDeclaredConversationOrchestrator(agent) && available;
}

function canExposeGlassHiveMainWorkControls(
  agent,
  { user, available = parallelWorkAvailable() } = {},
) {
  return (
    isDeclaredConversationOrchestrator(agent) &&
    (available || hasTrustedKnownWork(user))
  );
}

function availableGlassHiveMainOrchestrationTools(agent, requestedTools = [], { user } = {}) {
  if (!isDeclaredConversationOrchestrator(agent)) return [];
  const available = parallelWorkAvailable();
  const delegationAvailable = canExposeGlassHiveMainDelegation(agent, { available });
  const controlsAvailable = canExposeGlassHiveMainWorkControls(agent, { user, available });
  return Array.from(new Set(requestedTools)).filter((toolName) => {
    if (toolName === DELEGATION_TOOL_NAME) return delegationAvailable;
    return isConversationOrchestrationControlTool(toolName) && controlsAvailable;
  });
}

function createGlassHiveMainDelegationTool({ userId, req }) {
  const ownerId = String(userId || '').trim();
  if (!ownerId) throw new Error('glasshive_delegation_owner_required');
  return tool(
    async (args, runnableConfig = {}) => {
      const configurable = runnableConfig.configurable || {};
      const requestBody = configurable.requestBody || {};
      const invocationId = mainOrchestrationInvocationIdentity({
        userId: ownerId,
        requestBody,
        toolName: DELEGATION_TOOL_NAME,
        args,
        // `runnableConfig.toolCall` is Core-carried provider-runtime metadata, never a model arg.
        // It distinguishes separate identical calls in one turn; replaying the same runtime call
        // stays stable while JSON-RPC envelope ids never enter this path.
        trustedCallIdentity: runnableConfig?.toolCall?.id,
      });
      if (!invocationId) {
        return JSON.stringify({
          status: 'blocked',
          reason: 'delegation_identity_unavailable',
          tool: DELEGATION_TOOL_NAME,
        });
      }
      const {
        executeMainDelegation,
      } = require('~/server/services/viventium/GlassHiveCapabilityBrokerService');
      const result = await executeMainDelegation({
        user: { id: ownerId, role: req?.user?.role },
        requestBody,
        workerMemory:
          configurable.glasshive_worker_memory || req?._viventiumGlassHiveWorkerMemory || '',
        missionHostTools:
          configurable.glasshive_host_tools || req?._viventiumGlassHiveHostTools || [],
        missionHostToolResources:
          configurable.glasshive_host_tool_resources ||
          req?._viventiumGlassHiveHostToolResources ||
          {},
        capabilityDependency:
          configurable.glasshive_capability_dependency ||
          req?._viventiumGlassHiveCapabilityDependency ||
          {},
        args,
        invocationId,
        toolCall: runnableConfig?.toolCall,
        signal: runnableConfig.signal,
      });
      recordMainDelegationOutcome(req, invocationId, result);
      return JSON.stringify(result);
    },
    {
      name: DELEGATION_TOOL_NAME,
      description: MAIN_DELEGATION_DESCRIPTION,
      schema: delegationSchema,
    },
  );
}

function glassHiveMainOrchestrationDefinitions(requestedTools = []) {
  const requested = new Set(requestedTools);
  return [
    {
      name: DELEGATION_TOOL_NAME,
      description: MAIN_DELEGATION_DESCRIPTION,
      parameters: MAIN_DELEGATION_JSON_SCHEMA,
      allowed_callers: ['direct'],
    },
    {
      name: 'active_work_list',
      description: ACTIVE_WORK_LIST_DESCRIPTION,
      parameters: ACTIVE_WORK_LIST_JSON_SCHEMA,
      allowed_callers: ['direct'],
    },
    {
      name: 'active_work_action',
      description: ACTIVE_WORK_ACTION_DESCRIPTION,
      parameters: ACTIVE_WORK_ACTION_JSON_SCHEMA,
      allowed_callers: ['direct'],
    },
  ].filter((definition) => requested.has(definition.name));
}

/**
 * Reconcile the Core-owned facade after any underlying definition reload. OAuth completion can
 * replace both collections wholesale, so remove stale facade entries before appending the exact
 * current readiness/known-work subset.
 */
function appendGlassHiveMainOrchestrationFacade({
  toolDefinitions,
  toolRegistry,
  requestedTools = [],
} = {}) {
  const definitions = glassHiveMainOrchestrationDefinitions(requestedTools);
  const nextDefinitions = (Array.isArray(toolDefinitions) ? toolDefinitions : []).filter(
    (definition) => !isConversationOrchestrationTool(definition?.name),
  );
  const nextRegistry = toolRegistry instanceof Map ? new Map(toolRegistry) : new Map();
  for (const name of Array.from(nextRegistry.keys())) {
    if (isConversationOrchestrationTool(name)) nextRegistry.delete(name);
  }
  for (const definition of definitions) {
    nextDefinitions.push(definition);
    nextRegistry.set(definition.name, definition);
  }
  return { toolDefinitions: nextDefinitions, toolRegistry: nextRegistry };
}

module.exports = {
  appendGlassHiveMainOrchestrationFacade,
  availableGlassHiveMainOrchestrationTools,
  canExposeGlassHiveMainDelegation,
  canExposeGlassHiveMainWorkControls,
  createGlassHiveMainDelegationTool,
  glassHiveMainOrchestrationDefinitions,
};
