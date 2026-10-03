/* eslint-disable jest/no-export -- Shared contract helper excluded from test discovery. */
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import {
  buildTrustedSourceSelectionCapsule,
  ownedInteractionSources,
} from '../../agents/sourceSelectionContext';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { IJobStore, InteractionContext, LogicalTurnClaim } from '../interfaces/IJobStore';

const scope = 'a'.repeat(64);
/** The adapter capabilities the Telegram route binds to every input. */
const telegramCapabilities = {
  segment_stability: 'immediate',
  supersede_scope: 'response_only',
} as const;
const decodedSources = (capsule: string) =>
  JSON.parse(
    Buffer.from(
      capsule.split('\n').find((line) => /^[A-Za-z0-9_-]+$/.test(line)) ?? '',
      'base64url',
    ).toString('utf8'),
  ).sources as { label: string }[];
const context = (id: string, sequence?: number): InteractionContext => ({
  actor_kind: 'external_user',
  origin: 'interactive',
  surface: 'telegram',
  conversation_id: 'conversation',
  source_event_id: id,
  revision: 1,
  ...(sequence ? { source_sequence: sequence, source_order_scope: scope } : {}),
  source_segments: [
    {
      ordinal: 0,
      source_event_id: id,
      source_index: 0,
      text: `${id} original goal`,
      ...(sequence ? { source_sequence: sequence } : {}),
    },
  ],
});

