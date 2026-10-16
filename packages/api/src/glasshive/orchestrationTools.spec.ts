import {
  DELEGATION_TOOL_NAME,
  MAIN_DELEGATION_JSON_SCHEMA,
  mainDelegationTurnTruth,
} from './conversationOrchestration';
import {
  appendGlassHiveMainOrchestrationFacade,
  availableGlassHiveMainOrchestrationTools,
  createGlassHiveMainDelegationTool,
  glassHiveMainOrchestrationDefinitions,
} from './orchestrationTools';

describe('GlassHive Main orchestration tools', () => {
  const executeMainDelegation = jest.fn();
  const logger = { info: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    executeMainDelegation.mockResolvedValue({ status: 'ok', workRef: 'work-a' });
  });

  test.each(['direct-openai', 'direct-anthropic', 'direct-xai'])(
    'validates and forwards exact registered Direct worker profile %s',
    async (profile) => {
      const delegation = createGlassHiveMainDelegationTool(
        { userId: 'owner-1' },
        { executeMainDelegation, logger },
      );
      const args = {
        title: 'Synthetic mission',
        instruction: 'Complete it.',
        resourceClass: 'standard',
        profile,
        effort: 'low',
      };
      expect(delegation.schema.safeParse(args).success).toBe(true);
      expect(
        delegation.schema.safeParse({ ...args, profile: 'unregistered-runtime' }).success,
      ).toBe(false);
      await delegation.invoke(args, {
        configurable: {
          requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
        },
      });
      expect(executeMainDelegation).toHaveBeenCalledWith(
        expect.objectContaining({
          user: expect.objectContaining({ id: 'owner-1' }),
          args: expect.objectContaining({ profile, effort: 'low' }),
        }),
      );
    },
  );

  test('exposes launch only with turn authority and keeps known-work controls available', () => {
    const main = { glasshive_options: { orchestration: { parallel_available: true } } };
    const requested = [DELEGATION_TOOL_NAME, 'active_work_list', 'active_work_action'];

    expect(
      availableGlassHiveMainOrchestrationTools(main, requested, {
        user: { personalization: { parallel_work_known: true } },
      }),
    ).toEqual(['active_work_list', 'active_work_action']);
    expect(
      availableGlassHiveMainOrchestrationTools(main, requested, { turnAvailable: true }),
    ).toEqual(requested);
  });

  test('publishes the exact Core-owned definitions and replaces stale facade entries', () => {
    const definitions = glassHiveMainOrchestrationDefinitions([
      DELEGATION_TOOL_NAME,
      'active_work_list',
      'active_work_action',
    ]);
    expect(definitions).toHaveLength(3);
    expect(definitions.map((definition) => definition.toolType)).toEqual([
      'builtin',
      'builtin',
      'builtin',
    ]);
    expect(definitions[0].parameters.required).toContain('resourceClass');
    expect(definitions[0].parameters.properties.instruction).toEqual(
      MAIN_DELEGATION_JSON_SCHEMA.properties.instruction,
    );
    expect(definitions[0].parameters.properties.instruction.description).toContain(
      'original selected source wording is retained separately',
    );

    const base = { name: 'google_search', description: 'Search' };
    const stale = { name: DELEGATION_TOOL_NAME, description: 'stale' };
    const reconciled = appendGlassHiveMainOrchestrationFacade({
      toolDefinitions: [base, stale],
      toolRegistry: new Map([
        [base.name, base],
        [stale.name, stale],
      ]),
      requestedTools: ['active_work_list'],
    });
    expect(reconciled.toolDefinitions.map(({ name }) => name)).toEqual([
      'google_search',
      'active_work_list',
    ]);
    expect(Array.from(reconciled.toolRegistry.keys())).toEqual([
      'google_search',
      'active_work_list',
    ]);
  });

  test('exposes and validates source selection from the trusted construction request', () => {
    const make = (count: number) =>
      createGlassHiveMainDelegationTool(
        {
          userId: 'owner-1',
          req: {
            body: {
              viventiumTriggeringSourceSegments: Array.from({ length: count }, () => ({
                text: 'Source',
              })),
            },
          },
        },
        { executeMainDelegation, logger },
      );
    const args = { title: 'Mission', instruction: 'Complete it.', resourceClass: 'standard' };
    const multi = make(3).schema;
    expect(multi.safeParse(args).success).toBe(false);
    expect(multi.safeParse({ ...args, sourceOrdinals: [] }).success).toBe(false);
    expect(multi.safeParse({ ...args, sourceOrdinals: [4] }).success).toBe(false);
    expect(multi.safeParse({ ...args, sourceOrdinals: [1, 2, 3, 1] }).success).toBe(false);
    expect(multi.safeParse({ ...args, sourceOrdinals: [2] }).success).toBe(true);
    expect(multi.safeParse({ ...args, sourceOrdinals: [1, 3] }).success).toBe(true);
    expect(make(1).schema.safeParse(args).success).toBe(true);
    expect(make(0).schema.safeParse(args).success).toBe(true);
  });

  test('inherits only the trusted configured route and records an authoritative receipt', async () => {
    const req = { user: { role: 'USER' }, _viventiumFallbackLlmAttempt: true };
    const delegation = createGlassHiveMainDelegationTool(
      {
        userId: 'owner-1',
        req,
        agent: {
          glasshive_options: {
            orchestration: {
              worker_profile: 'codex-cli',
              fallback_worker_profile: 'claude-code',
            },
          },
        },
      },
      { executeMainDelegation, logger },
    );

    const output = JSON.parse(
      await delegation._call(
        { title: 'Synthetic mission', instruction: 'Complete it.', resourceClass: 'standard' },
        undefined,
        {
          configurable: {
            requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
          },
          toolCall: { id: 'call-1' },
        },
      ),
    );

    expect(output).toEqual({ status: 'ok', workRef: 'work-a' });
    expect(executeMainDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'owner-1', role: 'USER' },
        args: expect.objectContaining({ profile: 'codex-cli' }),
        fallbackWorkerProfile: 'claude-code',
        invocationId: expect.stringMatching(/^ghbi_[a-f0-9]{64}$/),
      }),
    );
    expect(mainDelegationTurnTruth(req)).toMatchObject({ confirmedCount: 1 });
  });

  test('admits and forwards exact files through the same provider-independent facade', async () => {
    const delegation = createGlassHiveMainDelegationTool(
      { userId: 'owner-1' },
      { executeMainDelegation, logger },
    );
    const args = {
      title: 'Read original',
      instruction: 'Compare the original attachment.',
      resourceClass: 'standard' as const,
      fileIds: ['11111111-1111-4111-8111-111111111111'],
    };
    expect(delegation.schema.safeParse(args).success).toBe(true);
    expect(delegation.schema.safeParse({ ...args, fileIds: [] }).success).toBe(true);
    for (const fileIds of [
      [''],
      [' spaced'],
      ['duplicate', 'duplicate'],
      [42],
      ['x'.repeat(257)],
      Array.from({ length: 65 }, (_, i) => String(i)),
    ]) {
      expect(delegation.schema.safeParse({ ...args, fileIds }).success).toBe(false);
    }
    await delegation.invoke(args, {
      configurable: {
        requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      },
    });
    expect(executeMainDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ fileIds: args.fileIds }),
      }),
    );
  });

  test('blocks execution when trusted turn identity is absent', async () => {
    const delegation = createGlassHiveMainDelegationTool(
      { userId: 'owner-1', req: { user: { role: 'USER' } } },
      { executeMainDelegation, logger },
    );

    expect(
      JSON.parse(
        await delegation.invoke({
          title: 'Synthetic mission',
          instruction: 'Complete it.',
          resourceClass: 'standard',
        }),
      ),
    ).toEqual({
      status: 'blocked',
      reason: 'delegation_identity_unavailable',
      tool: DELEGATION_TOOL_NAME,
    });
    expect(executeMainDelegation).not.toHaveBeenCalled();
  });
});
