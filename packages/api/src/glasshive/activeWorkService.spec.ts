import { logger } from '@librechat/data-schemas';
import { createGlassHiveActiveWorkService } from './activeWorkService';
import type { ActiveWorkServiceDependencies } from './activeWorkService';
import type { AccountFetch } from './accountClient';

jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));

const originalEnv = { ...process.env };

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('GlassHive active-work service', () => {
  beforeEach(() => {
    process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-service-secret';
    process.env.WPR_API_TOKEN = 'synthetic-api-token';
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
    process.env.VIVENTIUM_TENANT_ID = 'local-public-test';
    process.env.VIVENTIUM_ACTIVE_WORK_CACHE_MS = '2000';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('persists a positive owner-scoped first-page observation', async () => {
    const markUserParallelWorkKnown = jest.fn(async () => true);
    const service = createGlassHiveActiveWorkService({
      getUserParallelWorkKnownEpoch: async () => 7,
      markUserParallelWorkKnown,
      clearUserParallelWorkKnownIfEpoch: async () => true,
      enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
      hasKnownExternalWork: async () => false,
    });
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ snapshot: 'fresh', work: [{ workRef: 'work-1' }], overflowCount: 0 }),
    );

    await expect(
      service.getActiveWorkPage({ ownerId: 'owner-1', fetchImpl }),
    ).resolves.toMatchObject({ snapshot: 'fresh', work: [{ workRef: 'work-1' }] });
    expect(markUserParallelWorkKnown).toHaveBeenCalledWith('owner-1');
  });

  it('does not clear known work for an empty later page', async () => {
    const clearUserParallelWorkKnownIfEpoch = jest.fn(async () => true);
    const service = createGlassHiveActiveWorkService({
      getUserParallelWorkKnownEpoch: async () => 3,
      markUserParallelWorkKnown: async () => true,
      clearUserParallelWorkKnownIfEpoch,
      enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
      hasKnownExternalWork: async () => false,
    });

    await service.getActiveWorkPage({
      ownerId: 'owner-1',
      cursor: 'signed.next-page',
      fetchImpl: async () => jsonResponse({ snapshot: 'fresh', work: [], overflowCount: 0 }),
    });

    expect(clearUserParallelWorkKnownIfEpoch).not.toHaveBeenCalled();
  });

  it('adds Core-only history on the first page without repeating it on native cursor pages', async () => {
    const coreRows = Array.from({ length: 100 }, (_, i) => ({ workRef: `core-${i}`, state: 'failed' }));
    const nativeRows = [{ workRef: 'native-history', state: 'completed' }];
    const enrichActiveWorkSnapshot = jest.fn(async ({ snapshot, includeCoreOnlyHistory }) => ({
      ...snapshot,
      work: [...snapshot.work, ...(includeCoreOnlyHistory ? coreRows : [])],
    }));
    const service = testService({ enrichActiveWorkSnapshot });
    const fetchImpl = jest.fn(async () => jsonResponse({
      snapshot: 'fresh', work: nativeRows, cursor: 'signed.next-page', overflowCount: 7,
    }));
    const first = await service.getActiveWorkHistoryPage({ ownerId: 'owner-1', limit: 100, fetchImpl });
    const next = await service.getActiveWorkHistoryPage({
      ownerId: 'owner-1', cursor: 'signed.next-page', limit: 100, fetchImpl,
    });
    expect(first.work).toEqual([...nativeRows, ...coreRows]);
    expect(next.work).toEqual(nativeRows);
    expect(first.cursor).toBe('signed.next-page');
    expect(next.cursor).toBe('signed.next-page');
    expect(next.overflowCount).toBe(7);
    expect(enrichActiveWorkSnapshot).toHaveBeenNthCalledWith(1, expect.objectContaining({
      ownerId: 'owner-1', includeCoreOnlyHistory: true,
    }));
    expect(enrichActiveWorkSnapshot).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ownerId: 'owner-1', includeCoreOnlyHistory: false,
    }));
  });

  it('returns a cached stale snapshot when an explicit refresh is unavailable', async () => {
    const service = createGlassHiveActiveWorkService({
      getUserParallelWorkKnownEpoch: async () => 1,
      markUserParallelWorkKnown: async () => true,
      clearUserParallelWorkKnownIfEpoch: async () => true,
      enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
      hasKnownExternalWork: async () => false,
    });
    const successfulFetch = async () =>
      jsonResponse({ snapshot: 'fresh', work: [{ workRef: 'work-cache' }], overflowCount: 0 });

    await service.getActiveWorkSnapshot({ ownerId: 'owner-cache', fetchImpl: successfulFetch });
    await expect(
      service.getActiveWorkSnapshot({
        ownerId: 'owner-cache',
        forceRefresh: true,
        fetchImpl: async () => Promise.reject(new Error('synthetic outage')),
      }),
    ).resolves.toMatchObject({ snapshot: 'stale', work: [{ workRef: 'work-cache' }] });
  });

  it('keeps provider unavailability explicit when no truthful cache exists', async () => {
    const service = createGlassHiveActiveWorkService({
      getUserParallelWorkKnownEpoch: async () => 1,
      markUserParallelWorkKnown: async () => true,
      clearUserParallelWorkKnownIfEpoch: async () => true,
      enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
      hasKnownExternalWork: async () => false,
    });

    await expect(
      service.getActiveWorkSnapshot({
        ownerId: 'owner-cold',
        fetchImpl: async () => Promise.reject(new Error('synthetic outage')),
      }),
    ).resolves.toEqual({ snapshot: 'unavailable', work: null, overflowCount: null });
  });

  it.each([true, false])(
    'logs content-free interactive refresh failure (cached=%s) while preserving snapshot truth',
    async (cached) => {
      const service = createGlassHiveActiveWorkService({
        getUserParallelWorkKnownEpoch: async () => 1,
        markUserParallelWorkKnown: async () => true,
        clearUserParallelWorkKnownIfEpoch: async () => true,
        enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
        hasKnownExternalWork: async () => false,
      });
      if (cached) {
        await service.getActiveWorkSnapshot({
          ownerId: 'owner-interactive-failure',
          fetchImpl: async () => jsonResponse({ work: [{ workRef: 'work-1' }], overflowCount: 0 }),
        });
      }
      jest.mocked(logger.warn).mockClear();
      const result = await service.getActiveWorkInteractiveSnapshot({
        ownerId: 'owner-interactive-failure',
        fetchImpl: async () => {
          throw new DOMException('private transport body must stay private', 'TimeoutError');
        },
      });
      expect(result.snapshot).toBe(cached ? 'stale' : 'unavailable');
      const persistedMessage = jest.mocked(logger.warn).mock.calls.at(-1)?.[0] as string;
      expect(persistedMessage).toContain('[VIVENTIUM][active-work] Snapshot refresh failed {');
      expect(JSON.parse(persistedMessage.slice(persistedMessage.indexOf('{')))).toEqual({
        stage: 'interactive_refresh',
        errorClass: 'TimeoutError',
        code: null,
        httpStatus: null,
        elapsedMs: expect.any(Number),
      });
      expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain(
        'private transport',
      );
      expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toContain(
        'owner-interactive',
      );
    },
  );
  it.each([true, false])('logs bounded typed cause without raw failure content: %s', async (typed) => {
    const service = testService();
    jest.mocked(logger.warn).mockClear();
    const failure = Object.assign(new Error('private transport response and secret path'), {
      code: typed ? 'scope_not_ready' : 'private/token/value',
      status: typed ? 503 : 1000,
      name: typed ? 'Error' : 'private/error/path',
    });
    const result = await service.getActiveWorkInteractiveSnapshot({
      ownerId: 'owner-private', fetchImpl: async () => { throw failure; },
    });
    expect(result.snapshot).toBe('unavailable');
    const persistedMessage = jest.mocked(logger.warn).mock.calls.at(-1)?.[0] as string;
    const diagnostic = JSON.parse(persistedMessage.slice(persistedMessage.indexOf('{')));
    expect(diagnostic).toMatchObject({
      stage: 'interactive_refresh', errorClass: typed ? 'Error' : 'unknown_error',
      code: typed ? 'scope_not_ready' : null, httpStatus: typed ? 503 : null,
    });
    expect(persistedMessage.length).toBeLessThan(300);
    expect(persistedMessage).not.toContain('private');
  });
});

