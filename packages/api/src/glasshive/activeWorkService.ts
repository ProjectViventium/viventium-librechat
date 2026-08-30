import { requestAccountApi } from './accountClient';
import type { AccountFetch } from './accountClient';

/* === VIVENTIUM START ===
 * Feature: Trusted GlassHive active-work snapshot service.
 * Purpose: Preserve owner-scoped stale/unavailable truth, monotonic cache updates, and durable
 * known-work fencing while keeping database and projection adapters outside the package core.
 * === VIVENTIUM END === */

const DEFAULT_CACHE_MS = 2000;
const DEFAULT_COLD_TIMEOUT_MS = 100;
const DEFAULT_INTERACTIVE_TIMEOUT_MS = 5000;

type UnknownRecord = Record<string, unknown>;

interface CacheEntry {
  value: UnknownRecord;
  fetchedAt: number;
}

interface ObservationState {
  latestStarted: number;
  latestResolved: number;
  latestKnownWork: boolean;
  activeSequences: Set<number>;
  group: number;
  positiveGroups: Set<number>;
}

interface ActiveWorkObservation {
  ownerKey: string;
  state: ObservationState;
  sequence: number;
  group: number;
  generation: number;
  cacheVersion: number;
}

export interface ActiveWorkServiceDependencies {
  getUserParallelWorkKnownEpoch: (ownerId: string) => Promise<number | null | undefined>;
  markUserParallelWorkKnown: (ownerId: string) => Promise<boolean>;
  clearUserParallelWorkKnownIfEpoch: (
    ownerId: string,
    expectedKnownWorkEpoch: number,
  ) => Promise<boolean>;
  enrichActiveWorkSnapshot: (input: {
    ownerId: string;
    snapshot: UnknownRecord;
    includeCoreOnly?: boolean;
    includeCoreOnlyHistory?: boolean;
  }) => Promise<UnknownRecord>;
  hasKnownExternalWork: (input: { ownerId: string }) => Promise<boolean>;
}

export interface ActiveWorkPageOptions {
  ownerId?: unknown;
  cursor?: unknown;
  limit?: unknown;
  fetchImpl?: AccountFetch;
  timeoutMs?: number;
}

