const express = require('express');
const request = require('supertest');

const mockGetAllUserMemories = jest.fn();
const mockCreateMemory = jest.fn();
const mockDeleteMemory = jest.fn();
const mockSetMemory = jest.fn();
const mockEvaluateMemoryWrite = jest.fn();
const mockRunMemoryMaintenance = jest.fn();
const mockPrepareMemoryValueForWrite = jest.fn();

jest.mock('@librechat/api', () => ({
  evaluateMemoryWrite: (...args) => mockEvaluateMemoryWrite(...args),
  generateCheckAccess: jest.fn(() => (req, res, next) => next()),
  prepareMemoryValueForWrite: (...args) => mockPrepareMemoryValueForWrite(...args),
  runMemoryMaintenance: (...args) => mockRunMemoryMaintenance(...args),
}));

jest.mock('~/models', () => ({
  getAllUserMemories: (...args) => mockGetAllUserMemories(...args),
  toggleUserMemories: jest.fn(),
  updateUserPersonalization: jest.fn(),
  createMemory: (...args) => mockCreateMemory(...args),
  deleteMemory: (...args) => mockDeleteMemory(...args),
  setMemory: (...args) => mockSetMemory(...args),
}));

jest.mock('~/models/Role', () => ({
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
}));

jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  scheduleConversationRecallRefresh: jest.fn(),
}));

describe('memories write routes', () => {
  let app;

  beforeAll(() => {
    const router = require('../memories');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user_1' };
      req.config = {
        memory: {
          validKeys: ['context', 'drafts', 'context_archive'],
          tokenLimit: 100,
          keyLimits: { context: 60, drafts: 40, context_archive: 40 },
          maintenanceThresholdPercent: 80,
          charLimit: 10000,
        },
      };
      next();
    });
    app.use('/api/memories', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareMemoryValueForWrite.mockImplementation(({ value }) => ({
      value,
      tokenCount: value.length,
      compacted: false,
    }));
    mockEvaluateMemoryWrite.mockReturnValue({ ok: true });
    mockRunMemoryMaintenance.mockResolvedValue({
      shouldApply: false,
      reason: [],
      updates: [],
      totalTokensBefore: 0,
      totalTokensAfter: 0,
    });
  });

  test('PATCH rejects updates when shared memory policy fails', async () => {
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'context', value: 'old', tokenCount: 40 },
    ]);
    mockEvaluateMemoryWrite.mockReturnValueOnce({
      ok: false,
      message: 'Memory storage would exceed the configured token limit.',
      details: { projectedTotalTokens: 120 },
    });

    const res = await request(app)
      .patch('/api/memories/context')
      .send({ value: 'x'.repeat(81) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Memory storage would exceed the configured token limit.');
    expect(mockSetMemory).not.toHaveBeenCalled();
    expect(mockRunMemoryMaintenance).not.toHaveBeenCalled();
  });

  test('PATCH applies deterministic pre-write compaction before validation', async () => {
    mockGetAllUserMemories.mockResolvedValueOnce([{ key: 'world', value: 'old', tokenCount: 100 }]);
    mockPrepareMemoryValueForWrite.mockReturnValueOnce({
      value: 'compacted world',
      tokenCount: 15,
      compacted: true,
    });
    mockSetMemory.mockResolvedValueOnce({ ok: true });
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'world', value: 'compacted world', tokenCount: 15 },
    ]);

    const res = await request(app)
      .patch('/api/memories/world')
      .send({ value: 'very long world value' });

    expect(res.status).toBe(200);
    expect(mockPrepareMemoryValueForWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'world',
        value: 'very long world value',
      }),
    );
    expect(mockEvaluateMemoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        value: 'compacted world',
        tokenCount: 15,
      }),
    );
    expect(mockSetMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'world',
        value: 'compacted world',
        tokenCount: 15,
      }),
    );
  });

  test('PATCH rename evaluates against the total minus the replaced key', async () => {
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'context', value: 'old', tokenCount: 40 },
      { key: 'drafts', value: 'other', tokenCount: 30 },
    ]);
    mockCreateMemory.mockResolvedValueOnce({ ok: true });
    mockDeleteMemory.mockResolvedValueOnce({ ok: true });
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'context_archive', value: 'new', tokenCount: 20 },
    ]);

    const res = await request(app)
      .patch('/api/memories/context')
      .send({ key: 'context_archive', value: 'new content' });

    expect(res.status).toBe(200);
    expect(mockEvaluateMemoryWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'context_archive',
        baselineTotalTokens: 30,
        previousTokenCount: 0,
      }),
    );
    expect(mockRunMemoryMaintenance).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
      }),
    );
  });

  test('POST runs maintenance after a successful write', async () => {
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'context', value: 'old', tokenCount: 30 },
    ]);
    mockCreateMemory.mockResolvedValueOnce({ ok: true });
    mockGetAllUserMemories.mockResolvedValueOnce([
      { key: 'context', value: 'old', tokenCount: 30 },
      { key: 'drafts', value: 'new memory', tokenCount: 10 },
    ]);

    const res = await request(app).post('/api/memories').send({
      key: 'drafts',
      value: 'new memory',
    });

    expect(res.status).toBe(201);
    expect(mockRunMemoryMaintenance).toHaveBeenCalledTimes(1);
  });
});
