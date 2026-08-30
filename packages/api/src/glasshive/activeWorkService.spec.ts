import { createGlassHiveActiveWorkService } from './activeWorkService';

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
});
