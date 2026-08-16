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
 * - Bound automatic browser listening with the canonical server-projected follow-up window.
 * - Stop early on a visible follow-up or a durable terminal-silent Phase B decision.
 * - After a recent tool-using assistant response, keep polling briefly for out-of-band direct-action
 *   callbacks that are persisted after the main SSE stream has already closed.
 * - Window expiry stops query refreshes only; it never cancels Main or Phase B execution.
 * === VIVENTIUM END === */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { GLASSHIVE_MCP_SERVER_NAME } from '~/utils/viventiumGlassHive';

const POLL_INTERVAL_MS = 1500;
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
const TERMINAL_SILENT_FOLLOW_UP_RESULTS = new Set<string>(['suppressed', 'empty', 'skipped']);
const GLASSHIVE_MCP_SERVER = GLASSHIVE_MCP_SERVER_NAME;

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
  const [, mcpServer] = name.split(Constants.mcp_delimiter);
  return mcpServer === GLASSHIVE_MCP_SERVER;
}

function hasGlassHiveToolCallPart(message: TMessage): boolean {
  if (!Array.isArray(message.content)) {
    return false;
  }
  return (message.content as Array<TMessageContentParts | undefined>).some(
    (part) =>
      part?.type === ContentTypes.TOOL_CALL && isGlassHiveToolName(extractToolCallName(part)),
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

function getTargetMessage(messages: TMessage[], targetMessageId: string | null): TMessage | null {
  if (!targetMessageId) {
    return null;
  }
  return messages.find((message) => message?.messageId === targetMessageId) ?? null;
}

function hasPromotedFollowUp(messages: TMessage[], targetMessageId: string | null): boolean {
  const targetMessage = getTargetMessage(messages, targetMessageId);
  const viventiumMetadata = (targetMessage as any)?.metadata?.viventium;
  const renderedText = typeof targetMessage?.text === 'string' ? targetMessage.text.trim() : '';
  return viventiumMetadata?.promotedToEmptyParent === true && renderedText.length > 0;
}

function hasTerminalSilentFollowUpDecision(
  messages: TMessage[],
  targetMessageId: string | null,
): boolean {
  const targetMessage = getTargetMessage(messages, targetMessageId);
  const result = String(
    (targetMessage as any)?.metadata?.viventium?.cortexFollowUpDecision?.result || '',
  )
    .trim()
    .toLowerCase();
  return TERMINAL_SILENT_FOLLOW_UP_RESULTS.has(result);
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

function getBackgroundFollowUpWindowMs(queryClient: ReturnType<typeof useQueryClient>): number {
  const startupConfig = queryClient.getQueryData<{
    viventiumBackgroundFollowupWindowS?: unknown;
  }>([QueryKeys.startupConfig]);
  const windowS = startupConfig?.viventiumBackgroundFollowupWindowS;
  if (typeof windowS !== 'number' || !Number.isFinite(windowS) || windowS < 0) {
    // A mismatched/old client-server bundle gets one catch-up refresh, not a guessed business timer.
    return POLL_INTERVAL_MS;
  }
  if (windowS === 0) {
    return 0;
  }
  return Math.max(windowS * 1000, POLL_INTERVAL_MS);
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
  const listenWindowStartRef = useRef<number | null>(null);
  const sawActiveRef = useRef(false);
  const isSubmittingRef = useRef<boolean>(false);
  const targetParentRef = useRef<string | null>(null);
  const expiredCortexTargetRef = useRef<string | null>(null);
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
      // Also, do not consume the browser-listening window while the stream is still active.
      if (submitting) {
        if (active || recentLatestCortex) {
          if (
            latestCortexMessageId &&
            latestCortexMessageId !== expiredCortexTargetRef.current
          ) {
            sawActiveRef.current = true;
            targetParentRef.current = latestCortexMessageId;
            listenWindowStartRef.current = null;
          }
        } else if (sawActiveRef.current && !followUpForExistingTarget) {
          // Start the browser listening window only after the stream ends.
          listenWindowStartRef.current = null;
        }
        return;
      }

      if (
        !sawActiveRef.current &&
        latestCortexMessageId &&
        latestCortexMessageId !== expiredCortexTargetRef.current &&
        (active || recentLatestCortex)
      ) {
        sawActiveRef.current = true;
        targetParentRef.current = latestCortexMessageId;
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

      if (listenWindowStartRef.current == null) {
        listenWindowStartRef.current = Date.now();
      }
      const backgroundFollowUpWindowMs = getBackgroundFollowUpWindowMs(queryClient);
      const listenWindowElapsedMs = Date.now() - listenWindowStartRef.current;
      if (listenWindowElapsedMs >= backgroundFollowUpWindowMs) {
        expiredCortexTargetRef.current = targetParentRef.current;
        sawActiveRef.current = false;
        listenWindowStartRef.current = null;
        targetParentRef.current = null;
        return;
      }

      if (active) {
        if (latestCortexMessageId) {
          targetParentRef.current = latestCortexMessageId;
        }
        queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
        return;
      }

      if (!targetParentRef.current && latestCortexMessageId) {
        targetParentRef.current = latestCortexMessageId;
      }

      const currentTargetParentId = targetParentRef.current;
      const followUpForTarget = currentTargetParentId
        ? followUpParentIds.has(currentTargetParentId)
        : false;

      // The decision record is written before a visible follow-up is saved. Therefore `persisted`
      // remains pending here; only visible or terminal-silent state ends browser listening early.
      if (
        followUpForTarget ||
        hasPromotedFollowUp(messages, currentTargetParentId) ||
        hasTerminalSilentFollowUpDecision(messages, currentTargetParentId)
      ) {
        expiredCortexTargetRef.current = currentTargetParentId;
        sawActiveRef.current = false;
        listenWindowStartRef.current = null;
        targetParentRef.current = null;
        return;
      }

      queryClient.invalidateQueries([QueryKeys.messages, conversationId]);
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      sawActiveRef.current = false;
      listenWindowStartRef.current = null;
      targetParentRef.current = null;
      expiredCortexTargetRef.current = null;
      toolCallbackTargetRef.current = null;
      toolCallbackExpiredTargetRef.current = null;
      toolCallbackGraceStartRef.current = null;
    };
  }, [conversationId, getMessages, queryClient]);
}
