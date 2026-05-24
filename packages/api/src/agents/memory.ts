/** Memories */
import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import { Tools, supportsAdaptiveThinking } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import { HumanMessage } from '@langchain/core/messages';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import type { MemoryKeyLimits } from '~/memory';
import type {
  OpenAIClientOptions,
  StreamEventData,
  ToolEndCallback,
  ClientOptions,
  EventHandler,
  ToolEndData,
  LLMConfig,
} from '@librechat/agents';
import type { ObjectId, MemoryMethods, IUser } from '@librechat/data-schemas';
import type { TAttachment, MemoryArtifact } from 'librechat-data-provider';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
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

type RequiredMemoryMethods = Pick<
  MemoryMethods,
  'setMemory' | 'deleteMemory' | 'getFormattedMemories' | 'getAllUserMemories'
>;

type ToolEndMetadata = Record<string, unknown> & {
  run_id?: string;
  thread_id?: string;
};

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
const DEFAULT_MEMORY_READ_TOKEN_LIMIT = 1800;
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
  preferences: 180,
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

function trimMemoryValueToBudget(value: string, tokenBudget: number): string {
  if (approximateTokenCount(value) <= tokenBudget) {
    return value.trim();
  }
  const charBudget = Math.max(16, tokenBudget * 4 - 3);
  return `${value.slice(0, charBudget).trimEnd()}...`;
}

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

