import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiBaseUrl, request } from 'librechat-data-provider';

export type OrchestrationMode = 'focused' | 'parallel';

export type OrchestrationPreference = {
  available: boolean;
  mode: OrchestrationMode;
  hasKnownWork?: boolean;
  releaseGate?: {
    label: string;
    blockers: string[];
  };
};

export type WorkAttention = {
  kind: 'auth' | 'input' | 'launch_failed';
  code?: string;
  summary: string;
};

export type WorkState =
  | 'accepted'
  | 'queued'
  | 'claimed'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'settling'
  | 'paused'
  | 'needs_input'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkSummary = {
  workRef: string;
  title: string;
  state: WorkState;
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
    state: 'pending' | 'delivered' | 'acknowledged' | 'failed' | 'silent' | 'unknown';
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
const activeWorkHistoryKey = ['viventium', 'orchestration', 'work', 'history'] as const;

const LIVE_WORK_STATES = new Set<WorkState>([
  'accepted',
  'queued',
  'claimed',
  'admitted',
  'starting',
  'running',
  'settling',
  'stopping',
]);

const ATTENTION_WORK_STATES = new Set<WorkState>(['paused', 'needs_input']);

export const activeWorkRefetchInterval = (data?: { pages?: ActiveWorkSnapshot[] }): number => {
  const pages = data?.pages ?? [];
  const first = pages[0];
  if (first?.snapshot === 'stale' || first?.snapshot === 'unavailable') {
    return 10_000;
  }
  const work = pages.flatMap((page) => (Array.isArray(page.work) ? page.work : []));
  if (work.some((item) => LIVE_WORK_STATES.has(item.state))) {
    return 2_000;
  }
  if (
    work.some(
      (item) =>
        ATTENTION_WORK_STATES.has(item.state) ||
        item.attention != null ||
        item.actions?.includes('retry') ||
        ['pending', 'failed', 'unknown'].includes(item.delivery?.state),
    )
  ) {
    return 5_000;
  }
  return 30_000;
};

/* === VIVENTIUM START ===
 * Feature: Active work Control Panel discovery.
 * Purpose: Let an authoritative startup gate suppress the fallback preference request.
 */
export const useOrchestrationPreferenceQuery = ({ enabled = true }: { enabled?: boolean } = {}) =>
  useQuery<OrchestrationPreference>(
    preferenceKey,
    () => request.get(`${apiBaseUrl()}/api/viventium/orchestration`),
    {
      enabled,
      staleTime: 2_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: 1,
    },
  );
/* === VIVENTIUM END === */

const mergedSnapshot = (
  pages: ActiveWorkSnapshot[] | undefined,
): ActiveWorkSnapshot | undefined => {
  const first = pages?.[0];
  const last = pages?.[pages.length - 1];
  return first
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
};

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
    refetchInterval: activeWorkRefetchInterval,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: 1,
  });
  return { ...query, data: mergedSnapshot(query.data?.pages) };
};

export const useActiveWorkHistoryQuery = ({ enabled = false }: { enabled?: boolean } = {}) => {
  const query = useInfiniteQuery<ActiveWorkSnapshot>({
    queryKey: activeWorkHistoryKey,
    queryFn: ({ pageParam }) => {
      const cursor = typeof pageParam === 'string' ? pageParam : '';
      const queryString = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
      return request.get(`${apiBaseUrl()}/api/viventium/orchestration/work/history${queryString}`);
    },
    getNextPageParam: (lastPage) => lastPage.cursor || undefined,
    enabled,
    staleTime: 30_000,
    keepPreviousData: true,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  return { ...query, data: mergedSnapshot(query.data?.pages) };
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
