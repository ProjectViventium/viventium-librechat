const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
const { DELEGATION_TOOL_NAME } = require('../GlassHiveConversationOrchestration');

describe('GlassHive native orchestration operation tokens', () => {
  const originalEnv = process.env;
  const nowMs = 1_800_000_000_000;
  const baseGrant = Object.freeze({
    grant_id: 'ghcb_native_turn_1',
    user_id: 'owner-1',
    user_role: 'USER',
    conversation_id: 'conversation-1',
    message_id: 'message-1',
    turn_id: 'turn-1',
    authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
    exp: Math.floor(nowMs / 1000) + 600,
  });
  const args = Object.freeze({
    title: ' Mission A ',
    instruction: ' Keep the exact evidence. ',
    sourceOrdinals: [2, 1, 2],
    ownerId: 'model-forged-owner',
    operationId: 'model-forged-operation',
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

  test('binds one short-lived token to the signed turn and canonical mutation arguments', () => {
    const {
      NATIVE_OPERATION_TOKEN_FIELD,
      prepareNativeOrchestrationOperation,
      verifyNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');

    const prepared = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    expect(prepared).toMatchObject({
      status: 'prepared',
      tool: DELEGATION_TOOL_NAME,
      retryable: true,
      expiresAt: Math.floor(nowMs / 1000) + 120,
    });
    expect(prepared[NATIVE_OPERATION_TOKEN_FIELD]).toEqual(expect.any(String));

    const verified = verifyNativeOrchestrationOperation({
      token: prepared[NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args: {
        title: 'Mission A',
        instruction: 'Keep the exact evidence.',
        sourceOrdinals: [1, 2],
        ignored: 'canonical arguments deliberately ignore me',
      },
      nowMs: nowMs + 1_000,
    });
    const replay = verifyNativeOrchestrationOperation({
      token: prepared[NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 2_000,
    });
    const decodedEnvelope = JSON.parse(
      Buffer.from(prepared[NATIVE_OPERATION_TOKEN_FIELD], 'base64url').toString('utf8'),
    );
    const semanticallyIdenticalEnvelope = Buffer.from(
      JSON.stringify(
        {
          tag: decodedEnvelope.tag,
          version: decodedEnvelope.version,
          ciphertext: decodedEnvelope.ciphertext,
          algorithm: decodedEnvelope.algorithm,
          iv: decodedEnvelope.iv,
        },
        null,
        2,
      ),
      'utf8',
    ).toString('base64url');
    const reserializedReplay = verifyNativeOrchestrationOperation({
      token: semanticallyIdenticalEnvelope,
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 2_000,
    });
    expect(verified.invocationId).toMatch(/^ghno_[a-f0-9]{64}$/);
    expect(replay.invocationId).toBe(verified.invocationId);
    expect(reserializedReplay.invocationId).toBe(verified.invocationId);
    expect(verified.args).toEqual({
      title: 'Mission A',
      instruction: 'Keep the exact evidence.',
      sourceOrdinals: [1, 2],
    });

    const decoded = decodedEnvelope;
    expect(decoded).toMatchObject({
      version: 2,
      algorithm: 'A256GCM',
      iv: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      ciphertext: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      tag: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    });
    const visibleEnvelope = JSON.stringify(decoded);
    for (const privateClaim of [
      'owner-1',
      'USER',
      'conversation-1',
      'message-1',
      'turn-1',
      DELEGATION_TOOL_NAME,
    ]) {
      expect(visibleEnvelope).not.toContain(privateClaim);
    }
    expect(Object.keys(decoded).sort()).toEqual([
      'algorithm',
      'ciphertext',
      'iv',
      'tag',
      'version',
    ]);
  });

  test('rejects tampering, expiry, changed canonical args, and every changed signed turn scope', () => {
    const {
      NATIVE_OPERATION_TOKEN_FIELD,
      prepareNativeOrchestrationOperation,
      verifyNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');
    const prepared = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    const token = prepared[NATIVE_OPERATION_TOKEN_FIELD];
    const expectBindingFailure = (overrides) =>
      expect(() =>
        verifyNativeOrchestrationOperation({
          token,
          grant: baseGrant,
          toolName: DELEGATION_TOOL_NAME,
          args,
          nowMs: nowMs + 1_000,
          ...overrides,
        }),
      ).toThrow('orchestration_operation_token_binding_mismatch');

    expectBindingFailure({ args: { ...args, instruction: 'Changed objective.' } });
    expectBindingFailure({ grant: { ...baseGrant, user_id: 'owner-2' } });
    expectBindingFailure({ grant: { ...baseGrant, user_role: 'ADMIN' } });
    expectBindingFailure({ grant: { ...baseGrant, conversation_id: 'conversation-2' } });
    expectBindingFailure({ grant: { ...baseGrant, message_id: 'message-2' } });
    expectBindingFailure({ grant: { ...baseGrant, turn_id: 'turn-2' } });
    expectBindingFailure({ toolName: 'active_work_action' });

    expect(() =>
      verifyNativeOrchestrationOperation({
        token,
        grant: baseGrant,
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs: nowMs + 121_000,
      }),
    ).toThrow('orchestration_operation_token_expired');

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.ciphertext = `${decoded.ciphertext.slice(0, -1)}${
      decoded.ciphertext.endsWith('A') ? 'B' : 'A'
    }`;
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() =>
      verifyNativeOrchestrationOperation({
        token: tampered,
        grant: baseGrant,
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs: nowMs + 1_000,
      }),
    ).toThrow('orchestration_operation_token_invalid');

    const typeChangedEnvelope = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    typeChangedEnvelope.version = String(typeChangedEnvelope.version);
    expect(() =>
      verifyNativeOrchestrationOperation({
        token: Buffer.from(JSON.stringify(typeChangedEnvelope), 'utf8').toString('base64url'),
        grant: baseGrant,
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs: nowMs + 1_000,
      }),
    ).toThrow('orchestration_operation_token_invalid');
  });

  test('mints distinct operation identities for intentional identical calls', () => {
    const {
      NATIVE_OPERATION_TOKEN_FIELD,
      prepareNativeOrchestrationOperation,
      verifyNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');
    const first = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    const second = prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });

    expect(second[NATIVE_OPERATION_TOKEN_FIELD]).not.toBe(first[NATIVE_OPERATION_TOKEN_FIELD]);
    const firstCommit = verifyNativeOrchestrationOperation({
      token: first[NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 1_000,
    });
    const secondCommit = verifyNativeOrchestrationOperation({
      token: second[NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 1_000,
    });
    expect(secondCommit.invocationId).not.toBe(firstCommit.invocationId);
  });

  test('verifies and replays the same opaque token after a stateless module restart', () => {
    const firstModule = require('../GlassHiveNativeOrchestrationOperation');
    const prepared = firstModule.prepareNativeOrchestrationOperation({
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs,
    });
    const beforeRestart = firstModule.verifyNativeOrchestrationOperation({
      token: prepared[firstModule.NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 1_000,
    });

    jest.resetModules();
    const restartedModule = require('../GlassHiveNativeOrchestrationOperation');
    const afterRestart = restartedModule.verifyNativeOrchestrationOperation({
      token: prepared[firstModule.NATIVE_OPERATION_TOKEN_FIELD],
      grant: baseGrant,
      toolName: DELEGATION_TOOL_NAME,
      args,
      nowMs: nowMs + 2_000,
    });

    expect(afterRestart.invocationId).toBe(beforeRestart.invocationId);
    expect(afterRestart.operationId).toBe(beforeRestart.operationId);
    expect(afterRestart.args).toEqual(beforeRestart.args);
  });

  test('fails closed for mission-root authority and incomplete signed turn scope', () => {
    const {
      prepareNativeOrchestrationOperation,
    } = require('../GlassHiveNativeOrchestrationOperation');

    expect(() =>
      prepareNativeOrchestrationOperation({
        grant: { ...baseGrant, authority_kind: BROKER_AUTHORITY_KINDS.MISSION_WORKER },
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs,
      }),
    ).toThrow('orchestration_operation_authority_required');
    expect(() =>
      prepareNativeOrchestrationOperation({
        grant: { ...baseGrant, message_id: '' },
        toolName: DELEGATION_TOOL_NAME,
        args,
        nowMs,
      }),
    ).toThrow('orchestration_operation_scope_unavailable');
  });
});
