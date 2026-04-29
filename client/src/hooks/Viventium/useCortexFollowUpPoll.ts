/* === VIVENTIUM START ===
 * Feature: Background Cortices - Follow-up polling
 *
 * Why:
 * - The main SSE stream closes when the main agent finishes.
 * - Background cortices continue after that (non-blocking).
 * - We need a lightweight mechanism to surface:
 *   1) cortex status transitions (brewing -> complete)
 *   2) the single follow-up assistant message
 *
 * Approach:
 * - While any cortex is "activating" or "brewing", periodically invalidate the messages query.
 * - Once all cortices are resolved, keep polling briefly to catch the follow-up message.
 * - After a recent tool-using assistant response, keep polling briefly for out-of-band direct-action
 *   callbacks that are persisted after the main SSE stream has already closed.
 * - Stop automatically (and never poll indefinitely).
 * === VIVENTIUM END === */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';

/**
 * Keep polling long enough for real-world Phase B completion.
 * Backend default cortex execution timeout is 180s.
 */
const POLL_INTERVAL_MS = 1500;
const FOLLOW_UP_GRACE_MS = 180_000;
const DEFAULT_TOOL_CALLBACK_GRACE_MS = 10 * 60 * 1000;
const MAX_TOOL_CALLBACK_GRACE_MS = 24 * 60 * 60 * 1000;

const CORTEX_TYPES = new Set<string>([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);
const TERMINAL_GLASSHIVE_CALLBACK_EVENTS = new Set<string>([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'checkpoint.ready',
  'takeover.requested',
]);
const GLASSHIVE_MCP_SERVER = 'glasshive-workers-projects';

function extractCortexParts(message: TMessage): any[] {
  const transient = (message as any)?.__viventiumCortexParts;
  if (Array.isArray(transient) && transient.length > 0) {
    return transient;
  }
  if (!Array.isArray(message.content)) {
    return [];
  }
  return (message.content as Array<TMessageContentParts | undefined>).filter(
    (p) => p && CORTEX_TYPES.has(p.type),
  ) as any[];
}

function hasActiveCortex(messages: TMessage[]): boolean {
  return messages.some((m) =>
    extractCortexParts(m).some((p) => p?.status === 'activating' || p?.status === 'brewing'),
  );
}

function getMostRecentCortexMessage(messages: TMessage[]): TMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (extractCortexParts(message).length > 0) {
      return message;
    }
  }
  return null;
}

function hasRecentLatestCortexMessage(messages: TMessage[], maxAgeMs = 10 * 60 * 1000): boolean {
  const latestCortexMessage = getMostRecentCortexMessage(messages);
  if (!latestCortexMessage) {
    return false;
  }

  const createdAt = (latestCortexMessage as any)?.createdAt;
  if (!createdAt) {
    // Optimistic/streamed messages may not have createdAt yet; treat as recent.
    return true;
  }

  const ts = new Date(createdAt).getTime();
  if (!Number.isFinite(ts)) {
    return true;
  }
  return Date.now() - ts <= maxAgeMs;
}

function messageTimeValue(message: TMessage): number {
  const raw = (message as any)?.updatedAt || (message as any)?.createdAt;
  if (!raw) {
    return Date.now();
  }
  const ts = new Date(raw).getTime();
  return Number.isFinite(ts) ? ts : Date.now();
}

function extractToolCallName(part: any): string {
  const toolCall = part?.tool_call ?? part?.[ContentTypes.TOOL_CALL] ?? part?.toolCall ?? part;
  for (const candidate of [
    toolCall?.name,
    toolCall?.function?.name,
    toolCall?.toolName,
    part?.name,
    part?.function?.name,
    part?.toolName,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return '';
}

function isGlassHiveToolName(name: string): boolean {
  if (!name) {
    return false;
  }
  const [, mcpServer] = name.split('_mcp_');
  return mcpServer === GLASSHIVE_MCP_SERVER;
}

function hasGlassHiveToolCallPart(message: TMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return (message.content as Array<TMessageContentParts | undefined>).some(
    (part) => part?.type === ContentTypes.TOOL_CALL && isGlassHiveToolName(extractToolCallName(part)),
  );
}

function getLatestRecentToolCallMessageId(
  messages: TMessage[],
  maxAgeMs = DEFAULT_TOOL_CALLBACK_GRACE_MS,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message?.messageId || message.isCreatedByUser || !hasGlassHiveToolCallPart(message)) {
      continue;
    }
    if (Date.now() - messageTimeValue(message) <= maxAgeMs) {
      return message.messageId;
    }
    return null;
  }
  return null;
}

function getLatestCortexMessageId(messages: TMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message?.messageId) {
      continue;
    }
    if (extractCortexParts(message).length > 0) {
      return message.messageId;
    }
  }
  return null;
}

