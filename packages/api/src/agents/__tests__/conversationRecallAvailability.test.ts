import type { TFile } from 'librechat-data-provider';
import {
  __internal,
  evaluateConversationRecallCorpusFreshness,
  getConversationRecallCorpusUpdatedAt,
  getConversationRecallVectorRuntimeStatus,
} from '../conversationRecallAvailability';

describe('conversationRecallAvailability', () => {
  const originalFetch = global.fetch;
  const originalRagApiUrl = process.env.RAG_API_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    __internal.resetConversationRecallVectorRuntimeStatusCache();
    process.env.RAG_API_URL = 'http://localhost:8110';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.RAG_API_URL = originalRagApiUrl;
    jest.restoreAllMocks();
    __internal.resetConversationRecallVectorRuntimeStatusCache();
  });

  it('returns unconfigured when RAG_API_URL is missing', async () => {
    delete process.env.RAG_API_URL;

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: false,
      reason: 'unconfigured',
    });
  });

  it('returns ok and caches successful health checks', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true }) as typeof fetch;

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: true,
      reason: 'ok',
    });
    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: true,
      reason: 'ok',
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('returns http_error when health responds non-200', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as typeof fetch;

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: false,
      reason: 'http_error',
    });
  });

  it('returns timeout on aborted health check', async () => {
    const timeoutError = new Error('aborted');
    timeoutError.name = 'AbortError';
    global.fetch = jest.fn().mockRejectedValue(timeoutError) as typeof fetch;

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: false,
      reason: 'timeout',
    });
  });

  it('returns unreachable on generic health failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('connection refused')) as typeof fetch;

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: false,
      reason: 'unreachable',
    });
  });

  it('refreshes the cached health result after TTL expiry', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false }) as typeof fetch;
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(20_000);

    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: true,
      reason: 'ok',
    });
    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: true,
      reason: 'ok',
    });
    await expect(getConversationRecallVectorRuntimeStatus()).resolves.toEqual({
      available: false,
      reason: 'http_error',
    });

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('computes corpus freshness against the newest recall-eligible message timestamp', () => {
    const recallFiles = [
      { updatedAt: '2026-04-09T10:00:00.000Z' } as TFile,
    ];

    expect(
      evaluateConversationRecallCorpusFreshness({
        recallFiles,
        latestMessageCreatedAt: '2026-04-09T09:59:59.000Z',
      }).fresh,
    ).toBe(true);

    expect(
      evaluateConversationRecallCorpusFreshness({
        recallFiles,
        latestMessageCreatedAt: '2026-04-09T10:00:01.000Z',
      }).fresh,
    ).toBe(false);
  });

  it('returns the newest corpus timestamp across recall files', () => {
    const recallFiles = [
      { updatedAt: '2026-04-09T09:00:00.000Z' } as TFile,
      { createdAt: '2026-04-09T11:00:00.000Z' } as TFile,
    ];

    expect(getConversationRecallCorpusUpdatedAt(recallFiles)?.toISOString()).toBe(
      '2026-04-09T11:00:00.000Z',
    );
  });
});