/** Identical ownership and recovery checks run on both store implementations. */
export function rapidInputContract(createStore: () => IJobStore) {
  let store: IJobStore;
  beforeEach(() => {
    store = createStore();
  });
  afterEach(async () => {
    await store?.destroy();
  });
  test('ready input keeps its original provenance, yields to active Main, and resumes only at the current presentation watermark', async () => {
    const old = context('slow', 1),
      quick = context('quick', 2);
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 2 });
    const active = await store.claimLogicalTurn('quick-stream', 'owner', quick);
    await store.createJob('quick-stream', 'owner', 'conversation', {
      interactionContext: active.interactionContext,
    });
    const ready = {
      ...old,
      ready_input_continuation: {
        source_message_id: 'input-slow',
        presentation_source_sequence: 2,
      },
    };
    expect((await store.claimLogicalTurn('slow-stream', 'owner', ready)).status).toBe('busy');
    expect((await store.getJob('quick-stream'))?.status).toBe('running');
    await store.completeLogicalTurn('quick-stream');
    const resumed = await store.claimLogicalTurn('slow-stream', 'owner', ready);
    expect(resumed).toMatchObject({
      status: 'claimed',
      supersededStreamIds: [],
      interactionContext: {
        source_event_id: 'slow',
        source_sequence: 1,
        ready_input_continuation: { presentation_source_sequence: 2 },
      },
    });
    expect(resumed.interactionContext.source_segments?.map((s) => s.source_sequence)).toEqual([1]);
    expect((await store.claimLogicalTurn('duplicate', 'owner', ready)).status).toBe('duplicate');
  });
  test('a new observation fences a ready input continuation without losing the original goal', async () => {
    const old = context('slow', 1);
    const ready = {
      ...old,
      ready_input_continuation: {
        source_message_id: 'input-slow',
        presentation_source_sequence: 2,
      },
    };
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 3 });
    expect((await store.claimLogicalTurn('stale', 'owner', ready)).status).toBe('superseded');
    expect(
      (
        await store.claimLogicalTurn('retry', 'owner', {
          ...ready,
          ready_input_continuation: {
            ...ready.ready_input_continuation,
            presentation_source_sequence: 3,
          },
        })
      ).status,
    ).toBe('claimed');
  });
  test('ready input native result uses the separate fence and a newer source still rejects its publication and delivery', async () => {
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 2 });
    const ready = {
      ...context('slow', 1),
      ready_input_continuation: {
        source_message_id: 'input-slow',
        presentation_source_sequence: 2,
      },
    };
    const claim = await store.claimLogicalTurn('slow-stream', 'owner', ready);
    const job = await store.createJob('slow-stream', 'owner', 'conversation', {
      interactionContext: claim.interactionContext,
      responseMessageId: 'answer',
      userMessage: { messageId: 'input-slow' },
    });
    const now = Date.now(),
      digest = 'a'.repeat(64);
    const identity: NativeResponseIdentity = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'slow-stream',
      jobCreatedAt: job.createdAt,
      logicalTurnId: claim.interactionContext.logical_turn_id!,
      revision: claim.interactionContext.revision,
      sourceOrderScope: scope,
      sourceSequence: 2,
      invocationId: 'invocation',
      bodySha256: digest,
      providerId: 'provider',
      agentId: 'agent',
      originSha256: digest,
      source: { id: 'source-row', messageId: 'input-slow', digest },
      admittedAt: now,
      recoverUntil: now + 86400000,
    };
    expect(await store.bindNativeResponse(identity)).toBe(true);
    expect(await store.bindNativeResponse({ ...identity, sourceSequence: 1 })).toBe(false);
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 3 });
    expect(await store.commitNativeResponse(identity, digest)).toMatchObject({ status: 'revoked' });
    expect(
      await store.acknowledgeDelivery({
        logical_turn_id: identity.logicalTurnId,
        revision: identity.revision,
        state: 'committed',
      }),
    ).toMatchObject({ status: 'stale_source_order' });
  });
  test('older setup finishing last cannot take newest authority or erase either accepted input', async () => {
    const a = context('a', 1),
      b = context('b', 2);
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 1 });
    await store.retainLogicalTurnInput('owner', a);
    await store.observeSourceOrder!({ source_order_scope: scope, source_sequence: 2 });
    await store.retainLogicalTurnInput('owner', b);
    const newest = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(newest.status).toBe('claimed');
    expect(newest.interactionContext.source_segments?.map((s) => s.text)).toEqual([
      'a original goal',
      'b original goal',
    ]);
    const old = await store.claimLogicalTurn('a-stream', 'owner', a);
    expect(old.status).toBe('superseded');
    expect(old.supersededStreamIds).toEqual([]);
    const duplicate = await store.claimLogicalTurn('b-replay', 'owner', b);
    expect(duplicate).toMatchObject({
      status: 'duplicate',
      streamId: 'b-stream',
      interactionContext: { revision: 1 },
    });
  });
  test('claim waits for retained input persistence and then exposes both sources', async () => {
    const a = context('a', 1),
      b = context('b', 2);
    a.source_segments = [{ ...a.source_segments![0], source_message_id: 'input-a' }];
    await store.retainLogicalTurnInput('owner', a);
    await store.retainLogicalTurnInput('owner', b);
    expect((await store.claimLogicalTurn('b-stream', 'owner', b)).status).toBe('initializing');
    a.source_segments = [{ ...a.source_segments![0], source_persisted: true }];
    await store.retainLogicalTurnInput('owner', a);
    const ready = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(ready.status).toBe('claimed');
    expect(ready.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual([
      'a',
      'b',
    ]);
  });
  /* VIVENTIUM: a deferred quoted input keeps its own quote inside a combined turn. */
  test('a deferred quoted input keeps its own quote when an unquoted successor combines it', async () => {
    const quote = {
      version: 1 as const,
      provenanceStatus: 'verified' as const,
      senderRole: 'assistant_self' as const,
      repliedTelegramMessageId: '14384',
      quoteText: 'Willow is cheaper by $15.',
      logicalMessageId: 'addition-message',
    };
    const a = context('a', 1),
      b = context('b', 2);
    a.source_segments = [
      {
        ...a.source_segments![0],
        source_message_id: 'input-a',
        source_persisted: true,
        reply_context: quote,
      },
    ];
    await store.retainLogicalTurnInput('owner', a);
    await store.retainLogicalTurnInput('owner', b);
    const combined = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(combined.status).toBe('claimed');
    expect(
      combined.interactionContext.source_segments?.map((segment) => [
        segment.source_event_id,
        segment.reply_context ?? null,
      ]),
    ).toEqual([
      ['a', quote],
      ['b', null],
    ]);
  });
  /* VIVENTIUM: a claim only reserves a revision; the admission commit fixes each source's author. */
  const admitAndCommit = async (streamId: string, claim: LogicalTurnClaim) => {
    await store.createJob(streamId, 'owner', 'conversation', {
      interactionContext: claim.interactionContext,
    });
    await store.fenceSupersededLogicalTurnClaims?.(claim);
    return store.commitLogicalTurnAdmission!(streamId, 'owner', claim.interactionContext);
  };
  const quoted = (id: string, sequence: number) => {
    const input = context(id, sequence);
    input.source_segments = [
      {
        ...input.source_segments![0],
        source_message_id: `input-${id}`,
        source_persisted: true,
        reply_context: {
          version: 1,
          provenanceStatus: 'verified',
          senderRole: 'assistant_self',
          repliedTelegramMessageId: '14378',
          quoteText: 'Willow 427 / Elm 441',
          logicalMessageId: 'main-answer',
        },
      },
    ];
    return input;
  };
  const owned = (committed: InteractionContext) =>
    ownedInteractionSources(committed, telegramCapabilities).map(({ sourceOrdinal, segment }) => [
      sourceOrdinal,
      segment.source_event_id,
      segment.reply_context?.quoteText ?? null,
    ]);
  test('an additive combined turn owns the quoted input deferred to it', async () => {
    const a = quoted('a', 1),
      b = context('b', 2);
    await store.retainLogicalTurnInput('owner', a);
    await store.retainLogicalTurnInput('owner', b);
    const combined = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(combined.status).toBe('claimed');
    const committed = await admitAndCommit('b-stream', combined);
    expect(owned(committed)).toEqual([
      [1, 'a', 'Willow 427 / Elm 441'],
      [2, 'b', null],
    ]);
    const capsule = buildTrustedSourceSelectionCapsule(committed, telegramCapabilities);
    expect(decodedSources(capsule).map((source) => source.label)).toEqual(['S1', 'S2']);
    expect(capsule).not.toContain('owns only the current accepted input');
  });
  test('an additive combined turn leaves an input an admitted earlier revision authors to it', async () => {
    const a = context('a', 1),
      c = context('c', 2),
      b = context('b', 3);
    const first = await store.claimLogicalTurn('a-stream', 'owner', a);
    await admitAndCommit('a-stream', first);
    await store.retainLogicalTurnInput('owner', c);
    const combined = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(combined).toMatchObject({ status: 'claimed', supersededStreamIds: ['a-stream'] });
    const committed = await admitAndCommit('b-stream', combined);
    const { revision } = committed;
    expect(revision).toBe(first.interactionContext.revision + 1);
    expect(
      committed.source_segments?.map((s) => [s.source_event_id, s.authoring_revision]),
    ).toEqual([
      ['a', revision - 1],
      ['c', revision],
      ['b', revision],
    ]);
    expect(owned(committed).map(([ordinal]) => ordinal)).toEqual([2, 3]);
    const capsule = buildTrustedSourceSelectionCapsule(committed, telegramCapabilities);
    expect(decodedSources(capsule).map((source) => source.label)).toEqual(['S2', 'S3']);
    expect(capsule).toContain('Unlisted earlier inputs already have independent authoring owners');
    expect(
      ownedInteractionSources(committed, { supersede_scope: 'response_and_authoring' }).map(
        ({ sourceOrdinal }) => sourceOrdinal,
      ),
    ).toEqual([1, 2, 3]);
  });
  test('a reservation that never admits leaves its input and quote to the admitted winner', async () => {
    const reserved = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    const winner = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    expect(winner.supersededStreamIds).toEqual(['a-stream']);
    // The newer claim alone decides nothing: its marks still name the reservation.
    expect(winner.interactionContext.source_segments?.map((s) => s.authoring_revision)).toEqual([
      reserved.interactionContext.revision,
      winner.interactionContext.revision,
    ]);
    const committed = await admitAndCommit('b-stream', winner);
    expect(owned(committed)).toEqual([
      [1, 'a', 'Willow 427 / Elm 441'],
      [2, 'b', null],
    ]);
    await expect(
      store.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: reserved.interactionContext,
      }),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
    await expect(
      store.commitLogicalTurnAdmission!('a-stream', 'owner', reserved.interactionContext),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
    expect((await store.getJob('b-stream'))?.interactionContext).toEqual(committed);
  });
  test('an admitted revision that never commits is taken over by the winning commit', async () => {
    const older = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    const winner = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    await store.createJob('a-stream', 'owner', 'conversation', {
      interactionContext: older.interactionContext,
    });
    const committed = await admitAndCommit('b-stream', winner);
    expect(owned(committed)).toEqual([
      [1, 'a', 'Willow 427 / Elm 441'],
      [2, 'b', null],
    ]);
    await expect(
      store.commitLogicalTurnAdmission!('a-stream', 'owner', older.interactionContext),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
  });
  test('a winner whose turn another conversation retires still owns the reservation it fenced', async () => {
    const reserved = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    const winner = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    await store.createJob('b-stream', 'owner', 'conversation', {
      interactionContext: winner.interactionContext,
    });
    await store.fenceSupersededLogicalTurnClaims?.(winner);
    const other = await store.claimLogicalTurn('c-stream', 'owner', {
      ...context('c', 3),
      conversation_id: 'other-conversation',
    });
    expect(other.interactionContext.logical_turn_id).not.toBe(
      winner.interactionContext.logical_turn_id,
    );
    const committed = await store.commitLogicalTurnAdmission!(
      'b-stream',
      'owner',
      winner.interactionContext,
    );
    expect(owned(committed)).toEqual([
      [1, 'a', 'Willow 427 / Elm 441'],
      [2, 'b', null],
    ]);
    expect(other.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual(['c']);
    await expect(
      store.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: reserved.interactionContext,
      }),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
  });
  test('a relinquished author gives its input and quote to the next commit', async () => {
    const older = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    await admitAndCommit('a-stream', older);
    const winner = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    await store.relinquishLogicalTurnAuthor!('a-stream', 'owner', older.interactionContext);
    const committed = await admitAndCommit('b-stream', winner);
    expect(owned(committed)).toEqual([
      [1, 'a', 'Willow 427 / Elm 441'],
      [2, 'b', null],
    ]);
    await expect(
      store.commitLogicalTurnAdmission!('a-stream', 'owner', older.interactionContext),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
  });
  test('an admission whose turn another conversation retired still commits on its own ledger', async () => {
    const claimed = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    await store.createJob('a-stream', 'owner', 'conversation', {
      interactionContext: claimed.interactionContext,
    });
    const other = await store.claimLogicalTurn('s-stream', 'owner', {
      ...context('s', 2),
      conversation_id: 'other-conversation',
    });
    expect(other.interactionContext.logical_turn_id).not.toBe(
      claimed.interactionContext.logical_turn_id,
    );
    await expect(
      store.commitLogicalTurnAdmission!('a-stream', 'owner', claimed.interactionContext),
    ).resolves.toEqual(claimed.interactionContext);
  });
  test('ordinary supersession inherits exact prior source and owned uploaded files once', async () => {
    const a = context('a'),
      b = context('b');
    a.source_segments = [{ ...a.source_segments![0], source_files: [{ file_id: 'owner-file' }] }];
    const first = await store.claimLogicalTurn('a-stream', 'owner', a);
    const next = await store.claimLogicalTurn('b-stream', 'owner', b);
    expect(next.supersededStreamIds).toEqual(['a-stream']);
    expect(next.interactionContext.logical_turn_id).toBe(first.interactionContext.logical_turn_id);
    expect(next.interactionContext.source_segments).toHaveLength(2);
    expect(next.interactionContext.source_segments![0].source_files).toEqual([
      { file_id: 'owner-file' },
    ]);
  });
  test('failed first claim retains pending sources for the existing retry owner', async () => {
    await store.retainLogicalTurnInput('owner', context('a'));
    const b = context('b');
    const failed = await store.claimLogicalTurn('failed', 'owner', b);
    await store.rollbackLogicalTurnClaim('failed', failed.interactionContext);
    const retry = await store.claimLogicalTurn('retry', 'owner', b);
    expect(retry.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual([
      'a',
      'b',
    ]);
  });
  test('completed turn does not replay its old goals into the next turn', async () => {
    const a = await store.claimLogicalTurn('a-stream', 'owner', context('a'));
    await store.createJob('a-stream', 'owner', 'conversation', {
      interactionContext: a.interactionContext,
    });
    await store.completeLogicalTurn('a-stream');
    await store.retainLogicalTurnInput('owner', context('b'));
    const next = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
    expect(next.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual(['b']);
  });
  test('a repeated adopted source cannot leak into the next completed turn', async () => {
    await store.retainLogicalTurnInput('owner', context('a'));
    const claim = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
    await store.createJob('b-stream', 'owner', 'conversation', {
      interactionContext: claim.interactionContext,
    });
    await store.completeLogicalTurn('b-stream');
    await store.retainLogicalTurnInput('owner', context('a'));
    await store.retainLogicalTurnInput('owner', context('c'));
    const next = await store.claimLogicalTurn('c-stream', 'owner', context('c'));
    expect(next.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual(['c']);
  });
  test.each([
    [32, 10],
    [2, 24 * 1024],
  ])(
    'input capacity (%i sources of %i bytes) fails before evicting an accepted reference',
    async (count, bytes) => {
      const a = context('a');
      a.source_segments = Array.from({ length: count }, (_, index) => ({
        ordinal: index,
        source_event_id: `source-${index}`,
        source_index: 0,
        text: 'x'.repeat(bytes),
      }));
      await store.retainLogicalTurnInput('owner', a);
      const b = context('b');
      b.source_segments = [{ ...b.source_segments![0], text: 'y'.repeat(bytes) }];
      await expect(store.retainLogicalTurnInput('owner', b)).rejects.toMatchObject({
        code: 'source_input_capacity',
      });
      const original = await store.claimLogicalTurn('a-stream', 'owner', a);
      expect(original.interactionContext.source_segments).toHaveLength(count);
      expect(original.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual(
        a.source_segments.map((s) => s.source_event_id),
      );
    },
  );
  test('different owner or conversation cannot import retained input', async () => {
    await store.retainLogicalTurnInput('other', context('private'));
    const next = await store.claimLogicalTurn('own', 'owner', context('current'));
    expect(next.interactionContext.source_segments?.map((s) => s.source_event_id)).toEqual([
      'current',
    ]);
  });
  test('manager refuses stale authoring without replacing or aborting the current job', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.retainLogicalTurnInput('owner', context('a', 1));
    await manager.retainLogicalTurnInput('owner', context('b', 2));
    const current = await manager.createJob('b-stream', 'owner', 'conversation', {
      interactionContext: context('b', 2),
    });
    await expect(
      manager.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: context('a', 1),
      }),
    ).rejects.toMatchObject({ code: 'source_order_superseded' });
    expect(current.abortController.signal.aborted).toBe(false);
    await manager.destroy();
  });
}
