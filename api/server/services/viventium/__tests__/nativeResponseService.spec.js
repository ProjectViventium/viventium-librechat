const mockCommitProjection = jest.fn();
const mockProjectionComplete = jest.fn();
const mockRecover = jest.fn();
let mockTransactionDepth = 0;
const mockModels = {
  getNativeResponse: jest.fn(),
  getMessages: jest.fn(),
  getMessage: jest.fn(),
  markNativeResponseReplayStored: jest.fn(),
  mutateAcceptedMainContinuitySources: jest.fn(),
  mutateNativeResponseSources: jest.fn(),
};
const mockJobs = {
  finishNativeResponse: jest.fn(),
  settleNativeResponse: jest.fn(),
  getJob: jest.fn(),
  acknowledgeStreamDelivery: jest.fn(),
};

jest.mock('@librechat/api', () => ({
  createNativeResponseRecoveryService: () => ({
    recover: mockRecover,
    projectForTransmit: async (_identity, message) => message,
  }),
  isAcceptedMainProjectionComplete: (...args) => mockProjectionComplete(...args),
  GenerationJobManager: mockJobs,
  sanitizeMessageForTransmit: (message) => message,
}));
jest.mock('~/models', () => mockModels);
jest.mock('../ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) => mockCommitProjection(...args),
}));
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: async (operation) => {
    mockTransactionDepth++;
    try {
      return await operation();
    } finally {
      mockTransactionDepth--;
    }
  },
}));

const {
  recoverSavedNativeResponse,
  recoverNativeResponse,
  markNativeResponseReplayStored,
  mutateNativeResponseSources,
} = require('../nativeResponseService');

