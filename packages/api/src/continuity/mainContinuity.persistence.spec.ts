/* === VIVENTIUM START === Cross-package Mongo acceptance uses the public persistence boundary. === */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import type {
  IMessage,
  IConversation,
  IViventiumMainContinuityState,
} from '@librechat/data-schemas';
import type { MainContinuityState, AcceptedMainTurn } from './mainContinuity';
import { createGlassHiveTerminalCallbackTransactionService } from '../glasshive/terminalCallbackTransaction';
import {
  createMainContinuityService,
  prepareMainCompactionCandidate,
  mainCompactionCandidateDigest,
} from './mainContinuity';

describe('native Main acceptance projection', () => {
  let server: MongoMemoryReplSet;
  let methods: Pick<
    ReturnType<typeof createMethods>,
    | 'projectAcceptedMainPresentation'
    | 'mutateAcceptedMainContinuitySources'
    | 'readAcceptedMainHistory'
    | 'readLegacyMainInput'
    | 'fenceAcceptedMainCompaction'
  >;
  const ownerId = new mongoose.Types.ObjectId().toString();
  const identity = { ownerId, agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) };
  const { runGlassHiveTerminalCallbackTransaction: transaction } =
    createGlassHiveTerminalCallbackTransactionService(mongoose);
  const states = () =>
    mongoose.model<IViventiumMainContinuityState>('ViventiumMainContinuityState');
  const messages = () => mongoose.model<IMessage>('Message');
  const conversations = () => mongoose.model<IConversation>('Conversation');
  let transient = false;
  const service = (
    hooks: {
      beforeSwap?: (state: MainContinuityState) => Promise<void>;
    } = {},
  ) =>
    createMainContinuityService({
      logger: { warn: jest.fn() },
      history: {
        read: (context, options) => methods.readAcceptedMainHistory(context, options),
        legacy: (context, cursor) => methods.readLegacyMainInput(context, cursor),
        fence: (context, turns, operation) =>
          methods.fenceAcceptedMainCompaction(context, turns, operation, transaction),
      },
      persistence: {
        read: async (key) =>
          (await states().findOne({ domainEpochKey: key }).lean()) as MainContinuityState | null,
        create: async (value) => {
          await states().create(value);
          return true;
        },
        compareAndSwap: async (key, version, value) => {
          await hooks.beforeSwap?.(value);
          const { version: expectedVersion, ...next } = value;
          expect(expectedVersion).toBe(version);
          return (
            (
              await states().updateOne(
                { domainEpochKey: key, version },
                { $set: next, $inc: { version: 1 } },
              )
            ).modifiedCount === 1
          );
        },
      },
      loadPresentations: async (user, ids) => {
        if (transient) throw new Error('transient_read');
        const rows = await messages()
          .find({ user, messageId: { $in: ids } })
          .lean();
        const result = [];
        for (const assistant of rows) {
          const userMessage = await messages()
            .findOne({ user, messageId: assistant.parentMessageId })
            .lean();
          const conversation = await conversations()
            .findOne({ user, conversationId: assistant.conversationId })
            .lean();
          result.push({
            assistant: { ...assistant },
            userMessage: userMessage ? { ...userMessage } : null,
            conversation: conversation ? { ...conversation } : null,
          });
        }
        return result;
      },
      commitPresentation: (context, turn, operation) =>
        methods.projectAcceptedMainPresentation(context, turn, operation, transaction),
    });
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());
    mongoose.set('transactionAsyncLocalStorage', true);
    createModels(mongoose);
    await Promise.all([messages().init(), states().init()]);
    methods = createMethods(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    transient = false;
    await Promise.all([
      messages().deleteMany({}),
      states().deleteMany({}),
      conversations().deleteMany({}),
    ]);
    await conversations().create({
      user: ownerId,
      conversationId: 'conversation',
      agent_id: 'main',
      endpoint: 'agents',
    });
  });
  const domainIdentity = () => ({
    ...identity,
    continuityDomainId: service().continuityDomainId(ownerId, 'main'),
  });
  const history = () => methods.readAcceptedMainHistory(domainIdentity());
  const deleteSource = (messageId: string) => {
    const filter = { user: ownerId, messageId };
    return methods.mutateAcceptedMainContinuitySources(filter, () => messages().deleteMany(filter));
  };
  async function presentation(id: string, logicalTurnId = id, revision = 1) {
    const userMessageId = `u-${id}`,
      assistantMessageId = `a-${id}`;
    await messages().create([
      {
        user: ownerId,
        conversationId: 'conversation',
        messageId: userMessageId,
        isCreatedByUser: true,
        text: `Valid request ${id}.`,
      },
      {
        user: ownerId,
        conversationId: 'conversation',
        messageId: assistantMessageId,
        parentMessageId: userMessageId,
        isCreatedByUser: false,
        unfinished: false,
        text: `Accepted ${id}.`,
        metadata: {
          viventium: {
            mainContext: { agentId: 'main', stableAuthoritySha256: identity.stableAuthoritySha256 },
            interactionContext: { logical_turn_id: logicalTurnId, revision },
          },
        },
      },
    ]);
    return {
      ...identity,
      logicalTurnId,
      revision,
      conversationId: 'conversation',
      userMessageId,
      assistantMessageId,
      userText: `Valid request ${id}.`,
      assistantText: `Accepted ${id}.`,
      origin: 'interactive',
    };
  }
  async function compact(runtime: ReturnType<typeof service>) {
    const claim = await runtime.claimAcceptedMainCompaction(identity);
    expect(claim.status).toBe('claimed');
    const candidate = prepareMainCompactionCandidate(
      {
        version: 1,
        summary: 'The remaining valid synthetic requests were accepted.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      },
      {
        sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
        previousSemanticCompaction: claim.previousSemanticCompaction as never,
      },
    );
    expect(candidate).not.toBeNull();
    expect(
      await runtime.completeAcceptedMainCompaction({
        ...identity,
        ...claim,
        semanticCompaction: candidate,
        semanticReview: {
          version: 1,
          approved: true,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(candidate!),
        },
      }),
    ).toMatchObject({ status: 'compacted' });
    return claim;
  }
  async function acceptedScheduledSource(id: string) {
    const turn = await presentation(id);
    await messages().updateOne(
      { user: ownerId, messageId: turn.userMessageId },
      {
        $set: {
          metadata: {
            viventium: {
              visibility: 'internal',
              interactionContext: {
                actor_kind: 'system',
                origin: 'scheduler',
                conversation_id: turn.conversationId,
                logical_turn_id: turn.logicalTurnId,
                revision: turn.revision,
                schedule_id: 'schedule-1',
                schedule_run_id: `run-${id}`,
              },
            },
          },
        },
      },
    );
    expect(await service().commitAcceptedMainTurn({ ...turn, origin: 'scheduler' })).toMatchObject({
      status: 'committed',
    });
    return turn;
  }

  it('hydrates retained scheduled results from exact typed parent provenance without user authority', async () => {
    for (let index = 0; index < 4; index++) await acceptedScheduledSource(`scheduled-${index}`);
    const runtime = service();
    const loaded = await runtime.loadAcceptedMainContext(identity);
    expect(loaded.status).toBe('available');
    for (const turn of loaded.sourceTurns as AcceptedMainTurn[]) {
      expect(turn).toMatchObject({
        origin: 'scheduler',
        userText: '',
        scheduleId: 'schedule-1',
      });
      expect(turn.assistantText).toMatch(/^Accepted scheduled-/);
      expect(turn.scheduleRunId).toBe(`run-${turn.logicalTurnId}`);
    }
    const claim = await runtime.claimAcceptedMainCompaction(identity);
    expect(claim.status).toBe('claimed');
    expect(claim.sourceTurns).toMatchObject([
      {
        origin: 'scheduler',
        userText: '',
        assistantText: 'Accepted scheduled-0.',
      },
    ]);
    expect(
      await messages().countDocuments({
        'metadata.viventium.visibility': 'internal',
      }),
    ).toBe(4);
    await messages().updateOne(
      { messageId: 'u-scheduled-0' },
      {
        $set: { 'metadata.viventium.interactionContext.revision': 2 },
      },
    );
    expect(await runtime.completeAcceptedMainCompaction({ ...identity, ...claim })).toMatchObject({
      status: 'stale_source',
    });
    expect((await history()).count).toBe(4);
  });

  it.each([
    ['wrong owner', { user: 'another-owner' }],
    ['wrong conversation', { 'metadata.viventium.interactionContext.conversation_id': 'other' }],
    ['wrong logical turn', { 'metadata.viventium.interactionContext.logical_turn_id': 'other' }],
    ['wrong revision', { 'metadata.viventium.interactionContext.revision': 2 }],
    ['wrong actor', { 'metadata.viventium.interactionContext.actor_kind': 'human' }],
    ['missing schedule', { 'metadata.viventium.interactionContext.schedule_id': '' }],
    ['missing run', { 'metadata.viventium.interactionContext.schedule_run_id': '' }],
  ])('keeps an internal source unavailable with %s', async (_label, changes) => {
    const turn = await acceptedScheduledSource('invalid-scheduled');
    await messages().updateOne({ messageId: turn.userMessageId }, { $set: changes });
    expect(await service().loadAcceptedMainContext(identity)).toMatchObject({
      status: 'unavailable',
      reason: 'source_unavailable',
    });
    expect(await service().claimAcceptedMainCompaction(identity)).toMatchObject({
      status: 'empty',
    });
  });

  it('does not replace explicit interactive provenance from an internal scheduler parent', async () => {
    const turn = await acceptedScheduledSource('explicit-interactive');
    await messages().updateOne(
      { messageId: turn.assistantMessageId },
      {
        $set: { 'metadata.viventium.interactionContext.origin': 'interactive' },
      },
    );
    expect(await service().loadAcceptedMainContext(identity)).toMatchObject({
      status: 'unavailable',
    });
  });

  it('does not promote source edited after hydration and before the state CAS', async () => {
    let raced = false;
    let mutationCommitted = false;
    const runtime = service({
      beforeSwap: async (next) => {
        if (raced || !next.semanticCompaction || next.compactionLease) return;
        raced = true;
        // A separate raw-driver transaction cannot inherit the compaction session.
        const session = await mongoose.startSession();
        session.startTransaction();
        try {
          await messages().collection.updateOne(
            { user: ownerId, messageId: 'u-race-0' },
            { $set: { text: 'Cancel the draft. Do not continue it.' }, $inc: { __v: 1 } },
            { session },
          );
          await session.commitTransaction();
          mutationCommitted = true;
        } catch (error) {
          if (session.inTransaction()) await session.abortTransaction();
          expect(error).toMatchObject({ code: 112 });
        } finally {
          await session.endSession();
        }
      },
    });
    for (let n = 0; n < 4; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`race-${n}`));
    const claim = await runtime.claimAcceptedMainCompaction(identity);
    expect(claim.status).toBe('claimed');
    const candidate = prepareMainCompactionCandidate(
      {
        version: 1,
        summary: 'The draft work remains accepted.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      },
      { sourceTurns: claim.sourceTurns as AcceptedMainTurn[], previousSemanticCompaction: null },
    );
    const result = await runtime.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: candidate,
      semanticReview: {
        version: 1,
        approved: true,
        sourceDigest: claim.sourceDigest,
        candidateDigest: mainCompactionCandidateDigest(candidate!),
      },
    });
    expect(raced).toBe(true);
    if (mutationCommitted) {
      expect(result.status).not.toBe('compacted');
      expect((await service().loadAcceptedMainContext(identity)).semanticCompaction).toBeNull();
    } else {
      expect(result.status).toBe('compacted');
      expect((await messages().findOne({ messageId: 'u-race-0' }).orFail().lean()).text).toBe(
        'Valid request race-0.',
      );
    }
  });
  it('keeps newer epoch accepted history after old epoch promotion and reload', async () => {
    const runtime = service();
    for (let n = 0; n < 4; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`epoch-${n}`));
    const claim = await runtime.claimAcceptedMainCompaction(identity);
    const nextEpoch = { ...identity, stableAuthoritySha256: 'b'.repeat(64) };
    await runtime.commitAcceptedMainTurn({ ...(await presentation('epoch-4')), ...nextEpoch });
    const candidate = prepareMainCompactionCandidate(
      {
        version: 1,
        summary: 'The earlier request was accepted.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      },
      { sourceTurns: claim.sourceTurns as AcceptedMainTurn[], previousSemanticCompaction: null },
    );
    expect(
      await runtime.completeAcceptedMainCompaction({
        ...identity,
        ...claim,
        semanticCompaction: candidate,
        semanticReview: {
          version: 1,
          approved: true,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(candidate!),
        },
      }),
    ).toMatchObject({ status: 'compacted' });
    const loaded = await service().loadAcceptedMainContext(nextEpoch);
    expect(loaded.sourceTurns).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalTurnId: 'epoch-4' })]),
    );
    expect(loaded.semanticCompaction).toBeNull();
  });
  it('retains concurrent first accepted projections across two actual authority epochs', async () => {
    const runtime = service();
    const first = await presentation('concurrent-a');
    const second = {
      ...(await presentation('concurrent-b')),
      stableAuthoritySha256: 'b'.repeat(64),
    };
    expect(
      (
        await Promise.all([
          runtime.commitAcceptedMainTurn(first),
          runtime.commitAcceptedMainTurn(second),
        ])
      ).map((result) => result.status),
    ).toEqual(['committed', 'committed']);
    const loaded = await service().loadAcceptedMainContext(second);
    expect(loaded.sourceTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logicalTurnId: 'concurrent-a' }),
        expect.objectContaining({ logicalTurnId: 'concurrent-b' }),
      ]),
    );
  });
  it('fences a newer correction on different Message IDs during old-prefix promotion', async () => {
    let triedCorrection = false;
    const newer = await presentation('new-correction', 'logical', 2);
    const runtime = service({
      beforeSwap: async (next) => {
        if (triedCorrection || !next.semanticCompaction || next.compactionLease) return;
        triedCorrection = true;
        const storage = (
          mongoose as unknown as {
            transactionAsyncLocalStorage: {
              run: <T>(context: undefined, operation: () => Promise<T>) => Promise<T>;
            };
          }
        ).transactionAsyncLocalStorage;
        await expect(
          storage.run(undefined, () => service().commitAcceptedMainTurn(newer)),
        ).rejects.toMatchObject({ code: 112 });
      },
    });
    await runtime.commitAcceptedMainTurn(await presentation('old-correction', 'logical', 1));
    for (let n = 0; n < 3; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`correction-later-${n}`));
    await compact(runtime);
    expect(triedCorrection).toBe(true);
    expect(await runtime.commitAcceptedMainTurn(newer)).toMatchObject({ status: 'committed' });
    const loaded = await service().loadAcceptedMainContext(identity);
    expect(loaded.semanticCompaction).toBeNull();
    expect(loaded.sourceTurns).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalTurnId: 'logical', revision: 2 })]),
    );
  });
  it.each(['edit', 'delete'])(
    'invalidates an already-promoted cache after an actual source %s',
    async (change) => {
      const runtime = service();
      for (let n = 0; n < 4; n++)
        await runtime.commitAcceptedMainTurn(await presentation(`promoted-${n}`));
      await compact(runtime);
      expect((await runtime.loadAcceptedMainContext(identity)).semanticCompaction).not.toBeNull();
      const filter = { user: ownerId, messageId: 'u-promoted-0' };
      await transaction(() =>
        methods.mutateAcceptedMainContinuitySources(filter, () =>
          change === 'delete'
            ? messages()
                .deleteMany(filter)
                .then(() => undefined)
            : messages()
                .updateOne(filter, { $set: { text: 'Cancel the draft.' } })
                .then(() => undefined),
        ),
      );
      const loaded = await service().loadAcceptedMainContext(identity);
      expect(loaded.semanticCompaction).toBeNull();
      if (change === 'edit')
        expect(loaded.sourceTurns).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ logicalTurnId: 'promoted-0', userText: 'Cancel the draft.' }),
          ]),
        );
      else
        expect(
          (loaded.sourceTurns as AcceptedMainTurn[]).some(
            (turn) => turn.logicalTurnId === 'promoted-0',
          ),
        ).toBe(false);
    },
  );
  it('keeps legacy inputs available for epoch B after reviewed reconciliation in epoch A', async () => {
    const oldTurn = await presentation('legacy');
    const originalKey = createHash('sha256')
      .update(`${domainIdentity().continuityDomainId}\0${identity.stableAuthoritySha256}`)
      .digest('hex');
    const legacy = await states().create({
      ...domainIdentity(),
      domainEpochKey: originalKey,
      contextEpoch: identity.stableAuthoritySha256,
      acceptedTurns: [{ ...oldTurn, committedAt: new Date() }],
      semanticCompaction: {
        version: 1,
        summary: 'An older summary reported a private draft.',
        sourceDigest: 'c'.repeat(64),
        generatedAt: new Date(),
      },
    });
    const original = legacy.toObject();
    const runtime = service();
    const finish = async (context: typeof identity) => {
      const claim = await runtime.claimAcceptedMainCompaction(context);
      expect(claim.status).toBe('claimed');
      expect(claim.legacyInputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: originalKey, kind: 'legacy_state' }),
        ]),
      );
      const candidate = prepareMainCompactionCandidate(
        {
          version: 1,
          summary:
            'An older summary reported a private draft; the recovered request and reply are retained as historical evidence.',
          pendingAsks: [],
          commitments: [],
          corrections: [],
          decisions: [],
          durableIdentifiers: [],
          recurrenceOutcomes: [],
          toolPairs: [],
        },
        {
          previousSemanticCompaction: null,
          sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
          legacyInputs: claim.legacyInputs as Record<string, unknown>[],
        },
      )!;
      expect(
        await runtime.completeAcceptedMainCompaction({
          ...context,
          ...claim,
          semanticCompaction: candidate,
          semanticReview: {
            version: 1,
            approved: true,
            sourceDigest: claim.sourceDigest,
            candidateDigest: mainCompactionCandidateDigest(candidate),
          },
        }),
      ).toMatchObject({ status: 'compacted' });
      expect(await runtime.claimAcceptedMainCompaction(context)).toMatchObject({ status: 'empty' });
      return claim;
    };
    const a = await finish(identity),
      epochB = { ...identity, stableAuthoritySha256: 'b'.repeat(64) };
    expect((await runtime.loadAcceptedMainContext(epochB)).semanticCompaction).toBeNull();
    const b = await finish(epochB);
    expect(b.sourceDigest).not.toBe(a.sourceDigest);
    expect({
      ...(await states().findOne({ domainEpochKey: originalKey }).orFail().lean()),
      recordKind: undefined,
    }).toEqual({ ...original, recordKind: undefined });
  });
  it('keeps late duplicate authority after compaction, cache eviction and reconstruction', async () => {
    const runtime = service(),
      old = await presentation('old', 'old-logical', 2);
    await runtime.commitAcceptedMainTurn(old);
    for (let n = 0; n < 3; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`early-${n}`));
    await compact(runtime);
    for (let n = 0; n < 131; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`later-${n}`));
    const before = await history();
    expect(await service().commitAcceptedMainTurn(old)).toMatchObject({
      status: 'already_committed',
    });
    expect(await service().commitAcceptedMainTurn({ ...old, revision: 1 })).toMatchObject({
      status: 'already_committed',
    });
    const after = await history();
    expect(after.position).toBe(before.position);
    expect((await service().loadAcceptedMainContext(identity)).sourceTurns).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalTurnId: 'later-130' })]),
    );
    expect(
      (await messages().findOne({ messageId: 'a-old' }).orFail().lean()).acceptedMainContext,
    ).toBeUndefined();
  }, 30000);
  it('retains deleted highest revision floors after 128 turns and an epoch change', async () => {
    const runtime = service(),
      old = await presentation('unprojected', 'logical', 1),
      newer = await presentation('newer', 'logical', 2);
    await runtime.commitAcceptedMainTurn(newer);
    for (let n = 0; n < 131; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`later-${n}`));
    const epoch = { ...identity, stableAuthoritySha256: 'b'.repeat(64) };
    await runtime.commitAcceptedMainTurn({ ...(await presentation('new-epoch')), ...epoch });
    const epochTimes = new Map(
      (await states().find().lean()).map((state) => [
        state.domainEpochKey,
        state.updatedAt?.getTime(),
      ]),
    );
    await transaction(async () => {
      await deleteSource(newer.assistantMessageId);
    });
    for (const state of await states().find().lean())
      if (epochTimes.has(state.domainEpochKey))
        expect(state.updatedAt?.getTime()).toBe(epochTimes.get(state.domainEpochKey));
    expect(
      await states().findOne({ recordKind: 'revision_floor', logicalTurnId: 'logical' }).lean(),
    ).toMatchObject({ revisionFloor: 2 });
    expect(await service().commitAcceptedMainTurn({ ...old, ...epoch })).toMatchObject({
      status: 'already_committed',
    });
    expect(
      (
        await messages()
          .findOne({ messageId: old.assistantMessageId })
          .select('+acceptedMainContext')
          .orFail()
          .lean()
      ).acceptedMainContext,
    ).toBeUndefined();
  }, 30000);
  it('compacts valid later work after deletion but preserves unproven missing source', async () => {
    const runtime = service();
    for (let n = 0; n < 4; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`initial-${n}`));
    const source = await messages().findOne({ messageId: 'u-initial-0' }).orFail().lean();
    await messages().deleteMany({ messageId: source.messageId });
    expect(await runtime.claimAcceptedMainCompaction(identity)).toMatchObject({
      status: 'degraded',
      reason: 'source_unavailable',
    });
    expect((await history()).count).toBe(4);
    await messages().create(source);
    transient = true;
    await expect(runtime.claimAcceptedMainCompaction(identity)).rejects.toThrow('transient_read');
    transient = false;
    await transaction(async () => {
      await deleteSource(source.messageId);
    });
    for (let n = 0; n < 8; n++)
      await runtime.commitAcceptedMainTurn(await presentation(`valid-${n}`));
    const claim = await compact(runtime);
    expect(
      (claim.sourceTurns as AcceptedMainTurn[]).some((turn) => turn.logicalTurnId === 'initial-0'),
    ).toBe(false);
    const loaded = await service().loadAcceptedMainContext(identity);
    expect(loaded.compactionStatus).toBe('ready');
    expect(loaded.sourceTurns).toEqual(
      expect.arrayContaining([expect.objectContaining({ logicalTurnId: 'valid-7' })]),
    );
    expect(loaded.pendingCompactionCount).toBe(0);
    expect(String(loaded.messageCapsule)).not.toContain('sourceDeleted');
  });
  it('keeps proven legacy retirement distinct from unproven missing source before model assembly', async () => {
    const retired = await presentation('retired-legacy'),
      missing = await presentation('missing-legacy');
    const originalKey = createHash('sha256')
      .update(`${domainIdentity().continuityDomainId}\0${identity.stableAuthoritySha256}`)
      .digest('hex');
    await states().create({
      ...domainIdentity(),
      domainEpochKey: originalKey,
      contextEpoch: identity.stableAuthoritySha256,
      acceptedTurns: [retired, missing].map((turn) => ({ ...turn, committedAt: new Date() })),
      semanticCompaction: {
        version: 1,
        summary: 'Historical claims whose original sources need reconciliation.',
        sourceDigest: 'c'.repeat(64),
        generatedAt: new Date(),
      },
    });
    await transaction(() => deleteSource(retired.userMessageId));
    await messages().deleteOne({ user: ownerId, messageId: missing.userMessageId });
    const runtime = service();
    const claim = await runtime.claimAcceptedMainCompaction(identity);
    expect(claim.status).toBe('claimed');
    expect(claim.legacyInputs).toEqual([
      expect.objectContaining({
        sourceTurns: [],
        retiredSources: [
          {
            logicalTurnId: retired.logicalTurnId,
            revision: retired.revision,
            reason: 'source_deleted',
          },
        ],
        unavailableSources: [],
        sourceCoverage: 'partial',
        sourceRange: expect.objectContaining({ start: 0, end: 1, total: 2 }),
      }),
    ]);
    const candidate = prepareMainCompactionCandidate({
      version: 1,
      summary: 'The retired source is excluded. The historical claims still need reconciliation.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
    expect(candidate).not.toBeNull();
    expect(
      await runtime.completeAcceptedMainCompaction({
        ...identity,
        ...claim,
        semanticCompaction: candidate,
        semanticReview: {
          version: 1,
          approved: true,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(candidate!),
        },
      }),
    ).toMatchObject({ status: 'compacted' });
    const epoch = await states().findOne({ recordKind: 'epoch' }).orFail().lean();
    expect(epoch.legacySourceOffset).toBe(1);
    expect(epoch.legacyComplete).toBe(false);
    expect(await service().claimAcceptedMainCompaction(identity)).toMatchObject({
      status: 'degraded',
      reason: 'source_unavailable',
    });
    expect((await states().findById(epoch._id).orFail().lean()).legacySourceOffset).toBe(1);
  });
  it('locks both sources and rolls back the state with projection/deletion failures', async () => {
    const turn = await presentation('rollback');
    await expect(
      methods.projectAcceptedMainPresentation(
        { ...identity, continuityDomainId: service().continuityDomainId(ownerId, 'main') },
        turn,
        async () => {
          const rows = await messages()
            .find({ messageId: { $in: [turn.userMessageId, turn.assistantMessageId] } })
            .lean();
          expect(rows.every((row) => row.__v === 1)).toBe(true);
          await messages().updateOne(
            { messageId: turn.assistantMessageId },
            { text: 'Must roll back.' },
          );
          throw new Error('projection_failed');
        },
        transaction,
      ),
    ).rejects.toThrow('projection_failed');
    const row = await messages()
      .findOne({ messageId: turn.assistantMessageId })
      .select('+acceptedMainContext')
      .orFail()
      .lean();
    expect(row.acceptedMainContext).toBeUndefined();
    expect(row.text).toBe(turn.assistantText);
    expect(row.__v).toBe(0);
    await expect(
      transaction(async () => {
        expect(await service().commitAcceptedMainTurn(turn)).toMatchObject({ status: 'committed' });
        throw new Error('outer_projection_failed');
      }),
    ).rejects.toThrow('outer_projection_failed');
    expect(await states().countDocuments()).toBe(0);
    expect(
      (
        await messages()
          .findOne({ messageId: turn.assistantMessageId })
          .select('+acceptedMainContext')
          .orFail()
          .lean()
      ).acceptedMainContext,
    ).toBeUndefined();
    await service().commitAcceptedMainTurn(turn);
    const before = await states().findOne().orFail().lean();
    await expect(
      transaction(async () => {
        await deleteSource(turn.userMessageId);
        throw new Error('delete_failed');
      }),
    ).rejects.toThrow('delete_failed');
    expect(await messages().findOne({ messageId: turn.userMessageId })).not.toBeNull();
    expect((await states().findOne().orFail().lean()).version).toBe(before.version);
    expect((await history()).count).toBe(1);
  });
  it('prevents a concurrent parent deletion from leaving an unmarked accepted reference', async () => {
    const turn = await presentation('concurrent-delete');
    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acceptance = methods.projectAcceptedMainPresentation(
      { ...identity, continuityDomainId: service().continuityDomainId(ownerId, 'main') },
      turn,
      async () => {
        locked();
        await proceed;
        return service().commitAcceptedMainTurn(turn);
      },
      transaction,
    );
    await ready;
    const filter = { user: ownerId, messageId: turn.userMessageId };
    try {
      await expect(
        transaction(async () => {
          await methods.mutateAcceptedMainContinuitySources(filter, () =>
            messages().deleteMany(filter),
          );
        }),
      ).rejects.toMatchObject({ code: 112 });
    } finally {
      release();
    }
    expect(await acceptance).toMatchObject({ status: 'committed' });
    expect(await messages().findOne(filter)).not.toBeNull();
    await transaction(async () => {
      await methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages().deleteMany(filter),
      );
    });
    expect(
      (
        await messages()
          .findOne({ messageId: turn.assistantMessageId })
          .select('+acceptedMainContext')
          .orFail()
          .lean()
      ).acceptedMainContext?.sourceDeletedAt,
    ).toBeInstanceOf(Date);
    expect((await service().loadAcceptedMainContext(identity)).sourceTurns).toEqual([]);
  });
  it('does not retire another owner’s continuity through a foreign projection marker', async () => {
    const turn = await presentation('owner-scoped');
    await service().commitAcceptedMainTurn(turn);
    const before = await states().findOne().orFail().lean();
    const foreignOwner = new mongoose.Types.ObjectId().toString();
    await messages().create({
      user: foreignOwner,
      conversationId: 'foreign',
      messageId: 'foreign-source',
      isCreatedByUser: false,
      text: 'Foreign source.',
      acceptedMainContext: {
        continuityDomainId: before.continuityDomainId,
        logicalTurnId: turn.logicalTurnId,
        revision: turn.revision,
        committedAt: new Date(),
      },
    });
    await transaction(async () => {
      const filter = { user: foreignOwner, messageId: 'foreign-source' };
      await methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages().deleteMany(filter),
      );
    });
    const after = await states().findOne().orFail().lean();
    expect(after.version).toBe(before.version);
    expect((await history()).count).toBe(1);
    expect((await service().loadAcceptedMainContext(identity)).sourceTurns).toHaveLength(1);
  });
});
