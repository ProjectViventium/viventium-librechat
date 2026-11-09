/* === VIVENTIUM START ===
 * Feature: Conversation recall attachment readiness gating.
 *
 * Purpose:
 * - Attach vector-backed conversation recall only when the local/vector runtime is reachable.
 * - Refuse to attach stale recall corpora when newer recall-eligible messages exist.
 * - Keep this logic isolated from agent initialization plumbing.
 *
 * Added: 2026-04-08
 * === VIVENTIUM END === */

import { logger } from '@librechat/data-schemas';
import fs from 'node:fs';
import { buildConversationRecallFileId, ConversationRecallScope, FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import { buildConversationRecallAttachmentFiles } from './conversationRecall';
import type { ConversationRecallAttachmentReason } from './conversationRecall';

type ConversationRecallVectorRuntimeStatus = {
  available: boolean;
  /* === VIVENTIUM START === Semantic recall-health failure classes. === */
  reason:
    | 'ok'
    | 'unconfigured'
    | 'http_error'
    | 'unhealthy'
    | 'invalid_response'
    | 'timeout'
    | 'unreachable'
    | 'stale_restore';
  /* === VIVENTIUM END === */
};

const HEALTH_CHECK_TIMEOUT_MS = 1000;
const HEALTH_CACHE_TTL_MS = 15000;

let healthCache:
  | {
      expiresAt: number;
      status: ConversationRecallVectorRuntimeStatus;
    }
  | undefined;

function parseTimestamp(value: unknown): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
}

export function getConversationRecallCorpusUpdatedAt(
  recallFiles: TFile[] | null | undefined,
): Date | null {
  if (!Array.isArray(recallFiles) || recallFiles.length === 0) {
    return null;
  }

  let newest: Date | null = null;
  for (const file of recallFiles) {
    const parsed =
      parseTimestamp((file as TFile & { updatedAt?: unknown; createdAt?: unknown }).updatedAt) ??
      parseTimestamp((file as TFile & { updatedAt?: unknown; createdAt?: unknown }).createdAt);
    if (!parsed) {
      continue;
    }
    if (!newest || parsed.getTime() > newest.getTime()) {
      newest = parsed;
    }
  }

  return newest;
}

export function evaluateConversationRecallCorpusFreshness({
  recallFiles,
  latestMessageCreatedAt,
}: {
  recallFiles: TFile[] | null | undefined;
  latestMessageCreatedAt?: string | Date | null;
}): {
  fresh: boolean;
  corpusUpdatedAt: Date | null;
  latestMessageCreatedAt: Date | null;
} {
  const corpusUpdatedAt = getConversationRecallCorpusUpdatedAt(recallFiles);
  const latestMessageDate = parseTimestamp(latestMessageCreatedAt);

  if (!latestMessageDate) {
    return { fresh: true, corpusUpdatedAt, latestMessageCreatedAt: null };
  }

  if (!corpusUpdatedAt) {
    return { fresh: false, corpusUpdatedAt: null, latestMessageCreatedAt: latestMessageDate };
  }

  return {
    fresh: corpusUpdatedAt.getTime() >= latestMessageDate.getTime(),
    corpusUpdatedAt,
    latestMessageCreatedAt: latestMessageDate,
  };
}

