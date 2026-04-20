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
    global.fetch = jest.fn().mockResolvedValue({ ok: true } as Response);

    const status = await getConversationRecallVectorRuntimeStatus();

    expect(status).toEqual({
      available: true,
      reason: 'ok',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
