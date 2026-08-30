/**
 * Tests for the agent abort endpoint
 *
 * Tests the following fixes from PR #11462:
 * 1. Authorization check - only job owner can abort
 * 2. Early abort handling - skip save when no responseMessageId
 * 3. Partial response saving - save message before returning
 */

const express = require('express');
const request = require('supertest');

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
};

const mockGenerationJobManager = {
  getJob: jest.fn(),
  abortJob: jest.fn(),
  getActiveJobIdsForUser: jest.fn(),
  getActiveStreamsForUser: jest.fn(),
};

const mockSaveMessage = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: mockLogger,
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn().mockReturnValue(false),
  GenerationJobManager: mockGenerationJobManager,
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));

jest.mock('~/server/middleware', () => ({
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'test-user-123' };
    next();
  },
  messageIpLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  messageUserLimiter: (req, res, next) => next(),
}));

// Mock the chat module - needs to be a router
jest.mock('~/server/routes/agents/chat', () => require('express').Router());

// Mock the v1 module - v1 is directly used as middleware
jest.mock('~/server/routes/agents/v1', () => ({
  v1: require('express').Router(),
}));

// Import after mocks
const agentRoutes = require('~/server/routes/agents/index');

describe('Agent Abort Endpoint', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api/agents', agentRoutes);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /chat/stream/:streamId', () => {
    /* === VIVENTIUM START ===
     * Feature: Parallel Work owner isolation.
     * Purpose: An ownerless legacy stream must not become readable by an arbitrary account.
     */
    it('rejects a stream whose durable owner identity is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        status: 'running',
        metadata: {},
      });

      const response = await request(app).get('/api/agents/chat/stream/ownerless-stream');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: 'Stream not found',
        message: 'The generation job does not exist or has expired.',
      });
    });
    /* === VIVENTIUM END === */
  });

  /* === VIVENTIUM START ===
   * Feature: Exact resumable-stream liveness.
   * Purpose: Keep the navigation projection while exposing every exact overlapping stream.
   */
  describe('GET /chat/active', () => {
    it('returns exact streams and deduplicated conversation identities from one snapshot', async () => {
      mockGenerationJobManager.getActiveStreamsForUser.mockResolvedValue([
        { streamId: 'stream-a', conversationId: 'conversation-1' },
        { streamId: 'stream-b', conversationId: 'conversation-1' },
      ]);

      const response = await request(app).get('/api/agents/chat/active');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        activeJobIds: ['conversation-1'],
        activeStreams: [
          { streamId: 'stream-a', conversationId: 'conversation-1' },
          { streamId: 'stream-b', conversationId: 'conversation-1' },
        ],
      });
      expect(mockGenerationJobManager.getActiveStreamsForUser).toHaveBeenCalledWith(
        'test-user-123',
      );
      expect(mockGenerationJobManager.getActiveJobIdsForUser).not.toHaveBeenCalled();
    });

    it('omits exact stream authority when the installed manager lacks that capability', async () => {
      const exactStreamMethod = mockGenerationJobManager.getActiveStreamsForUser;
      mockGenerationJobManager.getActiveStreamsForUser = undefined;
      mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue(['conversation-legacy']);

      try {
        const response = await request(app).get('/api/agents/chat/active');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ activeJobIds: ['conversation-legacy'] });
      } finally {
        mockGenerationJobManager.getActiveStreamsForUser = exactStreamMethod;
      }
    });
  });
  /* === VIVENTIUM END === */

  describe('POST /chat/abort', () => {
    describe('Authorization', () => {
      it("returns the same 404 when a user tries to abort another user's job", async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: { userId: 'other-user-456' },
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Job not found', streamId: jobStreamId });
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('Abort target unavailable'),
        );
        expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
      });

      it('should allow abort when user owns the job', async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          status: 'running',
          metadata: { userId: 'test-user-123' },
        });

        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: null,
          content: [],
          text: '',
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, aborted: jobStreamId });
        expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith(
          jobStreamId,
          'user_cancelled',
        );
      });

      it('should not call abort for a job whose main response is already complete', async () => {
        const jobStreamId = 'test-stream-complete';

        mockGenerationJobManager.getJob.mockResolvedValue({
          status: 'complete',
          metadata: { userId: 'test-user-123' },
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          error: 'Generation is already complete',
          streamId: jobStreamId,
        });
        expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
        expect(mockSaveMessage).not.toHaveBeenCalled();
      });

      it('should reject aborting a job whose main response is already complete', async () => {
        const jobStreamId = 'test-stream-complete';

        mockGenerationJobManager.getJob.mockResolvedValue({
          status: 'complete',
          metadata: { userId: 'test-user-123' },
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(409);
        expect(response.body).toEqual({
          error: 'Generation is already complete',
          streamId: jobStreamId,
        });
        expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
        expect(mockSaveMessage).not.toHaveBeenCalled();
      });

      /* === VIVENTIUM START ===
       * Feature: Parallel Work owner isolation.
       * Purpose: A legacy/corrupt job without durable owner identity must fail closed rather than
       *          becoming abortable by whichever authenticated account knows its stream key.
       */
      it('should reject abort when job has no userId metadata', async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: {},
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: 'Job not found', streamId: jobStreamId });
        expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
      });
      /* === VIVENTIUM END === */
    });

    describe('Early Abort Handling', () => {
      it('should skip message saving when responseMessageId is missing (early abort)', async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: { userId: 'test-user-123' },
        });

        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: {
            userMessage: { messageId: 'user-msg-123' },
            // No responseMessageId - early abort before generation started
            conversationId: jobStreamId,
          },
          content: [],
          text: '',
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(200);
        expect(mockSaveMessage).not.toHaveBeenCalled();
      });

      it('should skip message saving when userMessage is missing', async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: { userId: 'test-user-123' },
        });

        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: {
            // No userMessage
            responseMessageId: 'response-msg-123',
            conversationId: jobStreamId,
          },
          content: [],
          text: '',
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(200);
        expect(mockSaveMessage).not.toHaveBeenCalled();
      });
    });

    describe('Partial Response Saving', () => {
      it('should save partial response when both userMessage and responseMessageId exist', async () => {
        const jobStreamId = 'test-stream-123';
        const userMessageId = 'user-msg-123';
        const responseMessageId = 'response-msg-456';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: { userId: 'test-user-123' },
        });

        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: {
            userMessage: { messageId: userMessageId },
            responseMessageId,
            conversationId: jobStreamId,
            sender: 'TestAgent',
            endpoint: 'anthropic',
            model: 'claude-3',
          },
          content: [{ type: 'text', text: 'Partial response...' }],
          text: 'Partial response...',
        });

        mockSaveMessage.mockResolvedValue();

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        expect(response.status).toBe(200);
        expect(mockSaveMessage).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            messageId: responseMessageId,
            parentMessageId: userMessageId,
            conversationId: jobStreamId,
            content: [{ type: 'text', text: 'Partial response...' }],
            text: 'Partial response...',
            sender: 'TestAgent',
            endpoint: 'anthropic',
            model: 'claude-3',
            unfinished: true,
            error: false,
            isCreatedByUser: false,
            user: 'test-user-123',
          }),
          expect.objectContaining({
            context: 'api/server/routes/agents/index.js - abort endpoint',
          }),
        );
      });

      it('should handle saveMessage errors gracefully', async () => {
        const jobStreamId = 'test-stream-123';

        mockGenerationJobManager.getJob.mockResolvedValue({
          metadata: { userId: 'test-user-123' },
        });

        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: {
            userMessage: { messageId: 'user-msg-123' },
            responseMessageId: 'response-msg-456',
            conversationId: jobStreamId,
          },
          content: [],
          text: '',
        });

        mockSaveMessage.mockRejectedValue(new Error('Database error'));

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: jobStreamId });

        // Should still return success even if save fails
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, aborted: jobStreamId });
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to save partial response'),
        );
      });
    });

    describe('Job Not Found', () => {
      /* === VIVENTIUM START ===
       * Feature: Exact Stop rollover.
       * Purpose: A placeholder route must select the newest owned job, never array order.
       * === VIVENTIUM END === */
      it('aborts the newest owned active job when the new-chat placeholder has no exact key', async () => {
        mockGenerationJobManager.getJob.mockImplementation(async (streamId) => {
          if (streamId === 'older-stream') {
            return { status: 'running', createdAt: 10, metadata: { userId: 'test-user-123' } };
          }
          if (streamId === 'newer-stream') {
            return { status: 'running', createdAt: 20, metadata: { userId: 'test-user-123' } };
          }
          return null;
        });
        mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue([
          'older-stream',
          'newer-stream',
        ]);
        mockGenerationJobManager.abortJob.mockResolvedValue({
          success: true,
          jobData: null,
          content: [],
          text: '',
        });

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: 'new' });

        expect(response.status).toBe(200);
        expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith('newer-stream');
      });

      it('should return 404 when job is not found', async () => {
        mockGenerationJobManager.getJob.mockResolvedValue(null);
        mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue([]);

        const response = await request(app)
          .post('/api/agents/chat/abort')
          .send({ conversationId: 'non-existent-job' });

        expect(response.status).toBe(404);
        expect(response.body).toEqual({
          error: 'Job not found',
          streamId: 'non-existent-job',
        });
      });
    });
  });
});
