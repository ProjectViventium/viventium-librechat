import { TOOL_EFFECT_CLASSES } from '../tools/toolEffectMetadata';
import { createActiveWorkTools } from './activeWorkTools';

describe('createActiveWorkTools', () => {
  const getActiveWorkPage = jest.fn();
  const executeGlassHiveWorkAction = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    getActiveWorkPage.mockResolvedValue({ snapshot: 'fresh', work: [{ workRef: 'work-51' }] });
    executeGlassHiveWorkAction.mockResolvedValue({ workRef: 'work-1', state: 'stopping' });
  });

  function create(userId: unknown = 'owner-1') {
    return createActiveWorkTools({ userId }, { getActiveWorkPage, executeGlassHiveWorkAction });
  }

  test('lists the authenticated owner roster with bounded defaults', async () => {
    const { list } = create();

    expect(JSON.parse(await list.invoke({}))).toMatchObject({
      snapshot: 'fresh',
      work: [{ workRef: 'work-51' }],
    });
    expect(getActiveWorkPage).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      cursor: '',
      limit: 50,
    });
  });

  test('declares roster reads and durable mutations structurally', () => {
    const { list, action } = create();

    expect(list.metadata?.viventiumToolEffectClass).toBe(TOOL_EFFECT_CLASSES.readOnly);
    expect(action.metadata?.viventiumToolEffectClass).toBe(TOOL_EFFECT_CLASSES.externalMutation);
  });

  test('derives a stable operation id from trusted turn and tool-call identity', async () => {
    const { action } = create();
    const config = {
      toolCall: { id: 'call-1' },
      configurable: {
        requestBody: {
          conversationId: 'conversation-1',
          messageId: 'message-1',
          viventiumStreamId: 'stream-1',
          viventiumAuthoringSourceEventId: 'voice:session-1:request-1',
          viventiumAuthoringSourceRevision: 7,
          viventiumAuthoringSurface: 'voice',
        },
      },
    };

    await action.invoke({ workRef: 'work-1', action: 'stop' }, config);
    await action.invoke({ workRef: 'work-1', action: 'stop' }, config);

    const first = executeGlassHiveWorkAction.mock.calls[0][0];
    expect(first).toEqual({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: expect.stringMatching(/^ghbi_[a-f0-9]{64}$/),
      durableEffectContext: {
        streamId: 'stream-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'message-1',
      },
    });
    expect(executeGlassHiveWorkAction.mock.calls[1][0].operationId).toBe(first.operationId);
  });

  test('keeps separate identical action occurrences distinct', async () => {
    const { action } = create();
    const configurable = {
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
    };
    const input = { workRef: 'work-1', action: 'message' as const, instruction: 'Keep checking' };

    await action.invoke(input, { toolCall: { id: 'native-a' }, configurable });
    await action.invoke(input, { toolCall: { id: 'native-b' }, configurable });

    expect(executeGlassHiveWorkAction.mock.calls[0][0].operationId).not.toBe(
      executeGlassHiveWorkAction.mock.calls[1][0].operationId,
    );
  });

  test('rejects mutation guidance that is absent or unbounded', async () => {
    const { action } = create();

    await expect(
      action.invoke({ workRef: 'work-1', action: 'message', instruction: '' }),
    ).rejects.toThrow();
    await expect(
      action.invoke({ workRef: 'work-1', action: 'message', instruction: 'x'.repeat(8001) }),
    ).rejects.toThrow();
    expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test('fails closed without an owner or trusted turn identity', async () => {
    expect(() => create('')).toThrow('active_work_owner_required');
    const { action } = create();

    await expect(action.invoke({ workRef: 'work-1', action: 'stop' })).rejects.toThrow(
      'active_work_operation_identity_unavailable',
    );
    expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
  });
});
