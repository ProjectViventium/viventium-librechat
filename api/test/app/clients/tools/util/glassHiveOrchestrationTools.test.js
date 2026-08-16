const mockExecuteMainDelegation = jest.fn();
const mockParallelWorkAvailable = jest.fn();

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerService', () => ({
  executeMainDelegation: (...args) => mockExecuteMainDelegation(...args),
}));
jest.mock('~/server/services/viventium/ViventiumOrchestrationMode', () => ({
  parallelWorkAvailable: () => mockParallelWorkAvailable(),
}));

describe('glassHiveOrchestrationTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParallelWorkAvailable.mockReturnValue(true);
    mockExecuteMainDelegation.mockImplementation(async ({ args }) => ({
      status: 'ok',
      workRef: args.sourceOrdinals?.[0] === 2 ? 'work-b' : 'work-a',
    }));
  });

  test('exposes the universal facade only to a declared Main on an isolation-ready deployment', () => {
    const {
      canExposeGlassHiveMainDelegation,
      glassHiveMainOrchestrationDefinitions,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const main = { glasshive_options: { orchestration: { parallel_available: true } } };

    expect(canExposeGlassHiveMainDelegation(main)).toBe(true);
    expect(canExposeGlassHiveMainDelegation({ glasshive_options: {} })).toBe(false);
    mockParallelWorkAvailable.mockReturnValue(false);
    expect(canExposeGlassHiveMainDelegation(main)).toBe(false);
    const definitions = glassHiveMainOrchestrationDefinitions([
      'worker_delegate_once_mcp_glasshive-workers-projects',
      'active_work_list',
      'active_work_action',
    ]);
    expect(definitions).toHaveLength(3);
    expect(definitions[0].parameters.properties).toHaveProperty(
      'sourceOrdinals',
    );
    expect(definitions[0].parameters.properties).not.toHaveProperty(
      'executionMode',
    );
  });

  test('filters launch separately from known existing-work controls during rollback', () => {
    const {
      availableGlassHiveMainOrchestrationTools,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const requested = [
      'worker_delegate_once_mcp_glasshive-workers-projects',
      'active_work_list',
      'active_work_action',
    ];
    const main = { glasshive_options: { orchestration: { parallel_available: true } } };
    mockParallelWorkAvailable.mockReturnValue(false);

    expect(
      availableGlassHiveMainOrchestrationTools(main, requested, {
        user: { personalization: { parallel_work_known: true } },
      }),
    ).toEqual(['active_work_list', 'active_work_action']);
    expect(
      availableGlassHiveMainOrchestrationTools(main, requested, {
        user: {
          personalization: { orchestration_mode: 'focused', parallel_work_known: false },
        },
      }),
    ).toEqual([]);
    expect(
      availableGlassHiveMainOrchestrationTools({}, requested, {
        user: { personalization: { parallel_work_known: true } },
      }),
    ).toEqual([]);
  });

  test('re-appends only centralized rollback controls after an OAuth tool reload', () => {
    const {
      appendGlassHiveMainOrchestrationFacade,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const staleDelegation = {
      name: 'worker_delegate_once_mcp_glasshive-workers-projects',
      description: 'stale',
    };
    const baseDefinition = { name: 'google_search', description: 'Search' };
    const result = appendGlassHiveMainOrchestrationFacade({
      toolDefinitions: [baseDefinition, staleDelegation],
      toolRegistry: new Map([
        ['google_search', baseDefinition],
        [staleDelegation.name, staleDelegation],
      ]),
      requestedTools: ['active_work_list', 'active_work_action'],
    });

    expect(result.toolDefinitions.map(({ name }) => name)).toEqual([
      'google_search',
      'active_work_list',
      'active_work_action',
    ]);
    expect(Array.from(result.toolRegistry.keys())).toEqual([
      'google_search',
      'active_work_list',
      'active_work_action',
    ]);
    expect(result.toolRegistry.has(staleDelegation.name)).toBe(false);
  });

  test('partitions rapid A/file-A and B through exact source ordinals and returns durable receipts', async () => {
    const {
      createGlassHiveMainDelegationTool,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const tool = createGlassHiveMainDelegationTool({
      userId: 'owner-1',
      req: {
        user: {
          id: 'owner-1',
          role: 'USER',
        },
      },
    });
    const requestBody = {
      conversationId: 'conversation-1',
      messageId: 'message-1',
      viventiumSourceEventId: 'source-c',
      viventiumTriggeringSourceSegments: [
        {
          source_event_id: 'source-a',
          source_index: 0,
          text: 'A: inspect the binary',
          source_files: [{ file_id: 'file-a', filename: 'a.bin' }],
        },
        { source_event_id: 'source-b', source_index: 0, text: 'B: research this' },
        { source_event_id: 'source-c', source_index: 0, text: 'C: answer quickly' },
      ],
      files: [
        { file_id: 'file-a', filename: 'a.bin', source_event_id: 'source-a', source_index: 0 },
      ],
    };
    const config = { configurable: { requestBody, glasshive_worker_memory: 'gated memory' } };

    const a = JSON.parse(
      await tool._call(
        { title: 'A', instruction: 'Inspect A', sourceOrdinals: [1] },
        undefined,
        { ...config, toolCall: { id: 'provider-call-a' } },
      ),
    );
    const b = JSON.parse(
      await tool._call(
        { title: 'B', instruction: 'Research B', sourceOrdinals: [2] },
        undefined,
        { ...config, toolCall: { id: 'provider-call-b' } },
      ),
    );

    expect(a).toMatchObject({ status: 'ok', workRef: 'work-a' });
    expect(b).toMatchObject({ status: 'ok', workRef: 'work-b' });
    expect(mockExecuteMainDelegation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        user: { id: 'owner-1', role: 'USER' },
        requestBody,
        workerMemory: 'gated memory',
        args: expect.objectContaining({ sourceOrdinals: [1] }),
        invocationId: expect.stringMatching(/^ghbi_[a-f0-9]{64}$/),
      }),
    );
    expect(mockExecuteMainDelegation.mock.calls[0][0].invocationId).not.toBe(
      mockExecuteMainDelegation.mock.calls[1][0].invocationId,
    );
  });

  test('records an authoritative blocked launch on the request for fail-closed final messaging', async () => {
    const req = { user: { id: 'owner-1', role: 'USER' } };
    mockExecuteMainDelegation.mockResolvedValueOnce({
      status: 'blocked',
      reason: 'glasshive_delegation_tool_error',
      retryable: false,
      needsInput: false,
    });
    const {
      createGlassHiveMainDelegationTool,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const {
      mainDelegationTurnTruth,
    } = require('~/server/services/viventium/GlassHiveConversationOrchestration');
    const tool = createGlassHiveMainDelegationTool({ userId: 'owner-1', req });

    await tool._call(
      { title: 'Synthetic mission', instruction: 'Run it safely.' },
      undefined,
      {
        configurable: {
          requestBody: {
            conversationId: 'conversation-1',
            messageId: 'message-1',
            viventiumSourceEventId: 'source-a',
          },
        },
        toolCall: { id: 'native-call-blocked' },
      },
    );

    expect(mainDelegationTurnTruth(req)).toEqual({
      attemptedCount: 1,
      confirmedCount: 0,
      unconfirmedCount: 1,
      retryableCount: 0,
      needsInputCount: 0,
    });
  });

  test('ignores reconnect IDs and attacker fields while material objective changes stay distinct', async () => {
    const {
      createGlassHiveMainDelegationTool,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const tool = createGlassHiveMainDelegationTool({
      userId: 'owner-1',
      req: { user: { id: 'owner-1' } },
    });
    const configurable = {
      requestBody: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        viventiumSourceEventId: 'source-a',
        viventiumTriggeringSourceSegments: [
          { source_event_id: 'source-a', source_index: 0, text: 'Run this once' },
        ],
      },
    };

    await tool._call(
      { title: 'A', instruction: 'Run A', sourceOrdinals: [1] },
      undefined,
      { configurable, toolCall: { id: 'native-call-a' } },
    );
    await tool._call(
      { title: ' A ', instruction: ' Run A ', sourceOrdinals: [1] },
      undefined,
      { configurable, toolCall: { id: 'native-call-a' } },
    );
    await tool._call(
      { title: 'A', instruction: 'Run A differently', sourceOrdinals: [1] },
      undefined,
      { configurable, toolCall: { id: 'native-call-a' } },
    );

    const identities = mockExecuteMainDelegation.mock.calls.map(([value]) => value.invocationId);
    expect(identities[1]).toBe(identities[0]);
    expect(identities[2]).not.toBe(identities[0]);
  });

  test('separates two intentional identical native calls while replaying each idempotently', async () => {
    const {
      createGlassHiveMainDelegationTool,
    } = require('~/app/clients/tools/util/glassHiveOrchestrationTools');
    const tool = createGlassHiveMainDelegationTool({
      userId: 'owner-1',
      req: { user: { id: 'owner-1' } },
    });
    const configurable = {
      requestBody: {
        conversationId: 'conversation-1',
        messageId: 'message-1',
        viventiumSourceEventId: 'source-a',
        viventiumTriggeringSourceSegments: [
          { source_event_id: 'source-a', source_index: 0, text: 'Run two independent checks' },
        ],
      },
    };
    const args = { title: 'Check', instruction: 'Run the independent check', sourceOrdinals: [1] };

    await tool._call(args, undefined, {
      configurable,
      toolCall: { id: 'native-call-a', turn: 0 },
    });
    await tool._call(args, undefined, {
      configurable,
      toolCall: { id: 'native-call-b', turn: 1 },
    });
    await tool._call(args, undefined, {
      configurable,
      toolCall: { id: 'native-call-a', turn: 0 },
    });
    await tool._call(args, undefined, {
      configurable,
      toolCall: { id: 'native-call-b', turn: 1 },
    });

    const calls = mockExecuteMainDelegation.mock.calls.map(([value]) => value);
    expect(calls[0].invocationId).not.toBe(calls[1].invocationId);
    expect(calls[2].invocationId).toBe(calls[0].invocationId);
    expect(calls[3].invocationId).toBe(calls[1].invocationId);
    expect(calls[0].toolCall).toMatchObject({ id: 'native-call-a', turn: 0 });
    expect(calls[1].toolCall).toMatchObject({ id: 'native-call-b', turn: 1 });
  });
});
