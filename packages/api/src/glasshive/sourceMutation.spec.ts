import type { IInteractionDurableEffect } from '@librechat/data-schemas';
import type { SourceMutationPrepareInput, SourceMutationService } from './sourceMutation';
import {
  executeSourceMutation,
  readSourceRecoverySnapshot,
  resolveManagedMutationSource,
} from './sourceMutation';

/* === VIVENTIUM START === Reservation, dispatch, and truthful outcome use one occurrence. === */
const input: SourceMutationPrepareInput = {
  streamId: 'stream',
  userId: 'owner',
  adapterId: 'glasshive.worker_delegate.v1',
  routeId: 'worker',
  operation: 'delegate',
  effectKind: 'durable_work_accepted',
  effectOrdinal: 0,
  effectOccurrenceRef: 'occurrence',
  providerIdempotencyKey: 'provider-key',
  providerIdempotencyMode: 'native_key',
  canonicalArgs: { instruction: 'Synthetic task' },
};
function fixture() {
  const order: string[] = [];
  const row = { effectKey: 'effect', status: 'committed' } as IInteractionDurableEffect;
  const service = {
    prepareDurableEffect: jest.fn(async () => {
      order.push('reserve');
      return { decision: 'dispatch' as const, effectKey: 'effect', claimToken: 'claim' };
    }),
    commitDurableEffect: jest.fn(async () => {
      order.push('commit');
      return row;
    }),
    settleDurableEffectFailure: jest.fn(async () => row),
  };
  const assertAuthor = jest.fn(async () => {
    order.push('author');
  });
  const dispatch = jest.fn(async () => {
    order.push('dispatch');
    return { receiptRef: 'work', result: { status: 'accepted', workRef: 'work' } };
  });
  return { order, service, assertAuthor, dispatch };
}
test('reserves before the final author check and commits the real receipt before projection', async () => {
  const f = fixture();
  const result = await executeSourceMutation({
    ...f,
    input,
    recordReceipt: async () => {
      f.order.push('projection');
    },
  });
  expect(f.order).toEqual(['reserve', 'author', 'dispatch', 'commit', 'projection']);
  expect(result).toEqual({ status: 'accepted', workRef: 'work' });
  expect(f.service.commitDurableEffect).toHaveBeenCalledWith({
    effectKey: 'effect',
    claimToken: 'claim',
    providerReceiptRef: 'work',
    replayResult: result,
  });
});
test('late supersession closes the reservation without a provider call', async () => {
  const f = fixture();
  const error = Object.assign(new Error('stale'), { code: 'source_authority_superseded' });
  f.assertAuthor.mockRejectedValueOnce(error);
  await expect(executeSourceMutation({ ...f, input })).rejects.toBe(error);
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.service.settleDurableEffectFailure).toHaveBeenCalledWith(
    expect.objectContaining({
      outcome: 'failed_without_effect',
      failureCode: 'source_authority_rejected_before_dispatch',
    }),
  );
});
test('a transport loss leaves an unknown outcome', async () => {
  const f = fixture();
  f.dispatch.mockRejectedValueOnce(new Error('lost reply'));
  await expect(executeSourceMutation({ ...f, input })).rejects.toThrow('lost reply');
  expect(f.service.settleDurableEffectFailure).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: 'provider_outcome_unknown' }),
  );
});
test.each(['in_progress', 'reconcile'])(
  'an existing %s occurrence is never dispatched again',
  async (decision) => {
    const f = fixture();
    const service: SourceMutationService = {
      ...f.service,
      prepareDurableEffect: async () => ({
        decision: decision as 'in_progress' | 'reconcile',
        effectKey: 'effect',
        claimToken: 'claim',
      }),
    };
    await expect(executeSourceMutation({ ...f, input, service })).rejects.toMatchObject({
      code: 'source_mutation_outcome_pending',
    });
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);
test('an exact committed replay returns the saved result without any new dispatch', async () => {
  const f = fixture();
  const replayResult = { status: 'accepted', workRef: 'original' };
  const service: SourceMutationService = {
    ...f.service,
    prepareDurableEffect: async () => ({
      decision: 'return_committed',
      effectKey: 'effect',
      replayResult,
    }),
  };
  expect(await executeSourceMutation({ ...f, input, service })).toEqual(replayResult);
  expect(f.assertAuthor).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});
test('a presentation projection error cannot discard Mongo acceptance', async () => {
  const f = fixture();
  expect(
    await executeSourceMutation({
      ...f,
      input,
      recordReceipt: async () => {
        throw new Error('projection unavailable');
      },
    }),
  ).toEqual({ status: 'accepted', workRef: 'work' });
  expect(f.dispatch).toHaveBeenCalledTimes(1);
});
test('selected earlier input is admitted only when this revision owns it', () => {
  const interaction = {
    source_event_id: 'S2',
    revision: 2,
    source_segments: [{ source_event_id: 'S1', authoring_revision: 2 }],
  };
  expect(resolveManagedMutationSource(interaction, 'S1')).toBe('S1');
  expect(() => resolveManagedMutationSource({ ...interaction, revision: 3 }, 'S1')).toThrow(
    'source_mutation_source_not_owned',
  );
  expect(() => resolveManagedMutationSource(interaction, 'foreign')).toThrow(
    'source_mutation_source_not_owned',
  );
});
function snapshotFixture(
  effectStatus: 'reserved' | 'committed' | 'provider_outcome_unknown',
  expires: number,
  launchState = 'accepted',
) {
  const effect = {
    effectKey: 'effect',
    sourceEventId: 'S1',
    logicalTurnRevision: 1,
    responseMessageId: 'old-response',
    effectKind: 'durable_work_accepted',
    status: effectStatus,
    routeId: 'worker',
    operation: 'delegate',
    providerReceiptRef: effectStatus === 'committed' ? 'work' : undefined,
    claimExpiresAt: new Date(expires),
    canonicalArgs: { private: 'excluded' },
  } as unknown as IInteractionDurableEffect;
  const scope = {
    ownerId: 'owner',
    conversationId: 'chat',
    logicalTurnId: 'turn',
    sourceEventIds: ['S1', 'S2'],
  };
  const model = {
    find: jest.fn(() => ({ sort: () => ({ limit: () => ({ lean: async () => [effect] }) }) })),
  };
  const collection = {
    find: jest.fn(() => ({
      sort: () => ({
        limit: () => ({
          toArray: async () => [
            {
              sourceEventId: 'S1',
              originRef: 'origin',
              workRef: 'work',
              launchState,
              preparationExpiresAt: new Date(expires),
              dispatchExpiresAt: new Date(expires),
            },
          ],
        }),
      }),
    })),
  };
  return { scope, model, collection };
}
test('fresh facts preserve owner scope, accepted work, and unknown effects without private arguments', async () => {
  const f = snapshotFixture('provider_outcome_unknown', 1000);
  const result = await readSourceRecoverySnapshot(f.scope, f.model, f.collection, 500);
  expect(result.pending).toBe(false);
  expect(result.facts.effects[0].status).toBe('provider_outcome_unknown');
  expect(result.facts.work[0]).toMatchObject({ launchState: 'accepted', workRef: 'work' });
  expect(result.facts.effects[0]).not.toHaveProperty('canonicalArgs');
  expect(f.model.find).toHaveBeenCalledWith({
    ownerId: 'owner',
    conversationId: 'chat',
    logicalTurnId: 'turn',
    sourceEventId: { $in: ['S1', 'S2'] },
  });
  expect(f.collection.find).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerId: 'owner',
      conversationId: 'chat',
      sourceEventId: { $in: ['S1', 'S2'] },
    }),
    expect.any(Object),
  );
});
test('a live reservation holds capture; expiry becomes unknown, never absent', async () => {
  const f = snapshotFixture('reserved', 1000, 'dispatch_ready');
  expect((await readSourceRecoverySnapshot(f.scope, f.model, f.collection, 500)).pending).toBe(
    true,
  );
  const expired = await readSourceRecoverySnapshot(f.scope, f.model, f.collection, 1000);
  expect(expired.pending).toBe(false);
  expect(expired.facts.effects[0].status).toBe('provider_outcome_unknown');
  expect(expired.facts.work[0].launchState).toBe('dispatch_unknown');
});
/* === VIVENTIUM END === */
