/* === VIVENTIUM START ===
 * Feature: Provider-independent Main orchestration facade.
 * Purpose: Keep its schema, exposure policy, trusted route inheritance, and receipt recording in
 * the typed package while /api only wires the broker and logger.
 * === VIVENTIUM END === */

import { tool } from '@librechat/agents/langchain/tools';
import { z } from 'zod';
import {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_LIST_DESCRIPTION,
  ACTIVE_WORK_LIST_JSON_SCHEMA,
  DELEGATION_TOOL_NAME,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  MAIN_DELEGATION_PROFILES,
  MAIN_DELEGATION_RESOURCE_CLASSES,
  MAIN_DELEGATION_STRING_LIMITS,
  hasTrustedKnownWork,
  isConversationOrchestrationControlTool,
  isConversationOrchestrationTool,
  isDeclaredConversationOrchestrator,
  mainOrchestrationInvocationIdentity,
  recordMainDelegationOutcome,
} from './conversationOrchestration';

type UnknownRecord = Record<string, unknown>;

interface InfoLogger {
  info(message: string, fields: UnknownRecord): void;
}

export interface GlassHiveMainDelegationDependencies {
  executeMainDelegation(input: UnknownRecord): Promise<unknown>;
  logger: InfoLogger;
}

export interface GlassHiveMainDelegationOptions {
  userId?: unknown;
  req?: unknown;
  agent?: unknown;
}

interface OrchestrationAvailabilityOptions {
  available?: unknown;
  user?: unknown;
  turnAvailable?: unknown;
  req?: unknown;
}

interface OrchestrationFacadeOptions {
  toolDefinitions?: unknown;
  toolRegistry?: unknown;
  requestedTools?: unknown;
}

const delegationSchema = z
  .object({
    title: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.title),
    instruction: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.instruction),
    goal: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.goal).optional(),
    workerName: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.workerName).optional(),
    workerRole: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.workerRole).optional(),
    profile: z.enum([...MAIN_DELEGATION_PROFILES] as [string, ...string[]]).optional(),
    effort: z.string().trim().min(1).max(MAIN_DELEGATION_STRING_LIMITS.effort).optional(),
    resourceClass: z.enum([...MAIN_DELEGATION_RESOURCE_CLASSES] as [string, ...string[]]),
    longMission: z.boolean().optional(),
    requiresHostAccess: z.boolean().optional(),
    sourceOrdinals: z.array(z.number().int().min(1).max(32)).max(32).optional(),
  })
  .strict();

function recordFrom(value: unknown): UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function resolvedParallelAvailability(options: OrchestrationAvailabilityOptions = {}): boolean {
  return typeof options.available === 'boolean' ? options.available : false;
}

export function canExposeGlassHiveMainDelegation(
  agent: unknown,
  options: OrchestrationAvailabilityOptions = {},
): boolean {
  return isDeclaredConversationOrchestrator(agent) && resolvedParallelAvailability(options);
}

export function canExposeGlassHiveMainWorkControls(
  agent: unknown,
  options: OrchestrationAvailabilityOptions = {},
): boolean {
  const available = resolvedParallelAvailability(options);
  return (
    isDeclaredConversationOrchestrator(agent) && (available || hasTrustedKnownWork(options.user))
  );
}

export function availableGlassHiveMainOrchestrationTools(
  agent: unknown,
  requestedTools: unknown = [],
  options: OrchestrationAvailabilityOptions = {},
): string[] {
  if (!isDeclaredConversationOrchestrator(agent)) return [];
  let available = options.turnAvailable;
  const req = recordFrom(options.req);
  if (
    typeof available !== 'boolean' &&
    typeof req._viventiumParallelWorkTurnAvailable === 'boolean'
  ) {
    available = req._viventiumParallelWorkTurnAvailable;
  }
  if (typeof available !== 'boolean') available = false;
  const delegationAvailable = canExposeGlassHiveMainDelegation(agent, { available });
  const controlsAvailable = canExposeGlassHiveMainWorkControls(agent, {
    user: options.user,
    available,
  });
  return Array.from(new Set(arrayFrom(requestedTools).map(String))).filter((toolName) => {
    if (toolName === DELEGATION_TOOL_NAME) return delegationAvailable;
    return isConversationOrchestrationControlTool(toolName) && controlsAvailable;
  });
}

function configuredWorkerProfile(agent: unknown, { fallback = false } = {}): string {
  const descriptor = recordFrom(agent);
  const agentOrchestration = recordFrom(recordFrom(descriptor.glasshive_options).orchestration);
  const definitionsOnlyOrchestration = recordFrom(descriptor.orchestration);
  const orchestration = Object.keys(agentOrchestration).length
    ? agentOrchestration
    : definitionsOnlyOrchestration;
  const configured = String(
    (fallback ? orchestration.fallback_worker_profile : orchestration.worker_profile) || '',
  ).trim();
  return configured.length > 0 && configured.length <= MAIN_DELEGATION_STRING_LIMITS.profile
    ? configured
    : '';
}