function testService(overrides: Partial<ActiveWorkServiceDependencies> = {}) {
  return createGlassHiveActiveWorkService({
    getUserParallelWorkKnownEpoch: async () => 7,
    markUserParallelWorkKnown: jest.fn(async () => true),
    clearUserParallelWorkKnownIfEpoch: jest.fn(async () => true),
    enrichActiveWorkSnapshot: async ({ snapshot }) => snapshot,
    hasKnownExternalWork: async () => false,
    ...overrides,
  });
}

function heldResponse() {
  let resolve!: (response: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  return {
    pending,
    release: (work: Array<{ workRef: string; state?: string }>) =>
      resolve(jsonResponse({ work, overflowCount: 0 })),
  };
}

async function settleRefresh(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
}

describe('owner-scoped active-work refresh deadlines', () => {
  beforeEach(() => {
    process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-service-secret';
    process.env.WPR_API_TOKEN = 'synthetic-api-token';
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
    process.env.VIVENTIUM_TENANT_ID = 'local-public-test';
    process.env.VIVENTIUM_ACTIVE_WORK_CACHE_MS = '2000';
    process.env.VIVENTIUM_ACTIVE_WORK_COLD_TIMEOUT_MS = '100';
    process.env.VIVENTIUM_ACTIVE_WORK_INTERACTIVE_TIMEOUT_MS = '5000';
    jest.useFakeTimers();
    jest.spyOn(AbortSignal, 'timeout').mockImplementation((timeoutMs) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('transport deadline', 'TimeoutError')),
        timeoutMs,
      );
      return controller.signal;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    process.env = { ...originalEnv };
  });

  it('keeps the 100 ms cold wait and shares the full transport with interactive refresh', async () => {
    jest.mocked(logger.warn).mockClear();
    const service = testService();
    const held = heldResponse();
    const fetchImpl = jest
      .fn<ReturnType<AccountFetch>, Parameters<AccountFetch>>()
      .mockReturnValue(held.pending);
    const cold = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    await settleRefresh();
    const signal = fetchImpl.mock.calls[0][1]?.signal;
    const interactive = service.getActiveWorkInteractiveSnapshot({ ownerId: 'owner-1', fetchImpl });
    let settled = false;
    void cold.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(cold).resolves.toEqual({
      snapshot: 'unavailable',
      work: null,
      overflowCount: null,
    });
    expect(signal?.aborted).toBe(false);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5000);
    const persistedMessage = jest.mocked(logger.warn).mock.calls.at(-1)?.[0] as string;
    expect(persistedMessage).toContain('[VIVENTIUM][active-work] Snapshot wait expired {');
    expect(JSON.parse(persistedMessage.slice(persistedMessage.indexOf('{')))).toEqual({
      stage: 'snapshot_wait',
      errorClass: 'TimeoutError',
      code: 'glasshive_active_work_wait_timeout',
      httpStatus: null,
      elapsedMs: 100,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1094);
    held.release([
      { workRef: 'work-a', state: 'completed' },
      { workRef: 'work-b', state: 'completed' },
    ]);
    expect((await interactive).snapshot).toBe('fresh');
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [
        { workRef: 'work-a', state: 'completed' },
        { workRef: 'work-b', state: 'completed' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives joined callers independent waits without another transport', async () => {
    const service = testService();
    const held = heldResponse();
    const fetchImpl = jest.fn().mockReturnValue(held.pending);
    const first = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    await jest.advanceTimersByTimeAsync(50);
    const second = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl, timeoutMs: 250 });
    await jest.advanceTimersByTimeAsync(50);
    expect((await first).snapshot).toBe('unavailable');
    held.release([{ workRef: 'work-1' }]);
    expect((await second).snapshot).toBe('fresh');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bounds background transport failure and recovers on the next read', async () => {
    const service = testService();
    const fetchImpl = jest
      .fn<ReturnType<AccountFetch>, Parameters<AccountFetch>>()
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      )
      .mockResolvedValueOnce(jsonResponse({ work: [{ workRef: 'recovered-work' }] }));
    const cold = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    await jest.advanceTimersByTimeAsync(100);
    expect((await cold).snapshot).toBe('unavailable');
    await jest.advanceTimersByTimeAsync(4900);
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'recovered-work' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns stale rows immediately while one full-budget refresh recovers', async () => {
    const service = testService();
    const held = heldResponse();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ work: [{ workRef: 'work-1', state: 'running' }] }))
      .mockReturnValueOnce(held.pending);
    await service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    await jest.advanceTimersByTimeAsync(2001);
    for (let count = 0; count < 2; count += 1) {
      await expect(
        service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
      ).resolves.toMatchObject({
        snapshot: 'stale',
        work: [{ workRef: 'work-1', state: 'running' }],
      });
    }
    await settleRefresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    held.release([{ workRef: 'work-1', state: 'completed' }]);
    await settleRefresh();
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
    ).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'work-1', state: 'completed' }],
    });
  });

  it.each([true, false])(
    'warms after mutation and fences an old positive=%s read',
    async (oldPositive) => {
      const markUserParallelWorkKnown = jest.fn(async () => true);
      const clearUserParallelWorkKnownIfEpoch = jest.fn(async () => true);
      const service = testService({ markUserParallelWorkKnown, clearUserParallelWorkKnownIfEpoch });
      const old = heldResponse();
      const current = heldResponse();
      const fetchImpl = jest
        .fn()
        .mockReturnValueOnce(old.pending)
        .mockReturnValueOnce(current.pending);
      const previousCaller = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
      await settleRefresh();
      expect(
        service.invalidateActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
      ).toBeUndefined();
      const currentCaller = service.getActiveWorkInteractiveSnapshot({
        ownerId: 'owner-1',
        fetchImpl,
      });
      await settleRefresh();
      const currentRows = oldPositive ? [] : [{ workRef: 'new-work', state: 'queued' }];
      current.release(currentRows);
      await currentCaller;
      old.release(oldPositive ? [{ workRef: 'old-work', state: 'completed' }] : []);
      await expect(previousCaller).resolves.toMatchObject({ snapshot: 'fresh', work: currentRows });
      await expect(
        service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
      ).resolves.toMatchObject({
        snapshot: 'fresh',
        work: currentRows,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      if (oldPositive) {
        expect(markUserParallelWorkKnown).not.toHaveBeenCalled();
        expect(clearUserParallelWorkKnownIfEpoch).toHaveBeenCalledTimes(1);
        expect(clearUserParallelWorkKnownIfEpoch).toHaveBeenCalledWith('owner-1', 7);
      } else {
        expect(clearUserParallelWorkKnownIfEpoch).not.toHaveBeenCalled();
        expect(markUserParallelWorkKnown).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('rejects a delayed pre-clear write into a new cache generation', async () => {
    const markUserParallelWorkKnown = jest.fn(async () => true);
    const service = testService({ markUserParallelWorkKnown });
    const held = heldResponse();
    const fetchImpl = jest
      .fn()
      .mockReturnValueOnce(held.pending)
      .mockResolvedValueOnce(jsonResponse({ work: [{ workRef: 'current-work' }] }));
    const old = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    await settleRefresh();
    service.clearActiveWorkCacheForTests();
    await service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
    held.release([{ workRef: 'old-work' }]);
    await expect(old).resolves.toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'current-work' }],
    });
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl }),
    ).resolves.toMatchObject({
      work: [{ workRef: 'current-work' }],
      snapshot: 'fresh',
    });
    expect(markUserParallelWorkKnown).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'returns unavailable when a superseded read resolves before replacement truth (prior cache=%s)',
    async (priorCache) => {
      const service = testService();
      const old = heldResponse();
      const current = heldResponse();
      const fetchImpl = jest.fn();
      if (priorCache) {
        fetchImpl.mockResolvedValueOnce(jsonResponse({ work: [{ workRef: 'old-work' }] }));
        await service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
      }
      fetchImpl.mockReturnValueOnce(old.pending).mockReturnValueOnce(current.pending);
      const previous = service.getActiveWorkSnapshot({
        ownerId: 'owner-1',
        fetchImpl,
        forceRefresh: true,
      });
      await settleRefresh();
      service.invalidateActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl });
      await settleRefresh();
      old.release([{ workRef: 'old-work', state: 'running' }]);
      await expect(previous).resolves.toEqual({
        snapshot: 'unavailable',
        work: null,
        overflowCount: null,
      });
      const replacement = service.getActiveWorkInteractiveSnapshot({
        ownerId: 'owner-1',
        fetchImpl,
      });
      current.release([{ workRef: 'new-work', state: 'completed' }]);
      await expect(replacement).resolves.toMatchObject({
        snapshot: 'fresh',
        work: [{ workRef: 'new-work' }],
      });
    },
  );

  it('isolates refreshes and invalidation by owner and tenant', async () => {
    const service = testService();
    const held = heldResponse();
    const firstFetch = jest.fn().mockReturnValue(held.pending);
    const secondFetch = jest
      .fn()
      .mockResolvedValue(jsonResponse({ work: [{ workRef: 'owner-2-work' }] }));
    const first = service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: firstFetch });
    await settleRefresh();
    await service.getActiveWorkSnapshot({ ownerId: 'owner-2', fetchImpl: secondFetch });
    process.env.VIVENTIUM_TENANT_ID = 'other-public-tenant';
    const tenantFetch = jest
      .fn()
      .mockImplementation(async () => jsonResponse({ work: [{ workRef: 'other-tenant-work' }] }));
    await service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: tenantFetch });
    service.invalidateActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: tenantFetch });
    await settleRefresh();
    process.env.VIVENTIUM_TENANT_ID = 'local-public-test';
    held.release([{ workRef: 'owner-1-work' }]);
    await first;
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: firstFetch }),
    ).resolves.toMatchObject({
      work: [{ workRef: 'owner-1-work' }],
    });
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-2', fetchImpl: secondFetch }),
    ).resolves.toMatchObject({
      work: [{ workRef: 'owner-2-work' }],
    });
    expect(firstFetch).toHaveBeenCalledTimes(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);
    process.env.VIVENTIUM_TENANT_ID = 'other-public-tenant';
    await expect(
      service.getActiveWorkSnapshot({ ownerId: 'owner-1', fetchImpl: tenantFetch }),
    ).resolves.toMatchObject({
      work: [{ workRef: 'other-tenant-work' }],
    });
    expect(tenantFetch).toHaveBeenCalledTimes(2);
  });
});
