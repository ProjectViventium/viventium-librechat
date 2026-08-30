const mockGetActiveWorkPage = jest.fn();
const mockGetActiveWorkSnapshot = jest.fn();
const mockExecuteGlassHiveWorkAction = jest.fn();

jest.mock('~/server/services/viventium/GlassHiveAccountService', () => ({
  getActiveWorkPage: (...args) => mockGetActiveWorkPage(...args),
  getActiveWorkSnapshot: (...args) => mockGetActiveWorkSnapshot(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveWorkActionService', () => ({
  executeGlassHiveWorkAction: (...args) => mockExecuteGlassHiveWorkAction(...args),
}));

describe('activeWorkTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetActiveWorkSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work-1', title: 'Research', state: 'running', actions: ['stop'] }],
      overflowCount: 0,
    });
    mockGetActiveWorkPage.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work-51', title: 'Later work', state: 'running', actions: [] }],
      overflowCount: 0,
    });
    mockExecuteGlassHiveWorkAction.mockResolvedValue({ workRef: 'work-1', state: 'stopping' });
  });

  test('list is owner-scoped and preserves snapshot truth', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { list } = createActiveWorkTools({ userId: 'owner-1' });

    const output = JSON.parse(await list.invoke({}));

    expect(mockGetActiveWorkPage).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      cursor: '',
      limit: 50,
    });
    expect(mockGetActiveWorkSnapshot).not.toHaveBeenCalled();
    expect(output).toMatchObject({ snapshot: 'fresh', work: [{ workRef: 'work-51' }] });
  });

  test('list follows the server cursor so Main can see the complete roster', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { list } = createActiveWorkTools({ userId: 'owner-1' });

    const output = JSON.parse(await list.invoke({ cursor: 'signed.next-page', limit: 25 }));

    expect(mockGetActiveWorkPage).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      cursor: 'signed.next-page',
      limit: 25,
    });
    expect(output.work).toEqual([expect.objectContaining({ workRef: 'work-51' })]);
  });

  test('declares roster reads separately from durable work mutations for fallback fencing', () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { list, action } = createActiveWorkTools({ userId: 'owner-1' });

    expect(list.metadata?.viventiumToolEffectClass).toBe(
      Symbol.for('viventium.agent.tool.effect.read_only.v1'),
    );
    expect(action.metadata?.viventiumToolEffectClass).toBe(
      Symbol.for('viventium.agent.tool.effect.external_mutation.v1'),
    );
  });

  test('carries the roster read declaration through the real tool-start callback', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { list } = createActiveWorkTools({ userId: 'owner-1' });
    let callbackMetadata;

    await list.invoke(
      {},
      {
        callbacks: [
          {
            handleToolStart: async (...args) => {
              callbackMetadata = args[5];
            },
          },
        ],
      },
    );

    expect(callbackMetadata?.viventiumToolEffectClass).toBe(
      Symbol.for('viventium.agent.tool.effect.read_only.v1'),
    );
  });

  test('action contract distinguishes Queue from Message on every conversational surface', () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { action } = createActiveWorkTools({ userId: 'owner-1' });

    expect(action.description).toContain('Queue persists a follow-up behind the current objective');
    expect(action.description).toContain('Message delivers noninterrupting guidance');
    expect(action.description).toContain('Dismiss removes an acknowledged terminal card');
  });

  test('action derives reconnect-stable idempotency from the trusted turn and exact action', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { action } = createActiveWorkTools({ userId: 'owner-1' });

    const config = {
      toolCall: { id: 'call-1' },
      configurable: {
        requestBody: {
          conversationId: 'conversation-1',
          messageId: 'message-1',
          viventiumStreamId: 'stream-native-1',
          viventiumAuthoringSourceEventId: 'voice:session-1:request-1',
          viventiumAuthoringSourceRevision: 7,
          viventiumAuthoringSurface: 'voice',
        },
      },
    };
    await action.invoke({ workRef: 'work-1', action: 'stop' }, config);

    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: expect.stringMatching(/^ghbi_[a-f0-9]{64}$/),
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'message-1',
      },
    });

    const firstOperationId = mockExecuteGlassHiveWorkAction.mock.calls[0][0].operationId;
    await action.invoke({ workRef: 'work-1', action: 'stop' }, config);
    expect(mockExecuteGlassHiveWorkAction.mock.calls[1][0].operationId).toBe(firstOperationId);
  });

  test.each(['queue', 'message', 'steer'])(
    'keeps two intentional identical %s actions distinct while replaying each occurrence',
    async (actionName) => {
      const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
      const { action } = createActiveWorkTools({ userId: 'owner-1' });
      const configurable = {
        requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      };
      const input = { workRef: 'work-1', action: actionName, instruction: 'Keep checking' };

      await action.invoke(input, { toolCall: { id: 'native-action-a' }, configurable });
      await action.invoke(input, { toolCall: { id: 'native-action-b' }, configurable });
      await action.invoke(input, { toolCall: { id: 'native-action-a' }, configurable });

      const operationIds = mockExecuteGlassHiveWorkAction.mock.calls.map(
        ([value]) => value.operationId,
      );
      expect(operationIds[0]).not.toBe(operationIds[1]);
      expect(operationIds[2]).toBe(operationIds[0]);
    },
  );

  test('message-like actions require bounded non-empty guidance', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { action } = createActiveWorkTools({ userId: 'owner-1' });

    await expect(
      action.invoke(
        { workRef: 'work-1', action: 'message', instruction: '' },
        {
          toolCall: { id: 'call-2' },
          configurable: {
            requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
          },
        },
      ),
    ).rejects.toThrow();
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test('action fails closed when the trusted turn identity is unavailable', async () => {
    const { createActiveWorkTools } = require('~/app/clients/tools/util/activeWorkTools');
    const { action } = createActiveWorkTools({ userId: 'owner-1' });

    await expect(action.invoke({ workRef: 'work-1', action: 'stop' })).rejects.toThrow(
      'active_work_operation_identity_unavailable',
    );
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
  });
});
