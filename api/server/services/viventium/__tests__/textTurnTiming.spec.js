const { logger } = require('@librechat/data-schemas');
const { GraphNodeKeys } = require('@librechat/agents');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
  },
}));

const {
  initializeTextTurnTiming,
  markMainProviderAttemptStart,
  markMainProviderFirstOutput,
  setTextMainRunContext,
} = require('../textTurnTiming');

describe('text turn timing telemetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('correlates first provider output to one hashed turn and distinct Main attempts', () => {
    const req = { body: { viventiumInputMode: 'text' } };
    initializeTextTurnTiming(req, {
      turnId: 'private-message-id',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 1_000,
    });
    setTextMainRunContext(req, { agentCount: 3 });

    const firstMetadata = {
      langgraph_node: `${GraphNodeKeys.AGENT}agent-main`,
      langgraph_step: 1,
      checkpoint_ns: 'agent-main:first',
      __pregel_task_id: 'private-provider-task-1',
      run_id: 'private-root-run',
    };
    const secondMetadata = {
      langgraph_node: `${GraphNodeKeys.AGENT}agent-main`,
      langgraph_step: 3,
      checkpoint_ns: 'agent-main:second',
      __pregel_task_id: 'private-provider-task-2',
      run_id: 'private-root-run',
    };
    markMainProviderAttemptStart(req, firstMetadata, { nowMs: 1_100 });
    expect(markMainProviderAttemptStart(req, firstMetadata, { nowMs: 1_101 })).toBeNull();
    const first = markMainProviderFirstOutput(req, firstMetadata, {
      kind: 'provider_token',
      nowMs: 1_175,
    });
    markMainProviderAttemptStart(req, secondMetadata, { nowMs: 1_400 });
    const second = markMainProviderFirstOutput(req, secondMetadata, {
      kind: 'provider_token',
      nowMs: 1_460,
    });

    expect(first).toEqual(
      expect.objectContaining({
        event: 'viventium_text_main_first_provider_output',
        attemptIndex: 1,
        fromTurnStartMs: 175,
        fromAttemptStartMs: 75,
        outputKind: 'provider_token',
      }),
    );
    expect(second).toEqual(
      expect.objectContaining({
        turnIdHash: first.turnIdHash,
        attemptIndex: 2,
        fromTurnStartMs: 460,
        fromAttemptStartMs: 60,
      }),
    );
    expect(second.invocationId).not.toBe(first.invocationId);

    const serializedLogs = logger.info.mock.calls.flat().join('\n');
    expect(serializedLogs).toContain('viventium_text_main_first_provider_output');
    expect(serializedLogs).not.toContain('private-message-id');
    expect(serializedLogs).not.toContain('private-root-run');
    expect(serializedLogs).not.toContain('private-provider-task');
  });

  it('records each output kind once per attempt without collapsing later graph reentries', () => {
    const req = { body: { viventiumInputMode: 'text' } };
    initializeTextTurnTiming(req, {
      turnId: 'turn-1',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 2_000,
    });
    setTextMainRunContext(req, { agentCount: 2 });
    const metadata = {
      langgraph_node: `${GraphNodeKeys.AGENT}agent-main`,
      langgraph_step: 1,
      checkpoint_ns: 'agent-main:first',
      __pregel_task_id: 'task-main-1',
      run_id: 'root-run',
    };
    markMainProviderAttemptStart(req, metadata, { nowMs: 2_020 });

    expect(
      markMainProviderFirstOutput(req, metadata, {
        kind: 'provider_token',
        nowMs: 2_050,
      }),
    ).not.toBeNull();
    expect(
      markMainProviderFirstOutput(req, metadata, {
        kind: 'provider_token',
        nowMs: 2_060,
      }),
    ).toBeNull();
    expect(
      markMainProviderFirstOutput(req, metadata, {
        kind: 'visible_text_delta',
        nowMs: 2_090,
      }),
    ).toEqual(expect.objectContaining({ outputKind: 'visible_text_delta' }));
  });

  it('ignores non-Main graph nodes and fails closed when multi-agent metadata is ambiguous', () => {
    const req = { body: { viventiumInputMode: 'text' } };
    initializeTextTurnTiming(req, {
      turnId: 'turn-2',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 3_000,
    });
    setTextMainRunContext(req, { agentCount: 4 });

    expect(
      markMainProviderAttemptStart(
        req,
        {
          langgraph_node: `${GraphNodeKeys.AGENT}agent-consultant`,
          langgraph_step: 2,
          __pregel_task_id: 'task-consultant',
          run_id: 'root-run',
        },
        { nowMs: 3_010 },
      ),
    ).toBeNull();
    expect(markMainProviderAttemptStart(req, {}, { nowMs: 3_020 })).toBeNull();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('uses the single configured agent as a structured fallback when node metadata is absent', () => {
    const req = { body: { viventiumInputMode: 'text' } };
    initializeTextTurnTiming(req, {
      turnId: 'turn-3',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 4_000,
    });
    setTextMainRunContext(req, { agentCount: 1 });

    const attempt = markMainProviderAttemptStart(req, { run_id: 'run-only' }, { nowMs: 4_010 });
    expect(attempt).toEqual(expect.objectContaining({ attemptIndex: 1 }));
  });

  it('does not initialize text telemetry for voice input', () => {
    const req = { body: { voiceMode: true, viventiumInputMode: 'voice_call' } };
    expect(
      initializeTextTurnTiming(req, {
        turnId: 'turn-voice',
        mainAgentId: 'agent-main',
        turnStartedAtMs: 5_000,
      }),
    ).toBeNull();
    expect(req._viventiumTextTurnTiming).toBeUndefined();
  });
});
