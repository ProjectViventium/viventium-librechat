/* eslint-disable jest/no-export -- Shared contract helper excluded from test discovery. */
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { IJobStore } from '../interfaces/IJobStore';

const digest = 'a'.repeat(64);
const scope = 'b'.repeat(64);
export async function admitted(store: IJobStore, streamId = 'stream-a', ordered = true) {
  if (ordered) await store.observeSourceOrder?.({ source_order_scope: scope, source_sequence: 1 });
  const claim = await store.claimLogicalTurn(streamId, 'owner', {
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'web',
    conversation_id: 'conversation',
    revision: 1,
    source_event_id: streamId,
    ...(ordered ? { source_order_scope: scope, source_sequence: 1 } : {}),
  });
  const job = await store.createJob(streamId, 'owner', 'conversation', {
    responseMessageId: 'assistant',
    interactionContext: claim.interactionContext,
    userMessage: { messageId: 'source' },
  });
  const admittedAt = Date.now();
  const identity: NativeResponseIdentity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'assistant',
    streamId,
    jobCreatedAt: job.createdAt,
    logicalTurnId: claim.interactionContext.logical_turn_id!,
    revision: claim.interactionContext.revision,
    sourceOrderScope: ordered ? scope : undefined,
    sourceSequence: ordered ? 1 : undefined,
    invocationId: 'invocation',
    bodySha256: digest,
    providerId: 'provider',
    agentId: 'agent',
    originSha256: digest,
    source: { id: 'source-db-id', messageId: 'source', digest },
    admittedAt,
    recoverUntil: admittedAt + 86_400_000,
  };
  return { identity, job };
}

