import { DELEGATION_TOOL_NAME, mainDelegationTurnTruth } from './conversationOrchestration';
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
    expect(definitions[0].parameters.required).toContain('resourceClass');

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
        args: expect.objectContaining({ profile: 'claude-code' }),
        fallbackWorkerProfile: 'claude-code',
        invocationId: expect.stringMatching(/^ghbi_[a-f0-9]{64}$/),
      }),
    );
    expect(mainDelegationTurnTruth(req)).toMatchObject({ confirmedCount: 1 });
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
