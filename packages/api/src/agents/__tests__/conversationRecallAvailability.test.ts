import fs from 'node:fs';
import { getConversationRecallVectorRuntimeStatus, __internal } from '../conversationRecallAvailability';

describe('conversationRecallAvailability', () => {
  const originalFetch = global.fetch;
  const originalRagApiUrl = process.env.RAG_API_URL;
  const originalMarkerPath = process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE;

  beforeEach(() => {
    __internal.resetConversationRecallVectorRuntimeStatusCache();
    process.env.RAG_API_URL = 'http://127.0.0.1:9000';
    process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE = '/tmp/viventium-recall-marker.json';
  });

  afterEach(() => {
    __internal.resetConversationRecallVectorRuntimeStatusCache();
    process.env.RAG_API_URL = originalRagApiUrl;
    process.env.VIVENTIUM_RECALL_REBUILD_REQUIRED_FILE = originalMarkerPath;
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  test('returns stale_restore when the recall rebuild marker exists', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    global.fetch = jest.fn();

    const status = await getConversationRecallVectorRuntimeStatus();

    expect(status).toEqual({
      available: false,
      reason: 'stale_restore',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('continues probing the vector runtime when no restore marker exists', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ status: 'UP' }),
    } as unknown as Response);

    const status = await getConversationRecallVectorRuntimeStatus();

    expect(status).toEqual({
      available: true,
      reason: 'ok',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('rejects a reachable vector runtime whose semantic health is down', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: 'DOWN',
        error: 'vector_store_unavailable',
      }),
    } as unknown as Response);

    const status = await getConversationRecallVectorRuntimeStatus();

    expect(status).toEqual({
      available: false,
      reason: 'unhealthy',
    });
  });

  test('rejects an invalid semantic health response', async () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockRejectedValue(new SyntaxError('invalid json')),
    } as unknown as Response);

    const status = await getConversationRecallVectorRuntimeStatus();

    expect(status).toEqual({
      available: false,
      reason: 'invalid_response',
    });
  });
});
