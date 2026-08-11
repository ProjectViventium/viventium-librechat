/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

/* === VIVENTIUM NOTE ===
 * Feature: LibreChat Voice Calls - Call Button
 *
 * Purpose:
 * - Add a modern, accessible Call entrypoint in LibreChat
 * - Opens the exact configured Viventium voice surface in a new tab/window (minimal coupling)
 *
 * Added: 2026-01-08
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Phone, PhoneOff, Loader2 } from 'lucide-react';
import { useRecoilValue } from 'recoil';
import { useQueryClient } from '@tanstack/react-query';
import { TooltipAnchor } from '@librechat/client';
import { QueryKeys, request } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks/AuthContext';
import { useGetStartupConfig } from '~/data-provider';
import store from '~/store';
import { cn } from '~/utils';
import { readVoiceCallFailureMessage } from './voiceCallError';

type CallState = 'idle' | 'connecting' | 'active' | 'error';
type CallFailureCode =
  | 'auth_expired'
  | 'mic_denied'
  | 'microphone_missing'
  | 'no_route'
  | 'gateway_down'
  | 'provider_failure'
  | 'unknown';

const callFailureMessages: Record<CallFailureCode, string> = {
  auth_expired: 'Your session expired. Sign in again, then retry the call.',
  mic_denied: 'Microphone access is blocked. Allow it in your browser and retry.',
  microphone_missing: 'No microphone is available.',
  no_route: 'Voice is not configured for this assistant.',
  gateway_down: 'Calling is temporarily unavailable. Please retry.',
  provider_failure: 'The configured voice provider is unavailable. Please retry.',
  unknown: 'The call could not start. Please retry.',
};

export function classifyCallFailure(status: number, code?: unknown) {
  const known = new Set(Object.keys(callFailureMessages));
  const resolved =
    typeof code === 'string' && known.has(code)
      ? (code as CallFailureCode)
      : status === 401
        ? 'auth_expired'
        : status === 502
          ? 'provider_failure'
          : status === 503
            ? 'gateway_down'
            : 'unknown';
  return { code: resolved, message: callFailureMessages[resolved] };
}

export function renderPendingCallWindow(
  callWindow: Window,
  state: 'connecting' | 'error',
  message?: string,
) {
  try {
    const doc = callWindow.document;
    const title = state === 'connecting' ? 'Connecting to Viventium…' : 'Viventium Call';
    const style = doc.createElement('style');
    style.textContent =
      'html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#0b1020;color:#f7f8fb;font:16px system-ui,sans-serif}.card{max-width:28rem;padding:2rem;text-align:center}.mark{font-size:2rem}.status{margin:.75rem 0;color:#b8c1d9}.back{margin-top:1rem;border:0;border-radius:.6rem;padding:.7rem 1rem;background:#fff;color:#111827;font:inherit;cursor:pointer}';
    const card = doc.createElement('main');
    card.className = 'card';
    const mark = doc.createElement('div');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    mark.textContent = '◉';
    const heading = doc.createElement('h1');
    heading.textContent = state === 'connecting' ? 'Connecting your call…' : 'Call needs attention';
    const status = doc.createElement('p');
    status.className = 'status';
    status.setAttribute('role', state === 'error' ? 'alert' : 'status');
    status.textContent =
      state === 'connecting'
        ? 'Checking the configured voice route and gateway.'
        : message || 'Return to Viventium and try the call again.';
    card.append(mark, heading, status);
    if (state === 'error') {
      const back = doc.createElement('button');
      back.className = 'back';
      back.type = 'button';
      back.textContent = 'Back to Viventium';
      back.addEventListener('click', () => {
        callWindow.opener?.focus();
        callWindow.close();
      });
      card.append(back);
    }
    doc.head.replaceChildren(style);
    doc.body.replaceChildren(card);
    doc.title = title;
  } catch {
    // A browser extension or an unusually strict popup policy can deny access to the inherited
    // about:blank document. The originating tab still owns the classified inline recovery.
  }
}

export function isTrustedCallLifecycleMessage(
  event: Pick<MessageEvent, 'source' | 'origin' | 'data'>,
  expectedWindow: Window | null,
  expectedOrigin: string,
  expectedCallSessionId: string,
) {
  return Boolean(
    expectedWindow &&
    event.source === expectedWindow &&
    event.origin === expectedOrigin &&
    event.data &&
    event.data.version === 1 &&
    event.data.type === 'viventium.call.event.v1' &&
    event.data.callSessionId === expectedCallSessionId &&
    ['result', 'ended'].includes(event.data.event),
  );
}

export function resolveCallLifecycleConversationId(data: unknown, fallback?: string) {
  const candidate =
    data && typeof data === 'object' && 'conversationId' in data
      ? (data as { conversationId?: unknown }).conversationId
      : undefined;
  if (
    typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 160 &&
    candidate !== 'new' &&
    /^[A-Za-z0-9_-]+$/.test(candidate)
  ) {
    return candidate;
  }
  return fallback && fallback !== 'new' ? fallback : '';
}

const terminalTaskStates = new Set([
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
]);
const MAX_CONTINUATION_RETRIES = 6;
const END_REQUEST_TIMEOUT_MS = 5000;
const CONTINUATION_REQUEST_TIMEOUT_MS = 5000;

export function continuationRetryDelayMs(attempt: number, jitter = Math.random()) {
  const boundedAttempt = Math.min(Math.max(Math.floor(attempt), 0), 8);
  const base = Math.min(750 * 2 ** boundedAttempt, 8000);
  const boundedJitter = Math.min(Math.max(jitter, 0), 1);
  return Math.min(Math.round(base * (0.8 + boundedJitter * 0.4)), 8000);
}

export function shouldRetryCallTaskResponse(status: number, attempt: number) {
  if (attempt >= MAX_CONTINUATION_RETRIES) {
    return false;
  }
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

type EndCallSessionOptions = {
  callSessionId: string;
  authToken?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  refreshToken?: () => Promise<{ token?: string }>;
  dispatchTokenUpdated?: (token: string) => void;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  attemptTimeoutMs?: number;
};

export async function endCallSessionWithRetry({
  callSessionId,
  authToken,
  signal,
  fetchImpl = fetch,
  refreshToken = request.refreshToken,
  dispatchTokenUpdated = request.dispatchTokenUpdatedEvent,
  wait = (delayMs, abortSignal) =>
    new Promise<void>((resolve) => {
      if (abortSignal?.aborted) return resolve();
      const timer = window.setTimeout(resolve, delayMs);
      abortSignal?.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    }),
  attemptTimeoutMs = END_REQUEST_TIMEOUT_MS,
}: EndCallSessionOptions): Promise<'ended' | 'terminal' | 'failed'> {
  let bearerToken = authToken;
  let authRefreshed = false;
  for (let attempt = 0; attempt <= MAX_CONTINUATION_RETRIES && !signal?.aborted; attempt += 1) {
    const attemptController = new AbortController();
    const abortAttempt = () => attemptController.abort();
    signal?.addEventListener('abort', abortAttempt, { once: true });
    const attemptTimer = window.setTimeout(
      abortAttempt,
      Math.max(1, Math.min(attemptTimeoutMs, END_REQUEST_TIMEOUT_MS)),
    );
    try {
      const response = await fetchImpl(
        `/api/viventium/calls/${encodeURIComponent(callSessionId)}/end`,
        {
          method: 'POST',
          headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
          signal: attemptController.signal,
          keepalive: true,
        },
      );
      if (response.ok) return 'ended';
      if (response.status === 404 || response.status === 410) return 'terminal';
      if (response.status === 401 && !authRefreshed) {
        authRefreshed = true;
        try {
          const refreshed = await refreshToken();
          if (refreshed?.token) {
            bearerToken = refreshed.token;
            dispatchTokenUpdated(refreshed.token);
          }
        } catch {
          // One refresh attempt only; a refreshed cookie from another tab may still authorize the
          // next idempotent attempt.
        }
        continue;
      }
      if (!shouldRetryCallTaskResponse(response.status, attempt)) return 'failed';
    } catch (endError) {
      if (signal?.aborted || !shouldRetryCallTaskResponse(0, attempt)) {
        return 'failed';
      }
    } finally {
      window.clearTimeout(attemptTimer);
      signal?.removeEventListener('abort', abortAttempt);
    }
    await wait(continuationRetryDelayMs(attempt), signal);
  }
  return 'failed';
}

export function summarizeCallTaskContinuation(events: unknown, fallbackConversationId?: string) {
  const snapshots = Array.isArray(events)
    ? events.filter((event): event is Record<string, unknown> =>
        Boolean(
          event &&
          typeof event === 'object' &&
          (event as Record<string, unknown>).version === 1 &&
          (event as Record<string, unknown>).type === 'snapshot' &&
          typeof (event as Record<string, unknown>).taskId === 'string' &&
          typeof (event as Record<string, unknown>).state === 'string',
        ),
      )
    : [];
  const completed = snapshots.filter((event) => event.state === 'completed');
  return {
    hasActive: snapshots.some((event) => !terminalTaskStates.has(String(event.state))),
    completed: completed.map((event) => ({
      taskId: String(event.taskId),
      conversationId: resolveCallLifecycleConversationId(event, fallbackConversationId),
    })),
  };
}

export function isObservedCallWindowClosed(callWindow: Pick<Window, 'closed'> | null) {
  return callWindow?.closed === true;
}

export async function fetchCallTaskContinuationPage({
  callSessionId,
  authToken,
  beforeCreatedAt,
  beforeTaskId,
  parentSignal,
  fetchImpl = fetch,
  attemptTimeoutMs = CONTINUATION_REQUEST_TIMEOUT_MS,
}: {
  callSessionId: string;
  authToken?: string;
  beforeCreatedAt?: string;
  beforeTaskId?: string;
  parentSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  attemptTimeoutMs?: number;
}) {
  const attemptController = new AbortController();
  let timedOut = false;
  const abortForParent = () => attemptController.abort();
  parentSignal?.addEventListener('abort', abortForParent, { once: true });
  const timer = window.setTimeout(
    () => {
      timedOut = true;
      attemptController.abort();
    },
    Math.max(1, Math.min(attemptTimeoutMs, CONTINUATION_REQUEST_TIMEOUT_MS)),
  );
  try {
    const query = new URLSearchParams();
    if (beforeCreatedAt && beforeTaskId) {
      query.set('beforeCreatedAt', beforeCreatedAt);
      query.set('beforeTaskId', beforeTaskId);
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return await fetchImpl(
      `/api/viventium/calls/${encodeURIComponent(callSessionId)}/tasks${suffix}`,
      {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        signal: attemptController.signal,
      },
    );
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) {
      const timeoutError = new Error('Call task continuation request timed out');
      timeoutError.name = 'TimeoutError';
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortForParent);
  }
}

/* === VIVENTIUM START ===
 * Feature: lossless post-hangup task continuation
 * Purpose: Traverse the server's stable durable cursor so an old active task and newly completed
 * work remain visible even after an API restart and more than the in-memory task limit. Cursor
 * replay is strict and dedupes by task sequence; malformed/repeated cursors fail visibly instead
 * of silently declaring the call finished.
 * === VIVENTIUM END === */
