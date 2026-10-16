import { TOOL_EFFECT_CLASSES } from '../tools/toolEffectMetadata';
import { createActiveWorkTools, readActiveWork } from './activeWorkTools';

describe('createActiveWorkTools', () => {
  const getActiveWorkPage = jest.fn();
  const executeGlassHiveWorkAction = jest.fn();
  const getActiveWorkHistoryPage = jest.fn();
  const getGlassHiveWorkResult = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    getActiveWorkPage.mockResolvedValue({ snapshot: 'fresh', work: [{ workRef: 'work-51' }] });
    executeGlassHiveWorkAction.mockResolvedValue({ workRef: 'work-1', state: 'stopping' });
  });

  function create(userId: unknown = 'owner-1') {
    return createActiveWorkTools(
      { userId },
      {
        getActiveWorkPage,
        getActiveWorkHistoryPage,
        getGlassHiveWorkResult,
        executeGlassHiveWorkAction,
      },
    );
  }

  test('Main clarification uses the existing action and exact wire values without owner approval authority', async () => {
    const {action} = create();
    const nativeInput = {version:1 as const, requestId:'question-1', requestFingerprint:'a'.repeat(64),
      action:'accept' as const, content:{answers:{'Which colour?\n ':['Blue']}}};
    const config={toolCall:{id:'answer-1'}, configurable:{requestBody:{conversationId:'conversation-1',messageId:'message-1'}}};
    await action.invoke({workRef:'work-1',action:'resume',nativeInput},config);
    expect(executeGlassHiveWorkAction).toHaveBeenCalledWith(expect.objectContaining({ownerId:'owner-1',nativeInput}));
    expect(executeGlassHiveWorkAction.mock.calls[0][0]).not.toHaveProperty('ownerInputControl');
    await action.invoke({workRef:'work-1',action:'resume',nativeInput:{...nativeInput,content:{optionId:'native-choice'}}},config);
    expect(executeGlassHiveWorkAction).toHaveBeenCalledTimes(2);
    expect(executeGlassHiveWorkAction.mock.calls[1][0]).toMatchObject({requestBody:config.configurable.requestBody});
    expect(executeGlassHiveWorkAction.mock.calls[1][0]).not.toHaveProperty('ownerInputControl');
    await expect(action.invoke({workRef:'work-1',action:'resume',nativeInput,ownerInputControl:true},config)).rejects.toThrow();
    await expect(action.invoke({workRef:'work-1',action:'resume',nativeInput,nativeHumanInput:{receivedAt:1}},config)).rejects.toThrow();
  });

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

  test('active and history share compact facts while preserving their original pagination', async () => {
    const value = { snapshot: 'fresh', cursor: 'native.cursor', overflowCount: 9,
      work: [{ workRef: 'work-exact', title: 'Exact work', state: 'needs_input',
        attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
        actions: ['resume', 'stop'], updatedAt: '2026-01-01T00:00:00Z',
        artifactLinks: { items: [{ url: 'https://example.invalid/large-file' }] },
        queue: { pending: 'verbose'.repeat(10000) }, route: { privateMetadata: 'not needed' } }] };
    getActiveWorkPage.mockResolvedValue(value);
    getActiveWorkHistoryPage.mockResolvedValue(value);
    const { list } = create();
    for (const scope of ['active', 'history'] as const) {
      const result = JSON.parse(await list.invoke({ scope, cursor: 'previous.cursor', limit: 100 }));
      expect(result).toMatchObject({ scope, snapshot: 'fresh', cursor: 'native.cursor',
        overflowCount: 9, omittedVisibleWork: 0, optionalMetadataOmitted: true,
        work: [{ workRef: 'work-exact', title: 'Exact work', state: 'needs_input',
          attention: value.work[0].attention, actions: ['resume', 'stop'] }] });
      expect(result.work[0]).not.toHaveProperty('nativeInputOmitted');
      expect(result.work[0]).not.toHaveProperty('artifactLinks');
      expect(result.work[0]).not.toHaveProperty('route');
      expect(result.work[0]).not.toHaveProperty('queue');
      expect(result.work[0]).not.toHaveProperty('updatedAt');
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(19 * 1024);
    }
    expect(getActiveWorkPage).toHaveBeenCalledWith({ ownerId: 'owner-1', cursor: 'previous.cursor', limit: 100 });
    expect(getActiveWorkHistoryPage).toHaveBeenCalledWith({ ownerId: 'owner-1', cursor: 'previous.cursor', limit: 100 });
    expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test('reads retained history and exact results without a mutation', async () => {
    const { list } = create();
    getActiveWorkHistoryPage.mockResolvedValue({ work: [{ workRef: 'work-old' }] });
    getGlassHiveWorkResult.mockResolvedValue({
      runId: 'run-old',
      outputText: 'Complete retained result',
    });
    await list.invoke({ scope: 'history', cursor: 'next', limit: 20 });
    expect(getActiveWorkHistoryPage).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      cursor: 'next',
      limit: 20,
    });
    expect(JSON.parse(await list.invoke({ scope: 'result', runId: 'run-old' }))).toEqual({
      runId: 'run-old',
      outputText: 'Complete retained result',
    });
    expect(getGlassHiveWorkResult).toHaveBeenCalledWith({ ownerId: 'owner-1', runId: 'run-old' });
    expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test.each([
    { scope: 'result' },
    { scope: 'result', runId: 'run-1', cursor: 'next' },
    { scope: 'active', runId: 'run-1' },
    { scope: 'result', runId: 'run-1', ownerId: 'other' },
    { scope: 'unknown' },
  ])('rejects invalid or owner-supplied result selectors %j', async (input) => {
    const { list } = create();
    await expect(list.invoke(input)).rejects.toThrow();
    expect(getGlassHiveWorkResult).not.toHaveBeenCalled();
  });

  test('declares roster reads and durable mutations structurally', () => {
    const { list, action } = create();

    expect(list.metadata?.viventiumToolEffectClass).toBe(TOOL_EFFECT_CLASSES.readOnly);
    expect(action.metadata?.viventiumToolEffectClass).toBe(TOOL_EFFECT_CLASSES.externalMutation);
  });

  test('typed invalid active-work input preserves its schema explanation before any read', async () => {
    await expect(readActiveWork('owner-1', {workRef:'work-1'}, {
      getActiveWorkPage, getActiveWorkHistoryPage, getGlassHiveWorkResult,
    })).rejects.toMatchObject({code:'active_work_arguments_invalid',
      message:'runId and workRef require result scope'});
    expect(getActiveWorkPage).not.toHaveBeenCalled();
    expect(getGlassHiveWorkResult).not.toHaveBeenCalled();
  });

  test('invalid unexpected input does not echo its private key in validation diagnostics', async () => {
    await expect(readActiveWork('owner-1', {synthetic_private_key:'synthetic-private-value'}, {
      getActiveWorkPage, getActiveWorkHistoryPage, getGlassHiveWorkResult,
    })).rejects.toMatchObject({code:'active_work_arguments_invalid',
      message:'Invalid active-work arguments'});
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

  test('Retry carries updated guidance in one existing action without a separate Message', async () => {
    const { action } = create();
    const instruction = 'Use the revised restricted objective and preserve existing files.';
    await action.invoke({ workRef: 'work-1', action: 'retry', instruction }, {
      toolCall: { id: 'native-retry-guidance' },
      configurable: { requestBody: { conversationId: 'conversation-1', messageId: 'message-1' } },
    });
    expect(executeGlassHiveWorkAction).toHaveBeenCalledTimes(1);
    expect(executeGlassHiveWorkAction).toHaveBeenCalledWith(expect.objectContaining({
      workRef: 'work-1', action: 'retry', instruction,
    }));
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


describe('actual eager action caller selected file handoff', () => {
  it.each(['message', 'queue', 'steer', 'pause'] as const)(
    'normalizes an optional empty file selection for %s before the owner executor',
    async (actionName) => {
      const execute = jest.fn().mockResolvedValue({ state: 'queued' });
      const { action } = createActiveWorkTools(
        { userId: 'owner-1' },
        {
          getActiveWorkPage: async () => ({}),
          getActiveWorkHistoryPage: async () => ({}),
          getGlassHiveWorkResult: async () => ({}),
          executeGlassHiveWorkAction: execute,
        },
      );
      const input = {
        workRef: 'work-1',
        action: actionName,
        instruction: 'Continue the exact objective',
      };
      const config = {
        toolCall: { id: 'native-1' },
        configurable: {
          requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
        },
      };
      await action.invoke({ ...input, fileIds: [] }, config);
      await action.invoke(input, config);
      expect(execute.mock.calls[0][0]).not.toHaveProperty('fileIds');
      expect(execute.mock.calls[0][0]).toEqual(execute.mock.calls[1][0]);
    },
  );
  it.each([{ fileIds: [''] }, { fileIds: [' padded'] }, { fileIds: ['a', 'a'] }, { fileIds: [42] }])(
    'rejects malformed nonempty file references %j before the owner executor',
    async ({ fileIds }) => {
      const execute = jest.fn(async () => ({}));
      const { action } = createActiveWorkTools(
        { userId: 'owner-1' },
        {
          getActiveWorkPage: async () => ({}),
          getActiveWorkHistoryPage: async () => ({}),
          getGlassHiveWorkResult: async () => ({}),
          executeGlassHiveWorkAction: execute,
        },
      );
      await expect(
        action.invoke({ workRef: 'work-1', action: 'message', instruction: 'Continue', fileIds }),
      ).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('passes selected IDs with trusted request resources to the shared owner executor', async () => {
    const execute=jest.fn(async()=>({state:'queued'}));
    const req={user:{id:'owner-1'},config:{paths:{}}};
    const {action}=createActiveWorkTools({userId:'owner-1',req},{getActiveWorkPage:async()=>({}),getActiveWorkHistoryPage:async()=>({}),getGlassHiveWorkResult:async()=>({}),executeGlassHiveWorkAction:execute});
    const body={conversationId:'conversation-1',messageId:'message-1',files:[{file_id:'a'}]};
    await action.invoke({workRef:'work-1',action:'steer',instruction:'Use this exact file',fileIds:['a']},{toolCall:{id:'native-1'},configurable:{requestBody:body}});
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ownerId:'owner-1',fileIds:['a'],requestBody:body,serverReq:req}));
  });
  it('rejects file arguments on unsupported follow-up action without sending an action', async () => {
    const execute=jest.fn(async()=>({}));const {action}=createActiveWorkTools({userId:'owner-1'},{getActiveWorkPage:async()=>({}),getActiveWorkHistoryPage:async()=>({}),getGlassHiveWorkResult:async()=>({}),executeGlassHiveWorkAction:execute});
    await expect(action.invoke({workRef:'work-1',action:'pause',instruction:'Use files',fileIds:['a']},{toolCall:{id:'native-1'},configurable:{requestBody:{conversationId:'conversation-1',messageId:'message-1'}}})).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
