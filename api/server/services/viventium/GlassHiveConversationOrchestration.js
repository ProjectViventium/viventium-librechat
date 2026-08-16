/* === VIVENTIUM START ===
 * Feature: Conversation-only GlassHive orchestration facade contract.
 * Purpose: Keep the tiny top-level Main control plane structurally separate from capabilities
 * inherited by durable mission roots and their native children.
 * === VIVENTIUM END === */

const DELEGATION_TOOL_NAME = 'worker_delegate_once_mcp_glasshive-workers-projects';
const CONVERSATION_ORCHESTRATION_TOOLS = Object.freeze([
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
const crypto = require('crypto');
const MAIN_DELEGATION_OUTCOMES_FIELD = '_viventiumMainDelegationOutcomes';
const WORK_REF_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const MAIN_DELEGATION_DESCRIPTION =
  'Start one durable background mission for the authenticated user and return only after Core has an authoritative workRef receipt. The launch always uses an isolated Docker/workstation boundary. Set requiresHostAccess=true when the goal depends on the current host session; that request will be truthfully blocked for a separate user-confirmed path.';
const MAIN_DELEGATION_STRING_LIMITS = Object.freeze({
  title: 200,
  instruction: 100000,
  goal: 10000,
  workerName: 200,
  workerRole: 500,
  profile: 100,
  effort: 32,
});
const MAIN_DELEGATION_JSON_SCHEMA = Object.freeze({
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
      minLength: 1,
      maxLength: MAIN_DELEGATION_STRING_LIMITS.profile,
    },
    effort: { type: 'string', minLength: 1, maxLength: MAIN_DELEGATION_STRING_LIMITS.effort },
    requiresHostAccess: {
      type: 'boolean',
      description:
        'True only when the task cannot run in an isolated workstation and needs the current host session or desktop.',
    },
    sourceOrdinals: {
      type: 'array',
      maxItems: 32,
      description:
        'Required when trusted turn context lists S1/S2/etc. Select exactly which rapid user inputs this mission owns.',
      items: { type: 'integer', minimum: 1, maximum: 32 },
    },
  },
  required: ['title', 'instruction'],
  additionalProperties: false,
});
const ACTIVE_WORK_LIST_DESCRIPTION =
  'List the authenticated user’s active background work roster and attention state. Follow a returned cursor until none remains when a complete roster is needed; unavailable never means empty.';
const ACTIVE_WORK_LIST_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
  additionalProperties: false,
});
const ACTIVE_WORK_ACTION_SEMANTICS =
  'Queue persists a follow-up behind the current objective without interrupting it. ' +
  'Message delivers noninterrupting guidance to the current run. ' +
  'Steer interrupts and redirects the exact active run. Pause and Resume preserve the objective. ' +
  'Stop cancels only that exact work. Retry continues terminal retryable work in the same mission. ' +
  'Dismiss removes an acknowledged terminal card without deleting history. ' +
  'When the user names an action, use that exact action and report the returned action truthfully.';
const ACTIVE_WORK_ACTION_DESCRIPTION =
  `Apply one valid action to an exact workRef. ${ACTIVE_WORK_ACTION_SEMANTICS}`;
