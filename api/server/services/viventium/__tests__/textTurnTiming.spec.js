const { logger } = require('@librechat/data-schemas');
const { GraphNodeKeys } = require('@librechat/agents');

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
  },
}));

const {
  initializeTextTurnTiming,
  markTextTurnBoundary,
  markMainProviderAttemptStart,
  markMainProviderFirstOutput,
  recordNativeProviderRequestAccepted,
  setTextMainNativeRequestAuthority,
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

  it('binds one exact native provider request receipt to the winning Main output', () => {
    const capsule = '\n<viventium_feeling_state>steady and curious</viventium_feeling_state>\n';
    const instructions = `\nMain authority\n\n${capsule}`;
    const req = {
      body: { viventiumInputMode: 'text' },
      _viventiumFeelingSnapshot: {
        enabled: true,
        snapshotHash: 'a'.repeat(64),
        capsule,
      },
    };
    initializeTextTurnTiming(req, {
      turnId: 'turn-native-receipt',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 6_000,
    });
    setTextMainRunContext(req, { agentCount: 2 });
    setTextMainNativeRequestAuthority(req, {
      instructions,
      provider: 'codex-cli',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    });
    const metadata = {
      langgraph_node: `${GraphNodeKeys.AGENT}agent-main`,
      langgraph_step: 1,
      checkpoint_ns: 'agent-main:native',
      __pregel_task_id: 'task-main-native',
      run_id: 'root-run-native',
      ls_provider: 'openai',
      ls_model_name: 'gpt-5.6-sol',
    };
    markMainProviderAttemptStart(req, metadata, { nowMs: 6_010 });

    const accepted = recordNativeProviderRequestAccepted(
      req,
      {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        status: 200,
        request: {
          model: 'gpt-5.6-terra',
          instructions: instructions.trim(),
          input: [{ role: 'user', content: 'private user text' }],
        },
      },
      { nowMs: 6_025 },
    );
    markMainProviderFirstOutput(req, metadata, {
      kind: 'provider_token',
      nowMs: 6_040,
    });

    expect(accepted).toEqual(
      expect.objectContaining({
        event: 'viventium_text_main_native_provider_request_accepted',
        provider: 'openai',
        model: 'gpt-5.6-terra',
        status: 200,
        snapshotHash: 'a'.repeat(64),
        capsuleOccurrenceCount: 1,
        mainInstructionOccurrenceCount: 1,
        eligibleForMainReceipt: true,
      }),
    );
    const events = logger.info.mock.calls
      .map(([line]) => JSON.parse(line.slice(line.indexOf('{'))))
      .filter((event) => event.event === 'viventium_text_main_winning_native_provider_receipt');
    expect(events).toEqual([
      expect.objectContaining({
        invocationId: accepted.invocationId,
        receiptRef: accepted.receiptRef,
        provider: 'openai',
        snapshotHash: 'a'.repeat(64),
        capsuleOccurrenceCount: 1,
        mainInstructionOccurrenceCount: 1,
        outputKind: 'provider_token',
      }),
    ]);
    const serializedLogs = logger.info.mock.calls.flat().join('\n');
    expect(serializedLogs).not.toContain('private user text');
    expect(serializedLogs).not.toContain('steady and curious');
  });

  it('does not create a winning receipt for a request missing the exact Main instructions', () => {
    const capsule = '<viventium_feeling_state>steady</viventium_feeling_state>';
    const req = {
      body: { viventiumInputMode: 'text' },
      _viventiumFeelingSnapshot: {
        enabled: true,
        snapshotHash: 'b'.repeat(64),
        capsule,
      },
    };
    initializeTextTurnTiming(req, {
      turnId: 'turn-native-rejected',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 7_000,
    });
    setTextMainRunContext(req, { agentCount: 1 });
    setTextMainNativeRequestAuthority(req, {
      instructions: `Main authority\n\n${capsule}`,
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
    const metadata = { run_id: 'single-main', ls_provider: 'anthropic' };
    markMainProviderAttemptStart(req, metadata, { nowMs: 7_010 });
    const accepted = recordNativeProviderRequestAccepted(
      req,
      {
        provider: 'anthropic',
        model: 'claude-opus-5',
        status: 200,
        request: { system: capsule, messages: [] },
      },
      { nowMs: 7_020 },
    );
    markMainProviderFirstOutput(req, metadata, { nowMs: 7_030 });

    expect(accepted.eligibleForMainReceipt).toBe(false);
    expect(logger.info.mock.calls.flat().join('\n')).not.toContain(
      'viventium_text_main_winning_native_provider_receipt',
    );
  });

  it('accepts a strict late GlassHive native-authority receipt for the winning Main output', () => {
    const capsule = '<viventium_feeling_state>steady</viventium_feeling_state>';
    const instructions = `Main authority\n\n${capsule}`;
    const req = {
      body: { viventiumInputMode: 'text' },
      _viventiumFeelingSnapshot: {
        enabled: true,
        snapshotHash: 'c'.repeat(64),
        capsule,
      },
    };
    initializeTextTurnTiming(req, {
      turnId: 'turn-glasshive-native-receipt',
      mainAgentId: 'agent-main',
      turnStartedAtMs: 8_000,
    });
    setTextMainRunContext(req, { agentCount: 1 });
    setTextMainNativeRequestAuthority(req, {
      instructions,
      provider: 'openAI',
      model: 'codex-cli:gpt-5.6-sol',
    });
    const metadata = { run_id: 'single-main-glasshive' };
    markMainProviderAttemptStart(req, metadata, { nowMs: 8_010 });
    markMainProviderFirstOutput(req, metadata, {
      kind: 'visible_text_delta',
      nowMs: 8_020,
    });

    const accepted = recordNativeProviderRequestAccepted(
      req,
      {
        provider: 'glasshive',
        model: 'gpt-5.6-terra',
        status: 200,
        instructionAuthority: instructions,
        nativeRequestSha256: 'd'.repeat(64),
        authorityReceipt: {
          protocol: 'glasshive.native_provider_authority_receipt.v1',
          run_id: 'run-native-1',
          runtime: 'codex-cli',
          model: 'gpt-5.6-terra',
          authority_sha256: require('crypto')
            .createHash('sha256')
            .update(instructions, 'utf8')
            .digest('hex'),
          authority_chars: Array.from(instructions).length,
          feeling_capsule_count: 1,
          placement: 'codex_developer_instructions',
          materialized: true,
        },
      },
      { nowMs: 8_030 },
    );

    expect(accepted).toEqual(
      expect.objectContaining({
        eligibleForMainReceipt: true,
        capsuleOccurrenceCount: 1,
        mainInstructionOccurrenceCount: 1,
        nativeRequestSha256: 'd'.repeat(64),
      }),
    );
    const winning = logger.info.mock.calls
      .map(([line]) => JSON.parse(line.slice(line.indexOf('{'))))
      .filter((event) => event.event === 'viventium_text_main_winning_native_provider_receipt');
    expect(winning).toHaveLength(1);
    expect(winning[0]).toEqual(
      expect.objectContaining({
        receiptRef: accepted.receiptRef,
        outputKind: 'visible_text_delta',
        snapshotHash: 'c'.repeat(64),
      }),
    );
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

  it('records each allowlisted turn boundary once without exposing raw identities', () => {
    const req = { body: { viventiumInputMode: 'text' } };
    initializeTextTurnTiming(req, {
      turnId: 'private-boundary-message-id',
      mainAgentId: 'private-main-agent-id',
      turnStartedAtMs: 9_000,
    });

    expect(markTextTurnBoundary(req, 'controller_admission', { nowMs: 9_010 })).toEqual(
      expect.objectContaining({
        event: 'viventium_text_turn_boundary',
        stage: 'controller_admission',
        observedAtMs: 9_010,
        fromTurnStartMs: 10,
      }),
    );
    expect(markTextTurnBoundary(req, 'controller_admission', { nowMs: 9_011 })).toBeNull();
    expect(markTextTurnBoundary(req, 'raw_message_saved', { nowMs: 9_012 })).toBeNull();
    expect(markTextTurnBoundary(req, 'concurrency_admitted', { nowMs: 9_020 })).toEqual(
      expect.objectContaining({ stage: 'concurrency_admitted' }),
    );

    const serializedLogs = logger.info.mock.calls.flat().join('\n');
    expect(serializedLogs).not.toContain('private-boundary-message-id');
    expect(serializedLogs).not.toContain('private-main-agent-id');
    expect(serializedLogs).not.toContain('raw_message_saved');
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