export async function fetchAllCallTaskContinuationPages({
  callSessionId,
  authToken,
  parentSignal,
  fetchImpl = fetch,
  attemptTimeoutMs = CONTINUATION_REQUEST_TIMEOUT_MS,
}: {
  callSessionId: string;
  authToken?: string;
  parentSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  attemptTimeoutMs?: number;
}) {
  const eventsByTaskId = new Map<string, Record<string, unknown>>();
  const seenCursors = new Set<string>();
  let beforeCreatedAt: string | undefined;
  let beforeTaskId: string | undefined;
  let response: Response | null = null;
  let continuation: CallTaskContinuationState | null = null;
  let pages = 0;
  do {
    response = await fetchCallTaskContinuationPage({
      callSessionId,
      ...(authToken ? { authToken } : {}),
      ...(beforeCreatedAt && beforeTaskId ? { beforeCreatedAt, beforeTaskId } : {}),
      ...(parentSignal ? { parentSignal } : {}),
      fetchImpl,
      attemptTimeoutMs,
    });
    if (!response.ok) return { response, events: [], continuation: null };
    const payload = await response.json();
    if (payload?.version !== 1 || !Array.isArray(payload?.events)) {
      throw new Error('Malformed call task continuation page');
    }
    continuation = parseCallTaskContinuationState(payload.continuation);
    for (const event of payload.events) {
      if (!event || typeof event !== 'object' || typeof event.taskId !== 'string') continue;
      const previous = eventsByTaskId.get(event.taskId);
      const previousSequence = Number(previous?.sequence);
      const nextSequence = Number(event.sequence);
      if (!previous || (Number.isSafeInteger(nextSequence) && nextSequence >= previousSequence)) {
        eventsByTaskId.set(event.taskId, event);
      }
    }
    if (payload.hasMore !== true) break;
    if (
      typeof payload.nextBeforeCreatedAt !== 'string' ||
      !payload.nextBeforeCreatedAt ||
      typeof payload.nextBeforeTaskId !== 'string' ||
      !payload.nextBeforeTaskId
    ) {
      throw new Error('Malformed call task continuation cursor');
    }
    const cursor = `${payload.nextBeforeCreatedAt}\0${payload.nextBeforeTaskId}`;
    if (seenCursors.has(cursor) || pages >= 255) {
      throw new Error('Call task continuation cursor did not advance');
    }
    seenCursors.add(cursor);
    beforeCreatedAt = payload.nextBeforeCreatedAt;
    beforeTaskId = payload.nextBeforeTaskId;
    pages += 1;
  } while (!parentSignal?.aborted);
  if (!response || !continuation) throw new Error('Call task continuation did not start');
  return { response, events: [...eventsByTaskId.values()], continuation };
}

