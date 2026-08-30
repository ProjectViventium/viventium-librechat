/* === VIVENTIUM START ===
 * Feature: Conversation-only GlassHive orchestration facade contract.
 * Purpose: Keep the tiny top-level Main control plane structurally separate from capabilities
 * inherited by durable mission roots and their native children.
 * === VIVENTIUM END === */

import crypto from 'node:crypto';

type UnknownRecord = Record<string, unknown>;

interface DelegationOutcome {
  confirmed: boolean;
  retryable: boolean;
  needsInput: boolean;
}

interface DelegationRequest extends UnknownRecord {
  _viventiumMainDelegationOutcomes?: Map<string, DelegationOutcome>;
}

export const DELEGATION_TOOL_NAME = 'worker_delegate_once_mcp_glasshive-workers-projects';
export const CONVERSATION_ORCHESTRATION_TOOLS = Object.freeze([
  DELEGATION_TOOL_NAME,
  'active_work_list',
  'active_work_action',
]);
const CONVERSATION_ORCHESTRATION_TOOL_SET = new Set(CONVERSATION_ORCHESTRATION_TOOLS);
const CONVERSATION_ORCHESTRATION_MUTATION_TOOL_SET = new Set([
  DELEGATION_TOOL_NAME,
  'active_work_action',
]);
const CONVERSATION_ORCHESTRATION_CONTROL_TOOL_SET = new Set([
  'active_work_list',
  'active_work_action',
]);
const MAIN_DELEGATION_OUTCOMES_FIELD = '_viventiumMainDelegationOutcomes' as const;
const WORK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

export const MAIN_DELEGATION_DESCRIPTION =
  "Start one new, independently completable durable background objective for the authenticated user and return only after Core has an authoritative workRef receipt. Create one mission for one independent objective; invoke this tool separately for sibling objectives. Terminal history cannot satisfy a new simultaneous execution group unless the user explicitly asks to reuse it. Preserve the current turn's requested mission count. Never present an old artifact as a current delivery. A mission receives the user's current connected-account capability projection independently from Main's direct callable catalog. Preserve and delegate the objective intact even when Main cannot directly see or call the required provider server. The mission must discover the live prerequisite or return precise needs_input truth. When the request continues, guides, redirects, pauses, resumes, stops, retries, or dismisses existing work, use the exact roster workRef with active_work_action instead of creating a duplicate mission. Use active_work_list first when the target is not already unambiguous in the ephemeral roster. The launch always uses an isolated Docker/workstation boundary. Opening a delivered artifact later is Main presentation work and does not make the Worker objective host-dependent. Set requiresHostAccess=true only when the Worker itself must use the current live host session during execution; that request will be truthfully blocked for a separate user-confirmed path.";

export const MAIN_DELEGATION_STRING_LIMITS = Object.freeze({
  title: 200,
  instruction: 100000,
  goal: 10000,
  workerName: 200,
  workerRole: 500,
  profile: 100,
  effort: 32,
});
export const MAIN_DELEGATION_PROFILES = Object.freeze([
  'codex-cli',
  'claude-code',
  'openclaw-general',
]);
export const MAIN_DELEGATION_RESOURCE_CLASSES = Object.freeze(['standard', 'light']);

export const MAIN_DELEGATION_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: MAIN_DELEGATION_STRING_LIMITS.title },
    instruction: {
      type: 'string',
      minLength: 1,
      maxLength: MAIN_DELEGATION_STRING_LIMITS.instruction,
    },
    goal: { type: 'string', minLength: 1, maxLength: MAIN_DELEGATION_STRING_LIMITS.goal },
    workerName: {
      type: 'string',
      minLength: 1,
      maxLength: MAIN_DELEGATION_STRING_LIMITS.workerName,
    },
    workerRole: {
      type: 'string',
      minLength: 1,
      maxLength: MAIN_DELEGATION_STRING_LIMITS.workerRole,
    },
    profile: {
      type: 'string',
      enum: MAIN_DELEGATION_PROFILES,
      description:
        'Optional exact worker profile. Omit it to use the server-owned primary/fallback route; select one only when the user or task genuinely requires that worker runtime.',
    },
    effort: { type: 'string', minLength: 1, maxLength: MAIN_DELEGATION_STRING_LIMITS.effort },
    resourceClass: {
      type: 'string',
      enum: MAIN_DELEGATION_RESOURCE_CLASSES,
      description:
        'Required worker memory class. Select light only when the complete objective can safely run within the bounded light-worker memory limit; select standard for objectives that need the normal worker memory limit. This field is independent of longMission.',
    },
    longMission: { type: 'boolean' },
    requiresHostAccess: {
      type: 'boolean',
      description:
        'True only when the Worker itself cannot execute in an isolated workstation and must use the current live host session or desktop. Omit it when Main can open or present the delivered result after the callback.',
    },
    sourceOrdinals: {
      type: 'array',
      maxItems: 32,
      description:
        'Required when trusted turn context lists S1/S2/etc. Select exactly which rapid user inputs this mission owns.',
      items: { type: 'integer', minimum: 1, maximum: 32 },
    },
  },
  required: ['title', 'instruction', 'resourceClass'],
  additionalProperties: false,
});