describe('native final presentation handoff', () => {
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    source: { messageId: 'question' },
  };
  const projected = { messageId: 'answer', text: 'Saved answer.', memoryWriteStatus: 'running' };

  beforeEach(() => {
    jest.resetAllMocks();
    mockCommitProjection.mockResolvedValue({ status: 'committed' });
    mockProjectionComplete.mockReturnValue(true);
    mockRecover.mockResolvedValue({ messageId: 'answer', text: 'Saved answer.' });
    mockModels.getMessages.mockResolvedValue([projected]);
    mockModels.getMessage.mockResolvedValue({ messageId: 'question', text: 'Question.' });
    mockModels.markNativeResponseReplayStored.mockResolvedValue(true);
    mockJobs.finishNativeResponse.mockResolvedValue(true);
    mockJobs.settleNativeResponse.mockResolvedValue(true);
    mockJobs.getJob.mockResolvedValue({
      metadata: { deliveryPolicy: { commit_authority: 'adapter' } },
    });
  });

  it('uses the ordinary public Message projection for live and recovered native answers', async () => {
    expect(await recoverSavedNativeResponse(identity)).toEqual(projected);
    expect(mockModels.getMessages).toHaveBeenCalledWith({
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
    });
    expect(await recoverNativeResponse(identity)).toBe(true);
    expect(mockJobs.finishNativeResponse.mock.calls[0][1].responseMessage).toEqual(projected);
    expect(mockJobs.acknowledgeStreamDelivery).not.toHaveBeenCalled();
  });

  it('does not publish an absent or still-pending saved answer', async () => {
    mockRecover.mockResolvedValue(null);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockModels.getMessages).not.toHaveBeenCalled();
    expect(mockJobs.finishNativeResponse).not.toHaveBeenCalled();
  });

  it('retains recovery until final replay and its Mongo mark both exist', async () => {
    mockJobs.finishNativeResponse.mockResolvedValue(false);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockModels.markNativeResponseReplayStored).not.toHaveBeenCalled();
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
    mockModels.markNativeResponseReplayStored.mockResolvedValue(false);
    expect(await markNativeResponseReplayStored(identity)).toBe(false);
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
  });

  it('releases retention only after the exact Mongo replay mark succeeds', async () => {
    const order = [];
    mockModels.markNativeResponseReplayStored.mockImplementation(async () => {
      order.push('mongo');
      return true;
    });
    mockJobs.settleNativeResponse.mockImplementation(async () => {
      order.push('settle');
      return true;
    });
    expect(await markNativeResponseReplayStored(identity)).toBe(true);
    expect(order).toEqual(['mongo', 'settle']);
    expect(mockJobs.settleNativeResponse).toHaveBeenCalledWith(identity, undefined);
  });
  it.each(['unavailable', 'context_metadata_missing', 'not_accepted', 'agent_mismatch', 'invalid'])(
    'keeps recovery pending when Main projection returns %s',
    async (status) => {
      mockJobs.getJob.mockResolvedValue({
        metadata: { deliveryPolicy: { commit_authority: 'server' } },
      });
      mockJobs.acknowledgeStreamDelivery.mockResolvedValue({
        status: 'recorded',
        presentation: { responseMessageId: 'answer' },
      });
      mockCommitProjection.mockResolvedValue({ status });
      mockProjectionComplete.mockReturnValue(false);
      expect(await recoverNativeResponse(identity)).toBe(false);
      expect(mockModels.markNativeResponseReplayStored).not.toHaveBeenCalled();
      expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
    },
  );

  it.each(['committed', 'already_committed', 'qa_excluded'])(
    'settles explicit projection success %s',
    async (status) => {
      mockJobs.getJob.mockResolvedValue({
        metadata: { deliveryPolicy: { commit_authority: 'server' } },
      });
      mockJobs.acknowledgeStreamDelivery.mockResolvedValue({
        status: 'recorded',
        idempotent: true,
        presentation: { responseMessageId: 'answer' },
      });
      mockCommitProjection.mockResolvedValue({ status });
      expect(await recoverNativeResponse(identity)).toBe(true);
      expect(mockProjectionComplete).toHaveBeenCalledWith({ status });
      expect(mockModels.markNativeResponseReplayStored).toHaveBeenCalledWith(identity);
    },
  );

  it('reports incomplete replay marking without settling or claiming recovery success', async () => {
    mockModels.markNativeResponseReplayStored.mockResolvedValue(false);
    expect(await recoverNativeResponse(identity)).toBe(false);
    expect(mockJobs.settleNativeResponse).not.toHaveBeenCalled();
  });
});

describe('shared source mutation boundary', () => {
  it.each(['edit', 'delete', 'system'])(
    'keeps A1 inside the transaction before B2 and preserves %s',
    async (kind) => {
      const order = [];
      const filter = { user: 'owner', messageId: 'source' };
      mockModels.mutateAcceptedMainContinuitySources.mockImplementation(
        async (scope, operation) => {
          expect(mockTransactionDepth).toBe(1);
          expect(scope).toBe(filter);
          order.push('continuity-before');
          const result = await operation();
          order.push('continuity-after');
          return result;
        },
      );
      mockModels.mutateNativeResponseSources.mockImplementation(
        async (scope, operation, _revoke, _transaction, _retire, selectedKind) => {
          expect(scope).toBe(filter);
          expect(selectedKind).toBe(kind);
          order.push('native');
          return operation();
        },
      );
      expect(
        await mutateNativeResponseSources(
          filter,
          async () => {
            order.push('write');
            return 'saved';
          },
          kind,
        ),
      ).toBe('saved');
      expect(order).toEqual(['continuity-before', 'native', 'write', 'continuity-after']);
    },
  );
  it('defaults unknown older callers to explicit edit authority', async () => {
    mockModels.mutateAcceptedMainContinuitySources.mockImplementation((_scope, operation) =>
      operation(),
    );
    mockModels.mutateNativeResponseSources.mockImplementation(
      (_scope, operation, _revoke, _transaction, _retire, kind) => {
        expect(kind).toBe('edit');
        return operation();
      },
    );
    expect(await mutateNativeResponseSources({ user: 'owner' }, async () => true)).toBe(true);
  });
});