export function clearActiveCallTracking({
  callWindow,
  callSessionId,
  playgroundOrigin,
}: {
  callWindow: { current: Window | null };
  callSessionId: { current: string };
  playgroundOrigin: { current: string };
}) {
  const endedCallSessionId = callSessionId.current;
  callWindow.current = null;
  callSessionId.current = '';
  playgroundOrigin.current = '';
  return endedCallSessionId;
}

type ContinuationPollState = {
  retryAttempts: number;
  authToken?: string;
  authRefreshed: boolean;
};

type CallTaskContinuationState = {
  version: 1;
  status: 'active' | 'monitoring' | 'quiescent';
  hasActive: boolean;
  observedAt: string;
  quietUntil: string;
  nextPollAfterMs: number | null;
};

export function parseCallTaskContinuationState(value: unknown): CallTaskContinuationState {
  const state = value as Partial<CallTaskContinuationState> | null;
  const validStatus =
    state?.status === 'active' || state?.status === 'monitoring' || state?.status === 'quiescent';
  const observedAtMs = Date.parse(state?.observedAt ?? '');
  const quietUntilMs = Date.parse(state?.quietUntil ?? '');
  const validNextPoll =
    state?.status === 'quiescent'
      ? state.nextPollAfterMs === null
      : Number.isInteger(state?.nextPollAfterMs) &&
        Number(state?.nextPollAfterMs) >= 250 &&
        Number(state?.nextPollAfterMs) <= 60_000;
  const validActivity =
    (state?.status === 'active' && state.hasActive === true) ||
    (state?.status !== 'active' && state?.hasActive === false);
  if (
    state?.version !== 1 ||
    !validStatus ||
    !validActivity ||
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(quietUntilMs) ||
    !validNextPoll
  ) {
    throw new Error('Malformed call task continuation state');
  }
  return state as CallTaskContinuationState;
}