function isResolvedDeferredCortexMessage(
  messages: TMessage[],
  targetMessageId: string | null,
): boolean {
  if (!targetMessageId) {
    return false;
  }

  const targetMessage = messages.find((message) => message?.messageId === targetMessageId);
  if (!targetMessage) {
    return false;
  }

  if (targetMessage.unfinished === true) {
    return false;
  }

  const parts = extractCortexParts(targetMessage);
  if (parts.length === 0) {
    return false;
  }

  if (parts.some((part) => part?.status === 'activating' || part?.status === 'brewing')) {
    return false;
  }

  const renderedText = typeof targetMessage.text === 'string' ? targetMessage.text.trim() : '';
  return renderedText.length > 0;
}

function collectFollowUpParentIds(messages: TMessage[]): Set<string> {
  const parentIds = new Set<string>();
  for (const message of messages) {
    const viventiumMetadata = (message as any)?.metadata?.viventium;
    if (viventiumMetadata?.type !== 'cortex_followup') {
      continue;
    }
    if (typeof message?.parentMessageId === 'string' && message.parentMessageId.length > 0) {
      parentIds.add(message.parentMessageId);
    }
    if (
      typeof viventiumMetadata?.parentMessageId === 'string' &&
      viventiumMetadata.parentMessageId.length > 0
    ) {
      parentIds.add(viventiumMetadata.parentMessageId);
    }
  }
  return parentIds;
}

function latestGlassHiveCallbackEvent(viventiumMetadata: any): string {
  const events = Array.isArray(viventiumMetadata?.events) ? viventiumMetadata.events : [];
  const latestEvent = events.length > 0 ? events[events.length - 1]?.event : null;
  return String(latestEvent || viventiumMetadata?.event || '').trim();
}

function collectDeferredCallbackAnchorEvents(messages: TMessage[]): Map<string, string> {
  const anchorEvents = new Map<string, string>();
  for (const message of messages) {
    const viventiumMetadata = (message as any)?.metadata?.viventium;
    if (viventiumMetadata?.type !== 'glasshive_worker_callback') {
      continue;
    }
    const event = latestGlassHiveCallbackEvent(viventiumMetadata);
    for (const candidate of [
      viventiumMetadata.anchorMessageId,
      viventiumMetadata.parentMessageId,
      viventiumMetadata.requestedParentMessageId,
      message?.parentMessageId,
    ]) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        anchorEvents.set(candidate, event);
      }
    }
  }
  return anchorEvents;
}

function isTerminalGlassHiveCallbackEvent(event: string | null | undefined): boolean {
  return TERMINAL_GLASSHIVE_CALLBACK_EVENTS.has(String(event || '').trim());
}

function getToolCallbackGraceMs(queryClient: ReturnType<typeof useQueryClient>): number {
  const startupConfig = queryClient.getQueryData<{ viventiumGlassHiveFollowupTimeoutS?: unknown }>([
    QueryKeys.startupConfig,
  ]);
  const timeoutS = Number(startupConfig?.viventiumGlassHiveFollowupTimeoutS);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    return DEFAULT_TOOL_CALLBACK_GRACE_MS;
  }
  return Math.min(Math.max(timeoutS * 1000, POLL_INTERVAL_MS), MAX_TOOL_CALLBACK_GRACE_MS);
}

