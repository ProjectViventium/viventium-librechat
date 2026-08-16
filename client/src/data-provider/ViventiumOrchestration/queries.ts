import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBaseUrl, request } from 'librechat-data-provider';

export type OrchestrationMode = 'focused' | 'parallel';

export type OrchestrationPreference = {
  available: boolean;
  mode: OrchestrationMode;
  hasKnownWork?: boolean;
};

export type WorkAttention = {
  kind: string;
  summary: string;
};

export type WorkSummary = {
  workRef: string;
  title: string;
  state: string;
  statusSummary?: string;
  attention?: WorkAttention;
  provider: string;
  originSurface?: string;
  nativeTeam?: {
    active: number;
    total: number;
    needsAttention: number;
    degraded: boolean;
  } | null;
  delivery: {
    state: 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'silent';
    unreadTerminal: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
  viewRef?: string;
  actions: string[];
};

export type ActiveWorkSnapshot = {
  snapshot: 'fresh' | 'stale' | 'unavailable';
  work: WorkSummary[] | null;
  overflowCount: number | null;
  cursor?: string;
};

export type WorkAction =
  'queue' | 'message' | 'steer' | 'pause' | 'resume' | 'stop' | 'retry' | 'dismiss';

export type WorkActionVariables = {
  workRef: string;
  action: WorkAction;
  operationId: string;
  instruction?: string;
};

const preferenceKey = ['viventium', 'orchestration', 'preference'] as const;
const activeWorkKey = ['viventium', 'orchestration', 'work'] as const;

export const useOrchestrationPreferenceQuery = () =>
  useQuery<OrchestrationPreference>(
    preferenceKey,
    () => request.get(`${apiBaseUrl()}/api/viventium/orchestration`),
    {
      staleTime: 2_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  );

export const useActiveWorkQuery = () => {
  const query = useInfiniteQuery<ActiveWorkSnapshot>({
    queryKey: activeWorkKey,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : '';
      const queryString = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request.get(`${apiBaseUrl()}/api/viventium/orchestration/work${queryString}`);
    },
    getNextPageParam: (lastPage) => lastPage.cursor || undefined,
    staleTime: 2_000,
    keepPreviousData: true,
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  });
  const pages = query.data?.pages;
  const first = pages?.[0];
  const last = pages?.[pages.length - 1];
  const merged = first
    ? {
        ...first,
        work: Array.isArray(first.work)
          ? Array.from(
              new Map(
                pages
                  ?.flatMap((page) => (Array.isArray(page.work) ? page.work : []))
                  .map((item) => [item.workRef, item]),
              ).values(),
            )
          : null,
        overflowCount: last?.overflowCount ?? first.overflowCount,
        cursor: last?.cursor,
      }
    : undefined;
  return { ...query, data: merged };
};

export const useUpdateOrchestrationMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<OrchestrationPreference, Error, { mode: OrchestrationMode }>(
    ({ mode }) =>
      request.patch(`${apiBaseUrl()}/api/viventium/orchestration`, {
        mode,
      }),
    {
      onSuccess: (response) => queryClient.setQueryData(preferenceKey, response),
      onError: () => queryClient.invalidateQueries(preferenceKey),
    },
  );
};

export const useWorkActionMutation = () => {
  const queryClient = useQueryClient();
  return useMutation<unknown, Error, WorkActionVariables>(
    ({ workRef, action, operationId, instruction }) =>
      request.post(
        `${apiBaseUrl()}/api/viventium/orchestration/work/${encodeURIComponent(workRef)}/actions`,
        {
          action,
          operationId,
          ...(instruction ? { instruction } : {}),
        },
      ),
    {
      onSuccess: () => queryClient.invalidateQueries(activeWorkKey),
      onError: () => queryClient.invalidateQueries(activeWorkKey),
    },
  );
};
