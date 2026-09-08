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
 * - Use the server-projected grace for fast refresh and the quiet period after cortices finish.
 *   Active cortices keep the existing slow refresh cadence, bounded by the 24h anchor cap.
 * - Stop early on a visible follow-up or a durable terminal-silent Phase B decision.
 * - After a recent tool-using assistant response, keep polling briefly for out-of-band direct-action
 *   callbacks that are persisted after the main SSE stream has already closed.
 * - Once that first grace window elapses, a GlassHive tool call whose latest persisted callback is
 *   still non-terminal (queued/running/needs_input) or absent keeps a slower refresh cadence,
 *   bounded by the 24h anchor cap, so a long-running or restarted Worker still lands in the open
 *   conversation without a reload. Only a terminal callback ends it early.
 * - Window expiry stops query refreshes only; it never cancels Main or Phase B execution.
 * === VIVENTIUM END === */

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { GLASSHIVE_MCP_SERVER_NAME } from '~/utils/viventiumGlassHive';
import type { ActiveWorkSnapshot } from '~/data-provider/ViventiumOrchestration/queries';

const POLL_INTERVAL_MS = 1500;
const SLOW_TOOL_CALLBACK_POLL_INTERVAL_MS = 10 * 1000;
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
// Mirrors the server's persisted `metadata.viventium.status.state` (callbackStatus in
// api/server/routes/viventium/glasshive.js). queued/running/needs_input/artifact_ready stay live.
const TERMINAL_GLASSHIVE_CALLBACK_STATES = new Set<string>(['completed', 'failed', 'cancelled']);
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

/**
 * The harness path reports connected-tool use as a structured harness-activity part
 * (event `tool`, tool `connected_tool`). The typed `expects_deferred_callback` anchor is the
 * authority: it marks a GlassHive run-dispatching tool whose real result arrives later as a Worker
 * callback, so only an anchored part arms the follow-up polling. An ordinary connected tool is
 * request/response and must never keep the page polling.
 *
 * Status is deliberately not required. Only the codex harness reports a terminal tool status; the
 * claude harness emits the tool-use step with no status at all, so requiring `completed` here made
 * every delegation on the claude route (the quota fallback) fail to arm and its finished Worker
 * result never reached the open page. A terminal failure status is still excluded: nothing will be
 * delivered later for a call the harness already reported as failed or cancelled.
 */
const TERMINAL_TOOL_FAILURE_STATUSES = new Set(['failed', 'cancelled']);