export default function useCortexFollowUpPoll({
  conversationId,
  getMessages,
  isSubmitting,
}: {
  conversationId?: string | null;
  getMessages?: () => TMessage[] | undefined;
  /**
   * IMPORTANT: Do not clobber the in-flight (optimistic) streaming messages.
   *
   * LibreChat streams the assistant response into a client-only placeholder messageId
   * (`${userMessageId}_`) created by `createdHandler`. Server fetches won't contain that
   * placeholder mid-stream, so invalidating the messages query while submitting can cause
   * the latest assistant message to temporarily disappear and then re-appear on the next SSE delta.
   *
   * We only need polling after the main stream closes (background cortices continue post-stream).
   */
  isSubmitting?: boolean;
}) {
  const queryClient = useQueryClient();
  const graceStartRef = useRef<number | null>(null);
  const sawActiveRef = useRef(false);
  const isSubmittingRef = useRef<boolean>(false);
  const targetParentRef = useRef<string | null>(null);
  const toolCallbackTargetRef = useRef<string | null>(null);
  const toolCallbackExpiredTargetRef = useRef<string | null>(null);
  const toolCallbackGraceStartRef = useRef<number | null>(null);

  useEffect(() => {
    isSubmittingRef.current = Boolean(isSubmitting);
  }, [isSubmitting]);

  useEffect(() => {
    if (!conversationId || conversationId === 'new') {
      return;
    }

    const interval = window.setInterval(() => {
      const messages =
        getMessages?.() ??
        queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]);
      if (!Array.isArray(messages) || messages.length === 0) {
        return;
      }

      const active = hasActiveCortex(messages);
      const toolCallbackGraceMs = getToolCallbackGraceMs(queryClient);
      const recentLatestCortex = hasRecentLatestCortexMessage(messages);
      const latestCortexMessageId = getLatestCortexMessageId(messages);
      const latestToolCallMessageId = getLatestRecentToolCallMessageId(
        messages,
        toolCallbackGraceMs,
      );
      const followUpParentIds = collectFollowUpParentIds(messages);
      const deferredCallbackAnchorEvents = collectDeferredCallbackAnchorEvents(messages);
      const existingTargetParentId = targetParentRef.current;
      const followUpForExistingTarget = existingTargetParentId
        ? followUpParentIds.has(existingTargetParentId)
        : false;
      const submitting = isSubmittingRef.current;

      // While submitting, SSE is the source of truth for the in-flight message.
      // Avoid any polling/refetching that could clobber the client-only placeholder `${userMessageId}_`.
      // Also, do not consume the grace-period budget while the stream is still active.
      if (submitting) {
        if (active || recentLatestCortex) {
          sawActiveRef.current = true;
          if (latestCortexMessageId) {
            targetParentRef.current = latestCortexMessageId;
          }
          graceStartRef.current = null;
        } else if (sawActiveRef.current && !followUpForExistingTarget) {
          // Pause grace until the stream ends.
          graceStartRef.current = null;
        }
        return;
      }

      if (active) {
        sawActiveRef.current = true;
        if (latestCortexMessageId) {
          targetParentRef.current = latestCortexMessageId;
        }
        graceStartRef.current = null;
        queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
        return;
      }

      if (!sawActiveRef.current && recentLatestCortex) {
        sawActiveRef.current = true;
        if (latestCortexMessageId) {
          targetParentRef.current = latestCortexMessageId;
        }
      }

      if (!sawActiveRef.current) {
        if (
          latestToolCallMessageId &&
          latestToolCallMessageId !== toolCallbackExpiredTargetRef.current
        ) {
          const latestCallbackEvent = deferredCallbackAnchorEvents.get(latestToolCallMessageId);
          if (isTerminalGlassHiveCallbackEvent(latestCallbackEvent)) {
            toolCallbackExpiredTargetRef.current = latestToolCallMessageId;
            toolCallbackTargetRef.current = null;
            toolCallbackGraceStartRef.current = null;
            return;
          }

          if (toolCallbackTargetRef.current !== latestToolCallMessageId) {
            toolCallbackTargetRef.current = latestToolCallMessageId;
            toolCallbackGraceStartRef.current = Date.now();
          }

          const elapsed = Date.now() - (toolCallbackGraceStartRef.current ?? Date.now());
          if (elapsed < toolCallbackGraceMs) {
            queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
            return;
          }

          toolCallbackExpiredTargetRef.current = latestToolCallMessageId;
          toolCallbackTargetRef.current = null;
          toolCallbackGraceStartRef.current = null;
        }
        return;
      }

      if (!targetParentRef.current && latestCortexMessageId) {
        targetParentRef.current = latestCortexMessageId;
      }

      const currentTargetParentId = targetParentRef.current;
      const followUpForTarget = currentTargetParentId
        ? followUpParentIds.has(currentTargetParentId)
        : false;

      // All cortices resolved: keep polling briefly to catch the follow-up message (if any)
      if (followUpForTarget) {
        sawActiveRef.current = false;
        graceStartRef.current = null;
        targetParentRef.current = null;
        return;
      }

      if (isResolvedDeferredCortexMessage(messages, targetParentRef.current)) {
        if (graceStartRef.current == null) {
          graceStartRef.current = Date.now();
        }
        const elapsed = Date.now() - graceStartRef.current;
        if (elapsed < FOLLOW_UP_GRACE_MS) {
          queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
          return;
        }

        sawActiveRef.current = false;
        graceStartRef.current = null;
        targetParentRef.current = null;
        return;
      }

      if (graceStartRef.current == null) {
        graceStartRef.current = Date.now();
      }
      const elapsed = Date.now() - graceStartRef.current;
      if (elapsed < FOLLOW_UP_GRACE_MS) {
        queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
        return;
      }

      // Stop after grace period (covers the suppression case: user sent newer input)
      sawActiveRef.current = false;
      graceStartRef.current = null;
      targetParentRef.current = null;
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      sawActiveRef.current = false;
      graceStartRef.current = null;
      targetParentRef.current = null;
      toolCallbackTargetRef.current = null;
      toolCallbackExpiredTargetRef.current = null;
      toolCallbackGraceStartRef.current = null;
    };
  }, [conversationId, getMessages, queryClient]);
}