export interface ActiveWorkSnapshotOptions {
  ownerId?: unknown;
  fetchImpl?: AccountFetch;
  forceRefresh?: boolean;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function configuredTenantId(): string {
  return String(process.env.VIVENTIUM_TENANT_ID || 'local').trim() || 'local';
}

function normalizedSnapshot(value: unknown, snapshot = 'fresh'): UnknownRecord {
  const normalized = recordFrom(value);
  if (!Array.isArray(normalized.work)) {
    throw new Error('glasshive_active_work_invalid');
  }
  return {
    ...normalized,
    snapshot,
    overflowCount:
      typeof normalized.overflowCount === 'number' && Number.isInteger(normalized.overflowCount)
        ? normalized.overflowCount
        : 0,
  };
}

function boundedListLimit(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(1, Math.min(parsed, 100)) : 50;
}

function normalizedCursor(value: unknown): string {
  const cursor = String(value || '').trim();
  if (!cursor) {
    return '';
  }
  if (cursor.length > 2048 || !/^[A-Za-z0-9._~:@+-]+$/.test(cursor)) {
    throw new Error('glasshive_active_work_cursor_invalid');
  }
  return cursor;
}

export function createGlassHiveActiveWorkService(dependencies: ActiveWorkServiceDependencies) {
  const activeWorkCache = new Map<string, CacheEntry>();
  const activeWorkRefreshes = new Map<string, Map<string, Promise<UnknownRecord>>>();
  const activeWorkCacheVersions = new Map<string, number>();
  const activeWorkObservations = new Map<string, ObservationState>();
  let activeWorkCacheGeneration = 0;

  function ownerCacheKey(ownerId: unknown): string {
    return `${configuredTenantId()}\0${String(ownerId || '').trim()}`;
  }

  function observationState(ownerKey: string): ObservationState {
    let state = activeWorkObservations.get(ownerKey);
    if (!state) {
      state = {
        latestStarted: 0,
        latestResolved: 0,
        latestKnownWork: true,
        activeSequences: new Set(),
        group: 0,
        positiveGroups: new Set(),
      };
      activeWorkObservations.set(ownerKey, state);
    }
    return state;
  }

  function beginActiveWorkObservation(ownerKey: string): ActiveWorkObservation {
    const state = observationState(ownerKey);
    if (state.activeSequences.size === 0) {
      state.group += 1;
    }
    state.latestStarted += 1;
    state.activeSequences.add(state.latestStarted);
    return {
      ownerKey,
      state,
      sequence: state.latestStarted,
      group: state.group,
      generation: activeWorkCacheGeneration,
      cacheVersion: activeWorkCacheVersions.get(ownerKey) || 0,
    };
  }

  function finishActiveWorkObservation(observation?: ActiveWorkObservation): void {
    if (!observation || activeWorkObservations.get(observation.ownerKey) !== observation.state) {
      return;
    }
    observation.state.activeSequences.delete(observation.sequence);
    if (observation.state.activeSequences.size === 0) {
      const minimumGroup = Math.max(0, observation.state.group - 1);
      for (const group of observation.state.positiveGroups) {
        if (group < minimumGroup) {
          observation.state.positiveGroups.delete(group);
        }
      }
    }
  }

  function activeWorkObservationIsCurrent(observation?: ActiveWorkObservation): boolean {
    return Boolean(
      observation &&
      observation.generation === activeWorkCacheGeneration &&
      observation.cacheVersion === (activeWorkCacheVersions.get(observation.ownerKey) || 0) &&
      activeWorkObservations.get(observation.ownerKey) === observation.state &&
      observation.sequence === observation.state.latestStarted,
    );
  }

  function recordResolvedKnownWork(
    observation: ActiveWorkObservation | undefined,
    knownWork: boolean,
  ): void {
    if (!observation) {
      return;
    }
    if (knownWork) {
      observation.state.positiveGroups.add(observation.group);
    }
    if (observation.sequence < observation.state.latestResolved) {
      return;
    }
    observation.state.latestResolved = observation.sequence;
    observation.state.latestKnownWork = knownWork;
  }

  function activeWorkObservationMayPersist(
    observation: ActiveWorkObservation | undefined,
    knownWork: boolean,
  ): boolean {
    if (
      !observation ||
      observation.generation !== activeWorkCacheGeneration ||
      observation.cacheVersion !== (activeWorkCacheVersions.get(observation.ownerKey) || 0) ||
      activeWorkObservations.get(observation.ownerKey) !== observation.state ||
      observation.group !== observation.state.group
    ) {
      return false;
    }
    if (knownWork) {
      return true;
    }
    return (
      activeWorkObservationIsCurrent(observation) &&
      !observation.state.positiveGroups.has(observation.group)
    );
  }

  async function persistObservedKnownWork({
    ownerId,
    observation,
    knownWork,
    expectedKnownWorkEpoch,
    callerGuard,
  }: {
    ownerId: string;
    observation: ActiveWorkObservation | undefined;
    knownWork: boolean;
    expectedKnownWorkEpoch: number;
    callerGuard: () => boolean;
  }): Promise<boolean> {
    if (!callerGuard() || !activeWorkObservationMayPersist(observation, knownWork)) {
      return false;
    }
    if (knownWork) {
      const fenced = await dependencies.markUserParallelWorkKnown(ownerId);
      if (!fenced) {
        throw Object.assign(new Error('parallel_work_positive_fence_failed'), {
          code: 'parallel_work_positive_fence_failed',
        });
      }
      return true;
    }
    return dependencies.clearUserParallelWorkKnownIfEpoch(ownerId, expectedKnownWorkEpoch);
  }

  async function enrichSnapshot(
    ownerId: string,
    snapshot: UnknownRecord,
    {
      authoritativeFirstPage = false,
      observation,
      knownWorkEpoch = 0,
      shouldPersistKnownWork = () => true,
    }: {
      authoritativeFirstPage?: boolean;
      observation?: ActiveWorkObservation;
      knownWorkEpoch?: number;
      shouldPersistKnownWork?: () => boolean;
    } = {},
  ): Promise<UnknownRecord> {
    const enriched = await dependencies.enrichActiveWorkSnapshot({
      ownerId,
      snapshot,
      ...(authoritativeFirstPage ? { includeCoreOnly: true } : {}),
    });
    if (enriched.snapshot === 'fresh' && Array.isArray(enriched.work)) {
      let knownWork = enriched.work.length > 0 || Number(enriched.overflowCount) > 0;
      if (!knownWork && !authoritativeFirstPage) {
        return enriched;
      }
      if (knownWork) {
        recordResolvedKnownWork(observation, true);
        if (!shouldPersistKnownWork() || !activeWorkObservationMayPersist(observation, true)) {
          return enriched;
        }
      } else if (
        !shouldPersistKnownWork() ||
        !activeWorkObservationMayPersist(observation, false)
      ) {
        return enriched;
      }

      if (!knownWork) {
        knownWork = await dependencies.hasKnownExternalWork({ ownerId });
        if (knownWork) {
          recordResolvedKnownWork(observation, true);
        }
        if (!shouldPersistKnownWork() || !activeWorkObservationMayPersist(observation, knownWork)) {
          return enriched;
        }
      }

      if (!knownWork) {
        recordResolvedKnownWork(observation, false);
      }
      await persistObservedKnownWork({
        ownerId,
        observation,
        knownWork,
        expectedKnownWorkEpoch: knownWorkEpoch,
        callerGuard: shouldPersistKnownWork,
      });
    }
    return enriched;
  }

  async function getActiveWorkPage({
    ownerId,
    cursor = '',
    limit = 50,
    fetchImpl = globalThis.fetch,
    timeoutMs = positiveIntEnv(
      'VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS',
      DEFAULT_INTERACTIVE_TIMEOUT_MS,
    ),
    rosterObservation,
    shouldPersistKnownWork = () => true,
  }: ActiveWorkPageOptions & {
    rosterObservation?: ActiveWorkObservation;
    shouldPersistKnownWork?: () => boolean;
  }): Promise<UnknownRecord> {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) {
      throw new Error('glasshive_owner_required');
    }
    const ownerKey = ownerCacheKey(normalizedOwnerId);
    const observation = rosterObservation || beginActiveWorkObservation(ownerKey);
    const pageCursor = normalizedCursor(cursor);
    let knownWorkEpoch: number | null | undefined = null;
    if (!pageCursor) {
      knownWorkEpoch = await dependencies.getUserParallelWorkKnownEpoch(normalizedOwnerId);
      if (knownWorkEpoch == null) {
        throw new Error('parallel_work_owner_not_found');
      }
    }
    const query = new URLSearchParams({ limit: String(boundedListLimit(limit)) });
    if (pageCursor) {
      query.set('cursor', pageCursor);
    }
    try {
      const response = await requestAccountApi({
        ownerId: normalizedOwnerId,
        path: `/v1/active-work?${query.toString()}`,
        fetchImpl,
        timeoutMs,
      });
      return await enrichSnapshot(normalizedOwnerId, normalizedSnapshot(response), {
        authoritativeFirstPage: !pageCursor,
        observation,
        knownWorkEpoch: knownWorkEpoch ?? 0,
        shouldPersistKnownWork,
      });
    } finally {
      finishActiveWorkObservation(observation);
    }
  }