export const ACTIVE_WORK_LIST_DESCRIPTION =
  'List the authenticated user’s existing durable background missions so Main can identify the exact workRef to continue or control instead of creating duplicate work. Each returned mission includes its current lifecycle state and authoritative actions. Follow a returned cursor until none remains when a complete roster is needed; unavailable never means empty.';
export const ACTIVE_WORK_LIST_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
});
export const ACTIVE_WORK_ACTION_SEMANTICS =
  "Use only the target work item's current actions: its owner-scoped actions list is authoritative, and the global action enum never makes an unlisted action available. Use active_work_list when that current action mask is unknown or stale. " +
  'Queue persists a follow-up behind the current objective without interrupting it. ' +
  'Message delivers noninterrupting guidance or continuation within the same mission. Message can continue completed work when its actions list allows it. ' +
  'Steer interrupts and redirects the exact active run. Pause and Resume preserve the objective. ' +
  'Stop cancels only that exact work. Retry is only for failed or otherwise retryable terminal work whose actions list includes retry. Completed work is successful and must never be retried. ' +
  'Retry does not deliver new guidance: when retryable failed work needs both recovery and a new instruction, Retry first, then Message or Steer the same workRef after recovery is accepted; do not claim the guidance was added until that second action settles. ' +
  'Dismiss removes an acknowledged terminal card without deleting history. ' +
  'When the user names an action, use that exact action and report the returned action truthfully.';
export const ACTIVE_WORK_ACTION_DESCRIPTION = `Continue or control one existing durable mission by exact workRef instead of starting a competing mission. Each call applies one exact action; a turn may sequence distinct actions when the mission lifecycle requires it. ${ACTIVE_WORK_ACTION_SEMANTICS}`;
export const ACTIVE_WORK_ACTION_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    workRef: { type: 'string', pattern: '^[A-Za-z0-9._:-]{1,160}$' },
    action: {
      type: 'string',
      enum: ['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss'],
      description: ACTIVE_WORK_ACTION_SEMANTICS,
    },
    instruction: { type: 'string', minLength: 1, maxLength: 8000 },
  },
  required: ['workRef', 'action'],
  additionalProperties: false,
});

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  let bounded = trimmed.slice(0, maxLength);
  const lastCodeUnit = bounded.charCodeAt(bounded.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    bounded = bounded.slice(0, -1);
  }
  return bounded;
}

function canonicalSourceOrdinals(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .slice(0, 32)
        .map(Number)
        .filter((item) => Number.isInteger(item) && item >= 1 && item <= 32),
    ),
  ).sort((left, right) => left - right);
}

/** Return exactly the executable, model-controlled part of an orchestration call. */
export function canonicalConversationOrchestrationArguments(
  toolName: unknown,
  args: unknown = {},
): UnknownRecord {
  const input = isRecord(args) ? args : {};
  if (toolName === DELEGATION_TOOL_NAME) {
    if (!Object.prototype.hasOwnProperty.call(input, 'resourceClass')) {
      throw new TypeError('resourceClass is required');
    }
    if (!MAIN_DELEGATION_RESOURCE_CLASSES.includes(String(input.resourceClass))) {
      throw new TypeError('resourceClass must be one of: standard, light');
    }
    if (
      Object.prototype.hasOwnProperty.call(input, 'longMission') &&
      typeof input.longMission !== 'boolean'
    ) {
      throw new TypeError('longMission must be a boolean');
    }
    const output: UnknownRecord = {
      title: boundedString(input.title, MAIN_DELEGATION_STRING_LIMITS.title),
      instruction: boundedString(input.instruction, MAIN_DELEGATION_STRING_LIMITS.instruction),
    };
    const optionalStrings: Array<[string, number]> = [
      ['goal', MAIN_DELEGATION_STRING_LIMITS.goal],
      ['workerName', MAIN_DELEGATION_STRING_LIMITS.workerName],
      ['workerRole', MAIN_DELEGATION_STRING_LIMITS.workerRole],
      ['profile', MAIN_DELEGATION_STRING_LIMITS.profile],
      ['effort', MAIN_DELEGATION_STRING_LIMITS.effort],
    ];
    for (const [key, maxLength] of optionalStrings) {
      const value = boundedString(input[key], maxLength);
      if (value) output[key] = value;
    }
    if (input.requiresHostAccess === true) output.requiresHostAccess = true;
    if (input.longMission === true) output.longMission = true;
    output.resourceClass = input.resourceClass;
    const sourceOrdinals = canonicalSourceOrdinals(input.sourceOrdinals);
    if (sourceOrdinals.length) output.sourceOrdinals = sourceOrdinals;
    return output;
  }
  if (toolName === 'active_work_action') {
    const instruction = boundedString(input.instruction, 8000);
    return {
      workRef: boundedString(input.workRef, 160),
      action: boundedString(input.action, 32).toLowerCase(),
      ...(instruction ? { instruction } : {}),
    };
  }
  if (toolName === 'active_work_list') {
    const cursor = boundedString(input.cursor, 2048);
    const limit =
      Number.isInteger(input.limit) && Number(input.limit) >= 1 && Number(input.limit) <= 100
        ? Number(input.limit)
        : 50;
    return { ...(cursor ? { cursor } : {}), limit };
  }
  return input;
}

