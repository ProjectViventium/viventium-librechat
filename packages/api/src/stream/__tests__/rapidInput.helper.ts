/* eslint-disable jest/no-export -- Shared contract helper excluded from test discovery. */
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { prepareNativeSourceRecovery } from '../../glasshive/nativeSupersession';
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
  test.each([false, true])(
    'a failed predecessor stays failed while exact pending goals start fresh; release earlier author=%s',
    async (releaseEarlierAuthor) => {
      const first = await store.claimLogicalTurn('a-stream', 'owner', context('a'));
      await admitAndCommit('a-stream', first);
      const failed = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
      await store.updateJob('a-stream', { status: 'superseded' });
      expect(await store.cancelNativeResponse((await store.getJob('a-stream'))!)).toMatchObject({
        status: 'revoked',
      });
      const acknowledgement = {
        logical_turn_id: first.interactionContext.logical_turn_id!,
        revision: first.interactionContext.revision,
        state: 'failed' as const,
      };
      expect(await store.acknowledgeDelivery(acknowledgement)).toMatchObject({
        status: 'recorded',
      });
      expect(
        await store.bindDeliveryAcknowledgement('a-stream', acknowledgement, null),
      ).toMatchObject({ status: 'recorded' });
      expect(await store.rollbackLogicalTurnClaim('b-stream', failed.interactionContext)).toBe(
        true,
      );
      // Rollback cannot turn failed delivery into proof that output was removed.
      expect(
        await store.acknowledgeDelivery({
          ...acknowledgement,
          state: 'partial_removed',
        }),
      ).toMatchObject({ status: 'conflict' });
      const retry = await store.claimLogicalTurn('c-stream', 'owner', context('c'));
      expect(retry.supersededStreamIds).toEqual([]);
      expect(retry.interactionContext.logical_turn_id).not.toBe(
        first.interactionContext.logical_turn_id,
      );
      expect(
        retry.interactionContext.source_segments?.map((source) => [
          source.source_event_id,
          source.authoring_revision,
        ]),
      ).toEqual([
        ['b', 1],
        ['c', 1],
      ]);
      expect((await store.getJob('a-stream'))?.nativeResponseCancelled).toBe(true);
      expect((await store.getJob('a-stream'))?.deliveryAcknowledgement?.state).toBe('failed');
      expect((await store.getJob('a-stream'))?.interactionContext?.source_event_id).toBe('a');
      if (releaseEarlierAuthor) {
        await store.relinquishLogicalTurnAuthor!('a-stream', 'owner', first.interactionContext);
      }
      const committed = await admitAndCommit('c-stream', retry);
      expect(owned(committed).map((source) => source[1])).toEqual(['b', 'c']);
    },
  );
  test('a committed predecessor starts a fresh turn after a rolled-back admission without replaying its old goal', async () => {
    const first = await store.claimLogicalTurn('a-stream', 'owner', context('a'));
    await admitAndCommit('a-stream', first);
    const candidate = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
    expect(await store.rollbackLogicalTurnClaim('b-stream', candidate.interactionContext)).toBe(
      true,
    );
    expect(
      await store.acknowledgeDelivery({
        logical_turn_id: first.interactionContext.logical_turn_id!,
        revision: first.interactionContext.revision,
        state: 'committed',
      }),
    ).toMatchObject({ status: 'recorded' });
    const retry = await store.claimLogicalTurn('c-stream', 'owner', context('c'));
    expect(retry.supersededStreamIds).toEqual([]);
    expect(retry.interactionContext.logical_turn_id).not.toBe(
      first.interactionContext.logical_turn_id,
    );
    expect(
      retry.interactionContext.source_segments?.map((source) => source.source_event_id),
    ).toEqual(['b', 'c']);
    expect(owned(await admitAndCommit('c-stream', retry)).map((source) => source[1])).toEqual([
      'b',
      'c',
    ]);
  });
  test.each([undefined, 'partial_removed'] as const)(
    'rollback retains the failed admission without changing a nonterminal predecessor; acknowledgement=%s',
    async (state) => {
      const first = await store.claimLogicalTurn('a-stream', 'owner', context('a'));
      await admitAndCommit('a-stream', first);
      const failed = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
      if (state) {
        expect(
          await store.acknowledgeDelivery({
            logical_turn_id: first.interactionContext.logical_turn_id!,
            revision: first.interactionContext.revision,
            state,
          }),
        ).toMatchObject({ status: 'recorded' });
      }
      expect(await store.rollbackLogicalTurnClaim('b-stream', failed.interactionContext)).toBe(
        true,
      );
      const retry = await store.claimLogicalTurn('c-stream', 'owner', context('c'));
      expect(retry.supersededStreamIds).toEqual(['a-stream']);
      expect(retry.interactionContext.logical_turn_id).toBe(
        first.interactionContext.logical_turn_id,
      );
      expect(
        retry.interactionContext.source_segments?.map((source) => source.source_event_id),
      ).toEqual(['a', 'b', 'c']);
      expect(owned(await admitAndCommit('c-stream', retry)).map((source) => source[1])).toEqual([
        'b',
        'c',
      ]);
    },
  );
  test.each([false, true])(
    'rollback of a removed candidate is allowed only before its source-author commit; committed=%s',
    async (committed) => {
      const first = await store.claimLogicalTurn('a-stream', 'owner', context('a'));
      await admitAndCommit('a-stream', first);
      const candidate = await store.claimLogicalTurn('b-stream', 'owner', context('b'));
      await store.createJob('b-stream', 'owner', 'conversation', {
        interactionContext: candidate.interactionContext,
      });
      if (committed) {
        await store.commitLogicalTurnAdmission!('b-stream', 'owner', candidate.interactionContext);
      }
      await store.deleteJob('b-stream');
      expect(await store.rollbackLogicalTurnClaim('b-stream', candidate.interactionContext)).toBe(
        !committed,
      );
      if (!committed) {
        const retry = await store.claimLogicalTurn('c-stream', 'owner', context('c'));
        expect(
          retry.interactionContext.source_segments?.map((source) => source.source_event_id),
        ).toEqual(['a', 'b', 'c']);
        expect(owned(await admitAndCommit('c-stream', retry)).map((source) => source[1])).toEqual([
          'b',
          'c',
        ]);
      }
    },
  );
  /* === VIVENTIUM START ===
   * Feature: Exact cancelled Main source-author reconciliation.
   * Purpose: A revoked Main cannot keep unresolved input, while other owners and committed work
   * retain their author claims. The same contract runs against memory and owned Redis storage.
   */
  test('a superseded running Main returns both exact pending sources to its successor', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    manager.setNativeSourceRecovery((current, previous) =>
      prepareNativeSourceRecovery(current, previous, {
        beforeCapture: async () => Date.now() + 1000,
        isUnboundCancelled: (job) => store.isNativeResponseUnboundCancelled!(job),
        getJob: (id) => store.getJob(id),
        readFacts: async () => ({ facts: { effects: [], work: [] }, pending: false }),
        sleep: async () => {
          throw new Error('Unexpected pending source proof');
        },
      }),
    );
    try {
      const first = await manager.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: quoted('a', 1),
        adapterCapabilities: telegramCapabilities,
      });
      const authored = await manager.commitLogicalTurnAuthor('a-stream', 'owner');
      expect(owned(authored!)).toEqual([[1, 'a', 'Willow 427 / Elm 441']]);
      const next = await manager.createJob('b-stream', 'owner', 'conversation', {
        interactionContext: context('b', 2),
        adapterCapabilities: telegramCapabilities,
      });
      expect(first.abortController.signal.aborted).toBe(true);
      expect(first.abortController.signal.reason).toBe('superseded');
      expect(next.abortController.signal.aborted).toBe(false);
      const facts = { effects: [], work: [] };
      const relinquish = jest.spyOn(store, 'relinquishLogicalTurnAuthor');
      const readFacts = jest.fn(async () => {
        expect(relinquish).not.toHaveBeenCalled();
        return { facts, pending: false };
      });
      // The runtime installs this release/fresh-facts barrier before authoring starts.
      manager.setNativeSourceRecovery((current, previous) =>
        prepareNativeSourceRecovery(current, previous, {
          beforeCapture: async () => Date.now() + 1000,
          getJob: (id) => store.getJob(id),
          isUnboundCancelled: (job) => store.isNativeResponseUnboundCancelled!(job),
          readFacts,
          sleep: async () => {
            throw new Error('Unexpected pending recovery');
          },
        }),
      );
      const committed = await manager.commitLogicalTurnAuthor('b-stream', 'owner');
      expect(readFacts).toHaveBeenCalledTimes(1);
      expect(readFacts).toHaveBeenCalledWith({
        ownerId: 'owner',
        conversationId: 'conversation',
        logicalTurnId: committed!.logical_turn_id,
        sourceEventIds: ['a', 'b'],
      });
      expect(committed!.source_recovery_facts).toEqual(facts);
      expect(relinquish).toHaveBeenCalledTimes(1);
      expect(owned(committed!)).toEqual([
        [1, 'a', 'Willow 427 / Elm 441'],
        [2, 'b', null],
      ]);
      expect(committed!.source_segments?.map((source) => source.authoring_revision)).toEqual([
        2, 2,
      ]);
      await expect(
        store.commitLogicalTurnAdmission!('a-stream', 'owner', authored!),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });
      expect(await store.getJob('a-stream')).toMatchObject({
        status: 'superseded',
        nativeResponseCancelled: true,
      });
    } finally {
      await manager.destroy();
    }
  });
  test('cancelled pre-native identity survives late onStart metadata while its successor recovers every source', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    manager.setNativeSourceRecovery((current, previous) =>
      prepareNativeSourceRecovery(current, previous, {
        beforeCapture: async () => Date.now() + 1000,
        isUnboundCancelled: (job) => store.isNativeResponseUnboundCancelled!(job),
        getJob: (id) => store.getJob(id),
        readFacts: async () => {
          // onStart may finish after the previous request was superseded but before the
          // successor commits. Terminal bookkeeping still belongs to that old job.
          await store.updateJob(previous.streamId, {
            responseMessageId: 'late-old-response',
            userMessage: { messageId: 'late-old-input' },
            generationCompleted: true,
            finalEvent: JSON.stringify({ final: true, superseded: true }),
          });
          return { facts: { effects: [], work: [] }, pending: false };
        },
        sleep: async () => {
          throw new Error('Unexpected pending source proof');
        },
      }),
    );
    try {
      await manager.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: quoted('a', 1),
        adapterCapabilities: telegramCapabilities,
      });
      await manager.commitLogicalTurnAuthor('a-stream', 'owner');
      await manager.createJob('b-stream', 'owner', 'conversation', {
        interactionContext: context('b', 2),
        adapterCapabilities: telegramCapabilities,
      });
      const cancelled = structuredClone((await store.getJob('a-stream'))!);
      expect(await store.isNativeResponseUnboundCancelled!(cancelled)).toBe(true);
      const committed = await manager.commitLogicalTurnAuthor('b-stream', 'owner');
      expect(owned(committed!)).toEqual([
        [1, 'a', 'Willow 427 / Elm 441'],
        [2, 'b', null],
      ]);
      const stopped = (await store.getJob('a-stream'))!;
      expect(stopped.responseMessageId).toBe(cancelled.responseMessageId);
      expect(stopped.userMessage).toEqual(cancelled.userMessage);
      expect(stopped.interactionContext).toEqual(cancelled.interactionContext);
      expect(stopped.generationCompleted).toBe(true);
      expect(JSON.parse(stopped.finalEvent!)).toMatchObject({ final: true, superseded: true });
      expect(await store.isNativeResponseUnboundCancelled!(stopped)).toBe(true);
      expect(committed?.source_segments?.map((source) => source.authoring_revision)).toEqual([
        2, 2,
      ]);
      await manager.createJob('c-stream', 'owner', 'conversation', {
        interactionContext: context('c', 3),
        adapterCapabilities: telegramCapabilities,
      });
      const final = await manager.commitLogicalTurnAuthor('c-stream', 'owner');
      expect(owned(final!)).toEqual([
        [1, 'a', 'Willow 427 / Elm 441'],
        [2, 'b', null],
        [3, 'c', null],
      ]);
      expect(final?.source_segments?.map((source) => source.authoring_revision)).toEqual([3, 3, 3]);
    } finally {
      await manager.destroy();
    }
  });
  test('manager source-recovery failure returns its created job input for a normal retry', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    let rejectNextCapture = true;
    manager.setNativeSourceRecovery((current, previous) => {
      if (rejectNextCapture) {
        rejectNextCapture = false;
        return Promise.reject(new Error('synthetic_source_capture_failure'));
      }
      return prepareNativeSourceRecovery(current, previous, {
        beforeCapture: async () => Date.now() + 1000,
        isUnboundCancelled: (job) => store.isNativeResponseUnboundCancelled!(job),
        getJob: (id) => store.getJob(id),
        readFacts: async () => ({ facts: { effects: [], work: [] }, pending: false }),
        sleep: async () => {
          throw new Error('Unexpected pending source proof');
        },
      });
    });
    try {
      await manager.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: context('a'),
        adapterCapabilities: telegramCapabilities,
      });
      const first = await manager.commitLogicalTurnAuthor('a-stream', 'owner');
      await manager.createJob('b-stream', 'owner', 'conversation', {
        interactionContext: context('b'),
        adapterCapabilities: telegramCapabilities,
      });
      await expect(manager.commitLogicalTurnAuthor('b-stream', 'owner')).rejects.toThrow(
        'synthetic_source_capture_failure',
      );
      expect(await store.getJob('b-stream')).toBeNull();
      await manager.createJob('c-stream', 'owner', 'conversation', {
        interactionContext: context('c'),
        adapterCapabilities: telegramCapabilities,
      });
      const committed = await manager.commitLogicalTurnAuthor('c-stream', 'owner');
      expect(committed?.logical_turn_id).toBe(first?.logical_turn_id);
      expect(owned(committed!).map((source) => source[1])).toEqual(['a', 'b', 'c']);
    } finally {
      await manager.destroy();
    }
  });
  test.each([
    ['other owner', 'other-owner', {}],
    ['other source', 'owner', { source_event_id: 'wrong-source' }],
    ['other revision', 'owner', { revision: 2 }],
    ['other logical turn', 'owner', { logical_turn_id: 'wrong-turn' }],
    ['other conversation', 'owner', { conversation_id: 'wrong-conversation' }],
    ['other source scope', 'owner', { source_order_scope: 'b'.repeat(64) }],
    ['other actor', 'owner', { actor_kind: 'system' as const }],
    ['other origin', 'owner', { origin: 'scheduler' as const }],
    ['other surface', 'owner', { surface: 'web' as const }],
  ])(
    'author relinquish rejects %s without releasing the admitted source',
    async (_, owner, change) => {
      const first = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
      const authored = await admitAndCommit('a-stream', first);
      await store.relinquishLogicalTurnAuthor!('a-stream', owner, { ...authored, ...change });
      const successor = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
      const committed = await admitAndCommit('b-stream', successor);
      expect(owned(committed)).toEqual([[2, 'b', null]]);
      await expect(
        store.commitLogicalTurnAdmission!('a-stream', 'owner', authored),
      ).resolves.toEqual(authored);
    },
  );
  test('a completed Main remains historical after a stale relinquish call', async () => {
    const first = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    const authored = await admitAndCommit('a-stream', first);
    await store.updateJob('a-stream', { status: 'complete', completedAt: Date.now() });
    await store.relinquishLogicalTurnAuthor!('a-stream', 'owner', authored);
    const successor = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    const committed = await admitAndCommit('b-stream', successor);
    expect(owned(committed)).toEqual([[2, 'b', null]]);
  });
  test('an older release cannot relinquish a newer revision author', async () => {
    const first = await store.claimLogicalTurn('a-stream', 'owner', quoted('a', 1));
    const authored = await admitAndCommit('a-stream', first);
    const successor = await store.claimLogicalTurn('b-stream', 'owner', context('b', 2));
    const committed = await admitAndCommit('b-stream', successor);
    await store.relinquishLogicalTurnAuthor!('b-stream', 'owner', authored);
    await expect(
      store.commitLogicalTurnAdmission!('b-stream', 'owner', committed),
    ).resolves.toEqual(committed);
  });
  test('superseding accepted durable work retains its exact independent author and receipt', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    try {
      const first = await manager.createJob('a-stream', 'owner', 'conversation', {
        interactionContext: quoted('a', 1),
        adapterCapabilities: telegramCapabilities,
        deliveryPolicy: { commit_authority: 'external_adapter' },
      });
      await manager.commitLogicalTurnAuthor('a-stream', 'owner');
      await manager.updateMetadata('a-stream', { responseMessageId: 'response-a' });
      expect(
        await manager.markDurableEffectReceipt({
          streamId: 'a-stream',
          userId: 'owner',
          sourceEventId: 'a',
          responseMessageId: 'response-a',
          effectKind: 'durable_work_accepted',
          effectRef: 'durable-worker-a',
        }),
      ).toBe(true);
      const before = await store.getJob('a-stream');
      await manager.createJob('b-stream', 'owner', 'conversation', {
        interactionContext: context('b', 2),
        adapterCapabilities: telegramCapabilities,
        deliveryPolicy: { commit_authority: 'external_adapter' },
      });
      const committed = await manager.commitLogicalTurnAuthor('b-stream', 'owner');
      expect(owned(committed!)).toEqual([[2, 'b', null]]);
      const after = await store.getJob('a-stream');
      expect(after?.durableEffectReceipt).toEqual(before?.durableEffectReceipt);
      expect(after?.durableEffectReceipts).toEqual(before?.durableEffectReceipts);
      expect(first.abortController.signal.aborted).toBe(true);
    } finally {
      await manager.destroy();
    }
  });
  /* === VIVENTIUM END === */
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
