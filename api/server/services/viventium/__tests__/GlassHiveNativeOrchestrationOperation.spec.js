const { DELEGATION_TOOL_NAME } = require('../GlassHiveConversationOrchestration');

describe('GlassHive native orchestration operation identity', () => {
  const originalEnv = process.env;
  const nowMs = 1_800_000_000_000;
  const baseGrant = Object.freeze({
    grant_id: 'ghcb_native_turn_1',
    user_id: 'owner-1',
    user_role: 'USER',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    turn_id: 'turn-1',
    authority_kind: 'conversation_orchestrator',
    exp: Math.floor(nowMs / 1000) + 600,
  });
  const args = Object.freeze({
    title: ' Mission A ',
    instruction: ' Keep the exact evidence. ',
    resourceClass: 'standard',
    sourceOrdinals: [2, 1, 2],
  });

  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET: 'native-operation-test-secret',
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('derives one stable HMAC occurrence across grant refreshes', () => {
    const {
      commitNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');

    const first = commitNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
    });
    const replay = commitNativeOrchestrationOperation({
      grant: { ...baseGrant, grant_id: 'ghcb_native_turn_1_refreshed' },
      toolName: DELEGATION_TOOL_NAME,
      args: {
        title: 'Mission A',
        instruction: 'Keep the exact evidence.',
        resourceClass: 'standard',
        sourceOrdinals: [1, 2],
      },
    });
    const changedTurn = commitNativeOrchestrationOperation({
      grant: { ...baseGrant, message_id: 'message-2' },
      toolName: DELEGATION_TOOL_NAME,
      args,
    });

    expect(first).toMatchObject({
      invocationId: expect.stringMatching(/^ghno_[a-f0-9]{64}$/),
      operationId: expect.stringMatching(/^ghno_[a-f0-9]{64}$/),
      args: {
        title: 'Mission A',
        instruction: 'Keep the exact evidence.',
        resourceClass: 'standard',
        sourceOrdinals: [1, 2],
      },
    });
    expect(replay.invocationId).toBe(first.invocationId);
    expect(changedTurn.invocationId).not.toBe(first.invocationId);
  });

  test('accepts a legacy opaque token but converges onto the one-call identity', () => {
    const {
      NATIVE_OPERATION_TOKEN_FIELD,
      commitNativeOrchestrationOperation,
      prepareNativeOrchestrationOperation,
      verifyNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');
    const prepared = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    const refreshedGrant = {
      ...baseGrant,
      grant_id: 'ghcb_native_turn_1_refreshed',
      exp: Math.floor(nowMs / 1000) + 900,
    };

    expect(
      verifyNativeOrchestrationOperation({
        token: prepared[NATIVE_OPERATION_TOKEN_FIELD],
        grant: refreshedGrant,
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs: nowMs + 1_000,
      }),
    ).toEqual(
      commitNativeOrchestrationOperation({
        grant: refreshedGrant,
        toolName: DELEGATION_TOOL_NAME,
        args,
      }),
    );
  });

  test('fails closed for mission authority, incomplete scope, and changed arguments', () => {
    const {
      NATIVE_OPERATION_TOKEN_FIELD,
      commitNativeOrchestrationOperation,
      prepareNativeOrchestrationOperation,
      verifyNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');

    expect(() =>
      commitNativeOrchestrationOperation({
        grant: { ...baseGrant, authority_kind: 'mission_worker' },
        toolName: DELEGATION_TOOL_NAME,
        args,
      }),
    ).toThrow('orchestration_operation_authority_required');
    expect(() =>
      commitNativeOrchestrationOperation({
        grant: { ...baseGrant, message_id: '' },
        toolName: DELEGATION_TOOL_NAME,
        args,
      }),
    ).toThrow('orchestration_operation_scope_unavailable');

    const prepared = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    expect(() =>
      verifyNativeOrchestrationOperation({
        token: prepared[NATIVE_OPERATION_TOKEN_FIELD],
        grant: baseGrant,
        toolName: DELEGATION_TOOL_NAME,
        args: { ...args, instruction: 'Changed objective.' },
        nowMs: nowMs + 1_000,
      }),
    ).toThrow('orchestration_operation_token_binding_mismatch');
  });
});