export function isConversationOrchestrationTool(value: unknown): boolean {
  return CONVERSATION_ORCHESTRATION_TOOL_SET.has(String(value || '').trim());
}

export function isConversationOrchestrationMutationTool(value: unknown): boolean {
  return CONVERSATION_ORCHESTRATION_MUTATION_TOOL_SET.has(String(value || '').trim());
}

export function isConversationOrchestrationControlTool(value: unknown): boolean {
  return CONVERSATION_ORCHESTRATION_CONTROL_TOOL_SET.has(String(value || '').trim());
}

export function hasTrustedKnownWork(user: unknown): boolean {
  if (!isRecord(user) || !isRecord(user.personalization)) return false;
  return user.personalization.parallel_work_known === true;
}

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function mainOrchestrationInvocationIdentity({
  userId,
  requestBody = {},
  toolName,
  args,
  trustedCallIdentity = '',
}: {
  userId?: unknown;
  requestBody?: UnknownRecord;
  toolName?: unknown;
  args?: unknown;
  trustedCallIdentity?: unknown;
} = {}): string {
  const executableArgs = canonicalConversationOrchestrationArguments(toolName, args);
  const conversationScope =
    requestBody.conversationId || requestBody.conversation_id || requestBody.viventiumLogicalTurnId;
  const messageScope = requestBody.messageId || requestBody.message_id;
  const scope = [
    userId,
    conversationScope,
    messageScope,
    requestBody.viventiumSourceEventId,
    String(trustedCallIdentity || '').trim(),
    toolName,
    stableJson(executableArgs),
  ]
    .map((value) => String(value || ''))
    .join('\0');
  if (
    !String(userId || '').trim() ||
    !String(conversationScope || '').trim() ||
    !String(messageScope || '').trim() ||
    !String(toolName || '').trim()
  ) {
    return '';
  }
  return `ghbi_${crypto.createHash('sha256').update(scope, 'utf8').digest('hex')}`;
}

export function isDeclaredConversationOrchestrator(agent: unknown): boolean {
  if (!isRecord(agent) || !isRecord(agent.glasshive_options)) return false;
  const orchestration = agent.glasshive_options.orchestration;
  return isRecord(orchestration) && orchestration.parallel_available === true;
}

/** Record only public-safe launch truth on the request that owns the provider turn. */
export function recordMainDelegationOutcome(
  request: unknown,
  invocationId: unknown,
  result: unknown = {},
): boolean {
  if (!isRecord(request)) return false;
  const req = request as DelegationRequest;
  let outcomes = req[MAIN_DELEGATION_OUTCOMES_FIELD];
  if (!(outcomes instanceof Map)) {
    outcomes = new Map<string, DelegationOutcome>();
    Object.defineProperty(req, MAIN_DELEGATION_OUTCOMES_FIELD, {
      configurable: true,
      enumerable: false,
      value: outcomes,
      writable: false,
    });
  }
  const row = isRecord(result) ? result : {};
  const key = boundedString(invocationId, 192) || `attempt-${outcomes.size + 1}`;
  const status = boundedString(row.status, 32).toLowerCase();
  const workRef = boundedString(row.workRef || row.work_ref, 160);
  outcomes.set(key, {
    confirmed: status === 'ok' && WORK_REF_PATTERN.test(workRef),
    retryable: row.retryable === true,
    needsInput: row.needsInput === true || row.needs_input === true,
  });
  return true;
}

export function mainDelegationTurnTruth(request: unknown): UnknownRecord | null {
  if (!isRecord(request)) return null;
  const outcomes = (request as DelegationRequest)[MAIN_DELEGATION_OUTCOMES_FIELD];
  if (!(outcomes instanceof Map) || outcomes.size === 0) return null;
  const values = Array.from(outcomes.values());
  const confirmedCount = values.filter((value) => value.confirmed).length;
  return {
    attemptedCount: values.length,
    confirmedCount,
    unconfirmedCount: values.length - confirmedCount,
    retryableCount: values.filter((value) => value.retryable).length,
    needsInputCount: values.filter((value) => value.needsInput).length,
  };
}
