import fs from 'node:fs';
import { FileContext } from 'librechat-data-provider';
import type { TFile } from 'librechat-data-provider';
import {
  getConversationRecallVectorRuntimeStatus,
  refreshConversationRecallExecutionFiles,
  __internal,
} from '../conversationRecallAvailability';

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

  const authorizedRecall = {
    file_id: 'conversation_recall:owner-1:all',
    context: FileContext.conversation_recall,
    viventiumConversationRecallMode: 'vector',
    viventiumConversationRecallAttachmentReason: 'vector_ready',
    metadata: { scope: 'all' },
  };
  const corpus: TFile = {
    ...authorizedRecall, user: 'owner-1', bytes: 0, embedded: true,
    filename: 'conversation-recall-all.txt', filepath: 'conversation_recall',
    object: 'file', type: 'text/plain', usage: 0,
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  };
  function executionDependencies() {
    return {
      readFiles: jest.fn().mockResolvedValue([corpus]),
      readLatestMessageCreatedAt: jest.fn().mockResolvedValue(new Date('2026-01-01T00:00:00Z')),
      readVectorStatus: jest.fn().mockResolvedValue({ available: true, reason: 'ok' }),
    };
  }
  test('stale saved vector resources execute source-only without changing original identity or metadata', async () => {
    const deps = executionDependencies();
    deps.readLatestMessageCreatedAt.mockResolvedValue(new Date('2026-01-03T00:00:00Z'));
    const before = structuredClone(authorizedRecall);
    const result = await refreshConversationRecallExecutionFiles({
      ownerId: 'owner-1', agentId: 'agent-1', activeMessageId: 'current-1', files: [authorizedRecall],
    }, deps);
    expect(result).toEqual([{ ...authorizedRecall,
      viventiumConversationRecallMode: 'source_only',
      viventiumConversationRecallAttachmentReason: 'stale_corpus' }]);
    expect(authorizedRecall).toEqual(before);
    expect(deps.readFiles).toHaveBeenCalledWith({ user: 'owner-1', context: FileContext.conversation_recall,
      file_id: { $in: [authorizedRecall.file_id] } });
    expect(deps.readLatestMessageCreatedAt).toHaveBeenCalledWith({ user: 'owner-1',
      excludeMessageId: 'current-1', excludeParentMessageId: 'current-1' });
  });
  test('a fresh, healthy authorized corpus executes vector recall', async () => {
    const result = await refreshConversationRecallExecutionFiles({
      ownerId: 'owner-1', files: [authorizedRecall],
    }, executionDependencies());
    expect(result).toEqual([authorizedRecall]);
  });
  test.each(['unconfigured', 'unhealthy', 'timeout', 'stale_restore'])(
    'current %s vector runtime executes truthful source-only recall', async (reason) => {
      const deps = executionDependencies();
      deps.readVectorStatus.mockResolvedValue({ available: false, reason });
      const [result] = await refreshConversationRecallExecutionFiles({
        ownerId: 'owner-1', files: [authorizedRecall],
      }, deps);
      expect(result).toMatchObject({ file_id: authorizedRecall.file_id,
        viventiumConversationRecallMode: 'source_only',
        viventiumConversationRecallAttachmentReason: `runtime_${reason}` });
    },
  );
  test('a canonical authorized rowless corpus retains existing source-only recall', async () => {
    const deps = executionDependencies();
    deps.readFiles.mockResolvedValue([]);
    const [result] = await refreshConversationRecallExecutionFiles({
      ownerId: 'owner-1', files: [authorizedRecall],
    }, deps);
    expect(result).toMatchObject({ file_id: authorizedRecall.file_id,
      viventiumConversationRecallMode: 'source_only',
      viventiumConversationRecallAttachmentReason: 'missing_corpus' });
  });
  test.each(['conversation_recall:other-owner:all', 'conversation_recall:owner-1:agent:other-agent',
    'conversation_recall:all:owner-1'])(
    'execution rejects a foreign or noncanonical recall namespace: %s', async (file_id) => {
      const deps = executionDependencies();
      await expect(refreshConversationRecallExecutionFiles({ ownerId: 'owner-1', agentId: 'agent-1',
        files: [{ ...authorizedRecall, file_id }] }, deps)).resolves.toEqual([]);
      expect(deps.readFiles).not.toHaveBeenCalled();
      expect(deps.readVectorStatus).not.toHaveBeenCalled();
    },
  );
  test.each([{ user: 'other-owner' }, { context: FileContext.message_attachment }])(
    'current row ownership and resource context remain required: %o', async (changed) => {
      const deps = executionDependencies();
      deps.readFiles.mockResolvedValue([{ ...corpus, ...changed }]);
      await expect(refreshConversationRecallExecutionFiles({ ownerId: 'owner-1', files: [authorizedRecall] }, deps))
        .resolves.toEqual([]);
    },
  );
  test('agent recall retains its exact namespace without a global freshness read or added rows', async () => {
    const deps = executionDependencies();
    const file = { ...authorizedRecall, file_id: 'conversation_recall:owner-1:agent:agent-1' };
    deps.readFiles.mockResolvedValue([{ ...corpus, file_id: file.file_id }, corpus]);
    await expect(refreshConversationRecallExecutionFiles({ ownerId: 'owner-1', agentId: 'agent-1', files: [file] }, deps))
      .resolves.toEqual([file]);
    expect(deps.readLatestMessageCreatedAt).not.toHaveBeenCalled();
  });
  test('ordinary resources require no recall readiness work', async () => {
    const deps = executionDependencies();
    const files = [{ file_id: 'ordinary-file', context: FileContext.message_attachment }];
    await expect(refreshConversationRecallExecutionFiles({ ownerId: 'owner-1', files }, deps)).resolves.toBe(files);
    expect(deps.readFiles).not.toHaveBeenCalled();
    expect(deps.readVectorStatus).not.toHaveBeenCalled();
  });
  test('a failed current-file read cannot fall back to the saved vector annotation', async () => {
    const deps = executionDependencies();
    deps.readFiles.mockRejectedValue(new Error('current ownership unavailable'));
    await expect(refreshConversationRecallExecutionFiles({ ownerId: 'owner-1', files: [authorizedRecall] }, deps))
      .rejects.toThrow('current ownership unavailable');
  });
});