export function createGlassHiveMainDelegationTool(
  options: GlassHiveMainDelegationOptions,
  deps: GlassHiveMainDelegationDependencies,
) {
  const ownerId = String(options.userId || '').trim();
  if (!ownerId) throw new Error('glasshive_delegation_owner_required');
  const req = recordFrom(options.req);
  const agent = recordFrom(options.agent);
  return tool(
    async (args, runnableConfig) => {
      const config = recordFrom(runnableConfig);
      const configurable = recordFrom(config.configurable);
      const requestBody = recordFrom(configurable.requestBody);
      const inheritedProfile = configuredWorkerProfile(agent, {
        fallback: req._viventiumFallbackLlmAttempt === true,
      });
      const fallbackWorkerProfile = configuredWorkerProfile(agent, { fallback: true });
      let descriptorShape = 'missing';
      if (Object.keys(recordFrom(recordFrom(agent.glasshive_options).orchestration)).length) {
        descriptorShape = 'agent';
      } else if (Object.keys(recordFrom(agent.orchestration)).length) {
        descriptorShape = 'definitions_only';
      }
      deps.logger.info('[VIVENTIUM][parallel-work] Selected trusted worker route', {
        descriptorShape,
        primaryWorkerProfile: configuredWorkerProfile(agent),
        fallbackWorkerProfile,
        mainProviderAttempt: req._viventiumFallbackLlmAttempt === true ? 'fallback' : 'primary',
      });
      const effectiveArgs =
        !String(args.profile || '').trim() && inheritedProfile
          ? { ...args, profile: inheritedProfile }
          : args;
      const invocationId = mainOrchestrationInvocationIdentity({
        userId: ownerId,
        requestBody,
        toolName: DELEGATION_TOOL_NAME,
        args: effectiveArgs,
        trustedCallIdentity: recordFrom(config.toolCall).id,
      });
      if (!invocationId) {
        return JSON.stringify({
          status: 'blocked',
          reason: 'delegation_identity_unavailable',
          tool: DELEGATION_TOOL_NAME,
        });
      }
      const result = await deps.executeMainDelegation({
        user: { id: ownerId, role: recordFrom(req.user).role },
        req: options.req,
        requestBody,
        workerMemory:
          configurable.glasshive_worker_memory || req._viventiumGlassHiveWorkerMemory || '',
        workerFeelings:
          configurable.glasshive_worker_feelings || req._viventiumGlassHiveWorkerFeelings || '',
        workerFeelingsEnabled:
          configurable.glasshive_worker_feelings_enabled === true ||
          req._viventiumGlassHiveWorkerFeelingsEnabled === true,
        workerFeelingsHash:
          configurable.glasshive_worker_feelings_hash ||
          req._viventiumGlassHiveWorkerFeelingsHash ||
          '',
        workerFeelingsScope:
          configurable.glasshive_worker_feelings_scope ||
          req._viventiumGlassHiveWorkerFeelingsScope ||
          'unknown',
        workerFeelingsRangePromptOverrideCount:
          configurable.glasshive_worker_feelings_range_prompt_override_count ||
          req._viventiumGlassHiveWorkerFeelingsRangePromptOverrideCount ||
          0,
        workerFeelingsActiveRangePromptOverrideCount:
          configurable.glasshive_worker_feelings_active_range_prompt_override_count ||
          req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideCount ||
          0,
        workerFeelingsActiveRangePromptOverrideChars:
          configurable.glasshive_worker_feelings_active_range_prompt_override_chars ||
          req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideChars ||
          0,
        missionHostTools:
          configurable.glasshive_host_tools || req._viventiumGlassHiveHostTools || [],
        missionHostToolResources:
          configurable.glasshive_host_tool_resources ||
          req._viventiumGlassHiveHostToolResources ||
          {},
        capabilityDependency:
          configurable.glasshive_capability_dependency ||
          req._viventiumGlassHiveCapabilityDependency ||
          {},
        args: effectiveArgs,
        fallbackWorkerProfile,
        invocationId,
        toolCall: config.toolCall,
        signal: config.signal,
      });
      recordMainDelegationOutcome(options.req, invocationId, result);
      return JSON.stringify(result);
    },
    {
      name: DELEGATION_TOOL_NAME,
      description: MAIN_DELEGATION_DESCRIPTION,
      schema: delegationSchema,
    },
  );
}

export function glassHiveMainOrchestrationDefinitions(
  requestedTools: unknown = [],
): UnknownRecord[] {
  const requested = new Set(arrayFrom(requestedTools).map(String));
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

/** Reconcile the Core facade after an underlying definition reload. */
export function appendGlassHiveMainOrchestrationFacade(options: OrchestrationFacadeOptions = {}): {
  toolDefinitions: UnknownRecord[];
  toolRegistry: Map<unknown, unknown>;
} {
  const definitions = glassHiveMainOrchestrationDefinitions(options.requestedTools);
  const nextDefinitions = arrayFrom(options.toolDefinitions)
    .map(recordFrom)
    .filter((definition) => !isConversationOrchestrationTool(definition.name));
  const nextRegistry =
    options.toolRegistry instanceof Map
      ? new Map(options.toolRegistry)
      : new Map<unknown, unknown>();
  for (const name of Array.from(nextRegistry.keys())) {
    if (isConversationOrchestrationTool(name)) nextRegistry.delete(name);
  }
  for (const definition of definitions) {
    nextDefinitions.push(definition);
    nextRegistry.set(definition.name, definition);
  }
  return { toolDefinitions: nextDefinitions, toolRegistry: nextRegistry };
}

/* === VIVENTIUM END === */