function hasCompletedConnectedToolActivity(message: TMessage): boolean {
  if (!Array.isArray(message?.content)) {
    return false;
  }
  return (message.content as Array<TMessageContentParts | undefined>).some((part) => {
    if (part?.type !== ContentTypes.HARNESS_ACTIVITY) {
      return false;
    }
    const activity = (part as any)?.harness_activity;
    return (
      activity?.event === 'tool' &&
      activity?.tool === 'connected_tool' &&
      activity?.expects_deferred_callback === true &&
      !TERMINAL_TOOL_FAILURE_STATUSES.has(String(activity?.status ?? ''))
    );
  });
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

function getLatestRecentToolCallMessage(
  messages: TMessage[],
  maxAgeMs = DEFAULT_TOOL_CALLBACK_GRACE_MS,
): TMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (
      !message?.messageId ||
      message.isCreatedByUser ||
      !(hasGlassHiveToolCallPart(message) || hasCompletedConnectedToolActivity(message))
    ) {
      continue;
    }
    if (Date.now() - messageTimeValue(message) <= maxAgeMs) {
      return message;
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

function latestGlassHiveCallbackState(viventiumMetadata: any): string {
  return String(viventiumMetadata?.status?.state || '')
    .trim()
    .toLowerCase();
}

type GlassHiveCallbackStatus = { event: string; state: string };

/**
 * Every deferred callback that shares an anchor (for example three Workers delegated from one
 * Main turn) is tracked; an anchor is terminal only when all of its callbacks are terminal.
 */
function collectDeferredCallbackAnchorEvents(
  messages: TMessage[],
): Map<string, GlassHiveCallbackStatus[]> {
  const anchorEvents = new Map<string, GlassHiveCallbackStatus[]>();
  for (const message of messages) {
    const viventiumMetadata = (message as any)?.metadata?.viventium;
    if (viventiumMetadata?.type !== 'glasshive_worker_callback') {
      continue;
    }
    const status = {
      event: latestGlassHiveCallbackEvent(viventiumMetadata),
      state: latestGlassHiveCallbackState(viventiumMetadata),
    };
    for (const candidate of [
      viventiumMetadata.anchorMessageId,
      viventiumMetadata.parentMessageId,
      viventiumMetadata.requestedParentMessageId,
      message?.parentMessageId,
    ]) {
      if (typeof candidate === 'string' && candidate.length > 0) {
        const existing = anchorEvents.get(candidate) ?? [];
        existing.push(status);
        anchorEvents.set(candidate, existing);
      }
    }
  }
  return anchorEvents;
}

function isTerminalGlassHiveCallbackEvent(event: string | null | undefined): boolean {
  return TERMINAL_GLASSHIVE_CALLBACK_EVENTS.has(String(event || '').trim());
}

function isTerminalGlassHiveCallback(statuses: GlassHiveCallbackStatus[] | undefined): boolean {
  if (!statuses || statuses.length === 0) {
    return false;
  }
  return statuses.every(
    (status) =>
      isTerminalGlassHiveCallbackEvent(status.event) ||
      TERMINAL_GLASSHIVE_CALLBACK_STATES.has(status.state),
  );
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
  activeWork,
}: {
  conversationId?: string | null;
  getMessages?: () => TMessage[] | undefined;
  activeWork?: ActiveWorkSnapshot;
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
  const memoryStartsRef = useRef(new Map<string, number>());
  const memoryPausedAtRef = useRef<number | null>(null);
  const isSubmittingRef = useRef<boolean>(false);
  const targetParentRef = useRef<string | null>(null);
  const expiredCortexTargetRef = useRef<string | null>(null);
  const cortexLastPollRef = useRef<number | null>(null);
  const cortexWasActiveRef = useRef(false);
  const toolCallbackTargetRef = useRef<string | null>(null);
  const toolCallbackExpiredTargetRef = useRef<string | null>(null);
  const toolCallbackGraceStartRef = useRef<number | null>(null);
  const toolCallbackLastPollRef = useRef<number | null>(null);
  const toolCallbackTerminalTargetRef = useRef<string | null>(null);
  const toolCallbackTerminalSeenAtRef = useRef<number | null>(null);
  const toolCallbackStatusSignatureRef = useRef<string>('');
  const activeWorkRef = useRef(activeWork);
  activeWorkRef.current = activeWork;
  const activeWorkSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (isSubmitting && !isSubmittingRef.current) {
      memoryPausedAtRef.current = Date.now();
      // A stream can cancel a result refresh already in flight; catch up after it closes.
      activeWorkSignatureRef.current = null;
      if (conversationId && conversationId !== 'new') {
        // A refresh already in flight must not replace the new streamed rows when it resolves.
        void queryClient.cancelQueries(
          { queryKey: [QueryKeys.messages, conversationId], exact: true },
          { revert: false },
        );
      }
    } else if (!isSubmitting && memoryPausedAtRef.current != null) {
      const pausedMs = Date.now() - memoryPausedAtRef.current;
      for (const [messageId, startedAt] of memoryStartsRef.current) {
        memoryStartsRef.current.set(messageId, startedAt + pausedMs);
      }
      memoryPausedAtRef.current = null;
    }
    isSubmittingRef.current = Boolean(isSubmitting);
  }, [conversationId, isSubmitting, queryClient]);

  useEffect(() => {
    if (!conversationId || conversationId === 'new') {
      return;
    }
    const memoryStarts = memoryStartsRef.current;

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
      // Discover the anchor up to the 24h cap; the configured grace only bounds the fast cadence.
      const latestToolCallMessage = getLatestRecentToolCallMessage(
        messages,
        MAX_TOOL_CALLBACK_GRACE_MS,
      );
      const latestToolCallMessageId = latestToolCallMessage?.messageId ?? null;
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
          if (latestCortexMessageId && latestCortexMessageId !== expiredCortexTargetRef.current) {
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

      // Memory writing can outlive Main without any cortex content part. Reuse this
      // observer and ordinary message query; the server's projected state owns completion.
      let refreshed = false;
      const refreshMessages = () => {
        if (!refreshed) {
          refreshed = true;
          void queryClient.invalidateQueries([QueryKeys.messages, conversationId], undefined, {
            cancelRefetch: false,
          });
        }
      };
      // Durable work state also covers native broker paths with no legacy tool content part.
      const workSnapshot = activeWorkRef.current;
      if (workSnapshot?.snapshot === 'fresh' && Array.isArray(workSnapshot.work)) {
        const signature = JSON.stringify(
          workSnapshot.work
            .map((work) => [work.workRef, work.state, work.updatedAt, work.delivery?.state])
            .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        );
        if (signature !== activeWorkSignatureRef.current) {
          const hadSnapshot = activeWorkSignatureRef.current !== null;
          activeWorkSignatureRef.current = signature;
          if (hadSnapshot || workSnapshot.work.length > 0) refreshMessages();
        }
      }
      const pendingMemoryIds = new Set<string>();
      let memorySettled = false;
      const now = Date.now();
      const memoryWindowMs = getBackgroundFollowUpWindowMs(queryClient);
      for (const message of messages) {
        if (message.memoryWriteStatus !== 'pending' && message.memoryWriteStatus !== 'running') {
          if (
            memoryStarts.has(message.messageId) &&
            (message.memoryWriteStatus === 'completed' || message.memoryWriteStatus === 'failed')
          ) {
            memorySettled = true;
          }
          continue;
        }
        pendingMemoryIds.add(message.messageId);
        const startedAt = memoryStarts.get(message.messageId) ?? now;
        memoryStarts.set(message.messageId, startedAt);
        if (now - startedAt < memoryWindowMs) {
          refreshMessages();
        }
      }
      for (const messageId of memoryStarts.keys()) {
        if (!pendingMemoryIds.has(messageId)) {
          memoryStarts.delete(messageId);
        }
      }
      // Late receipts arrive through message polling, after the SSE attachment handler closes.
      // Reconcile the memory view once from its server owner, even when writing failed.
      if (memorySettled) {
        // Invalidation alone reuses an initial read that has not populated the cache yet.
        void queryClient
          .cancelQueries({ queryKey: [QueryKeys.memories], exact: true })
          .then(() => queryClient.invalidateQueries([QueryKeys.memories]));
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
          latestToolCallMessage &&
          latestToolCallMessageId &&
          latestToolCallMessageId !== toolCallbackExpiredTargetRef.current
        ) {
          const latestCallback = deferredCallbackAnchorEvents.get(latestToolCallMessageId);
          const now = Date.now();
          if (isTerminalGlassHiveCallback(latestCallback)) {
            // Every Worker callback for this assistant turn is terminal, but Main's Phase B
            // follow-up that summarizes those results is authored afterwards. Keep listening at
            // the slow cadence until that follow-up (or a terminal-silent decision) is visible,
            // bounded by the configured background follow-up window, so the result reaches the
            // open page without a reload.
            // Sibling Workers report independently: the callbacks seen so far are not the full
            // set expected for this turn. Measure the bounded window from the latest change in
            // the callback set, so a fast sibling cannot end listening while others still run.
            const statusSignature = JSON.stringify(
              (latestCallback ?? []).map((status) => [status?.event, status?.state]),
            );
            if (
              toolCallbackTerminalTargetRef.current !== latestToolCallMessageId ||
              toolCallbackStatusSignatureRef.current !== statusSignature
            ) {
              toolCallbackTerminalTargetRef.current = latestToolCallMessageId;
              toolCallbackStatusSignatureRef.current = statusSignature;
              toolCallbackTerminalSeenAtRef.current = now;
            }
            const terminalElapsedMs = now - (toolCallbackTerminalSeenAtRef.current ?? now);
            const followUpVisible =
              followUpParentIds.has(latestToolCallMessageId) ||
              hasTerminalSilentFollowUpDecision(messages, latestToolCallMessageId);
            if (
              followUpVisible ||
              terminalElapsedMs >= getBackgroundFollowUpWindowMs(queryClient)
            ) {
              toolCallbackExpiredTargetRef.current = latestToolCallMessageId;
              toolCallbackTargetRef.current = null;
              toolCallbackGraceStartRef.current = null;
              toolCallbackLastPollRef.current = null;
              toolCallbackTerminalTargetRef.current = null;
              toolCallbackTerminalSeenAtRef.current = null;
              toolCallbackStatusSignatureRef.current = '';
              return;
            }
            const lastTerminalPollAt = toolCallbackLastPollRef.current;
            if (
              lastTerminalPollAt == null ||
              now - lastTerminalPollAt >= SLOW_TOOL_CALLBACK_POLL_INTERVAL_MS
            ) {
              toolCallbackLastPollRef.current = now;
              refreshMessages();
            }
            return;
          }
          if (toolCallbackTargetRef.current !== latestToolCallMessageId) {
            toolCallbackTargetRef.current = latestToolCallMessageId;
            toolCallbackGraceStartRef.current = now;
            toolCallbackLastPollRef.current = null;
          }

          // Fast cadence for the first grace window after the tool call. Past it, the Worker is
          // still live (no terminal callback persisted), so keep a slower cadence instead of going
          // dark; the 24h anchor cap in getLatestRecentToolCallMessage bounds it.
          const elapsed = now - (toolCallbackGraceStartRef.current ?? now);
          const anchorAgeMs = now - messageTimeValue(latestToolCallMessage);
          const withinGrace = elapsed < toolCallbackGraceMs && anchorAgeMs <= toolCallbackGraceMs;
          const lastPollAt = toolCallbackLastPollRef.current;
          if (
            withinGrace ||
            lastPollAt == null ||
            now - lastPollAt >= SLOW_TOOL_CALLBACK_POLL_INTERVAL_MS
          ) {
            toolCallbackLastPollRef.current = now;
            refreshMessages();
          }
        }
        return;
      }

      if (listenWindowStartRef.current == null) {
        listenWindowStartRef.current = Date.now();
      }
      const backgroundFollowUpWindowMs = getBackgroundFollowUpWindowMs(queryClient);
      let listenWindowElapsedMs = Date.now() - listenWindowStartRef.current;
      if (active && backgroundFollowUpWindowMs > 0) {
        const anchor = getMostRecentCortexMessage(messages);
        const anchorAgeMs = anchor ? Date.now() - messageTimeValue(anchor) : 0;
        if (Math.max(anchorAgeMs, listenWindowElapsedMs) < MAX_TOOL_CALLBACK_GRACE_MS) {
          cortexWasActiveRef.current = true;
          if (latestCortexMessageId) targetParentRef.current = latestCortexMessageId;
          const lastPollAt = cortexLastPollRef.current;
          if (
            listenWindowElapsedMs < backgroundFollowUpWindowMs ||
            lastPollAt == null ||
            Date.now() - lastPollAt >= SLOW_TOOL_CALLBACK_POLL_INTERVAL_MS
          ) {
            cortexLastPollRef.current = Date.now();
            refreshMessages();
          }
          return;
        }
      } else if (cortexWasActiveRef.current) {
        // Phase B is authored after the final cortex settles. Its grace starts here.
        cortexWasActiveRef.current = false;
        cortexLastPollRef.current = null;
        listenWindowStartRef.current = Date.now();
        listenWindowElapsedMs = 0;
      }
      if (listenWindowElapsedMs >= backgroundFollowUpWindowMs) {
        expiredCortexTargetRef.current = targetParentRef.current;
        sawActiveRef.current = false;
        listenWindowStartRef.current = null;
        targetParentRef.current = null;
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

      refreshMessages();
    }, POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      sawActiveRef.current = false;
      memoryStarts.clear();
      activeWorkSignatureRef.current = null;
      memoryPausedAtRef.current = null;
      listenWindowStartRef.current = null;
      targetParentRef.current = null;
      expiredCortexTargetRef.current = null;
      cortexLastPollRef.current = null;
      cortexWasActiveRef.current = false;
      toolCallbackTargetRef.current = null;
      toolCallbackExpiredTargetRef.current = null;
      toolCallbackGraceStartRef.current = null;
      toolCallbackLastPollRef.current = null;
      toolCallbackTerminalTargetRef.current = null;
      toolCallbackTerminalSeenAtRef.current = null;
      toolCallbackStatusSignatureRef.current = '';
    };
  }, [conversationId, getMessages, queryClient]);
}
