/** Memories */
import { z } from 'zod';
import { createHmac, randomBytes } from 'crypto';
import { Tools, supportsAdaptiveThinking } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import { tool } from '@librechat/agents/langchain/tools';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import type { MemoryKeyLimits } from '~/memory';
import type {
  OpenAIClientOptions,
  StreamEventData,
  ToolEndCallback,
  EventHandler,
  ToolEndData,
  LLMConfig,
} from '@librechat/agents';
import type { BaseMessage, ToolMessage } from '@librechat/agents/langchain/messages';
import type { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import type { ObjectId, MemoryMethods, IUser } from '@librechat/data-schemas';
import type { TAttachment, MemoryArtifact } from 'librechat-data-provider';
import type { Response as ServerResponse } from 'express';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import {
  evaluateMemoryWrite,
  prepareMemoryValueForWrite,
  resolveMemoryKeyLimits,
  runMemoryMaintenance,
} from '~/memory';
import {
  hasActiveAnthropicThinking,
  sanitizeAnthropicTemperatureForThinking,
} from '~/endpoints/anthropic/helpers';
import { resolveHeaders, createSafeUser } from '~/utils';

/* === VIVENTIUM START === Include tombstone-aware state in revision-safe snapshots. === */
type RequiredMemoryMethods = Pick<
  MemoryMethods,
  | 'setMemory'
  | 'deleteMemory'
  | 'getFormattedMemories'
  | 'getAllUserMemories'
  | 'getAllUserMemoryStates'
>;
/* === VIVENTIUM END === */

type ToolEndMetadata = Record<string, unknown> & {
  run_id?: string;
  thread_id?: string;
};

type SanitizedMemoryLLMConfig = Omit<Partial<LLMConfig>, 'apiKey'> & { apiKey?: string };

function normalizeMemoryLLMConfig(llmConfig?: Partial<LLMConfig>): SanitizedMemoryLLMConfig {
  const config = { ...(llmConfig ?? {}) } as Record<string, unknown>;
  if (typeof config.apiKey !== 'string') {
    delete config.apiKey;
  }
  return config as SanitizedMemoryLLMConfig;
}

export interface MemoryConfig {
  validKeys?: string[];
  instructions?: string;
  llmConfig?: Partial<LLMConfig>;
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  maintenanceThresholdPercent?: number;
  readProfile?: MemoryReadProfileConfig;
}

export interface MemorySnapshot {
  withKeys: string;
  withoutKeys: string;
  totalTokens: number;
  memoryTokenMap: Record<string, number>;
  memoryRevisionMap: Record<string, number>;
  memoryValueHashMap: Record<string, string>;
}

export interface MemoryWriteAuditContext {
  source?: string;
  conversationId?: string;
  messageId?: string;
}

/* === VIVENTIUM START ===
 * Feature: Bounded saved-memory read profile and writer health gate
 * Purpose: Keep chat-time memory reads small/cached/deduped and prevent repeated
 * provider-auth failures from running on every chat turn.
 * === VIVENTIUM END === */
export interface MemoryReadProfileConfig {
  tokenLimit?: number;
  keyLimits?: Record<string, number>;
  keyOrder?: string[];
  cacheTtlMs?: number;
}

export interface MemoryReadContext {
  text: string;
  totalTokens: number;
  includedKeys: string[];
  omittedKeys: string[];
  duplicateKeys: string[];
  cacheHit: boolean;
}

export const memoryInstructions =
  'The system automatically stores important user information and can update or delete memories based on user requests, enabling dynamic memory management.';

const MEMORY_DECISION_TOOL_NAME = 'apply_memory_changes';
const ANTHROPIC_MEMORY_DEFAULT_THINKING = true;
const DEFAULT_MEMORY_READ_TOKEN_LIMIT = 2200;
const DEFAULT_MEMORY_READ_CACHE_TTL_MS = 30_000;
const DEFAULT_MEMORY_READ_KEY_ORDER = [
  'core',
  'preferences',
  'world',
  'context',
  'working',
  'drafts',
  'signals',
  'moments',
  'me',
];
const DEFAULT_MEMORY_READ_KEY_LIMITS: Record<string, number> = {
  core: 220,
  preferences: 600,
  world: 320,
  context: 320,
  working: 180,
  drafts: 220,
  signals: 200,
  moments: 180,
  me: 160,
};
const MEMORY_WRITER_AUTH_SUPPRESSION_MS = 10 * 60 * 1000;
const MEMORY_WRITER_HEALTH_LOG_INTERVAL_MS = 60 * 1000;

type MemoryEntryLeanLike = {
  _id?: unknown;
  key?: string;
  value?: string;
  tokenCount?: number;
  updated_at?: Date | string;
};

type MemoryReadCacheEntry = MemoryReadContext & {
  expiresAt: number;
};

type MemoryWriterHealthEntry = {
  blockedUntil: number;
  reason: 'auth';
  message: string;
  provider?: string;
  model?: string;
  lastLoggedAt?: number;
};

const memoryReadContextCache = new Map<string, MemoryReadCacheEntry>();
const memoryWriterHealth = new Map<string, MemoryWriterHealthEntry>();

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function approximateTokenCount(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / 4));
}

function sanitizePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveMemoryReadProfile(config: MemoryConfig = {}): Required<MemoryReadProfileConfig> {
  const profile = config.readProfile ?? {};
  return {
    tokenLimit: sanitizePositiveNumber(profile.tokenLimit, DEFAULT_MEMORY_READ_TOKEN_LIMIT),
    keyLimits: {
      ...DEFAULT_MEMORY_READ_KEY_LIMITS,
      ...(profile.keyLimits ?? {}),
    },
    keyOrder:
      Array.isArray(profile.keyOrder) && profile.keyOrder.length > 0
        ? profile.keyOrder.filter((key) => typeof key === 'string' && key.trim())
        : DEFAULT_MEMORY_READ_KEY_ORDER,
    cacheTtlMs: sanitizePositiveNumber(profile.cacheTtlMs, DEFAULT_MEMORY_READ_CACHE_TTL_MS),
  };
}

