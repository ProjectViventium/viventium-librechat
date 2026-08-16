import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';
import {
  useActiveWorkQuery,
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