export function nativeStoreContract(factory: () => IJobStore, clock = false) {
  let store: IJobStore;
  beforeEach(() => {
    store = factory();
  });
  afterEach(async () => {
    await store?.destroy();
    jest.useRealTimers();
  });
  test('identity-fenced updates reject a stale incarnation and accept the exact native owner', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    const ack = { logical_turn_id: identity.logicalTurnId!, revision: identity.revision!, state: 'partial_removed' as const, presentation_ref: identity.responseMessageId };
    await store.updateJob(identity.streamId, { deliveryAcknowledgement: ack }, { ...identity, jobCreatedAt: identity.jobCreatedAt + 1 });
    expect((await store.getJob(identity.streamId))?.deliveryAcknowledgement).toBeUndefined();
    await store.updateJob(identity.streamId, { deliveryAcknowledgement: ack }, identity);
    expect((await store.getJob(identity.streamId))?.deliveryAcknowledgement).toEqual(ack);
  });
  test('BSON-null absent facts preserve one bound publication and its exact replay', async () => {
    const { identity } = await admitted(store, 'unordered-stream', false);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    const restored = {
      ...identity,
      sourceOrderScope: null,
      sourceSequence: null,
      deliveryDispositionRequired: null,
      deliveryContext: null,
    } as unknown as NativeResponseIdentity;
    expect(await store.bindNativeResponse(restored)).toBe(true);
    expect(await store.commitNativeResponse(restored, digest)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
    const finalEvent = JSON.stringify({
      final: true,
      responseMessage: { messageId: 'assistant', text: 'The original saved answer.' },
    });
    expect(await store.finishNativeResponse(restored, digest, finalEvent)).toBe(true);
    expect((await store.getJob(identity.streamId))?.finalEvent).toBe(finalEvent);
    expect(await store.getNativeResponseCommit(identity)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
    expect(await store.bindNativeResponse({ ...restored, sourceSequence: 0 })).toBe(false);
    expect(
      await store.bindNativeResponse({ ...restored, deliveryDispositionRequired: false }),
    ).toBe(false);
    expect(await store.bindNativeResponse({ ...restored, agentId: 'another' })).toBe(false);
    expect(await store.finishNativeResponse(restored, 'f'.repeat(64), finalEvent)).toBe(false);
  });
  test('bind is exact and cannot replace an invocation or owner', async () => {
    const { identity } = await admitted(store);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    expect(await store.bindNativeResponse({ ...identity })).toBe(true);
    expect(await store.bindNativeResponse({ ...identity, invocationId: 'other' })).toBe(false);
    expect(await store.bindNativeResponse({ ...identity, userId: 'foreign' })).toBe(false);
    expect(await store.bindNativeResponse({ ...identity, deliveryDispositionRequired: true })).toBe(
      false,
    );
    expect(
      await store.bindNativeResponse({ ...identity, deliveryContext: { surface: 'voice' } }),
    ).toBe(false);
  });
  test('direct parent proof is exact across binding, restart reads and publication', async () => {
    const { identity } = await admitted(store);
    const parent = { id: 'parent-db-id', messageId: 'prior', digest: 'd'.repeat(64) };
    identity.source = { ...identity.source, parent };
    expect(await store.bindNativeResponse(identity)).toBe(true);
    expect((await store.getJob(identity.streamId))?.nativeResponse?.source.parent).toEqual(parent);
    expect(
      await store.bindNativeResponse({
        ...identity,
        source: {
          ...identity.source,
          parent: { digest: parent.digest, messageId: parent.messageId, id: parent.id },
        },
      }),
    ).toBe(true);
    for (const changed of [
      { ...parent, id: 'replacement' },
      { ...parent, messageId: 'other' },
      { ...parent, digest: 'e'.repeat(64) },
      undefined,
    ]) {
      expect(
        await store.bindNativeResponse({
          ...identity,
          source: { ...identity.source, parent: changed },
        }),
      ).toBe(false);
    }
    expect(await store.commitNativeResponse(identity, digest)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
    expect(await store.finishNativeResponse(identity, digest, '{"final":true}')).toBe(true);
  });
  test('malformed parent evidence cannot bind a native request', async () => {
    const { identity } = await admitted(store);
    for (const parent of [
      { id: '', messageId: 'prior', digest },
      { id: 'id', messageId: '', digest },
      { id: 'id', messageId: 'prior', digest: 'bad' },
    ]) {
      expect(
        await store.bindNativeResponse({ ...identity, source: { ...identity.source, parent } }),
      ).toBe(false);
    }
    expect(await store.bindNativeResponse(identity)).toBe(true);
  });
  test('delivery context persists exactly across stores and cannot change authority', async () => {
    const { identity } = await admitted(store);
    identity.deliveryContext = { surface: 'telegram', authenticated: true, audioRequested: false };
    expect(await store.bindNativeResponse(identity)).toBe(true);
    expect((await store.getJob(identity.streamId))?.nativeResponse?.deliveryContext).toEqual(
      identity.deliveryContext,
    );
    expect(
      await store.bindNativeResponse({
        ...identity,
        deliveryContext: { surface: 'telegram', audioRequested: false, authenticated: true },
      }),
    ).toBe(true);
    expect(
      await store.bindNativeResponse({
        ...identity,
        deliveryContext: { surface: 'telegram', audioRequested: true, authenticated: true },
      }),
    ).toBe(false);
    expect(
      await store.bindNativeResponse({
        ...identity,
        deliveryContext: { surface: 'telegram', audioRequested: false, authenticated: false },
      }),
    ).toBe(false);
  });
  test('Stop before admission irreversibly fences later dispatch', async () => {
    const { identity, job } = await admitted(store);
    expect(await store.cancelNativeResponse(job)).toEqual({ status: 'revoked' });
    expect(await store.bindNativeResponse(identity)).toBe(false);
    expect(await store.commitNativeResponse(identity, digest)).not.toMatchObject({
      status: 'committed',
    });
  });
  test('Stop wins against a prepared candidate without reviving on another bind', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    expect(await store.revokeNativeResponse(identity)).toEqual({ status: 'revoked' });
    expect(await store.revokeNativeResponse(identity)).toEqual({ status: 'revoked' });
    expect(await store.bindNativeResponse(identity)).toBe(false);
    expect(await store.commitNativeResponse(identity, digest)).toEqual({ status: 'revoked' });
  });
  test('commit is immutable; later source revocation returns its winner', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    const winner = { status: 'committed', candidateSha256: digest };
    expect(await store.commitNativeResponse(identity, digest)).toEqual(winner);
    expect(await store.commitNativeResponse(identity, digest)).toEqual(winner);
    expect(await store.commitNativeResponse(identity, 'c'.repeat(64))).toEqual({
      status: 'revoked',
    });
    expect(await store.revokeNativeResponse(identity)).toEqual(winner);
    expect(await store.revokeNativeResponse(identity)).toEqual(winner);
  });
  test('new source watermark prevents unpublished stale work', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.observeSourceOrder?.({ source_order_scope: scope, source_sequence: 2 });
    expect(await store.commitNativeResponse(identity, digest)).toEqual({ status: 'revoked' });
  });
  test('committed receipt survives a later completed logical turn', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, digest);
    await store.finishNativeResponse(identity, digest, '{"final":true}');
    await store.completeLogicalTurn(identity.streamId);
    await admitted(store, 'stream-b');
    expect(await store.revokeNativeResponse(identity)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
  });
  test('explicit assistant retirement removes only its exact replay and preserves publication history', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, digest);
    await store.finishNativeResponse(identity, digest, '{"final":true}');
    await store.deleteJob(identity.streamId, { ...identity, invocationId: 'foreign' });
    expect(await store.getJob(identity.streamId)).not.toBeNull();
    await store.deleteJob(identity.streamId, identity);
    await store.deleteJob(identity.streamId, identity);
    expect(await store.getJob(identity.streamId)).toBeNull();
    expect(await store.getNativeResponseCommit(identity)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
    expect(await store.finishNativeResponse(identity, digest, '{"final":true}')).toBe(false);
  });
  test('replacement same-stream incarnation cannot inherit native authority', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.createJob(identity.streamId, 'owner', 'conversation', {
      responseMessageId: 'replacement',
    });
    expect(await store.bindNativeResponse(identity)).toBe(false);
    expect(await store.commitNativeResponse(identity, digest)).not.toMatchObject({
      status: 'committed',
    });
    expect((await store.getJob(identity.streamId))?.nativeResponse).toBeUndefined();
  });
  test('retains native candidate through transport error and all cleanup paths', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.updateJob(identity.streamId, { status: 'error', completedAt: Date.now() });
    await store.deleteJob(identity.streamId);
    await store.cleanup();
    expect((await store.getJob(identity.streamId))?.nativeResponse).toEqual(identity);
    expect(await store.getRunningJobs()).toEqual([]);
    expect(await store.getJobCountByStatus('running')).toBe(0);
    expect(await store.commitNativeResponse(identity, digest)).toEqual({
      status: 'committed',
      candidateSha256: digest,
    });
  });
  test('explicit unsupported settlement releases only its revoked binding and keeps ordinary completion', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(false);
    await store.revokeNativeResponse(identity);
    expect(
      await store.settleNativeResponse({ ...identity, invocationId: 'other' }, 'unsupported'),
    ).toBe(false);
    expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(true);
    expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(true);
    expect((await store.getJob(identity.streamId))?.nativeResponse).toBeUndefined();
    expect(await store.getNativeResponseCommit(identity)).toEqual({ status: 'revoked' });
    await store.updateJob(identity.streamId, {
      finalEvent: 'ordinary graph answer',
      status: 'complete',
    });
    expect((await store.getJob(identity.streamId))?.finalEvent).toBe('ordinary graph answer');
    await store.deleteJob(identity.streamId);
    expect(await store.getJob(identity.streamId)).toBeNull();
  });
  test('unsupported release cannot erase a finished Stop or affect a replacement', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.cancelNativeResponse((await store.getJob(identity.streamId))!);
    await store.finishNativeResponse(identity, '', 'stop', 'cancelled');
    expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(false);
    expect((await store.getJob(identity.streamId))?.finalEvent).toBe('stop');
    await store.createJob(identity.streamId, 'owner', 'conversation', {
      responseMessageId: 'replacement',
    });
    expect(await store.settleNativeResponse(identity, 'unsupported')).toBe(false);
    expect((await store.getJob(identity.streamId))?.responseMessageId).toBe('replacement');
  });
  test('revoked terminal FINAL settles once without authorizing normal completion', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    const final = JSON.stringify({
      final: true,
      responseMessage: { error: true, unfinished: false },
    });
    expect(await store.settleNativeResponse(identity, 'cancelled')).toBe(false);
    await store.cancelNativeResponse((await store.getJob(identity.streamId))!);
    expect(await store.settleNativeResponse(identity, 'cancelled')).toBe(false);
    expect(await store.finishNativeResponse(identity, '', final, 'cancelled')).toBe(true);
    expect(await store.settleNativeResponse(identity)).toBe(false);
    expect(await store.settleNativeResponse(identity, 'cancelled')).toBe(true);
    expect(await store.settleNativeResponse(identity, 'cancelled')).toBe(true);
    expect(await store.getNativeResponseCommit(identity)).toEqual({ status: 'revoked' });
    expect(await store.getJob(identity.streamId)).toMatchObject({
      nativeResponseSettled: true,
      finalEvent: final,
    });
    await store.deleteJob(identity.streamId, identity);
    expect(await store.settleNativeResponse(identity, 'cancelled')).toBe(false);
  });
  test('cancelled native Stop keeps one immutable FINAL through cleanup and rejects normal completion', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(false);
    const bound = await store.getJob(identity.streamId);
    expect(await store.cancelNativeResponse(bound!)).toEqual({ status: 'revoked' });
    await store.deleteJob(identity.streamId);
    await store.cleanup();
    expect((await store.getJob(identity.streamId))?.nativeResponse).toEqual(identity);
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(true);
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(true);
    expect(await store.finishNativeResponse(identity, '', 'changed', 'cancelled')).toBe(false);
    expect(await store.finishNativeResponse(identity, digest, 'stop')).toBe(false);
    expect(await store.getJob(identity.streamId)).toMatchObject({
      status: 'aborted',
      finalEvent: 'stop',
      nativeResponseFinished: true,
    });
    await store.updateJob(identity.streamId, { status: 'running', finalEvent: 'late answer' });
    expect(await store.getJob(identity.streamId)).toMatchObject({
      status: 'aborted',
      finalEvent: 'stop',
    });
    await store.deleteJob(identity.streamId, identity);
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(false);
  });
  test('same-stream replacement cannot inherit a cancelled FINAL or accept its late finish', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.cancelNativeResponse((await store.getJob(identity.streamId))!);
    await store.finishNativeResponse(identity, '', 'stop', 'cancelled');
    await store.createJob(identity.streamId, 'owner', 'conversation', {
      responseMessageId: 'replacement',
    });
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(false);
    expect(await store.getJob(identity.streamId)).toMatchObject({
      responseMessageId: 'replacement',
      status: 'running',
    });
    expect((await store.getJob(identity.streamId))?.finalEvent).toBeUndefined();
  });
  test('a cancelled finish cannot overwrite a committed winner', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, digest);
    expect(await store.finishNativeResponse(identity, '', 'stop', 'cancelled')).toBe(false);
    expect(await store.finishNativeResponse(identity, digest, 'answer')).toBe(true);
    expect((await store.getJob(identity.streamId))?.finalEvent).toBe('answer');
  });
  test('late logical cleanup uses the captured revision instead of a replacement sharing its stream', async () => {
    const { identity } = await admitted(store);
    const next = await store.claimLogicalTurn(identity.streamId, 'owner', {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'conversation',
      revision: 2,
      source_event_id: 'new-source',
      source_order_scope: scope,
      source_sequence: 1,
    });
    await store.createJob(identity.streamId, 'owner', 'conversation', {
      responseMessageId: 'replacement',
      interactionContext: next.interactionContext,
      userMessage: { messageId: 'source-2' },
    });
    await store.completeLogicalTurn(identity.streamId, identity);
    const later = await store.claimLogicalTurn('later-stream', 'owner', {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'conversation',
      revision: 3,
      source_event_id: 'later-source',
      source_order_scope: scope,
      source_sequence: 1,
    });
    expect(later.interactionContext.logical_turn_id).toBe(next.interactionContext.logical_turn_id);
    expect(later.interactionContext.revision).toBe(next.interactionContext.revision + 1);
  });
  test('only committed exact candidate may finish with immutable replay and no acknowledgement', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    expect(await store.finishNativeResponse(identity, digest, 'first')).toBe(false);
    await store.commitNativeResponse(identity, digest);
    expect(await store.finishNativeResponse(identity, digest, 'first')).toBe(true);
    expect(await store.finishNativeResponse(identity, digest, 'second')).toBe(false);
    const job = await store.getJob(identity.streamId);
    expect(job).toMatchObject({
      finalEvent: 'first',
      generationCompleted: true,
      status: 'complete',
    });
    expect(job?.deliveryAcknowledgement).toBeUndefined();
  });
  test('cannot replace a committed winner before its actual saved event', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, digest);
    await expect(
      store.createJob(identity.streamId, 'owner', 'conversation', {
        responseMessageId: 'replacement',
      }),
    ).rejects.toThrow('pending');
    expect((await store.getJob(identity.streamId))?.nativeResponse).toEqual(identity);
  });
  test('generic updates cannot change bound identity or accepted final content', async () => {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.updateJob(identity.streamId, {
      responseMessageId: 'foreign',
      nativeResponseCancelled: true,
      nativeResponse: { ...identity, invocationId: 'other' },
    });
    expect(await store.commitNativeResponse(identity, digest)).toMatchObject({
      status: 'committed',
    });
    await store.finishNativeResponse(identity, digest, 'accepted');
    await store.updateJob(identity.streamId, {
      status: 'error',
      finalEvent: 'replaced',
      error: 'late transport error',
    });
    expect(await store.getJob(identity.streamId)).toMatchObject({
      status: 'complete',
      finalEvent: 'accepted',
      nativeResponse: identity,
    });
  });
  if (clock) {
    test('reads and retries cannot extend fixed 24-hour deadline', async () => {
      jest.useFakeTimers({ now: 1_900_000_000_000 });
      const { identity } = await admitted(store);
      await store.bindNativeResponse(identity);
      jest.setSystemTime(identity.recoverUntil - 1);
      await store.updateJob(identity.streamId, { status: 'error', completedAt: Date.now() });
      await store.cleanup();
      expect(await store.bindNativeResponse(identity)).toBe(true);
      jest.setSystemTime(identity.recoverUntil + 1);
      expect(await store.commitNativeResponse(identity, digest)).toEqual({ status: 'unavailable' });
      await store.cleanup();
      expect(await store.getJob(identity.streamId)).toBeNull();
    });
  }
}