  async function getActiveWorkHistoryPage({
    ownerId,
    cursor = '',
    limit = 50,
    fetchImpl = globalThis.fetch,
    timeoutMs = positiveIntEnv(
      'VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS',
      DEFAULT_INTERACTIVE_TIMEOUT_MS,
    ),
  }: ActiveWorkPageOptions): Promise<UnknownRecord> {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) {
      throw new Error('glasshive_owner_required');
    }
    const pageCursor = normalizedCursor(cursor);
    const query = new URLSearchParams({ limit: String(boundedListLimit(limit)) });
    if (pageCursor) {
      query.set('cursor', pageCursor);
    }
    const response = await requestAccountApi({
      ownerId: normalizedOwnerId,
      path: `/v1/active-work/history?${query.toString()}`,
      fetchImpl,
      timeoutMs,
    });
    return dependencies.enrichActiveWorkSnapshot({
      ownerId: normalizedOwnerId,
      snapshot: normalizedSnapshot(response),
      includeCoreOnlyHistory: true,
    });
  }

  async function getActiveWorkSnapshot({
    ownerId,
    fetchImpl = globalThis.fetch,
    forceRefresh = false,
    timeoutMs = positiveIntEnv('VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS', DEFAULT_COLD_TIMEOUT_MS),
  }: ActiveWorkSnapshotOptions): Promise<UnknownRecord> {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) {
      throw new Error('glasshive_owner_required');
    }
    const key = ownerCacheKey(normalizedOwnerId);
    const now = Date.now();
    const cacheMs = positiveIntEnv('VIVENTIUM_ACTIVE_WORK_CACHE_MS', DEFAULT_CACHE_MS);
    const cached = activeWorkCache.get(key);
    if (!forceRefresh && cached && now - cached.fetchedAt <= cacheMs) {
      return { ...cached.value, snapshot: 'fresh' };
    }

    const refresh = (): Promise<UnknownRecord> => {
      let ownerRefreshes = activeWorkRefreshes.get(key);
      if (!ownerRefreshes) {
        ownerRefreshes = new Map();
        activeWorkRefreshes.set(key, ownerRefreshes);
      }
      const refreshRegistry = ownerRefreshes;
      const deadlineKey = String(timeoutMs);
      const existing = refreshRegistry.get(deadlineKey);
      if (existing) {
        return existing;
      }
      const generation = activeWorkCacheGeneration;
      const keyVersion = activeWorkCacheVersions.get(key) || 0;
      const observation = beginActiveWorkObservation(key);
      const pending = getActiveWorkPage({
        ownerId: normalizedOwnerId,
        fetchImpl,
        timeoutMs,
        rosterObservation: observation,
        shouldPersistKnownWork: () =>
          generation === activeWorkCacheGeneration &&
          keyVersion === (activeWorkCacheVersions.get(key) || 0),
      })
        .then((value) => {
          if (
            generation === activeWorkCacheGeneration &&
            keyVersion === (activeWorkCacheVersions.get(key) || 0) &&
            activeWorkObservationIsCurrent(observation)
          ) {
            activeWorkCache.set(key, { value, fetchedAt: Date.now() });
          }
          return value;
        })
        .finally(() => {
          if (refreshRegistry.get(deadlineKey) === pending) {
            refreshRegistry.delete(deadlineKey);
            if (refreshRegistry.size === 0 && activeWorkRefreshes.get(key) === refreshRegistry) {
              activeWorkRefreshes.delete(key);
            }
          }
        });
      refreshRegistry.set(deadlineKey, pending);
      return pending;
    };

    if (!forceRefresh && cached) {
      void refresh().catch(() => undefined);
      return { ...cached.value, snapshot: 'stale' };
    }
    try {
      return await refresh();
    } catch {
      if (cached) {
        return { ...cached.value, snapshot: 'stale' };
      }
      const unavailable: UnknownRecord = {
        snapshot: 'unavailable',
        work: null,
        overflowCount: null,
      };
      try {
        return await dependencies.enrichActiveWorkSnapshot({
          ownerId: normalizedOwnerId,
          snapshot: unavailable,
          includeCoreOnly: true,
        });
      } catch {
        return unavailable;
      }
    }
  }

  async function getActiveWorkInteractiveSnapshot(
    options: ActiveWorkSnapshotOptions,
  ): Promise<UnknownRecord> {
    return getActiveWorkSnapshot({
      ...options,
      forceRefresh: true,
      timeoutMs: positiveIntEnv(
        'VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS',
        DEFAULT_INTERACTIVE_TIMEOUT_MS,
      ),
    });
  }

  function invalidateActiveWorkSnapshot({ ownerId }: { ownerId?: unknown }): void {
    const normalizedOwnerId = String(ownerId || '').trim();
    if (!normalizedOwnerId) {
      throw new Error('glasshive_owner_required');
    }
    const key = ownerCacheKey(normalizedOwnerId);
    activeWorkCacheVersions.set(key, (activeWorkCacheVersions.get(key) || 0) + 1);
    const state = observationState(key);
    state.latestStarted += 1;
    state.group += 1;
    state.activeSequences.clear();
    state.positiveGroups.clear();
    activeWorkCache.delete(key);
    activeWorkRefreshes.delete(key);
  }

  function clearActiveWorkCacheForTests(): void {
    activeWorkCacheGeneration += 1;
    activeWorkCache.clear();
    activeWorkRefreshes.clear();
    activeWorkCacheVersions.clear();
    activeWorkObservations.clear();
  }

  return {
    clearActiveWorkCacheForTests,
    getActiveWorkHistoryPage,
    getActiveWorkInteractiveSnapshot,
    getActiveWorkPage,
    getActiveWorkSnapshot,
    invalidateActiveWorkSnapshot,
  };
}