export async function getConversationRecallVectorRuntimeStatus(): Promise<ConversationRecallVectorRuntimeStatus> {
  /* === VIVENTIUM START ===
   * Feature: Restore-aware conversation recall vector gating.
   *
   * Purpose:
   * - After a local restore, vector-backed recall can be structurally stale even when the
   *   vector service itself is healthy.
   * - A local marker should therefore degrade recall to the existing source-only attachment path
   *   until the operator explicitly rebuilds and clears the marker.
   * === VIVENTIUM END === */
  if (process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE) {
    try {
      if (fs.existsSync(process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE)) {
        return {
          available: false,
          reason: 'stale_restore',
        };
      }
    } catch (error) {
      logger.debug('[conversationRecall] Failed to read recall rebuild marker', {
        markerPath: process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!process.env.RAG_API_URL?.trim()) {
    return {
      available: false,
      reason: 'unconfigured',
    };
  }

  const now = Date.now();
  if (healthCache && healthCache.expiresAt > now) {
    return healthCache.status;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  try {
    const response = await fetch(`${process.env.RAG_API_URL}/health`, {
      signal: controller.signal,
    });
    /* === VIVENTIUM START ===
     * HTTP reachability is insufficient: only the RAG service's declared UP state enables vectors.
     */
    let status: ConversationRecallVectorRuntimeStatus;
    if (!response?.ok) {
      status = { available: false, reason: 'http_error' };
    } else {
      try {
        const payload = (await response.json()) as { status?: unknown };
        status =
          payload?.status === 'UP'
            ? { available: true, reason: 'ok' }
            : { available: false, reason: 'unhealthy' };
      } catch {
        status = { available: false, reason: 'invalid_response' };
      }
    }
    /* === VIVENTIUM END === */
    healthCache = {
      status,
      expiresAt: now + HEALTH_CACHE_TTL_MS,
    };
    return status;
  } catch (error) {
    const status: ConversationRecallVectorRuntimeStatus =
      error instanceof Error && error.name === 'AbortError'
        ? { available: false, reason: 'timeout' }
        : { available: false, reason: 'unreachable' };
    healthCache = {
      status,
      expiresAt: now + HEALTH_CACHE_TTL_MS,
    };
    logger.debug('[conversationRecall] Vector runtime health check failed', {
      reason: status.reason,
      ragApiUrl: process.env.RAG_API_URL,
    });
    return status;
  } finally {
    clearTimeout(timer);
  }
}

/** Refresh execution readiness without changing the signed owner, namespace, or resource list. */
export async function refreshConversationRecallExecutionFiles<T extends Pick<TFile, 'file_id' | 'context'>>(
  { ownerId, agentId, activeMessageId, files }: {
    ownerId: string;
    agentId?: string;
    activeMessageId?: string;
    files: T[];
  },
  { readFiles, readLatestMessageCreatedAt, readVectorStatus = getConversationRecallVectorRuntimeStatus }: {
    readFiles: (filter: { user: string; context: FileContext; file_id: { $in: string[] } }) => Promise<TFile[]>;
    readLatestMessageCreatedAt: (filter: {
      user: string; excludeMessageId?: string; excludeParentMessageId?: string;
    }) => Promise<Date | string | null>;
    readVectorStatus?: () => Promise<ConversationRecallVectorRuntimeStatus>;
  },
): Promise<T[]> {
  const isRecall = (file: T) => file.context === FileContext.conversation_recall ||
    file.file_id.startsWith('conversation_recall:');
  if (!files.some(isRecall)) return files;
  if (!ownerId) return files.filter((file) => !isRecall(file));
  const allId = buildConversationRecallFileId({ userId: ownerId, scope: ConversationRecallScope.all });
  const allowedIds = new Set([allId, ...(agentId ? [buildConversationRecallFileId({
    userId: ownerId, scope: ConversationRecallScope.agent, agentId,
  })] : [])]);
  const selected = files.filter((file) => isRecall(file) && allowedIds.has(file.file_id));
  if (!selected.length) return files.filter((file) => !isRecall(file));
  const ids = [...new Set(selected.map((file) => file.file_id))];
  const [rows, latest, runtime] = await Promise.all([
    readFiles({ user: ownerId, context: FileContext.conversation_recall, file_id: { $in: ids } }),
    ids.includes(allId) ? readLatestMessageCreatedAt({ user: ownerId,
      excludeMessageId: activeMessageId, excludeParentMessageId: activeMessageId }) : Promise.resolve(null),
    readVectorStatus(),
  ]);
  const current = new Map(rows.map((file) => [file.file_id, file]));
  return files.flatMap((file) => {
    if (!isRecall(file)) return [file];
    if (!allowedIds.has(file.file_id)) return [];
    const row = current.get(file.file_id);
    if (row && (String(row.user) !== ownerId || row.context !== FileContext.conversation_recall)) return [];
    const corpus = row ? [row] : [];
    const { fresh } = evaluateConversationRecallCorpusFreshness({ recallFiles: corpus,
      latestMessageCreatedAt: file.file_id === allId ? latest : null });
    const mode = runtime.available && fresh && row ? 'vector' : 'source_only';
    const reason: ConversationRecallAttachmentReason = mode === 'vector' ? 'vector_ready'
      : !row ? 'missing_corpus' : !fresh ? 'stale_corpus'
      : runtime.reason === 'ok' ? 'runtime_unhealthy' : `runtime_${runtime.reason}`;
    const [ready] = buildConversationRecallAttachmentFiles({ userId: ownerId,
      scope: file.file_id === allId ? ConversationRecallScope.all : ConversationRecallScope.agent,
      agentId, existingFiles: corpus, mode, reason });
    return ready?.file_id === file.file_id ? [{ ...file,
      viventiumConversationRecallMode: mode, viventiumConversationRecallAttachmentReason: reason }] : [];
  });
}

export const __internal = {
  parseTimestamp,
  resetConversationRecallVectorRuntimeStatusCache() {
    healthCache = undefined;
  },
};