export function shouldContinueCallTaskPolling(state: CallTaskContinuationState) {
  return {
    shouldContinue: state.status !== 'quiescent',
    nextPollAfterMs: state.nextPollAfterMs,
  };
}

export default function CallButton({ className }: { className?: string }) {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const agentId = conversation?.agent_id;
  const conversationId = conversation?.conversationId;
  const { token } = useAuthContext();
  const { data: startupConfig } = useGetStartupConfig();
  const queryClient = useQueryClient();
  const errorId = useId();

  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const callWindowRef = useRef<Window | null>(null);
  const callSessionIdRef = useRef<string>('');
  const playgroundOriginRef = useRef<string>('');
  const continuationTimerRef = useRef<number | null>(null);
  const continuationAbortRef = useRef<AbortController | null>(null);
  const invalidatedTaskIdsRef = useRef(new Set<string>());

  /* === VIVENTIUM START ===
   * Feature: Voice readiness and privacy guard.
   * Purpose: Missing or disabled Voice capability must not expose a working-looking call action.
   * === VIVENTIUM END === */
  const voiceEnabled = startupConfig?.viventiumVoiceEnabled === true;
  const enabled = voiceEnabled && typeof agentId === 'string' && agentId.length > 0;

  const stopContinuationPolling = useCallback(() => {
    if (continuationTimerRef.current !== null) {
      window.clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
    continuationAbortRef.current?.abort();
    continuationAbortRef.current = null;
  }, []);

  const pollCallTasks = useCallback(
    async function pollCallTasksImpl(
      callSessionId: string,
      pollState: ContinuationPollState = {
        retryAttempts: 0,
        authToken: token,
        authRefreshed: false,
      },
    ): Promise<void> {
      stopContinuationPolling();
      const abortController = new AbortController();
      continuationAbortRef.current = abortController;
      try {
        const continuation = await fetchAllCallTaskContinuationPages({
          callSessionId,
          ...(pollState.authToken ? { authToken: pollState.authToken } : {}),
          parentSignal: abortController.signal,
        });
        const response = continuation.response;
        if (response.status === 401 && !pollState.authRefreshed) {
          let refreshedToken = '';
          try {
            const refreshResponse = await request.refreshToken();
            refreshedToken = refreshResponse?.token ?? '';
          } catch {
            // One refresh attempt is the security boundary. A subsequent request may use a cookie
            // renewed by another tab, but this poller never loops token refresh indefinitely.
          }
          if (refreshedToken && !abortController.signal.aborted) {
            request.dispatchTokenUpdatedEvent(refreshedToken);
          }
          if (!abortController.signal.aborted) {
            continuationTimerRef.current = window.setTimeout(
              () =>
                void pollCallTasksImpl(callSessionId, {
                  ...pollState,
                  ...(refreshedToken ? { authToken: refreshedToken } : {}),
                  authRefreshed: true,
                }),
              0,
            );
          }
          return;
        }
        if (!response.ok) {
          if (
            shouldRetryCallTaskResponse(response.status, pollState.retryAttempts) &&
            !abortController.signal.aborted
          ) {
            continuationTimerRef.current = window.setTimeout(
              () =>
                void pollCallTasksImpl(callSessionId, {
                  ...pollState,
                  retryAttempts: pollState.retryAttempts + 1,
                }),
              continuationRetryDelayMs(pollState.retryAttempts),
            );
          }
          return;
        }
        const summary = summarizeCallTaskContinuation(
          continuation.events,
          conversationId ?? undefined,
        );
        for (const completed of summary.completed) {
          if (invalidatedTaskIdsRef.current.has(completed.taskId)) {
            continue;
          }
          invalidatedTaskIdsRef.current.add(completed.taskId);
          if (completed.conversationId) {
            void queryClient.invalidateQueries([QueryKeys.messages, completed.conversationId]);
            void queryClient.invalidateQueries([QueryKeys.conversation, completed.conversationId]);
          }
          void queryClient.invalidateQueries([QueryKeys.allConversations]);
        }
        const continuationDecision = shouldContinueCallTaskPolling(continuation.continuation);
        if (continuationDecision.shouldContinue && !abortController.signal.aborted) {
          continuationTimerRef.current = window.setTimeout(
            () =>
              void pollCallTasksImpl(callSessionId, {
                ...pollState,
                retryAttempts: 0,
              }),
            continuationDecision.nextPollAfterMs ?? 1500,
          );
        }
      } catch (pollError) {
        if (
          shouldRetryCallTaskResponse(0, pollState.retryAttempts) &&
          !(pollError instanceof DOMException && pollError.name === 'AbortError')
        ) {
          continuationTimerRef.current = window.setTimeout(
            () =>
              void pollCallTasksImpl(callSessionId, {
                ...pollState,
                retryAttempts: pollState.retryAttempts + 1,
              }),
            continuationRetryDelayMs(pollState.retryAttempts),
          );
        }
      }
    },
    [conversationId, queryClient, stopContinuationPolling, token],
  );

  const markCallEndedAndPoll = useCallback(
    (callSessionId: string) => {
      if (!callSessionId) {
        return;
      }
      void endCallSessionWithRetry({
        callSessionId,
        ...(token ? { authToken: token } : {}),
      });
      void pollCallTasks(callSessionId);
    },
    [pollCallTasks, token],
  );

  // Reset to idle once the call window is closed.
  useEffect(() => {
    const t = window.setInterval(() => {
      const w = callWindowRef.current;
      if (isObservedCallWindowClosed(w)) {
        const endedCallSessionId = clearActiveCallTracking({
          callWindow: callWindowRef,
          callSessionId: callSessionIdRef,
          playgroundOrigin: playgroundOriginRef,
        });
        markCallEndedAndPoll(endedCallSessionId);
        setState('idle');
      }
    }, 1000);

    return () => window.clearInterval(t);
  }, [markCallEndedAndPoll]);

  useEffect(() => () => stopContinuationPolling(), [stopContinuationPolling]);

  useEffect(() => {
    const onCallMessage = (event: MessageEvent) => {
      const callWindow = callWindowRef.current;
      if (
        !isTrustedCallLifecycleMessage(
          event,
          callWindow,
          playgroundOriginRef.current,
          callSessionIdRef.current,
        )
      ) {
        return;
      }
      const resolvedConversationId = resolveCallLifecycleConversationId(
        event.data,
        conversationId ?? undefined,
      );
      if (resolvedConversationId) {
        void queryClient.invalidateQueries([QueryKeys.messages, resolvedConversationId]);
        void queryClient.invalidateQueries([QueryKeys.conversation, resolvedConversationId]);
      }
      void queryClient.invalidateQueries([QueryKeys.allConversations]);
      if (event.data.event === 'ended') {
        const endedCallSessionId = clearActiveCallTracking({
          callWindow: callWindowRef,
          callSessionId: callSessionIdRef,
          playgroundOrigin: playgroundOriginRef,
        });
        setState('idle');
        setError(null);
        markCallEndedAndPoll(endedCallSessionId);
      }
    };
    window.addEventListener('message', onCallMessage);
    return () => window.removeEventListener('message', onCallMessage);
  }, [conversationId, markCallEndedAndPoll, queryClient]);

  const startCall = useCallback(async () => {
    if (!enabled || state === 'connecting') {
      return;
    }

    // If a call tab is already open, focus it.
    if (callWindowRef.current && !callWindowRef.current.closed) {
      callWindowRef.current.focus();
      return;
    }

    // Open synchronously in the originating click so browser popup policy never turns a successful
    // signed session into a manual copy/paste recovery flow.
    const pendingWindow = window.open('', '_blank');
    if (!pendingWindow) {
      setState('error');
      setError(
        'Your browser blocked the call window. Allow popups for this site and click Call again.',
      );
      return;
    }
    callWindowRef.current = pendingWindow;
    renderPendingCallWindow(pendingWindow, 'connecting');
    setState('connecting');
    setError(null);

    try {
      const makeRequest = async (bearerToken?: string) => {
        return await fetch('/api/viventium/calls', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
          },
          body: JSON.stringify({
            conversationId: conversationId ?? 'new',
            agentId,
          }),
        });
      };

      let resp = await makeRequest(token);
      if (resp.status === 401) {
        // Match existing SSE behavior: refresh token and retry once.
        const refreshResponse = await request.refreshToken();
        const newToken = refreshResponse?.token ?? '';
        if (newToken) {
          request.dispatchTokenUpdatedEvent(newToken);
          resp = await makeRequest(newToken);
        }
      }

      if (!resp.ok) {
        throw new Error(await readVoiceCallFailureMessage(resp));
      }

      const data = await resp.json();

      const url = data?.playgroundUrl;
      if (typeof url !== 'string' || url.length === 0) {
        throw new Error('Missing playgroundUrl');
      }

      const resolvedUrl = new URL(url, window.location.href);
      playgroundOriginRef.current = resolvedUrl.origin;
      callSessionIdRef.current = typeof data?.callSessionId === 'string' ? data.callSessionId : '';
      pendingWindow.location.replace(resolvedUrl.href);
      setState('active');
      pendingWindow.focus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Call failed';
      renderPendingCallWindow(pendingWindow, 'error', msg);
      callWindowRef.current = null;
      setState('error');
      setError(msg);
    }
  }, [agentId, conversationId, enabled, state, token]);

  const endCall = useCallback(() => {
    const callSessionId = callSessionIdRef.current;
    const w = callWindowRef.current;
    if (w && !w.closed) {
      w.close();
    }
    markCallEndedAndPoll(callSessionId);
    clearActiveCallTracking({
      callWindow: callWindowRef,
      callSessionId: callSessionIdRef,
      playgroundOrigin: playgroundOriginRef,
    });
    setState('idle');
  }, [markCallEndedAndPoll]);

  if (!enabled) {
    return null;
  }

  const isConnecting = state === 'connecting';
  const isActive = state === 'active';

  const label = isActive
    ? 'End voice call'
    : state === 'error'
      ? 'Retry voice call'
      : 'Start voice call';
  const title =
    error ||
    (state === 'idle'
      ? 'Start voice call'
      : state === 'connecting'
        ? 'Connecting…'
        : state === 'active'
          ? 'End voice call'
          : 'Voice could not start');

  return (
    <div className="flex items-center gap-2">
      <TooltipAnchor
        description={title}
        render={
          <button
            type="button"
            onClick={isActive ? endCall : startCall}
            disabled={isConnecting}
            aria-label={label}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              'flex items-center justify-center rounded-lg p-2 transition-all duration-200',
              'hover:bg-surface-secondary focus:outline-none focus:ring-2 focus:ring-offset-2',
              state === 'idle' && 'text-text-secondary hover:text-text-primary',
              state === 'connecting' && 'cursor-wait text-yellow-500',
              state === 'active' &&
                'bg-green-500/10 text-green-500 hover:bg-red-500/10 hover:text-red-500',
              state === 'error' && 'text-red-500',
              className,
            )}
          >
            {state === 'connecting' ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : state === 'active' ? (
              <PhoneOff className="h-5 w-5" />
            ) : (
              <Phone className="h-5 w-5" />
            )}
          </button>
        }
      />
      {error ? (
        <span id={errorId} role="alert" className="max-w-64 text-xs leading-tight text-red-500">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/* === VIVENTIUM NOTE === */