const ACTIVE_WORK_ACTION_JSON_SCHEMA = Object.freeze({
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

function boundedString(value, maxLength) {
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

function canonicalSourceOrdinals(value) {
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

/**
 * Return exactly the executable, model-controlled part of a conversation-orchestration call.
 * This is shared by transport identity and execution so ignored owner/operation/mode fields,
 * unknown properties, and whitespace cannot mint a second durable operation on retry.
 */
function canonicalConversationOrchestrationArguments(toolName, args = {}) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (toolName === DELEGATION_TOOL_NAME) {
    const output = {
      title: boundedString(input.title, MAIN_DELEGATION_STRING_LIMITS.title),
      instruction: boundedString(input.instruction, MAIN_DELEGATION_STRING_LIMITS.instruction),
    };
    for (const [key, maxLength] of [
      ['goal', MAIN_DELEGATION_STRING_LIMITS.goal],
      ['workerName', MAIN_DELEGATION_STRING_LIMITS.workerName],
      ['workerRole', MAIN_DELEGATION_STRING_LIMITS.workerRole],
      ['profile', MAIN_DELEGATION_STRING_LIMITS.profile],
      ['effort', MAIN_DELEGATION_STRING_LIMITS.effort],
    ]) {
      const value = boundedString(input[key], maxLength);
      if (value) output[key] = value;
    }
    if (input.requiresHostAccess === true) output.requiresHostAccess = true;
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
    const limit = Number.isInteger(input.limit) && input.limit >= 1 && input.limit <= 100
      ? input.limit
      : 50;
    return { ...(cursor ? { cursor } : {}), limit };
  }
  return input;
}

function isConversationOrchestrationTool(value) {
  return CONVERSATION_ORCHESTRATION_TOOL_SET.has(String(value || '').trim());
}

function isConversationOrchestrationMutationTool(value) {
  return CONVERSATION_ORCHESTRATION_MUTATION_TOOL_SET.has(String(value || '').trim());
}

function isConversationOrchestrationControlTool(value) {
  return CONVERSATION_ORCHESTRATION_CONTROL_TOOL_SET.has(String(value || '').trim());
}

function hasTrustedKnownWork(user) {
  return user?.personalization?.parallel_work_known === true;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable Core-owned operation identity for every Main provider lane. A direct provider adapter may
 * additionally bind its Core-carried `runnableConfig.toolCall.id` occurrence; model arguments and
 * reconnect-level JSON-RPC ids never supply that identity. Ignored model fields cannot mint a
 * second durable mutation, while materially different objectives/source sets remain distinct.
 */
function mainOrchestrationInvocationIdentity({
  userId,
  requestBody = {},
  toolName,
  args,
  trustedCallIdentity = '',
} = {}) {
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
    .join('\u0000');
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

function isDeclaredConversationOrchestrator(agent) {
  return agent?.glasshive_options?.orchestration?.parallel_available === true;
}

/** Record only public-safe launch truth on the request that owns the provider turn. */
function recordMainDelegationOutcome(req, invocationId, result = {}) {
  if (!req || typeof req !== 'object') return false;
  let outcomes = req[MAIN_DELEGATION_OUTCOMES_FIELD];
  if (!(outcomes instanceof Map)) {
    outcomes = new Map();
    Object.defineProperty(req, MAIN_DELEGATION_OUTCOMES_FIELD, {
      configurable: true,
      enumerable: false,
      value: outcomes,
      writable: false,
    });
  }
  const key = boundedString(invocationId, 192) || `attempt-${outcomes.size + 1}`;
  const status = boundedString(result?.status, 32).toLowerCase();
  const workRef = boundedString(result?.workRef || result?.work_ref, 160);
  outcomes.set(key, {
    confirmed: status === 'ok' && WORK_REF_PATTERN.test(workRef),
    retryable: result?.retryable === true,
    needsInput: result?.needsInput === true || result?.needs_input === true,
  });
  return true;
}

function mainDelegationTurnTruth(req) {
  const outcomes = req?.[MAIN_DELEGATION_OUTCOMES_FIELD];
  if (!(outcomes instanceof Map) || outcomes.size === 0) return null;
  const values = Array.from(outcomes.values());
  const confirmedCount = values.filter((value) => value.confirmed === true).length;
  return {
    attemptedCount: values.length,
    confirmedCount,
    unconfirmedCount: values.length - confirmedCount,
    retryableCount: values.filter((value) => value.retryable === true).length,
    needsInputCount: values.filter((value) => value.needsInput === true).length,
  };
}

module.exports = {
  CONVERSATION_ORCHESTRATION_TOOLS,
  DELEGATION_TOOL_NAME,
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_LIST_DESCRIPTION,
  ACTIVE_WORK_LIST_JSON_SCHEMA,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  MAIN_DELEGATION_STRING_LIMITS,
  canonicalConversationOrchestrationArguments,
  hasTrustedKnownWork,
  isDeclaredConversationOrchestrator,
  isConversationOrchestrationControlTool,
  isConversationOrchestrationMutationTool,
  isConversationOrchestrationTool,
  mainDelegationTurnTruth,
  mainOrchestrationInvocationIdentity,
  recordMainDelegationOutcome,
};
