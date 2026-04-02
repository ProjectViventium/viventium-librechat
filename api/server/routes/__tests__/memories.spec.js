/* === VIVENTIUM START ===
 * Tests: Memories preferences route (conversation recall toggle)
 *
 * Purpose:
 * - Validate request payload handling for `/memories/preferences`.
 * - Ensure the correct persistence method is used for legacy and unified updates.
 * - Verify conversation-recall refresh scheduling runs only when expected.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockToggleUserMemories = jest.fn();
const mockUpdateUserPersonalization = jest.fn();
const mockScheduleConversationRecallRefresh = jest.fn();

jest.mock('@librechat/api', () => ({
  Tokenizer: { getTokenCount: jest.fn(() => 1) },
  evaluateMemoryWrite: jest.fn(() => ({ ok: true })),
  generateCheckAccess: jest.fn(() => (req, res, next) => next()),
  prepareMemoryValueForWrite: jest.fn(({ value }) => ({
    value,
    tokenCount: value.length,
    compacted: false,
  })),
  runMemoryMaintenance: jest.fn(async () => ({
    shouldApply: false,
    reason: [],
    updates: [],
    totalTokensBefore: 0,
    totalTokensAfter: 0,
  })),
}));

jest.mock('~/models', () => ({
  getAllUserMemories: jest.fn(),
  toggleUserMemories: (...args) => mockToggleUserMemories(...args),
  updateUserPersonalization: (...args) => mockUpdateUserPersonalization(...args),
  createMemory: jest.fn(),
  deleteMemory: jest.fn(),
  setMemory: jest.fn(),
}));

jest.mock('~/models/Role', () => ({
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
}));

jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  scheduleConversationRecallRefresh: (...args) => mockScheduleConversationRecallRefresh(...args),
}));

describe('memories preferences route', () => {
  let app;

  beforeAll(() => {
    const router = require('../memories');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: 'user_1' };
      next();
    });
    app.use('/api/memories', router);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 400 when no boolean preference is provided', async () => {
    const res = await request(app).patch('/api/memories/preferences').send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one boolean preference must be provided');
    expect(mockToggleUserMemories).not.toHaveBeenCalled();
    expect(mockUpdateUserPersonalization).not.toHaveBeenCalled();
    expect(mockScheduleConversationRecallRefresh).not.toHaveBeenCalled();
  });

  test('updates memories preference via toggleUserMemories when only memories is provided', async () => {
    mockToggleUserMemories.mockResolvedValueOnce({
      personalization: {
        memories: false,
        conversation_recall: false,
      },
    });

    const res = await request(app).patch('/api/memories/preferences').send({ memories: false });

    expect(res.status).toBe(200);
    expect(mockToggleUserMemories).toHaveBeenCalledWith('user_1', false);
    expect(mockUpdateUserPersonalization).not.toHaveBeenCalled();
    expect(mockScheduleConversationRecallRefresh).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      updated: true,
      preferences: {
        memories: false,
        conversation_recall: false,
      },
    });
  });

  test('updates conversation recall preference and schedules a refresh', async () => {
    mockUpdateUserPersonalization.mockResolvedValueOnce({
      personalization: {
        memories: true,
        conversation_recall: true,
      },
    });

    const res = await request(app)
      .patch('/api/memories/preferences')
      .send({ conversation_recall: true });

    expect(res.status).toBe(200);
    expect(mockUpdateUserPersonalization).toHaveBeenCalledWith('user_1', {
      conversation_recall: true,
    });
    expect(mockScheduleConversationRecallRefresh).toHaveBeenCalledWith({ userId: 'user_1' });
    expect(res.body).toEqual({
      updated: true,
      preferences: {
        memories: true,
        conversation_recall: true,
      },
    });
  });

  test('updates both preferences through updateUserPersonalization and schedules refresh', async () => {
    mockUpdateUserPersonalization.mockResolvedValueOnce({
      personalization: {
        memories: false,
        conversation_recall: true,
      },
    });

    const res = await request(app).patch('/api/memories/preferences').send({
      memories: false,
      conversation_recall: true,
    });

    expect(res.status).toBe(200);
    expect(mockUpdateUserPersonalization).toHaveBeenCalledWith('user_1', {
      memories: false,
      conversation_recall: true,
    });
    expect(mockScheduleConversationRecallRefresh).toHaveBeenCalledWith({ userId: 'user_1' });
  });

  test('returns 404 when the update target user does not exist', async () => {
    mockUpdateUserPersonalization.mockResolvedValueOnce(null);

    const res = await request(app)
      .patch('/api/memories/preferences')
      .send({ conversation_recall: true });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found.' });
    expect(mockScheduleConversationRecallRefresh).not.toHaveBeenCalled();
  });

  test('returns 500 when persistence throws', async () => {
    mockUpdateUserPersonalization.mockRejectedValueOnce(new Error('persist failed'));

    const res = await request(app)
      .patch('/api/memories/preferences')
      .send({ conversation_recall: true });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'persist failed' });
    expect(mockScheduleConversationRecallRefresh).not.toHaveBeenCalled();
  });
});
