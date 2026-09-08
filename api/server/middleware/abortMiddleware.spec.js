/**
 * Tests for abortMiddleware - spendCollectedUsage function
 *
 * This tests the token spending logic for abort scenarios,
 * particularly for parallel agents (addedConvo) where multiple
 * models need their tokens spent.
 *
 * spendCollectedUsage delegates to recordCollectedUsage from @librechat/api,
 * passing pricing + bulkWriteOps deps, with context: 'abort'.
 * After spending, it clears the collectedUsage array to prevent double-spending
 * from the AgentClient finally block (which shares the same array reference).
 */

const mockSpendTokens = jest.fn().mockResolvedValue();
const mockSpendStructuredTokens = jest.fn().mockResolvedValue();
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });

const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);

jest.mock('~/models/spendTokens', () => ({
  spendTokens: (...args) => mockSpendTokens(...args),
  spendStructuredTokens: (...args) => mockSpendStructuredTokens(...args),
}));

jest.mock('~/models/tx', () => ({
  getMultiplier: mockGetMultiplier,
  getCacheMultiplier: mockGetCacheMultiplier,
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  countTokens: jest.fn().mockResolvedValue(100),
  isEnabled: jest.fn().mockReturnValue(false),
  sendEvent: jest.fn(),
  GenerationJobManager: {
    getJob: jest.fn(),
    abortJob: jest.fn(),
  },
  recordCollectedUsage: mockRecordCollectedUsage,
  sanitizeMessageForTransmit: jest.fn((msg) => msg),
}));

jest.mock('librechat-data-provider', () => ({
  isAssistantsEndpoint: jest.fn().mockReturnValue(false),
  ErrorTypes: { INVALID_REQUEST: 'INVALID_REQUEST', NO_SYSTEM_MESSAGES: 'NO_SYSTEM_MESSAGES' },
}));

jest.mock('~/app/clients/prompts', () => ({
  truncateText: jest.fn((text) => text),
  smartTruncateText: jest.fn((text) => text),
}));

jest.mock('~/cache/clearPendingReq', () => jest.fn().mockResolvedValue());

jest.mock('~/server/middleware/error', () => ({
  sendError: jest.fn(),
}));

const mockUpdateBalance = jest.fn().mockResolvedValue({});
const mockBulkInsertTransactions = jest.fn().mockResolvedValue(undefined);
jest.mock('~/models', () => ({
  saveMessage: jest.fn().mockResolvedValue(),
  getConvo: jest.fn().mockResolvedValue({ title: 'Test Chat' }),
  updateBalance: mockUpdateBalance,
  bulkInsertTransactions: mockBulkInsertTransactions,
}));

jest.mock('./abortRun', () => ({
  abortRun: jest.fn(),
}));

const { spendCollectedUsage } = require('./abortMiddleware');

describe('abortMiddleware - spendCollectedUsage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('spendCollectedUsage delegation', () => {
    it('should return early if collectedUsage is empty', async () => {
      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage: [],
        fallbackModel: 'gpt-4',
      });

      expect(mockRecordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should return early if collectedUsage is null', async () => {
      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage: null,
        fallbackModel: 'gpt-4',
      });

      expect(mockRecordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should call recordCollectedUsage with abort context and full deps', async () => {
      const collectedUsage = [{ input_tokens: 100, output_tokens: 50, model: 'gpt-4' }];

      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
        fallbackModel: 'gpt-4',
        messageId: 'msg-123',
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        {
          spendTokens: expect.any(Function),
          spendStructuredTokens: expect.any(Function),
          pricing: {
            getMultiplier: mockGetMultiplier,
            getCacheMultiplier: mockGetCacheMultiplier,
          },
          bulkWriteOps: {
            insertMany: mockBulkInsertTransactions,
            updateBalance: mockUpdateBalance,
          },
        },
        {
          user: 'user-123',
          conversationId: 'convo-123',
          collectedUsage,
          context: 'abort',
          messageId: 'msg-123',
          model: 'gpt-4',
        },
      );
    });

    it('should pass context abort for multiple models (parallel agents)', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
        { input_tokens: 120, output_tokens: 60, model: 'gemini-pro' },
      ];

      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
        fallbackModel: 'gpt-4',
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          context: 'abort',
          collectedUsage,
        }),
      );
    });

    it('should handle real-world parallel agent abort scenario', async () => {
      const collectedUsage = [
        { input_tokens: 31596, output_tokens: 151, model: 'gemini-3-flash-preview' },
        { input_tokens: 28000, output_tokens: 120, model: 'gpt-5.2' },
      ];

      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
        fallbackModel: 'gemini-3-flash-preview',
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          user: 'user-123',
          conversationId: 'convo-123',
          context: 'abort',
          model: 'gemini-3-flash-preview',
        }),
      );
    });

    /**
     * Race condition prevention: after abort middleware spends tokens,
     * the collectedUsage array is cleared so AgentClient.recordCollectedUsage()
     * (which shares the same array reference) sees an empty array and returns early.
     */
    it('should clear collectedUsage array after spending to prevent double-spending', async () => {
      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
      ];

      expect(collectedUsage.length).toBe(2);

      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
        fallbackModel: 'gpt-4',
      });

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(collectedUsage.length).toBe(0);
    });

    it('should await recordCollectedUsage before clearing array', async () => {
      let resolved = false;
      mockRecordCollectedUsage.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resolved = true;
        return { input_tokens: 100, output_tokens: 50 };
      });

      const collectedUsage = [
        { input_tokens: 100, output_tokens: 50, model: 'gpt-4' },
        { input_tokens: 80, output_tokens: 40, model: 'claude-3' },
      ];

      await spendCollectedUsage({
        userId: 'user-123',
        conversationId: 'convo-123',
        collectedUsage,
        fallbackModel: 'gpt-4',
      });

      expect(resolved).toBe(true);
      expect(collectedUsage.length).toBe(0);
    });
  });
});