function getUpdatedAtMs(memory: MemoryEntryLeanLike): number {
  const value = memory.updated_at;
  const ms = value instanceof Date ? value.getTime() : new Date(value ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getMemoryEntryId(memory: MemoryEntryLeanLike): string {
  const value = memory._id;
  if (value == null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function dedupeMemoriesByKey(memories: MemoryEntryLeanLike[]): {
  memories: MemoryEntryLeanLike[];
  duplicateKeys: string[];
} {
  const sorted = [...memories].sort((a, b) => {
    const updatedDiff = getUpdatedAtMs(b) - getUpdatedAtMs(a);
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return getMemoryEntryId(b).localeCompare(getMemoryEntryId(a));
  });
  const byKey = new Map<string, MemoryEntryLeanLike>();
  const duplicateKeys = new Set<string>();
  for (const memory of sorted) {
    const key = typeof memory.key === 'string' ? memory.key.trim() : '';
    if (!key) {
      continue;
    }
    if (byKey.has(key)) {
      duplicateKeys.add(key);
      continue;
    }
    byKey.set(key, memory);
  }
  return { memories: Array.from(byKey.values()), duplicateKeys: Array.from(duplicateKeys).sort() };
}

/* === VIVENTIUM START ===
 * Feature: Memory recall context preservation.
 * Purpose: Keep both the beginning and end of long memory values when applying prompt budgets.
 */
function trimMemoryValueToBudget(value: string, tokenBudget: number): string {
  const trimmed = value.trim();
  if (approximateTokenCount(trimmed) <= tokenBudget) {
    return trimmed;
  }
  const separator = '\n...\n';
  const charBudget = Math.max(16, tokenBudget * 4 - separator.length);
  const headChars = Math.ceil(charBudget / 2);
  const tailChars = Math.floor(charBudget / 2);
  return `${trimmed.slice(0, headChars).trimEnd()}${separator}${trimmed
    .slice(Math.max(0, trimmed.length - tailChars))
    .trimStart()}`;
}
/* === VIVENTIUM END === */

function formatMemoryReadProfile({
  memories,
  config,
}: {
  memories: MemoryEntryLeanLike[];
  config?: MemoryConfig;
}): MemoryReadContext {
  const readProfile = resolveMemoryReadProfile(config);
  const validKeys = new Set(config?.validKeys ?? []);
  const hasValidKeyFilter = validKeys.size > 0;
  const { memories: dedupedMemories, duplicateKeys } = dedupeMemoriesByKey(memories);
  const keyOrderIndex = new Map(readProfile.keyOrder.map((key, index) => [key, index]));
  const eligibleMemories = dedupedMemories
    .filter((memory) => {
      const key = typeof memory.key === 'string' ? memory.key.trim() : '';
      return key && (!hasValidKeyFilter || validKeys.has(key));
    })
    .sort((a, b) => {
      const aKey = String(a.key);
      const bKey = String(b.key);
      const aOrder = keyOrderIndex.get(aKey) ?? Number.MAX_SAFE_INTEGER;
      const bOrder = keyOrderIndex.get(bKey) ?? Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
      return getUpdatedAtMs(b) - getUpdatedAtMs(a);
    });

  const includedKeys: string[] = [];
  const omittedKeys: string[] = [];
  const sections: string[] = [];
  let remainingTokens = readProfile.tokenLimit;

  for (const memory of eligibleMemories) {
    const key = String(memory.key);
    const rawValue = typeof memory.value === 'string' ? memory.value.trim() : '';
    if (!rawValue) {
      continue;
    }
    const keyLimit = sanitizePositiveNumber(
      readProfile.keyLimits[key],
      Math.min(readProfile.tokenLimit, remainingTokens),
    );
    const budget = Math.min(keyLimit, remainingTokens);
    if (budget <= 0) {
      omittedKeys.push(key);
      continue;
    }
    const trimmedValue = trimMemoryValueToBudget(rawValue, budget);
    const usedTokens = Math.min(budget, memory.tokenCount ?? approximateTokenCount(trimmedValue));
    sections.push(`## ${key}\n${trimmedValue}`);
    includedKeys.push(key);
    remainingTokens -= Math.max(1, usedTokens);
    if (approximateTokenCount(rawValue) > budget) {
      omittedKeys.push(`${key}:truncated`);
    }
  }

  const includedSet = new Set(includedKeys);
  for (const memory of eligibleMemories) {
    const key = String(memory.key);
    if (!includedSet.has(key) && !omittedKeys.includes(key)) {
      omittedKeys.push(key);
    }
  }

  return {
    text: sections.join('\n\n'),
    totalTokens: readProfile.tokenLimit - remainingTokens,
    includedKeys,
    omittedKeys,
    duplicateKeys,
    cacheHit: false,
  };
}

function getMemoryReadCacheKey({
  userId,
  config,
}: {
  userId: string | ObjectId;
  config?: MemoryConfig;
}) {
  return `${String(userId)}:${stableStringify({
    validKeys: config?.validKeys,
    readProfile: resolveMemoryReadProfile(config),
  })}`;
}

export function clearMemoryReadContextCache(userId?: string | ObjectId) {
  if (userId == null) {
    memoryReadContextCache.clear();
    return;
  }
  const prefix = `${String(userId)}:`;
  for (const key of memoryReadContextCache.keys()) {
    if (key.startsWith(prefix)) {
      memoryReadContextCache.delete(key);
    }
  }
}

export async function loadMemoryReadContext({
  userId,
  memoryMethods,
  config = {},
}: {
  userId: string | ObjectId;
  memoryMethods: RequiredMemoryMethods;
  config?: MemoryConfig;
}): Promise<MemoryReadContext> {
  const readProfile = resolveMemoryReadProfile(config);
  const cacheKey = getMemoryReadCacheKey({ userId, config });
  const now = Date.now();
  const cached = memoryReadContextCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { ...cached, cacheHit: true };
  }

  const memories = await memoryMethods.getAllUserMemories(userId);
  const context = formatMemoryReadProfile({
    memories: memories as MemoryEntryLeanLike[],
    config: { ...config, readProfile },
  });
  memoryReadContextCache.set(cacheKey, {
    ...context,
    expiresAt: now + readProfile.cacheTtlMs,
  });
  return context;
}

function getErrorField(error: unknown, key: string): unknown {
  if (error == null || typeof error !== 'object') {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

function errorContainsAuthFailure(error: unknown): boolean {
  const status = getErrorField(error, 'status') ?? getErrorField(error, 'statusCode');
  const code = String(getErrorField(error, 'code') ?? '').toLowerCase();
  const type = String(getErrorField(error, 'type') ?? '').toLowerCase();
  const message = String(
    getErrorField(error, 'message') ??
      getErrorField(getErrorField(error, 'error'), 'message') ??
      '',
  ).toLowerCase();

  if (status === 401 || status === '401') {
    return true;
  }
  return (
    code.includes('auth') ||
    type.includes('auth') ||
    message.includes('invalid authentication') ||
    message.includes('authentication') ||
    message.includes('api key')
  );
}

function getMemoryWriterHealthKey({
  userId,
  provider,
  model,
}: {
  userId: string | ObjectId;
  provider?: string;
  model?: string;
}) {
  return [String(userId), provider || 'unknown', model || 'unknown'].join(':');
}

export function clearMemoryWriterHealth({
  userId,
  provider,
  model,
}: {
  userId: string | ObjectId;
  provider?: string;
  model?: string;
}) {
  memoryWriterHealth.delete(getMemoryWriterHealthKey({ userId, provider, model }));
}

export function markMemoryWriterFailure({
  userId,
  provider,
  model,
  error,
}: {
  userId: string | ObjectId;
  provider?: string;
  model?: string;
  error: unknown;
}): MemoryWriterHealthEntry | undefined {
  if (!errorContainsAuthFailure(error)) {
    return undefined;
  }
  const key = getMemoryWriterHealthKey({ userId, provider, model });
  const entry: MemoryWriterHealthEntry = {
    blockedUntil: Date.now() + MEMORY_WRITER_AUTH_SUPPRESSION_MS,
    reason: 'auth',
    message:
      'Saved memory writer authentication failed. Reconnect the memory provider account before retrying durable memory writes.',
    provider,
    model,
  };
  memoryWriterHealth.set(key, entry);
  return entry;
}

export function getMemoryWriterHealthGate({
  userId,
  provider,
  model,
}: {
  userId: string | ObjectId;
  provider?: string;
  model?: string;
}): (MemoryWriterHealthEntry & { blocked: true; shouldLog: boolean }) | { blocked: false } {
  const key = getMemoryWriterHealthKey({ userId, provider, model });
  const entry = memoryWriterHealth.get(key);
  if (!entry) {
    return { blocked: false };
  }
  const now = Date.now();
  if (entry.blockedUntil <= now) {
    memoryWriterHealth.delete(key);
    return { blocked: false };
  }
  const shouldLog =
    entry.lastLoggedAt == null || now - entry.lastLoggedAt >= MEMORY_WRITER_HEALTH_LOG_INTERVAL_MS;
  if (shouldLog) {
    entry.lastLoggedAt = now;
  }
  return { ...entry, blocked: true, shouldLog };
}

const getDefaultInstructions = (
  validKeys?: string[],
  tokenLimit?: number,
) => `Use the \`${MEMORY_DECISION_TOOL_NAME}\` tool to save, delete, or skip durable memory updates, but ONLY when the user has requested you to remember, forget, or update something.

Encode each durable action inside \`operations\`:
  - Use \`{"action":"set","key":"...","value":"..."}\` to create or update a memory key
  - Use \`{"action":"delete","key":"..."}\` only when the entire key should disappear
  - Use \`{"action":"noop","reason":"..."}\` when the current turn does not require any durable memory change

For partial forgetting or corrections, use a \`set\` operation instead of deleting and re-adding the memory. Rewrite the full affected value, remove only the forgotten or corrected detail, and preserve unrelated information.
When the user asks to forget an entity, preference, or project reference, remove obvious aliases, abbreviations, and alternate spellings of that same target across every affected key.

1. ONLY use memory tools when the user requests memory actions with phrases like:
   - "Remember [that] [I]..."
   - "Don't forget [that] [I]..."
   - "Please remember..."
   - "Store this..."
   - "Forget [that] [I]..."
   - "Delete the memory about..."

2. NEVER store information just because the user mentioned it in conversation.

3. NEVER use memory tools when the user asks you to use other tools or invoke tools in general.

4. Memory tools are ONLY for memory requests, not for general tool usage.

5. Call \`${MEMORY_DECISION_TOOL_NAME}\` exactly once per memory run. If no durable change is needed, emit a single \`noop\` operation instead of plain text.

${validKeys && validKeys.length > 0 ? `\nVALID KEYS: ${validKeys.join(', ')}` : ''}

${tokenLimit ? `\nTOKEN LIMIT: Maximum ${tokenLimit} tokens per memory value.` : ''}

When in doubt, and the user hasn't asked to remember or forget anything, emit a single \`noop\` operation and END THE TURN IMMEDIATELY.`;

const getMemoryToolProtocolInstructions = () => `TOOL PROTOCOL OVERRIDE:
- The durable memory tool for this run is \`${MEMORY_DECISION_TOOL_NAME}\`.
- Call \`${MEMORY_DECISION_TOOL_NAME}\` exactly once on every memory run.
- Put every durable write inside \`operations\`.
- Map any prior \`set_memory\` intent to \`{"action":"set","key":"...","value":"..."}\`.
- Map any prior \`delete_memory\` intent to \`{"action":"delete","key":"..."}\`.
- If nothing durable should change, emit exactly one \`{"action":"noop","reason":"..."}\` operation.
- Do not answer in plain text instead of the tool call.`;

/* === VIVENTIUM START ===
 * Feature: Anthropic memory tool-call hygiene
 *
 * Purpose:
 * - Keep Anthropic memory runs compatible with forced tool usage and adaptive-thinking
 *   models without mutating unrelated providers.
 * - Contain retryability classification and thinking-shape sanitization in the memory
 *   owner layer instead of scattering provider-specific patches through call sites.
 * === VIVENTIUM END === */
function describeAnthropicThinkingMode(thinking: unknown): string {
  if (thinking == null) {
    return 'default_enabled';
  }
  if (thinking === false) {
    return 'disabled';
  }
  if (thinking === true) {
    return 'enabled_boolean';
  }
  if (typeof thinking !== 'object' || Array.isArray(thinking)) {
    return 'nonstandard';
  }

  const type =
    typeof (thinking as { type?: unknown }).type === 'string'
      ? String((thinking as { type?: unknown }).type)
      : '';
  return type || 'object';
}

function sanitizeAnthropicMemoryConfig(config: LLMConfig): LLMConfig {
  if ((config as Partial<LLMConfig>).provider !== Providers.ANTHROPIC) {
    return config;
  }

  const configRecord = config as Record<string, unknown>;
  const modelName = typeof configRecord.model === 'string' ? String(configRecord.model) : '';
  const hasExplicitThinking = Object.prototype.hasOwnProperty.call(configRecord, 'thinking');
  const effectiveThinking = hasExplicitThinking
    ? configRecord.thinking
    : ANTHROPIC_MEMORY_DEFAULT_THINKING;
  const sanitized = sanitizeAnthropicTemperatureForThinking({
    ...config,
    thinking: effectiveThinking,
  }) as LLMConfig & {
    thinking?: unknown;
    temperature?: number;
    tool_choice?: unknown;
    invocationKwargs?: Record<string, unknown>;
  };
  const hasForcedToolChoice =
    sanitized.tool_choice != null || sanitized.invocationKwargs?.tool_choice != null;
  const hasActiveThinkingForForcedToolUse =
    hasActiveAnthropicThinking(effectiveThinking) ||
    sanitized.invocationKwargs?.output_config != null;

  if (hasForcedToolChoice && hasActiveThinkingForForcedToolUse) {
    delete sanitized.thinking;

    if (sanitized.invocationKwargs?.output_config != null) {
      const { output_config: _outputConfig, ...remainingInvocationKwargs } =
        sanitized.invocationKwargs;
      sanitized.invocationKwargs = remainingInvocationKwargs;
      if (Object.keys(remainingInvocationKwargs).length === 0) {
        delete sanitized.invocationKwargs;
      }
    }
  }

  if (sanitized.thinking === false) {
    delete sanitized.thinking;
  }

  if (modelName && supportsAdaptiveThinking(modelName) && sanitized.temperature != null) {
    delete sanitized.temperature;
  }

  if (!hasExplicitThinking) {
    delete sanitized.thinking;
  }

  return sanitized;
}

function isRetryableMemoryProcessingError(error: unknown): boolean {
  const typedError = error as
    | {
        status?: number;
        statusCode?: number;
        code?: string | number;
        response?: { status?: number };
        message?: string;
      }
    | undefined;

  const status = typedError?.status ?? typedError?.statusCode ?? typedError?.response?.status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }

  const code = String(typedError?.code ?? '').toUpperCase();
  if (['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  const message = String(typedError?.message ?? '').toLowerCase();
  return (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('network') ||
    message.includes('fetch failed')
  );
}

function buildMemoryErrorArtifact(
  evaluation: ReturnType<typeof evaluateMemoryWrite>,
  currentTotalTokens: number,
): Record<Tools.memory, MemoryArtifact> {
  return {
    [Tools.memory]: {
      key: 'system',
      type: 'error',
      value: JSON.stringify({
        errorType: evaluation.errorType ?? 'validation_failed',
        message: evaluation.message,
        ...(evaluation.details ?? {}),
      }),
      tokenCount: currentTotalTokens,
    },
  };
}

function buildGenericMemoryErrorArtifact(
  message: string,
  currentTotalTokens: number,
  details?: Record<string, unknown>,
): Record<Tools.memory, MemoryArtifact> {
  return {
    [Tools.memory]: {
      key: 'system',
      type: 'error',
      value: JSON.stringify({
        errorType: 'invalid_operation',
        message,
        ...(details ?? {}),
      }),
      tokenCount: currentTotalTokens,
    },
  };
}

/* === VIVENTIUM START ===
 * A model-correctable storage proposal gets one bounded retry only when no write from the batch
 * applied. Keep the retry signal structured so policy failures cannot be mistaken for provider
 * success or inferred from human-facing text.
 */
type MemoryErrorDetails = {
  errorType: string;
  message?: string;
  key?: string;
  keyLimit?: number;
  projectedKeyTokens?: number;
  tokenLimit?: number;
  projectedTotalTokens?: number;
  partialApplied?: boolean;
};

const RETRYABLE_MEMORY_POLICY_ERRORS = new Set([
  'already_exceeded',
  'would_exceed',
  'key_limit_exceeded',
  'key_already_exceeded',
]);

function parseMemoryErrorDetails(artifact?: MemoryArtifact): MemoryErrorDetails | null {
  if (artifact?.type !== 'error' || typeof artifact.value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(artifact.value) as Partial<MemoryErrorDetails>;
    if (typeof parsed.errorType !== 'string' || !parsed.errorType) {
      return null;
    }
    return parsed as MemoryErrorDetails;
  } catch {
    return null;
  }
}

function markMemoryErrorPartialApply(
  artifact: Record<Tools.memory, MemoryArtifact>,
  partialApplied: boolean,
) {
  const details = parseMemoryErrorDetails(artifact[Tools.memory]);
  if (details) {
    artifact[Tools.memory].value = JSON.stringify({ ...details, partialApplied });
  }
  return artifact;
}

function getRetryableMemoryPolicyErrors(
  attachments?: (TAttachment | null)[],
): MemoryErrorDetails[] | null {
  const artifacts = (attachments ?? [])
    .map((attachment) => attachment?.[Tools.memory] as MemoryArtifact | undefined)
    .filter((artifact): artifact is MemoryArtifact => artifact != null);
  const errors = artifacts
    .map((artifact) => parseMemoryErrorDetails(artifact))
    .filter((details): details is MemoryErrorDetails => details != null);
  if (
    errors.length === 0 ||
    artifacts.some((artifact) => artifact.type !== 'error') ||
    errors.some(
      (details) =>
        details.partialApplied === true || !RETRYABLE_MEMORY_POLICY_ERRORS.has(details.errorType),
    )
  ) {
    return null;
  }
  return errors;
}

function buildMemoryPolicyRetryInstruction(errors: MemoryErrorDetails[]): string {
  const limits = errors.map((error) => {
    const fields = [
      `error=${error.errorType}`,
      error.key ? `key=${error.key}` : null,
      Number.isFinite(error.keyLimit) ? `key_limit=${error.keyLimit}` : null,
      Number.isFinite(error.projectedKeyTokens)
        ? `proposed_key_tokens=${error.projectedKeyTokens}`
        : null,
      Number.isFinite(error.tokenLimit) ? `total_limit=${error.tokenLimit}` : null,
      Number.isFinite(error.projectedTotalTokens)
        ? `proposed_total_tokens=${error.projectedTotalTokens}`
        : null,
    ].filter(Boolean);
    return `- ${fields.join(' ')}`;
  });
  return `# Internal memory storage correction
This is runtime policy feedback, not user-authored content. Do not store or quote it.
The previous proposal was rejected before any write applied. Retry exactly once using the original
user request and existing memory. Preserve every unrelated durable fact, remove duplicates and
compress wording as needed, and return full replacement values within every stated limit. Do not
truncate, use placeholders, or invent facts.
${limits.join('\n')}`;
}
/* === VIVENTIUM END === */

type MemoryRuntimeState = {
  tokenCounts: Record<string, number>;
  runningTotalTokens: number;
  revisions: Record<string, number>;
  valueHashes: Record<string, string>;
  revisionProtected: boolean;
};

type MemoryProcessingAttemptState = {
  storageApplied: boolean;
};

const memoryAuditHashKey = randomBytes(32);
const hashMemoryAuditValue = (value: unknown): string =>
  createHmac('sha256', memoryAuditHashKey)
    .update(String(value ?? ''))
    .digest('hex')
    .slice(0, 16);

/* === VIVENTIUM START ===
 * Persist a privacy-safe structured write audit even under the local text logger formatter.
 */
function logMemoryWriteAudit({
  userId,
  key,
  action,
  status,
  beforeHash,
  afterHash,
  auditContext,
}: {
  userId: string | ObjectId;
  key: string;
  action: 'set' | 'delete';
  status: 'applied' | 'conflict' | 'failed';
  beforeHash?: string;
  afterHash?: string;
  auditContext?: MemoryWriteAuditContext;
}) {
  const event = {
    event: 'memory_writer_write',
    userHash: hashMemoryAuditValue(userId),
    conversationHash: auditContext?.conversationId
      ? hashMemoryAuditValue(auditContext.conversationId)
      : undefined,
    messageHash: auditContext?.messageId ? hashMemoryAuditValue(auditContext.messageId) : undefined,
    source: auditContext?.source ?? 'chat',
    key,
    action,
    status,
    beforeHash,
    afterHash,
  };
  // The local non-JSON formatter retains message text but may discard metadata objects.
  logger.info(`[MemoryAgent] write audit ${JSON.stringify(event)}`);
}
/* === VIVENTIUM END === */

function memoryErrorMetadata(error: unknown): Record<string, unknown> {
  const typed = error as
    | { name?: string; code?: string | number; status?: number; statusCode?: number }
    | undefined;
  return {
    errorType: typed?.name ?? 'unknown',
    errorCode: typed?.code,
    errorStatus: typed?.status ?? typed?.statusCode,
  };
}

function createMemoryRuntimeState({
  memoryTokenMap,
  totalTokens = 0,
  memoryRevisionMap,
  memoryValueHashMap,
}: {
  memoryTokenMap?: Record<string, number>;
  totalTokens?: number;
  memoryRevisionMap?: Record<string, number>;
  memoryValueHashMap?: Record<string, string>;
}): MemoryRuntimeState {
  const tokenCounts: Record<string, number> = { ...(memoryTokenMap ?? {}) };
  let runningTotalTokens = totalTokens;

  if (memoryTokenMap) {
    const computedTotal = Object.values(tokenCounts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    if (Number.isFinite(computedTotal) && computedTotal !== runningTotalTokens) {
      runningTotalTokens = computedTotal;
    }
  }

  return {
    tokenCounts,
    runningTotalTokens,
    revisions: { ...(memoryRevisionMap ?? {}) },
    valueHashes: { ...(memoryValueHashMap ?? {}) },
    revisionProtected: memoryRevisionMap !== undefined,
  };
}

/**
 * Creates a memory tool instance with user context
 */
export const createMemoryTool = ({
  userId,
  setMemory,
  validKeys,
  tokenLimit,
  keyLimits,
  memoryTokenMap,
  memoryRevisionMap,
  memoryValueHashMap,
  auditContext,
  totalTokens = 0,
  state,
  attemptState,
}: {
  userId: string | ObjectId;
  setMemory: MemoryMethods['setMemory'];
  validKeys?: string[];
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  memoryTokenMap?: Record<string, number>;
  memoryRevisionMap?: Record<string, number>;
  memoryValueHashMap?: Record<string, string>;
  auditContext?: MemoryWriteAuditContext;
  totalTokens?: number;
  state?: MemoryRuntimeState;
  attemptState?: MemoryProcessingAttemptState;
}): DynamicStructuredTool => {
  /* === VIVENTIUM START ===
   * Fix: Prevent tokenLimit double-counting for per-key overwrites.
   *
   * Problem:
   * - Memory agent writes full replacement values per key (overwrite semantics).
   * - Previous logic treated each write as append-only: newTotal = total + newValueTokens.
   * - This rejects valid overwrites once memories grow, showing "Memory Error" in UI.
   *
   * Solution:
   * - Track per-key token counts and compute delta = newTokens - previousTokens.
   * - Maintain a running total across tool calls within the same memory run.
   *
   * Added: 2026-02-09
   * === VIVENTIUM END === */
  const runtimeState =
    state ??
    createMemoryRuntimeState({
      memoryTokenMap,
      totalTokens,
      memoryRevisionMap,
      memoryValueHashMap,
    });

  return tool(
    async ({ key, value }) => {
      try {
        const preparedValue = prepareMemoryValueForWrite({ key, value, keyLimits });
        const nextValue = preparedValue.value;
        const tokenCount = preparedValue.tokenCount;
        const previousTokenCount = runtimeState.tokenCounts[key] ?? 0;
        const evaluation = evaluateMemoryWrite({
          key,
          value: nextValue,
          tokenCount,
          validKeys,
          tokenLimit,
          keyLimits,
          baselineTotalTokens: runtimeState.runningTotalTokens,
          previousTokenCount,
        });
        if (!evaluation.ok) {
          logger.warn(`Memory Agent failed to set memory for key "${key}": ${evaluation.message}`);
          return [
            evaluation.message ?? `Failed to set memory for key "${key}"`,
            buildMemoryErrorArtifact(evaluation, runtimeState.runningTotalTokens),
          ];
        }

        const tokenDelta = tokenCount - previousTokenCount;
        const artifact: Record<Tools.memory, MemoryArtifact> = {
          [Tools.memory]: {
            key,
            value: nextValue,
            tokenCount,
            type: 'update',
          },
        };

        const beforeHash = runtimeState.valueHashes[key];
        const writeParams = {
          userId,
          key,
          value: nextValue,
          tokenCount,
          ...(runtimeState.revisionProtected
            ? { expectedRevision: runtimeState.revisions[key] ?? null }
            : {}),
        };
        const result = await setMemory(writeParams);
        if (result.ok) {
          if (attemptState) {
            attemptState.storageApplied = true;
          }
          runtimeState.tokenCounts[key] = tokenCount;
          runtimeState.runningTotalTokens += tokenDelta;
          runtimeState.valueHashes[key] = hashMemoryAuditValue(nextValue);
          if (result.revision != null) {
            runtimeState.revisions[key] = result.revision;
            artifact[Tools.memory].revision = result.revision;
          }
          logMemoryWriteAudit({
            userId,
            key,
            action: 'set',
            status: 'applied',
            beforeHash,
            afterHash: runtimeState.valueHashes[key],
            auditContext,
          });
          logger.debug(`Memory set for key "${key}" (${tokenCount} tokens)`);
          return [`Memory set for key "${key}" (${tokenCount} tokens)`, artifact];
        }
        if (result.conflict) {
          const message = `Memory key "${key}" changed while this memory update was running; the stale update was not applied.`;
          logMemoryWriteAudit({
            userId,
            key,
            action: 'set',
            status: 'conflict',
            beforeHash,
            afterHash: hashMemoryAuditValue(nextValue),
            auditContext,
          });
          return [
            message,
            buildGenericMemoryErrorArtifact(message, runtimeState.runningTotalTokens, {
              errorType: 'revision_conflict',
              key,
            }),
          ];
        }
        logMemoryWriteAudit({
          userId,
          key,
          action: 'set',
          status: 'failed',
          beforeHash,
          afterHash: hashMemoryAuditValue(nextValue),
          auditContext,
        });
        logger.warn(`Failed to set memory for key "${key}"`);
        return [`Failed to set memory for key "${key}"`, undefined];
      } catch (error) {
        logMemoryWriteAudit({
          userId,
          key,
          action: 'set',
          status: 'failed',
          beforeHash: runtimeState.valueHashes[key],
          afterHash: hashMemoryAuditValue(value),
          auditContext,
        });
        logger.error('Memory Agent failed to set memory', memoryErrorMetadata(error));
        return [`Error setting memory for key "${key}"`, undefined];
      }
    },
    {
      name: 'set_memory',
      description: 'Saves important information about the user into memory.',
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory value. Must be one of: ${validKeys.join(', ')}`
              : 'The key identifier for this memory',
          ),
        value: z.string().describe(
          /* === VIVENTIUM START ===
           * Memory values in Viventium are often structured multi-line blocks (core/context/moments/etc),
           * not single sentences. Requiring a full replacement value also helps avoid placeholder-based
           * rewrites that silently drop prior memory content.
           * Added: 2026-02-07
           */
          'The full memory value to store for this key. May be multi-line. When updating existing memory, provide the complete updated value (not a diff).',
          /* === VIVENTIUM END === */
        ),
      }),
    },
  );
};

/**
 * Creates a delete memory tool instance with user context
 */
const createDeleteMemoryTool = ({
  userId,
  deleteMemory,
  validKeys,
  memoryTokenMap,
  memoryRevisionMap,
  memoryValueHashMap,
  auditContext,
  totalTokens = 0,
  state,
  attemptState,
}: {
  userId: string | ObjectId;
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  memoryTokenMap?: Record<string, number>;
  memoryRevisionMap?: Record<string, number>;
  memoryValueHashMap?: Record<string, string>;
  auditContext?: MemoryWriteAuditContext;
  totalTokens?: number;
  state?: MemoryRuntimeState;
  attemptState?: MemoryProcessingAttemptState;
}) => {
  const runtimeState =
    state ??
    createMemoryRuntimeState({
      memoryTokenMap,
      totalTokens,
      memoryRevisionMap,
      memoryValueHashMap,
    });

  return tool(
    async ({ key }) => {
      try {
        if (validKeys && validKeys.length > 0 && !validKeys.includes(key)) {
          logger.warn(
            `Memory Agent failed to delete memory: Invalid key "${key}". Must be one of: ${validKeys.join(
              ', ',
            )}`,
          );
          return [`Invalid key "${key}". Must be one of: ${validKeys.join(', ')}`, undefined];
        }

        const artifact: Record<Tools.memory, MemoryArtifact> = {
          [Tools.memory]: {
            key,
            type: 'delete',
          },
        };

        const beforeHash = runtimeState.valueHashes[key];
        const result = await deleteMemory({
          userId,
          key,
          ...(runtimeState.revisionProtected
            ? { expectedRevision: runtimeState.revisions[key] ?? null }
            : {}),
        });
        if (result.ok) {
          if (attemptState) {
            attemptState.storageApplied = true;
          }
          const previousTokenCount = runtimeState.tokenCounts[key] ?? 0;
          delete runtimeState.tokenCounts[key];
          /* === VIVENTIUM START === Keep the tombstone revision for later same-run CAS writes. === */
          if (result.revision != null) {
            runtimeState.revisions[key] = result.revision;
            artifact[Tools.memory].revision = result.revision;
          }
          /* === VIVENTIUM END === */
          delete runtimeState.valueHashes[key];
          runtimeState.runningTotalTokens = Math.max(
            0,
            runtimeState.runningTotalTokens - previousTokenCount,
          );
          logMemoryWriteAudit({
            userId,
            key,
            action: 'delete',
            status: 'applied',
            beforeHash,
            auditContext,
          });
          logger.debug(`Memory deleted for key "${key}"`);
          return [`Memory deleted for key "${key}"`, artifact];
        }
        if (result.conflict) {
          const message = `Memory key "${key}" changed while this memory update was running; the stale delete was not applied.`;
          logMemoryWriteAudit({
            userId,
            key,
            action: 'delete',
            status: 'conflict',
            beforeHash,
            auditContext,
          });
          return [
            message,
            buildGenericMemoryErrorArtifact(message, runtimeState.runningTotalTokens, {
              errorType: 'revision_conflict',
              key,
            }),
          ];
        }
        logMemoryWriteAudit({
          userId,
          key,
          action: 'delete',
          status: 'failed',
          beforeHash,
          auditContext,
        });
        logger.warn(`Failed to delete memory for key "${key}"`);
        return [`Failed to delete memory for key "${key}"`, undefined];
      } catch (error) {
        logMemoryWriteAudit({
          userId,
          key,
          action: 'delete',
          status: 'failed',
          beforeHash: runtimeState.valueHashes[key],
          auditContext,
        });
        logger.error('Memory Agent failed to delete memory', memoryErrorMetadata(error));
        return [`Error deleting memory for key "${key}"`, undefined];
      }
    },
    {
      name: 'delete_memory',
      description:
        'Deletes an entire memory key for the user. Only use when the whole key should be removed; for partial forgetting or corrections, rewrite the full updated value with `set_memory` instead.',
      responseFormat: 'content_and_artifact',
      schema: z.object({
        key: z
          .string()
          .describe(
            validKeys && validKeys.length > 0
              ? `The key of the memory to delete. Must be one of: ${validKeys.join(', ')}`
              : 'The key identifier of the memory to delete',
          ),
      }),
    },
  );
};

const createNoopMemoryTool = () =>
  tool(async () => ['No durable memory update needed for this turn', undefined], {
    name: 'noop_memory',
    description:
      'Use this when the current chat does not require any durable memory changes. If the user explicitly asked you to remember, store, forget, delete, or update memory, do not use this tool.',
    responseFormat: 'content_and_artifact',
    schema: z.object({
      reason: z
        .string()
        .optional()
        .describe('Optional short reason why no durable memory update is needed.'),
    }),
  });

export const createApplyMemoryChangesTool = ({
  userId,
  setMemory,
  deleteMemory,
  validKeys,
  tokenLimit,
  keyLimits,
  memoryTokenMap,
  memoryRevisionMap,
  memoryValueHashMap,
  auditContext,
  totalTokens = 0,
  attemptState,
}: {
  userId: string | ObjectId;
  setMemory: MemoryMethods['setMemory'];
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  memoryTokenMap?: Record<string, number>;
  memoryRevisionMap?: Record<string, number>;
  memoryValueHashMap?: Record<string, string>;
  auditContext?: MemoryWriteAuditContext;
  totalTokens?: number;
  attemptState?: MemoryProcessingAttemptState;
}) => {
  const runtimeState = createMemoryRuntimeState({
    memoryTokenMap,
    totalTokens,
    memoryRevisionMap,
    memoryValueHashMap,
  });
  const setMemoryTool = createMemoryTool({
    userId,
    setMemory,
    validKeys,
    tokenLimit,
    keyLimits,
    state: runtimeState,
    auditContext,
    attemptState,
  });
  const deleteMemoryTool = createDeleteMemoryTool({
    userId,
    deleteMemory,
    validKeys,
    state: runtimeState,
    auditContext,
    attemptState,
  });
  const noopMemoryTool = createNoopMemoryTool();

  return tool(
    async ({ operations }) => {
      const normalizedOperations = Array.isArray(operations) ? operations : [];
      if (normalizedOperations.length === 0) {
        return [
          'At least one memory operation is required.',
          buildGenericMemoryErrorArtifact(
            'At least one memory operation is required.',
            runtimeState.runningTotalTokens,
          ),
        ];
      }

      const summaries: string[] = [];
      let primaryArtifact: Record<Tools.memory, MemoryArtifact> | undefined;
      let errorArtifact: Record<Tools.memory, MemoryArtifact> | undefined;
      let appliedCount = 0;

      for (const operation of normalizedOperations) {
        const action = operation?.action;
        let result: [string, Record<Tools.memory, MemoryArtifact> | undefined] | undefined;

        if (action === 'set') {
          if (
            typeof operation?.key !== 'string' ||
            operation.key.trim().length === 0 ||
            typeof operation?.value !== 'string'
          ) {
            result = [
              'Set operations require both key and value.',
              buildGenericMemoryErrorArtifact(
                'Set operations require both key and value.',
                runtimeState.runningTotalTokens,
                {
                  action,
                },
              ),
            ];
          } else {
            result = (await setMemoryTool.func({
              key: operation.key,
              value: operation.value,
            })) as [string, Record<Tools.memory, MemoryArtifact> | undefined];
          }
        } else if (action === 'delete') {
          if (typeof operation?.key !== 'string' || operation.key.trim().length === 0) {
            result = [
              'Delete operations require a key.',
              buildGenericMemoryErrorArtifact(
                'Delete operations require a key.',
                runtimeState.runningTotalTokens,
                {
                  action,
                },
              ),
            ];
          } else {
            result = (await deleteMemoryTool.func({
              key: operation.key,
            })) as [string, Record<Tools.memory, MemoryArtifact> | undefined];
          }
        } else if (action === 'noop') {
          result = (await noopMemoryTool.func({
            reason: operation?.reason,
          })) as [string, Record<Tools.memory, MemoryArtifact> | undefined];
        } else {
          result = [
            `Unsupported memory action "${String(action ?? '')}"`,
            buildGenericMemoryErrorArtifact(
              `Unsupported memory action "${String(action ?? '')}"`,
              runtimeState.runningTotalTokens,
            ),
          ];
        }

        if (!result) {
          continue;
        }

        if (result[0]) {
          summaries.push(result[0]);
        }

        const memoryArtifact = result[1]?.[Tools.memory];
        if (memoryArtifact?.type === 'error') {
          errorArtifact ??= result[1];
          break;
        } else if (memoryArtifact?.type === 'update' || memoryArtifact?.type === 'delete') {
          appliedCount += 1;
          primaryArtifact ??= result[1];
        } else if ((action === 'set' || action === 'delete') && result[1] == null) {
          errorArtifact ??= buildGenericMemoryErrorArtifact(
            result[0] || `Failed to ${action} memory`,
            runtimeState.runningTotalTokens,
            {
              errorType: 'write_failed',
              action,
              key: operation?.key,
            },
          );
          break;
        }
      }

      return [
        summaries.filter(Boolean).join('\n') || 'No durable memory update needed for this turn',
        errorArtifact != null
          ? markMemoryErrorPartialApply(errorArtifact, appliedCount > 0)
          : primaryArtifact,
      ];
    },
    {
      name: MEMORY_DECISION_TOOL_NAME,
      description:
        'Apply one or more durable memory operations for the user. Call this exactly once per memory run, using set, delete, or noop operations.',
      responseFormat: 'content_and_artifact',
      schema: z.object({
        operations: z
          .array(
            z.object({
              action: z.enum(['set', 'delete', 'noop']),
              key: z
                .string()
                .optional()
                .describe(
                  validKeys && validKeys.length > 0
                    ? `The memory key. Must be one of: ${validKeys.join(', ')}`
                    : 'The memory key to modify',
                ),
              value: z
                .string()
                .optional()
                .describe(
                  'For set operations, the full memory value to store for this key. May be multi-line.',
                ),
              reason: z.string().optional().describe('Optional short reason for noop operations.'),
            }),
          )
          .min(1)
          .describe('Ordered durable memory operations for this turn.'),
      }),
    },
  );
};

const resolveMemoryToolChoice = (provider?: string): string | undefined => {
  const normalized = String(provider ?? '')
    .trim()
    .toLowerCase();

  switch (normalized) {
    case 'openai':
    case 'azureopenai':
    case 'anthropic':
    case 'google':
    case 'vertexai':
      return MEMORY_DECISION_TOOL_NAME;
    default:
      return undefined;
  }
};

const preserveForcedToolChoice = ({
  provider,
  llmConfig,
  toolChoice,
}: {
  provider?: string;
  llmConfig: LLMConfig;
  toolChoice: string;
}): void => {
  const normalized = String(provider ?? '')
    .trim()
    .toLowerCase();

  if (normalized === 'openai' || normalized === 'azureopenai') {
    const openAIConfig = llmConfig as OpenAIClientOptions;
    const usesResponsesApi =
      openAIConfig.useResponsesApi === true ||
      /\bgpt-[5-9](?:\.\d+)?\b/i.test(String(openAIConfig.model ?? ''));
    const preservedToolChoice = usesResponsesApi
      ? {
          type: 'function',
          name: toolChoice,
        }
      : {
          type: 'function',
          function: {
            name: toolChoice,
          },
        };
    openAIConfig.modelKwargs = {
      ...(openAIConfig.modelKwargs ?? {}),
      tool_choice: preservedToolChoice,
    };
    return;
  }

  if (normalized === 'anthropic') {
    const anthropicConfig = llmConfig as {
      invocationKwargs?: Record<string, unknown>;
    };
    anthropicConfig.invocationKwargs = {
      ...(anthropicConfig.invocationKwargs ?? {}),
      tool_choice: {
        type: 'tool',
        name: toolChoice,
      },
    };
  }
};

export class BasicToolEndHandler implements EventHandler {
  private callback?: ToolEndCallback;
  constructor(callback?: ToolEndCallback) {
    this.callback = callback;
  }

  handle(
    event: string,
    data: StreamEventData | undefined,
    metadata?: Record<string, unknown>,
  ): void {
    if (!metadata) {
      console.warn(`Graph or metadata not found in ${event} event`);
      return;
    }
    const toolEndData = data as ToolEndData | undefined;
    if (!toolEndData?.output) {
      console.warn('No output found in tool_end event');
      return;
    }
    this.callback?.(toolEndData, metadata);
  }
}

export async function processMemory({
  res,
  userId,
  setMemory,
  deleteMemory,
  messages,
  memory,
  messageId,
  conversationId,
  validKeys,
  instructions,
  llmConfig,
  tokenLimit,
  keyLimits,
  memoryTokenMap,
  memoryRevisionMap,
  memoryValueHashMap,
  auditContext,
  totalTokens = 0,
  streamId = null,
  deferArtifactDelivery = false,
  user,
}: {
  res: ServerResponse;
  setMemory: MemoryMethods['setMemory'];
  deleteMemory: MemoryMethods['deleteMemory'];
  userId: string | ObjectId;
  memory: string;
  messageId: string;
  conversationId: string;
  messages: BaseMessage[];
  validKeys?: string[];
  instructions: string;
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  memoryTokenMap?: Record<string, number>;
  memoryRevisionMap?: Record<string, number>;
  memoryValueHashMap?: Record<string, string>;
  auditContext?: MemoryWriteAuditContext;
  totalTokens?: number;
  llmConfig?: Partial<LLMConfig>;
  streamId?: string | null;
  deferArtifactDelivery?: boolean;
  user?: IUser;
}): Promise<(TAttachment | null)[] | undefined> {
  try {
    const attemptState: MemoryProcessingAttemptState = { storageApplied: false };
    const resolvedKeyLimits = resolveMemoryKeyLimits(keyLimits);
    const memoryTool = createMemoryTool({
      userId,
      tokenLimit,
      keyLimits: resolvedKeyLimits,
      setMemory,
      validKeys,
      memoryTokenMap,
      memoryRevisionMap,
      memoryValueHashMap,
      auditContext,
      totalTokens,
      attemptState,
    });
    const deleteMemoryTool = createDeleteMemoryTool({
      userId,
      validKeys,
      deleteMemory,
      memoryTokenMap,
      memoryRevisionMap,
      memoryValueHashMap,
      auditContext,
      totalTokens,
      attemptState,
    });
    const noopMemoryTool = createNoopMemoryTool();
    const applyMemoryChangesTool = createApplyMemoryChangesTool({
      userId,
      setMemory,
      deleteMemory,
      validKeys,
      tokenLimit,
      keyLimits: resolvedKeyLimits,
      memoryTokenMap,
      memoryRevisionMap,
      memoryValueHashMap,
      auditContext,
      totalTokens,
      attemptState,
    });

    const currentMemoryTokens = totalTokens;

    let memoryStatus = `# Existing memory:\n${memory ?? 'No existing memories'}`;

    if (tokenLimit) {
      const remainingTokens = tokenLimit - currentMemoryTokens;
      memoryStatus = `# Memory Status:
Current memory usage: ${currentMemoryTokens} tokens
Token limit: ${tokenLimit} tokens
Remaining capacity: ${remainingTokens} tokens

# Existing memory:
${memory ?? 'No existing memories'}`;
    }
    if (resolvedKeyLimits && Object.keys(resolvedKeyLimits).length > 0) {
      const perKeyStatus = Object.entries(resolvedKeyLimits)
        .map(([memoryKey, limit]) => {
          const current = memoryTokenMap?.[memoryKey] ?? 0;
          const delta = current - limit;
          const status =
            delta > 0 ? `OVER by ${delta}` : `${Math.max(0, limit - current)} remaining`;
          return `- ${memoryKey}: ${current}/${limit} (${status})`;
        })
        .join('\n');
      memoryStatus = `${memoryStatus}\n\nPer-key budgets:\n${perKeyStatus}`;
    }

    const defaultLLMConfig: LLMConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4.1-mini',
      temperature: 0.4,
      streaming: false,
      disableStreaming: true,
    };

    const finalLLMConfig = {
      ...defaultLLMConfig,
      ...normalizeMemoryLLMConfig(llmConfig),
      /**
       * Ensure streaming is always disabled for memory processing
       */
      streaming: false,
      disableStreaming: true,
    } as LLMConfig;

    const memoryProvider = (finalLLMConfig as Partial<LLMConfig>).provider ?? llmConfig?.provider;
    const toolChoice = resolveMemoryToolChoice(memoryProvider);
    if (toolChoice != null) {
      (finalLLMConfig as Record<string, unknown>).tool_choice = toolChoice;
      preserveForcedToolChoice({
        provider: memoryProvider,
        llmConfig: finalLLMConfig,
        toolChoice,
      });
    }

    // Handle GPT-5+ models
    if ('model' in finalLLMConfig && /\bgpt-[5-9](?:\.\d+)?\b/i.test(finalLLMConfig.model ?? '')) {
      // Remove temperature for GPT-5+ models
      delete finalLLMConfig.temperature;

      // Move maxTokens to modelKwargs for GPT-5+ models
      if ('maxTokens' in finalLLMConfig && finalLLMConfig.maxTokens != null) {
        const modelKwargs = (finalLLMConfig as OpenAIClientOptions).modelKwargs ?? {};
        const paramName =
          (finalLLMConfig as OpenAIClientOptions).useResponsesApi === true
            ? 'max_output_tokens'
            : 'max_completion_tokens';
        modelKwargs[paramName] = finalLLMConfig.maxTokens;
        delete finalLLMConfig.maxTokens;
        (finalLLMConfig as OpenAIClientOptions).modelKwargs = modelKwargs;
      }
    }

    const bedrockConfig = finalLLMConfig as {
      additionalModelRequestFields?: { thinking?: unknown };
      temperature?: number;
    };
    if (
      llmConfig?.provider === Providers.BEDROCK &&
      bedrockConfig.additionalModelRequestFields?.thinking != null &&
      bedrockConfig.temperature != null
    ) {
      (finalLLMConfig as unknown as Record<string, unknown>).temperature = 1;
    }

    if (llmConfig?.provider === Providers.ANTHROPIC) {
      const anthropicConfig = finalLLMConfig as {
        thinking?: unknown;
        temperature?: number;
      };
      const hadTemperature = anthropicConfig.temperature != null;
      const sanitizedAnthropicConfig = sanitizeAnthropicMemoryConfig(finalLLMConfig);
      const removedTemperature =
        hadTemperature &&
        (sanitizedAnthropicConfig as { temperature?: number }).temperature == null;
      const clearedThinking =
        Object.prototype.hasOwnProperty.call(
          finalLLMConfig as Record<string, unknown>,
          'thinking',
        ) &&
        !Object.prototype.hasOwnProperty.call(
          sanitizedAnthropicConfig as Record<string, unknown>,
          'thinking',
        );
      if (removedTemperature) {
        delete (finalLLMConfig as Record<string, unknown>).temperature;
      }
      if (clearedThinking) {
        delete (finalLLMConfig as Record<string, unknown>).thinking;
      }
      Object.assign(finalLLMConfig as Record<string, unknown>, sanitizedAnthropicConfig);
      if (removedTemperature) {
        logger.info('[MemoryAgent] Removed Anthropic temperature for memory run', {
          /* === VIVENTIUM START === Hash private identifiers in memory-agent telemetry. === */
          userHash: hashMemoryAuditValue(userId),
          conversationHash: hashMemoryAuditValue(conversationId),
          messageHash: hashMemoryAuditValue(messageId),
          /* === VIVENTIUM END === */
          model:
            'model' in sanitizedAnthropicConfig
              ? (sanitizedAnthropicConfig.model as string | undefined)
              : undefined,
          thinkingMode: describeAnthropicThinkingMode(anthropicConfig.thinking),
        });
      }
    }

    const llmConfigWithHeaders = finalLLMConfig as OpenAIClientOptions;
    if (llmConfigWithHeaders?.configuration?.defaultHeaders != null) {
      llmConfigWithHeaders.configuration.defaultHeaders = resolveHeaders({
        headers: llmConfigWithHeaders.configuration.defaultHeaders as Record<string, string>,
        user: user ? createSafeUser(user) : undefined,
      });
    }

    const artifactPromises: Promise<TAttachment | null>[] = [];
    const memoryCallback = createMemoryCallback({
      res,
      artifactPromises,
      streamId,
      deferDelivery: deferArtifactDelivery,
    });
    const customHandlers = {
      [GraphEvents.TOOL_END]: new BasicToolEndHandler(memoryCallback),
    };

    /**
     * For Bedrock provider, include instructions in the user message instead of as a system prompt.
     * Bedrock's Converse API requires conversations to start with a user message, not a system message.
     * Other providers can use the standard system prompt approach.
     */
    const isBedrock = llmConfig?.provider === Providers.BEDROCK;

    let graphInstructions: string | undefined = instructions;
    let graphAdditionalInstructions: string | undefined = memoryStatus;
    let processedMessages = messages;

    if (isBedrock) {
      const combinedInstructions = [instructions, memoryStatus].filter(Boolean).join('\n\n');

      if (messages.length > 0) {
        const firstMessage = messages[0];
        const originalContent =
          typeof firstMessage.content === 'string' ? firstMessage.content : '';

        if (typeof firstMessage.content !== 'string') {
          logger.warn(
            'Bedrock memory processing: First message has non-string content, using empty string',
          );
        }

        const bedrockUserMessage = new HumanMessage(
          `${combinedInstructions}\n\n${originalContent}`,
        );
        processedMessages = [bedrockUserMessage, ...messages.slice(1)];
      } else {
        processedMessages = [new HumanMessage(combinedInstructions)];
      }

      graphInstructions = undefined;
      graphAdditionalInstructions = undefined;
    }

    const run = await Run.create({
      runId: messageId,
      graphConfig: {
        type: 'standard',
        llmConfig: finalLLMConfig,
        tools: [applyMemoryChangesTool, memoryTool, deleteMemoryTool, noopMemoryTool],
        instructions: graphInstructions,
        additional_instructions: graphAdditionalInstructions,
        toolEnd: true,
      },
      customHandlers,
      returnContent: true,
    });

    const config = {
      runName: 'MemoryRun',
      configurable: {
        user_id: userId,
        thread_id: conversationId,
        provider: llmConfig?.provider,
      },
      streamMode: 'values',
      recursionLimit: 3,
      version: 'v2',
    } as const;

    const inputs = {
      messages: processedMessages,
    };
    let content;
    try {
      content = await run.processStream(inputs, config);
    } catch (error) {
      if (!isRetryableMemoryProcessingError(error) || attemptState.storageApplied) {
        throw error;
      }

      logger.warn('[MemoryAgent] Retrying memory run after retryable upstream error', {
        /* === VIVENTIUM START === Hash private identifiers in memory-agent telemetry. === */
        userHash: hashMemoryAuditValue(userId),
        conversationHash: hashMemoryAuditValue(conversationId),
        messageHash: hashMemoryAuditValue(messageId),
        /* === VIVENTIUM END === */
        provider: llmConfig?.provider,
        model:
          llmConfig != null && 'model' in llmConfig
            ? (llmConfig.model as string | undefined)
            : undefined,
      });
      content = await run.processStream(inputs, config);
    }
    if (content) {
      clearMemoryWriterHealth({
        userId,
        provider: llmConfig?.provider,
        model:
          llmConfig != null && 'model' in llmConfig
            ? (llmConfig.model as string | undefined)
            : undefined,
      });
      logger.debug('[MemoryAgent] Provider run completed', {
        /* === VIVENTIUM START === Hash private identifiers in memory-agent telemetry. === */
        userHash: hashMemoryAuditValue(userId),
        conversationHash: hashMemoryAuditValue(conversationId),
        messageHash: hashMemoryAuditValue(messageId),
        /* === VIVENTIUM END === */
        provider: llmConfig?.provider,
      });
    } else {
      logger.debug('[MemoryAgent] Returned no content', {
        /* === VIVENTIUM START === Hash private identifiers in memory-agent telemetry. === */
        userHash: hashMemoryAuditValue(userId),
        conversationHash: hashMemoryAuditValue(conversationId),
        messageHash: hashMemoryAuditValue(messageId),
        /* === VIVENTIUM END === */
      });
    }
    return await Promise.all(artifactPromises);
  } catch (error) {
    const typedError = error as { message?: string; code?: string; type?: string } | undefined;
    const configuredModel =
      llmConfig != null && 'model' in llmConfig
        ? (llmConfig.model as string | undefined)
        : undefined;
    const anthropicThinking =
      llmConfig?.provider === Providers.ANTHROPIC
        ? ((llmConfig as Record<string, unknown>).thinking ?? ANTHROPIC_MEMORY_DEFAULT_THINKING)
        : undefined;
    const healthEntry = markMemoryWriterFailure({
      userId,
      provider: llmConfig?.provider,
      model: configuredModel,
      error,
    });
    logger.error(
      `[MemoryAgent] Failed to process memory | userHash=${hashMemoryAuditValue(userId)} | conversationHash=${hashMemoryAuditValue(conversationId)} | messageHash=${hashMemoryAuditValue(messageId)} | provider=${String(llmConfig?.provider ?? 'unknown')} | model=${configuredModel ?? 'unknown'} | thinkingMode=${anthropicThinking == null ? 'n/a' : describeAnthropicThinkingMode(anthropicThinking)} | temperature=${String((llmConfig as { temperature?: unknown } | undefined)?.temperature ?? 'unset')} | errorType=${typedError?.type ?? 'unknown'} | errorCode=${typedError?.code ?? 'unknown'}`,
      {
        provider: llmConfig?.provider,
        model: configuredModel,
        errorCode: typedError?.code,
        errorType: typedError?.type,
        memoryWriterHealth: healthEntry
          ? {
              reason: healthEntry.reason,
              blockedUntil: new Date(healthEntry.blockedUntil).toISOString(),
            }
          : undefined,
      },
    );
  }
}

export async function loadMemorySnapshot({
  userId,
  memoryMethods,
  config = {},
}: {
  userId: string | ObjectId;
  memoryMethods: RequiredMemoryMethods;
  config?: MemoryConfig;
}): Promise<MemorySnapshot> {
  const { validKeys, tokenLimit, keyLimits, maintenanceThresholdPercent } = config;
  /* === VIVENTIUM START ===
   * Feature: Deterministic memory maintenance before memory-agent execution
   *
   * Purpose:
   * - Compact overgrown keys and remove operational residue before the memory agent
   *   reads the current store.
   * - This keeps the memory agent aligned with the actual writable budget and reduces
   *   repeated write failures once memory pressure builds up.
   *
   * Added: 2026-03-09
   * === VIVENTIUM END === */
  await runMemoryMaintenance({
    userId: String(userId),
    getAllUserMemories: async (resolvedUserId) => memoryMethods.getAllUserMemories(resolvedUserId),
    setMemory: async ({ userId: maintenanceUserId, key, value, tokenCount, expectedRevision }) =>
      memoryMethods.setMemory({
        userId: maintenanceUserId,
        key,
        value,
        tokenCount,
        expectedRevision,
      }),
    policy: {
      validKeys,
      tokenLimit,
      keyLimits,
      maintenanceThresholdPercent,
    },
  });

  /* === VIVENTIUM START ===
   * User prompt text sees active rows only; writer CAS state also retains deleted-key revisions.
   */
  const states = await memoryMethods.getAllUserMemoryStates(userId);
  const entries = (states ?? []).filter((entry) => !entry.deletedAt);
  const formatted = await memoryMethods.getFormattedMemories({ userId, memories: entries });
  const memoryRevisionMap: Record<string, number> = {};
  const memoryValueHashMap: Record<string, string> = {};
  for (const entry of states ?? []) {
    if (!entry?.key) {
      continue;
    }
    memoryRevisionMap[entry.key] = Number(entry.__v ?? 0);
    if (!entry.deletedAt) {
      memoryValueHashMap[entry.key] = hashMemoryAuditValue(entry.value);
    }
  }
  return {
    withKeys: formatted.withKeys ?? '',
    withoutKeys: formatted.withoutKeys ?? '',
    totalTokens: formatted.totalTokens ?? 0,
    memoryTokenMap: formatted.memoryTokenMap ?? {},
    memoryRevisionMap,
    memoryValueHashMap,
  };
  /* === VIVENTIUM END === */
}

export async function createMemoryProcessor({
  res,
  userId,
  messageId,
  memoryMethods,
  conversationId,
  config = {},
  streamId = null,
  user,
  snapshot,
  auditSource = 'chat',
}: {
  res: ServerResponse;
  messageId: string;
  conversationId: string;
  userId: string | ObjectId;
  memoryMethods: RequiredMemoryMethods;
  config?: MemoryConfig;
  streamId?: string | null;
  user?: IUser;
  snapshot?: MemorySnapshot;
  auditSource?: string;
}): Promise<[string, (messages: BaseMessage[]) => Promise<(TAttachment | null)[] | undefined>]> {
  const { validKeys, instructions, llmConfig, tokenLimit, keyLimits } = config;
  const finalInstructions = [
    instructions || getDefaultInstructions(validKeys, tokenLimit),
    getMemoryToolProtocolInstructions(),
  ]
    .filter(Boolean)
    .join('\n\n');
  const preparedSnapshot =
    snapshot ??
    (await loadMemorySnapshot({
      userId,
      memoryMethods,
      config,
    }));
  const {
    withKeys,
    withoutKeys,
    totalTokens,
    memoryTokenMap,
    memoryRevisionMap,
    memoryValueHashMap,
  } = preparedSnapshot;

  return [
    withoutKeys,
    async function (messages: BaseMessage[]): Promise<(TAttachment | null)[] | undefined> {
      try {
        const runAttempt = (attemptMessages: BaseMessage[]) =>
          processMemory({
            res,
            userId,
            messages: attemptMessages,
            validKeys,
            llmConfig,
            keyLimits,
            messageId,
            tokenLimit,
            memoryTokenMap: memoryTokenMap ?? {},
            memoryRevisionMap: memoryRevisionMap ?? {},
            memoryValueHashMap: memoryValueHashMap ?? {},
            auditContext: {
              source: auditSource,
              conversationId,
              messageId,
            },
            streamId,
            deferArtifactDelivery: true,
            conversationId,
            memory: withKeys,
            totalTokens: totalTokens || 0,
            instructions: finalInstructions,
            setMemory: memoryMethods.setMemory,
            deleteMemory: memoryMethods.deleteMemory,
            user,
          });

        let attachments = await runAttempt(messages);
        const retryableErrors = getRetryableMemoryPolicyErrors(attachments);
        if (retryableErrors) {
          logger.warn(
            `[MemoryAgent] Retrying rejected storage proposal | userHash=${hashMemoryAuditValue(userId)} | conversationHash=${hashMemoryAuditValue(conversationId)} | messageHash=${hashMemoryAuditValue(messageId)} | errors=${retryableErrors.map((error) => error.errorType).join(',')}`,
          );
          const correctedAttachments = await runAttempt([
            ...messages,
            new HumanMessage(buildMemoryPolicyRetryInstruction(retryableErrors)),
          ]);
          const correctionHasFinalOutcome = (correctedAttachments ?? []).some((attachment) => {
            const type = attachment?.[Tools.memory]?.type;
            return type === 'update' || type === 'delete' || type === 'error';
          });
          if (correctionHasFinalOutcome) {
            attachments = correctedAttachments;
          } else {
            logger.warn(
              `[MemoryAgent] Correction returned no durable outcome; preserving rejection | userHash=${hashMemoryAuditValue(userId)} | conversationHash=${hashMemoryAuditValue(conversationId)} | messageHash=${hashMemoryAuditValue(messageId)}`,
            );
          }
        }
        deliverDeferredMemoryAttachments({ res, streamId, attachments });
        return attachments;
      } catch (error) {
        logger.error('Memory Agent failed to process memory', error);
      }
    },
  ];
}

async function handleMemoryArtifact({
  res,
  data,
  metadata,
  streamId = null,
  deferDelivery = false,
}: {
  res: ServerResponse;
  data: ToolEndData;
  metadata?: ToolEndMetadata;
  streamId?: string | null;
  deferDelivery?: boolean;
}) {
  const output = data?.output as ToolMessage | undefined;
  if (!output) {
    return null;
  }

  if (!output.artifact) {
    return null;
  }

  const memoryArtifact = output.artifact[Tools.memory] as MemoryArtifact | undefined;
  if (!memoryArtifact) {
    return null;
  }

  const attachment: Partial<TAttachment> = {
    type: Tools.memory,
    toolCallId: output.tool_call_id,
    messageId: metadata?.run_id ?? '',
    conversationId: metadata?.thread_id ?? '',
    [Tools.memory]: memoryArtifact,
  };
  if (deferDelivery || !res.headersSent) {
    return attachment;
  }
  if (streamId) {
    GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
  return attachment;
}

function deliverDeferredMemoryAttachments({
  res,
  streamId,
  attachments,
}: {
  res: ServerResponse;
  streamId?: string | null;
  attachments?: (TAttachment | null)[];
}) {
  if (!res.headersSent) {
    return;
  }
  for (const attachment of attachments ?? []) {
    if (!attachment) {
      continue;
    }
    if (streamId) {
      GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
    } else {
      res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
    }
  }
}

/**
 * Creates a memory callback for handling memory artifacts
 * @param params - The parameters object
 * @param params.res - The server response object
 * @param params.artifactPromises - Array to collect artifact promises
 * @param params.streamId - The stream ID for resumable mode, or null for standard mode
 * @returns The memory callback function
 */
export function createMemoryCallback({
  res,
  artifactPromises,
  streamId = null,
  deferDelivery = false,
}: {
  res: ServerResponse;
  artifactPromises: Promise<Partial<TAttachment> | null>[];
  streamId?: string | null;
  deferDelivery?: boolean;
}): ToolEndCallback {
  return async (data: ToolEndData, metadata?: Record<string, unknown>) => {
    const output = data?.output as ToolMessage | undefined;
    const memoryArtifact = output?.artifact?.[Tools.memory] as MemoryArtifact;
    if (memoryArtifact == null) {
      return;
    }
    artifactPromises.push(
      handleMemoryArtifact({ res, data, metadata, streamId, deferDelivery }).catch((error) => {
        logger.error('Error processing memory artifact content:', error);
        return null;
      }),
    );
  };
}
