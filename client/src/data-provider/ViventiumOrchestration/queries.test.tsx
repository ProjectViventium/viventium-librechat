import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import {
  activeWorkRefetchInterval,
  useActiveWorkQuery,
  useActiveWorkHistoryQuery,
  useOrchestrationPreferenceQuery,
  useUpdateOrchestrationMutation,
  useWorkActionMutation,
} from './queries';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: jest.fn(() => ''),
  request: {
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

describe('Viventium orchestration data hooks', () => {
  let queryClient: QueryClient;
  let wrapper: React.FC<PropsWithChildren>;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  afterEach(() => queryClient.clear());

  test('reads the canonical preference and active-work endpoints', async () => {
    (request.get as jest.Mock)
      .mockResolvedValueOnce({ available: true, mode: 'focused' })
      .mockResolvedValueOnce({ snapshot: 'fresh', work: [], overflowCount: 0 });

    const preference = renderHook(() => useOrchestrationPreferenceQuery(), { wrapper });
    const work = renderHook(() => useActiveWorkQuery(), { wrapper });

    await waitFor(() => expect(preference.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(work.result.current.isSuccess).toBe(true));
    expect(request.get).toHaveBeenCalledWith('/api/viventium/orchestration');
    expect(request.get).toHaveBeenCalledWith('/api/viventium/orchestration/work');
  });

  /* === VIVENTIUM START ===
   * Feature: Active work Control Panel discovery.
   * Purpose: Prevent duplicate preference traffic when startup config already enables the entry.
   */
  test('does not request the preference when the caller already has an authoritative gate', () => {
    const preference = renderHook(() => useOrchestrationPreferenceQuery({ enabled: false }), {
      wrapper,
    });

    expect(preference.result.current.fetchStatus).toBe('idle');
    expect(request.get).not.toHaveBeenCalled();
  });
  /* === VIVENTIUM END === */

  test('follows the opaque next cursor and merges roster pages without duplicates', async () => {
    (request.get as jest.Mock)
      .mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'work-1', title: 'First' }],
        overflowCount: 1,
        cursor: 'signed.next-page',
      })
      .mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'work-2', title: 'Second' }],
        overflowCount: 0,
      });
    const work = renderHook(() => useActiveWorkQuery(), { wrapper });
    await waitFor(() => expect(work.result.current.isSuccess).toBe(true));

    await act(async () => {
      await work.result.current.fetchNextPage();
    });

    expect(request.get).toHaveBeenLastCalledWith(
      '/api/viventium/orchestration/work?cursor=signed.next-page',
    );
    await waitFor(() =>
      expect(work.result.current.data?.work?.map((item) => item.workRef)).toEqual([
        'work-1',
        'work-2',
      ]),
    );
    expect(work.result.current.data?.overflowCount).toBe(0);
  });

  test('loads History only when enabled and follows its opaque cursor', async () => {
    (request.get as jest.Mock)
      .mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'history-1', state: 'completed', actions: [] }],
        overflowCount: 1,
        cursor: 'signed.history-next',
      })
      .mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'history-2', state: 'failed', actions: [] }],
        overflowCount: 0,
      });
    const history = renderHook(() => useActiveWorkHistoryQuery({ enabled: false }), { wrapper });
    expect(history.result.current.fetchStatus).toBe('idle');
    expect(request.get).not.toHaveBeenCalled();

    history.rerender();
    const enabled = renderHook(() => useActiveWorkHistoryQuery({ enabled: true }), { wrapper });
    await waitFor(() => expect(enabled.result.current.isSuccess).toBe(true));
    await act(async () => {
      await enabled.result.current.fetchNextPage();
    });
    expect(request.get).toHaveBeenLastCalledWith(
      '/api/viventium/orchestration/work/history?cursor=signed.history-next',
    );
    await waitFor(() =>
      expect(enabled.result.current.data?.work?.map((item) => item.workRef)).toEqual([
        'history-1',
        'history-2',
      ]),
    );
  });

  test('adapts refresh to live, attention, unavailable, and recent-only truth', () => {
    expect(
      activeWorkRefetchInterval({
        pages: [
          {
            snapshot: 'fresh',
            work: [
              {
                workRef: 'live',
                title: 'Running mission',
                state: 'running',
                provider: 'codex',
                delivery: { state: 'pending', unreadTerminal: false },
                actions: [],
              },
            ],
            overflowCount: 0,
          },
        ],
      }),
    ).toBe(2_000);
    expect(
      activeWorkRefetchInterval({
        pages: [
          {
            snapshot: 'fresh',
            work: [
              {
                workRef: 'attention',
                title: 'Mission needs attention',
                state: 'failed',
                provider: 'codex',
                delivery: { state: 'unknown', unreadTerminal: true },
                actions: [],
              },
            ],
            overflowCount: 0,
          },
        ],
      }),
    ).toBe(5_000);
    for (const state of ['paused', 'needs_input'] as const) {
      expect(
        activeWorkRefetchInterval({
          pages: [
            {
              snapshot: 'fresh',
              work: [
                {
                  workRef: state,
                  title: 'Mission needs attention',
                  state,
                  provider: 'codex',
                  delivery: { state: 'pending', unreadTerminal: false },
                  actions: [],
                },
              ],
              overflowCount: 0,
            },
          ],
        }),
      ).toBe(5_000);
    }
    expect(
      activeWorkRefetchInterval({
        pages: [{ snapshot: 'unavailable', work: null, overflowCount: null }],
      }),
    ).toBe(10_000);
    expect(
      activeWorkRefetchInterval({
        pages: [
          {
            snapshot: 'fresh',
            work: [
              {
                workRef: 'done',
                title: 'Completed mission',
                state: 'completed',
                provider: 'codex',
                delivery: { state: 'delivered', unreadTerminal: false },
                actions: [],
              },
            ],
            overflowCount: 0,
          },
        ],
      }),
    ).toBe(30_000);
  });

  test('keeps terminal-only refresh slow even when old worker runtime counts remain', () => {
    expect(
      activeWorkRefetchInterval({
        pages: [
          {
            snapshot: 'fresh',
            work: [
              {
                workRef: 'completed-worker',
                title: 'Completed mission',
                state: 'completed',
                provider: 'codex',
                nativeTeam: { active: 2, total: 2, needsAttention: 0, degraded: false },
                delivery: { state: 'delivered', unreadTerminal: false },
                actions: [],
              },
            ],
            overflowCount: 0,
          },
        ],
      }),
    ).toBe(30_000);
    expect(activeWorkRefetchInterval()).toBe(30_000);
  });

  test('patches only the canonical mode', async () => {
    (request.patch as jest.Mock).mockResolvedValue({ available: true, mode: 'parallel' });
    const mutation = renderHook(() => useUpdateOrchestrationMutation(), { wrapper });

    await act(async () => {
      await mutation.result.current.mutateAsync({ mode: 'parallel' });
    });

    expect(request.patch).toHaveBeenCalledWith('/api/viventium/orchestration', {
      mode: 'parallel',
    });
  });

  test('encodes the opaque work ref and sends operationId without a caller idempotency key', async () => {
    (request.post as jest.Mock).mockResolvedValue({ accepted: true });
    const mutation = renderHook(() => useWorkActionMutation(), { wrapper });

    await act(async () => {
      await mutation.result.current.mutateAsync({
        workRef: 'opaque/ref ? private',
        action: 'steer',
        operationId: '37d6c0ce-c7fa-4b03-b054-46f6bd2d82c6',
        instruction: 'Use the official source.',
      });
    });

    expect(request.post).toHaveBeenCalledWith(
      '/api/viventium/orchestration/work/opaque%2Fref%20%3F%20private/actions',
      {
        action: 'steer',
        operationId: '37d6c0ce-c7fa-4b03-b054-46f6bd2d82c6',
        instruction: 'Use the official source.',
      },
    );
    expect((request.post as jest.Mock).mock.calls[0][1]).not.toHaveProperty('idempotencyKey');
  });
});
