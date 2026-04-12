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
import type { TFile } from 'librechat-data-provider';

type ConversationRecallVectorRuntimeStatus = {
  available: boolean;
  reason: 'ok' | 'unconfigured' | 'http_error' | 'timeout' | 'unreachable';
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

export function getConversationRecallCorpusUpdatedAt(recallFiles: TFile[] | null | undefined): Date | null {
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
    const status: ConversationRecallVectorRuntimeStatus = response?.ok
      ? { available: true, reason: 'ok' }
      : { available: false, reason: 'http_error' };
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

export const __internal = {
  parseTimestamp,
  resetConversationRecallVectorRuntimeStatusCache() {
    healthCache = undefined;
  },
};
