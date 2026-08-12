/* === VIVENTIUM START === one-click call error and postMessage trust-boundary tests. === VIVENTIUM END === */

import {
  classifyCallFailure,
  clearActiveCallTracking,
  continuationRetryDelayMs,
  endCallSessionWithRetry,
  fetchAllCallTaskContinuationPages,
  fetchCallTaskContinuationPage,
  shouldRetryCallTaskResponse,
  isTrustedCallLifecycleMessage,
  isObservedCallWindowClosed,
  resolveCallLifecycleConversationId,
  summarizeCallTaskContinuation,
} from './CallButton';

describe('CallButton trust and failure helpers', () => {
  test('uses structured failure codes and never exposes arbitrary server text', () => {
    expect(classifyCallFailure(503, 'gateway_down')).toEqual({
      code: 'gateway_down',
      message: 'Calling is temporarily unavailable. Please retry.',
    });
    expect(classifyCallFailure(500, '<script>private failure</script>')).toEqual({
      code: 'unknown',
      message: 'The call could not start. Please retry.',
    });
  });

  test('accepts only exact window, origin, V1 type, session, and lifecycle event', () => {
    const callWindow = {} as Window;
    const valid = {
      source: callWindow,
      origin: 'https://calls.example.com',
      data: {
        version: 1,
        type: 'viventium.call.event.v1',
        callSessionId: 'call-1',
        event: 'result',
      },
    } as Pick<MessageEvent, 'source' | 'origin' | 'data'>;

    expect(
      isTrustedCallLifecycleMessage(valid, callWindow, 'https://calls.example.com', 'call-1'),
    ).toBe(true);
    expect(
      isTrustedCallLifecycleMessage(
        { ...valid, origin: 'https://hostile.example' },
        callWindow,
        'https://calls.example.com',
        'call-1',
      ),
    ).toBe(false);
    expect(
      isTrustedCallLifecycleMessage(valid, {} as Window, 'https://calls.example.com', 'call-1'),
    ).toBe(false);
    expect(
      isTrustedCallLifecycleMessage(valid, callWindow, 'https://calls.example.com', 'call-2'),
    ).toBe(false);
    expect(
      isTrustedCallLifecycleMessage(
        { ...valid, data: { ...valid.data, event: 'refresh' } },
        callWindow,
        'https://calls.example.com',
        'call-1',
      ),
    ).toBe(false);
  });

  test.each(['result', 'ended'])(
    'uses the materialized conversation for a trusted %s event',
    (event) => {
      expect(
        resolveCallLifecycleConversationId(
          { event, conversationId: 'conversation_materialized_1' },
          'conversation_stale_1',
        ),
      ).toBe('conversation_materialized_1');
    },
  );

  test('rejects an invalid lifecycle conversation id and safely falls back', () => {
    expect(
      resolveCallLifecycleConversationId(
        { conversationId: '../hostile?token=private' },
        'conversation_safe_1',
      ),
    ).toBe('conversation_safe_1');
  });

  test('keeps polling running work and invalidates a completed linked conversation once', () => {
    expect(
      summarizeCallTaskContinuation([
        { version: 1, type: 'snapshot', taskId: 'task-1', state: 'running' },
      ]),
    ).toEqual({ hasActive: true, completed: [] });
    expect(
      summarizeCallTaskContinuation([
        {
          version: 1,
          type: 'snapshot',
          taskId: 'task-1',
          state: 'completed',
          conversationId: 'conversation_linked_1',
          internalOwnerSecret: 'never-consumed',
        },
      ]),
    ).toEqual({
      hasActive: false,
      completed: [{ taskId: 'task-1', conversationId: 'conversation_linked_1' }],
    });
  });

  test('ends only an actually closed call window, never an in-place refresh', () => {
    expect(isObservedCallWindowClosed({ closed: true } as Window)).toBe(true);
    expect(isObservedCallWindowClosed({ closed: false } as Window)).toBe(false);
    expect(isObservedCallWindowClosed(null)).toBe(false);
  });

  test('trusted ended lifecycle clears active tracking so a fresh Call can start immediately', () => {
    const oldWindow = { closed: false } as Window;
    const tracking = {
      callWindow: { current: oldWindow as Window | null },
      callSessionId: { current: 'call-ended' },
      playgroundOrigin: { current: 'https://calls.example.com' },
    };

    expect(clearActiveCallTracking(tracking)).toBe('call-ended');
    expect(tracking).toEqual({
      callWindow: { current: null },
      callSessionId: { current: '' },
      playgroundOrigin: { current: '' },
    });
    expect(clearActiveCallTracking(tracking)).toBe('');
  });

  test('retries transient continuation failures with bounded exponential jitter', () => {
    expect(shouldRetryCallTaskResponse(503, 0)).toBe(true);
    expect(shouldRetryCallTaskResponse(429, 5)).toBe(true);
    expect(shouldRetryCallTaskResponse(503, 6)).toBe(false);
    expect(shouldRetryCallTaskResponse(404, 0)).toBe(false);
    expect(continuationRetryDelayMs(0, 0.5)).toBe(750);
    expect(continuationRetryDelayMs(20, 1)).toBeLessThanOrEqual(8000);
  });

  test('retries a transient end failure independently until the terminal transition succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const wait = jest.fn().mockResolvedValue(undefined);

    await expect(
      endCallSessionWithRetry({ callSessionId: 'call-1', fetchImpl, wait }),
    ).resolves.toBe('ended');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({ keepalive: true });
  });

  test('times out a stalled end request and retries without waiting forever', async () => {
    const fetchImpl = jest
      .fn()
      .mockImplementationOnce(
        (_url, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('Timed out', 'AbortError')),
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await expect(
      endCallSessionWithRetry({
        callSessionId: 'call-1',
        fetchImpl,
        attemptTimeoutMs: 1,
        wait: jest.fn().mockResolvedValue(undefined),
      }),
    ).resolves.toBe('ended');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('turns a stalled continuation request into a retryable timeout', async () => {
    const fetchImpl = jest.fn(
      (_url, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Timed out', 'AbortError')),
            { once: true },
          );
        }),
    );

    await expect(
      fetchCallTaskContinuationPage({
        callSessionId: 'call-stalled',
        fetchImpl: fetchImpl as typeof fetch,
        attemptTimeoutMs: 1,
      }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(shouldRetryCallTaskResponse(0, 0)).toBe(true);
  });

  test('retrieves every stable continuation page so old active and newest completed work survive restart', async () => {
    const events = Array.from({ length: 1_002 }, (_, index) => ({
      version: 1,
      type: 'snapshot',
      taskId: `task-${index.toString().padStart(4, '0')}`,
      sequence: index === 0 ? 4 : 2,
      state: index === 0 ? 'running' : index === 1_001 ? 'completed' : 'failed',
      ...(index === 1_001 ? { conversationId: 'conversation-latest' } : {}),
    }));
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          version: 1,
          events: events.slice(490),
          hasMore: true,
          nextBeforeCreatedAt: '2026-08-09T12:00:00.000Z',
          nextBeforeTaskId: 'task-0490',
          continuation: {
            version: 1,
            status: 'active',
            hasActive: true,
            observedAt: '2026-08-09T12:00:01.000Z',
            quietUntil: '2026-08-09T12:00:03.000Z',
            nextPollAfterMs: 1500,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          version: 1,
          events: events.slice(0, 490),
          hasMore: false,
          continuation: {
            version: 1,
            status: 'active',
            hasActive: true,
            observedAt: '2026-08-09T12:00:01.000Z',
            quietUntil: '2026-08-09T12:00:03.000Z',
            nextPollAfterMs: 1500,
          },
        }),
      });

    const result = await fetchAllCallTaskContinuationPages({
      callSessionId: 'call-pressure',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.response.status).toBe(200);
    expect(result.events).toHaveLength(1_002);
    expect(summarizeCallTaskContinuation(result.events)).toMatchObject({
      hasActive: true,
      completed: [{ taskId: 'task-1001', conversationId: 'conversation-latest' }],
    });
    expect(fetchImpl.mock.calls[1][0]).toContain('beforeCreatedAt=2026-08-09T12%3A00%3A00.000Z');
    expect(fetchImpl.mock.calls[1][0]).toContain('beforeTaskId=task-0490');
  });

  test('refreshes authentication once and stops idempotently on an already-ended session', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: false, status: 410 });
    const refreshToken = jest.fn().mockResolvedValue({ token: 'refreshed-token' });
    const dispatchTokenUpdated = jest.fn();

    await expect(
      endCallSessionWithRetry({
        callSessionId: 'call-1',
        authToken: 'expired-token',
        fetchImpl,
        refreshToken,
        dispatchTokenUpdated,
        wait: jest.fn(),
      }),
    ).resolves.toBe('terminal');
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(dispatchTokenUpdated).toHaveBeenCalledWith('refreshed-token');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer refreshed-token' },
    });
  });
});
