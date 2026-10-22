import { createForegroundAttentionControl } from './foregroundAttention';
import { nativeResponseOrigin } from './nativeResponse';

describe('exact Telegram foreground attention', () => {
  function harness() {
    let now = 1_000_000;
    const identity = {
      userId: 'owner-a',
      conversationId: 'conversation-a',
      responseMessageId: 'answer-a',
      streamId: 'stream-a',
      jobCreatedAt: 1,
      logicalTurnId: 'turn-a',
      revision: 1,
      sourceOrderScope: 'a'.repeat(64),
      sourceSequence: 1,
      deliveryContext: { surface: 'telegram' as const, authenticated: true, audioRequested: false },
      invocationId: 'invocation-a',
      bodySha256: 'b'.repeat(64),
      providerId: 'provider-a',
      agentId: 'agent-a',
      originSha256: nativeResponseOrigin('http://native.test/v1'),
      source: { id: 'source-a', messageId: 'question-a', digest: 'c'.repeat(64) },
      admittedAt: 1,
      recoverUntil: 86_400_001,
      status: 'failed' as const,
      terminalSnapshotStoredAt: 100,
    };
    const original = {
      user: 'owner-a',
      conversationId: 'conversation-a',
      messageId: 'answer-a',
      error: true,
      unfinished: false,
      nativeResponse: identity,
    };
    const current = {
      user: 'owner-a',
      conversationId: 'conversation-a',
      messageId: 'new-failure',
      error: true,
      unfinished: false,
      metadata: {
        viventium: { foregroundAttention: { version: 1, responseMessageId: 'answer-a' } },
      },
    };
    const result = {
      state: 'failed',
      request_id: 'request-a',
      failure_class: 'provider_progress_stalled',
      foreground_attention_control: {
        version: 1 as const,
        can_cancel: true,
        capacity_released: false,
      },
    };
    const readMessage = jest.fn(async (_owner: string, id: string) =>
      id === 'answer-a' ? original : current,
    );
    const readNative = jest.fn(async () => original);
    const sourceMatches = jest.fn(async () => true);
    const readResult = jest.fn(async () => result);
    const cancel = jest.fn(async () => ({
      acknowledged: true,
      capacityReleased: true,
      state: 'cancelled',
    }));
    const resolveRoute = jest.fn(async () => ({ baseURL: 'http://native.test/v1', headers: {} }));
    const control = createForegroundAttentionControl({
      readMessage,
      readNative,
      sourceMatches,
      readResult,
      resolveRoute,
      cancel,
      now: () => now,
    });
    const scope = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      sourceOrderScope: 'a'.repeat(64),
      responseMessageId: 'new-failure',
    };
    return {
      control,
      scope,
      original,
      current,
      identity,
      result,
      cancel,
      sourceMatches,
      readNative,
      resolveRoute,
      setNow: (value: number) => {
        now = value;
      },
    };
  }

  it('resolves a saved error reference after restart and cancels only its exact native request', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    expect(proof).toMatchObject({ version: 1, action: 'cancel', responseMessageId: 'new-failure' });
    expect(proof.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'operation-a' }),
    ).toMatchObject({ state: 'cancelled', capacityReleased: true });
    expect(h.cancel).toHaveBeenCalledWith(h.identity, h.result, expect.any(Object));
  });

  it.each([
    'owner',
    'conversation',
    'scope',
    'source',
    'snapshot',
    'proof',
    'replacement',
    'origin',
    'expired',
  ])('rejects %s proof without cancellation', async (guard) => {
    const h = harness();
    if (guard === 'owner') h.scope.ownerId = 'other-owner';
    if (guard === 'conversation') h.scope.conversationId = 'other-conversation';
    if (guard === 'scope') h.scope.sourceOrderScope = 'd'.repeat(64);
    if (guard === 'source') h.sourceMatches.mockResolvedValue(false);
    if (guard === 'snapshot') h.identity.terminalSnapshotStoredAt = 0;
    if (guard === 'proof')
      delete (h.result as Partial<typeof h.result>).foreground_attention_control;
    if (guard === 'replacement') h.result.foreground_attention_control.can_cancel = false;
    if (guard === 'origin') h.identity.originSha256 = 'd'.repeat(64);
    if (guard === 'expired') h.setNow(h.identity.recoverUntil + 1);
    await expect(h.control.attention(h.scope)).rejects.toThrow();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('revalidates changed source and saved identity after the receipt', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    h.sourceMatches.mockResolvedValue(false);
    await expect(
      h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).rejects.toThrow();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('expires a receipt at the reported boundary', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    h.setNow(Date.parse(proof.expiresAt));
    await expect(
      h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).rejects.toThrow();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('rejects a changed saved native identity after the receipt', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    h.identity.bodySha256 = 'd'.repeat(64);
    await expect(
      h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).rejects.toThrow();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('finishes an exact cancellation whose capacity acknowledgement was interrupted', async () => {
    const h = harness();
    h.result.state = 'cancelled';
    const proof = await h.control.attention(h.scope);
    expect(
      await h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).toMatchObject({ state: 'cancelled', capacityReleased: true });
    expect(h.cancel).toHaveBeenCalledTimes(1);
  });

  it('keeps unconfirmed capacity pending', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    h.cancel.mockRejectedValue(
      Object.assign(new Error('pending'), { capacityReleasePending: true }),
    );
    expect(
      await h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).toMatchObject({ state: 'pending', capacityReleased: false });
  });

  it('acknowledges a repeated cancelled request without touching any runtime', async () => {
    const h = harness();
    const proof = await h.control.attention(h.scope);
    h.result.state = 'cancelled';
    h.result.foreground_attention_control = {
      version: 1,
      can_cancel: false,
      capacity_released: true,
    };
    expect(
      await h.control.cancel(h.scope, { receipt: proof.receipt, operationId: 'op-a' }),
    ).toMatchObject({ state: 'already_cancelled', capacityReleased: true });
    expect(h.cancel).not.toHaveBeenCalled();
  });
});