function sanitizeAnthropicMemoryConfig(config: ClientOptions): ClientOptions {
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
  }) as ClientOptions & {
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

type MemoryRuntimeState = {
  tokenCounts: Record<string, number>;
  runningTotalTokens: number;
};

function createMemoryRuntimeState({
  memoryTokenMap,
  totalTokens = 0,
}: {
  memoryTokenMap?: Record<string, number>;
  totalTokens?: number;
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
  totalTokens = 0,
  state,
}: {
  userId: string | ObjectId;
  setMemory: MemoryMethods['setMemory'];
  validKeys?: string[];
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  memoryTokenMap?: Record<string, number>;
  totalTokens?: number;
  state?: MemoryRuntimeState;
}) => {
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

        const result = await setMemory({ userId, key, value: nextValue, tokenCount });
        if (result.ok) {
          runtimeState.tokenCounts[key] = tokenCount;
          runtimeState.runningTotalTokens += tokenDelta;
          logger.debug(`Memory set for key "${key}" (${tokenCount} tokens) for user "${userId}"`);
          return [`Memory set for key "${key}" (${tokenCount} tokens)`, artifact];
        }
        logger.warn(`Failed to set memory for key "${key}" for user "${userId}"`);
        return [`Failed to set memory for key "${key}"`, undefined];
      } catch (error) {
        logger.error('Memory Agent failed to set memory', error);
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
  totalTokens = 0,
  state,
}: {
  userId: string | ObjectId;
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  memoryTokenMap?: Record<string, number>;
  totalTokens?: number;
  state?: MemoryRuntimeState;
}) => {
  const runtimeState =
    state ??
    createMemoryRuntimeState({
      memoryTokenMap,
      totalTokens,
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

        const result = await deleteMemory({ userId, key });
        if (result.ok) {
          const previousTokenCount = runtimeState.tokenCounts[key] ?? 0;
          delete runtimeState.tokenCounts[key];
          runtimeState.runningTotalTokens = Math.max(
            0,
            runtimeState.runningTotalTokens - previousTokenCount,
          );
          logger.debug(`Memory deleted for key "${key}" for user "${userId}"`);
          return [`Memory deleted for key "${key}"`, artifact];
        }
        logger.warn(`Failed to delete memory for key "${key}" for user "${userId}"`);
        return [`Failed to delete memory for key "${key}"`, undefined];
      } catch (error) {
        logger.error('Memory Agent failed to delete memory', error);
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
  totalTokens = 0,
}: {
  userId: string | ObjectId;
  setMemory: MemoryMethods['setMemory'];
  deleteMemory: MemoryMethods['deleteMemory'];
  validKeys?: string[];
  tokenLimit?: number;
  keyLimits?: MemoryKeyLimits;
  memoryTokenMap?: Record<string, number>;
  totalTokens?: number;
}) => {
  const runtimeState = createMemoryRuntimeState({
    memoryTokenMap,
    totalTokens,
  });
  const setMemoryTool = createMemoryTool({
    userId,
    setMemory,
    validKeys,
    tokenLimit,
    keyLimits,
    state: runtimeState,
  });
  const deleteMemoryTool = createDeleteMemoryTool({
    userId,
    deleteMemory,
    validKeys,
    state: runtimeState,
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

        if (primaryArtifact == null && result[1] != null) {
          primaryArtifact = result[1];
        }
      }

      return [
        summaries.filter(Boolean).join('\n') || 'No durable memory update needed for this turn',
        primaryArtifact,
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
  llmConfig: ClientOptions;
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
  totalTokens = 0,
  streamId = null,
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
  totalTokens?: number;
  llmConfig?: Partial<LLMConfig>;
  streamId?: string | null;
  user?: IUser;
}): Promise<(TAttachment | null)[] | undefined> {
  try {
    const resolvedKeyLimits = resolveMemoryKeyLimits(keyLimits);
    const memoryTool = createMemoryTool({
      userId,
      tokenLimit,
      keyLimits: resolvedKeyLimits,
      setMemory,
      validKeys,
      memoryTokenMap,
      totalTokens,
    });
    const deleteMemoryTool = createDeleteMemoryTool({
      userId,
      validKeys,
      deleteMemory,
      memoryTokenMap,
      totalTokens,
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
      totalTokens,
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

    const finalLLMConfig: ClientOptions = {
      ...defaultLLMConfig,
      ...llmConfig,
      /**
       * Ensure streaming is always disabled for memory processing
       */
      streaming: false,
      disableStreaming: true,
    };

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
          userId,
          conversationId,
          messageId,
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
    const memoryCallback = createMemoryCallback({ res, artifactPromises, streamId });
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
      if (!isRetryableMemoryProcessingError(error)) {
        throw error;
      }

      logger.warn('[MemoryAgent] Retrying memory run after retryable upstream error', {
        userId,
        conversationId,
        messageId,
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
      logger.debug('[MemoryAgent] Processed successfully', {
        userId,
        conversationId,
        messageId,
        provider: llmConfig?.provider,
      });
    } else {
      logger.debug('[MemoryAgent] Returned no content', { userId, conversationId, messageId });
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
      `[MemoryAgent] Failed to process memory | userId: ${userId} | conversationId: ${conversationId} | messageId: ${messageId} | provider=${String(llmConfig?.provider ?? 'unknown')} | model=${configuredModel ?? 'unknown'} | thinkingMode=${anthropicThinking == null ? 'n/a' : describeAnthropicThinkingMode(anthropicThinking)} | temperature=${String((llmConfig as { temperature?: unknown } | undefined)?.temperature ?? 'unset')} | errorType=${typedError?.type ?? 'unknown'} | errorCode=${typedError?.code ?? 'unknown'} | errorMessage=${String(
        typedError?.message ?? 'unknown',
      )
        .replace(/\s+/g, ' ')
        .slice(0, 300)}`,
      {
        error,
        provider: llmConfig?.provider,
        model: configuredModel,
        errorMessage: typedError?.message,
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
    setMemory: async ({ userId: maintenanceUserId, key, value, tokenCount }) =>
      memoryMethods.setMemory({
        userId: maintenanceUserId,
        key,
        value,
        tokenCount,
      }),
    policy: {
      validKeys,
      tokenLimit,
      keyLimits,
      maintenanceThresholdPercent,
    },
  });

  const formatted = await memoryMethods.getFormattedMemories({ userId });
  return {
    withKeys: formatted.withKeys ?? '',
    withoutKeys: formatted.withoutKeys ?? '',
    totalTokens: formatted.totalTokens ?? 0,
    memoryTokenMap: formatted.memoryTokenMap ?? {},
  };
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
  const { withKeys, withoutKeys, totalTokens, memoryTokenMap } = preparedSnapshot;

  return [
    withoutKeys,
    async function (messages: BaseMessage[]): Promise<(TAttachment | null)[] | undefined> {
      try {
        return await processMemory({
          res,
          userId,
          messages,
          validKeys,
          llmConfig,
          keyLimits,
          messageId,
          tokenLimit,
          memoryTokenMap: memoryTokenMap ?? {},
          streamId,
          conversationId,
          memory: withKeys,
          totalTokens: totalTokens || 0,
          instructions: finalInstructions,
          setMemory: memoryMethods.setMemory,
          deleteMemory: memoryMethods.deleteMemory,
          user,
        });
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
}: {
  res: ServerResponse;
  data: ToolEndData;
  metadata?: ToolEndMetadata;
  streamId?: string | null;
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
  if (!res.headersSent) {
    return attachment;
  }
  if (streamId) {
    GenerationJobManager.emitChunk(streamId, { event: 'attachment', data: attachment });
  } else {
    res.write(`event: attachment\ndata: ${JSON.stringify(attachment)}\n\n`);
  }
  return attachment;
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
}: {
  res: ServerResponse;
  artifactPromises: Promise<Partial<TAttachment> | null>[];
  streamId?: string | null;
}): ToolEndCallback {
  return async (data: ToolEndData, metadata?: Record<string, unknown>) => {
    const output = data?.output as ToolMessage | undefined;
    const memoryArtifact = output?.artifact?.[Tools.memory] as MemoryArtifact;
    if (memoryArtifact == null) {
      return;
    }
    artifactPromises.push(
      handleMemoryArtifact({ res, data, metadata, streamId }).catch((error) => {
        logger.error('Error processing memory artifact content:', error);
        return null;
      }),
    );
  };
}