describe('native cancellation HTTP boundary', () => {
  const { handleAbort } = require('./abortMiddleware');
  const { GenerationJobManager } = require('@librechat/api');
  const { saveMessage } = require('~/models');
  let req, res;
  beforeEach(() => {
    jest.clearAllMocks();
    req = { body: { abortKey: 'conversation:request', endpoint: 'agents' }, user: { id: 'owner' } };
    GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'owner' } });
    res = {
      headersSent: false,
      status: jest.fn(() => res),
      json: jest.fn(),
      send: jest.fn(),
      setHeader: jest.fn(),
    };
  });
  test.each(['committed', 'pending', 'unavailable'])(
    'reports native %s without a second save or false cancellation',
    async (nativeResponse) => {
      GenerationJobManager.abortJob.mockResolvedValue({ success: false, nativeResponse });
      await handleAbort()(req, res);
      expect(res.status).toHaveBeenCalledWith(nativeResponse === 'committed' ? 200 : 202);
      expect(res.json).toHaveBeenCalledWith({ success: false, nativeResponse });
      expect(saveMessage).not.toHaveBeenCalled();
      expect(mockSpendTokens).not.toHaveBeenCalled();
    },
  );
  test('returns the abort owner saved projection without rewriting its text or completion flags', async () => {
    const responseMessage = {
      messageId: 'answer',
      conversationId: 'conversation',
      text: 'Saved partial.',
      content: [{ type: 'text', text: 'Saved partial.' }],
      unfinished: true,
      error: false,
      finish_reason: 'incomplete',
      metadata: { retained: true },
    };
    GenerationJobManager.abortJob.mockResolvedValue({
      success: true,
      text: responseMessage.text,
      content: responseMessage.content,
      collectedUsage: [],
      finalEvent: { responseMessage },
      jobData: {
        nativeResponse: { invocationId: 'native' },
        responseMessageId: 'answer',
        conversationId: 'conversation',
        userMessage: { messageId: 'source', conversationId: 'conversation', text: 'Request.' },
      },
    });
    await handleAbort()(req, res);
    expect(saveMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.send.mock.calls[0][0]).responseMessage).toEqual(responseMessage);
  });
});

describe('assistants chat Stop route ownership', () => {
  const express = require('express');
  const request = require('supertest');
  const { GenerationJobManager } = require('@librechat/api');
  const { saveMessage } = require('~/models');
  const noop = (_req, _res, next) => next();
  let app;
  beforeAll(() => {
    jest.doMock('~/server/middleware', () => ({
      handleAbort: require('./abortMiddleware').handleAbort,
      setHeaders: noop,
      validateModel: noop,
      buildEndpointOption: noop,
    }));
    jest.doMock('~/server/middleware/validate/convoAccess', () => noop);
    jest.doMock('~/server/middleware/assistants/validate', () => noop);
    jest.doMock('~/server/controllers/assistants/chatV1', () => noop);
    jest.doMock('~/server/controllers/assistants/chatV2', () => noop);
    app = express();
    app.use(express.json(), (req, _res, next) => {
      req.user = { id: 'owner' };
      next();
    });
    app.use('/api/assistants/v1/chat', require('~/server/routes/assistants/chatV1'));
    app.use('/api/assistants/v2/chat', require('~/server/routes/assistants/chatV2'));
  });
  beforeEach(() => {
    jest.clearAllMocks();
    GenerationJobManager.abortJob.mockResolvedValue({
      success: false,
      nativeResponse: 'committed',
      finalEvent: { responseMessage: { text: 'Private saved answer.' } },
    });
  });
  test.each(['v1', 'v2'])(
    '%s refuses a foreign job before cancellation or reading its saved FINAL',
    async (version) => {
      GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'other-owner' } });
      const response = await request(app)
        .post(`/api/assistants/${version}/chat/abort`)
        .send({ abortKey: 'foreign-conversation:request', endpoint: 'agents' });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: 'Job not found', streamId: 'foreign-conversation' });
      expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
      expect(saveMessage).not.toHaveBeenCalled();
    },
  );
  test.each(['v1', 'v2'])(
    '%s permits the selected owner and carries explicit Stop intent',
    async (version) => {
      GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'owner' } });
      const response = await request(app)
        .post(`/api/assistants/${version}/chat/abort`)
        .send({ abortKey: 'conversation:request', endpoint: 'agents' });
      expect(response.status).toBe(200);
      expect(GenerationJobManager.abortJob).toHaveBeenCalledWith(
        'conversation',
        'user_cancelled',
        'owner',
      );
      expect(response.body.finalEvent.responseMessage.text).toBe('Private saved answer.');
    },
  );
  test('missing job owner fails closed', async () => {
    GenerationJobManager.getJob.mockResolvedValue({ metadata: {} });
    const response = await request(app)
      .post('/api/assistants/v1/chat/abort')
      .send({ abortKey: 'conversation:request', endpoint: 'agents' });
    expect(response.status).toBe(404);
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
  });
});
