/* === VIVENTIUM START === Native persistence tests have no reverse API import. === */
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createModels } from '~/models';
import {
  createMainContinuityMethods,
  mainContinuityStorageKey,
  mainContinuityMessageEvidence,
} from './mainContinuity';
import type { IMessage } from '~/types/message';
import type { IViventiumMainContinuityState } from '~/types/mainContinuityState';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
describe('native accepted history storage', () => {
  let server: MongoMemoryReplSet;
  let methods: ReturnType<typeof createMainContinuityMethods>;
  const ownerId = new mongoose.Types.ObjectId().toString(),
    agentId = 'main';
  const identity = {
    ownerId,
    agentId,
    continuityDomainId: sha(JSON.stringify({ version: 1, ownerId, agentId })),
  };
  const messages = () => mongoose.model<IMessage>('Message');
  const states = () =>
    mongoose.model<IViventiumMainContinuityState>('ViventiumMainContinuityState');
  const transaction = <T>(operation: () => Promise<T>) =>
    mongoose.connection.transaction(operation);
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());
    mongoose.set('transactionAsyncLocalStorage', true);
    createModels(mongoose);
    await Promise.all([messages().init(), states().init()]);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await Promise.all([
      messages().deleteMany({}),
      states().deleteMany({}),
      mongoose.model('Conversation').deleteMany({}),
    ]);
    await mongoose.model('Conversation').create({
      user: ownerId,
      conversationId: 'conversation',
      agent_id: agentId,
      endpoint: 'agents',
    });
    methods = createMainContinuityMethods(mongoose);
  });
  async function source(id: string, logicalTurnId = id, revision = 1) {
    const turn = {
      logicalTurnId,
      revision,
      userMessageId: `u-${id}`,
      assistantMessageId: `a-${id}`,
      conversationId: 'conversation',
      origin: 'interactive',
    };
    await messages().create([
      {
        user: ownerId,
        messageId: turn.userMessageId,
        conversationId: turn.conversationId,
        isCreatedByUser: true,
        text: 'Keep private.',
      },
      {
        user: ownerId,
        messageId: turn.assistantMessageId,
        parentMessageId: turn.userMessageId,
        conversationId: turn.conversationId,
        isCreatedByUser: false,
        unfinished: false,
        text: 'I will wait.',
        metadata: {
          viventium: {
            mainContext: { agentId },
            interactionContext: { logical_turn_id: logicalTurnId, revision },
          },
        },
      },
    ]);
    return turn;
  }
  const accept = async (turn: Awaited<ReturnType<typeof source>>) =>
    methods.projectAcceptedMainPresentation(
      identity,
      turn,
      async () => ({ status: 'committed' }),
      transaction,
    );
  test('acceptance and fenced history reads do not overlap queries in one session', async () => {
    const turn = await source('serial');
    const execute = mongoose.Query.prototype.exec;
    const active = new Set<object>();
    const runtimeMongoose = mongoose as typeof mongoose & {
      transactionAsyncLocalStorage?: {
        getStore: () => { session?: { inTransaction: () => boolean } } | undefined;
      };
    };
    const spy = jest.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function (
      this: mongoose.Query<unknown, unknown>,
      ...args
    ) {
      const session = runtimeMongoose.transactionAsyncLocalStorage?.getStore()?.session;
      if (!session?.inTransaction()) return execute.apply(this, args);
      if (active.has(session)) throw new Error('parallel_query_in_transaction');
      active.add(session);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await execute.apply(this, args);
      } finally {
        active.delete(session);
      }
    });
    try {
      expect(await accept(turn)).toMatchObject({ status: 'committed' });
      expect(
        await methods.fenceAcceptedMainCompaction(
          identity,
          [turn],
          async () => {
            const history = await methods.readAcceptedMainHistory(identity);
            return { status: history.count === 1 ? 'committed' : 'missing' };
          },
          transaction,
        ),
      ).toMatchObject({ status: 'committed' });
    } finally {
      spy.mockRestore();
    }
  });
  test('concurrent first projections share a monotonic native position', async () => {
    const a = await source('a'),
      b = await source('b');
    expect((await Promise.all([accept(a), accept(b)])).map((item) => item.status)).toEqual([
      'committed',
      'committed',
    ]);
    const page = await methods.readAcceptedMainHistory(identity);
    expect(page.position).toBe(2);
    expect(page.turns.map((turn) => turn.acceptedPosition)).toEqual([1, 2]);
    expect(new Set(page.turns.map((turn) => turn.logicalTurnId))).toEqual(new Set(['a', 'b']));
    const control = await states().findOne({ recordKind: 'domain' }).orFail().lean();
    expect(await accept(a)).toMatchObject({ status: 'already_committed' });
    expect(await states().countDocuments({ recordKind: 'revision_floor' })).toBe(0);
    expect(control.acceptedTurns).toBeUndefined();
    expect(control.pendingCompactionTurns).toBeUndefined();
    expect(control.contextEpoch).toBeUndefined();
  });
  test('correction has a later position and invalidates source generation', async () => {
    await accept(await source('a', 'logical', 1));
    await accept(await source('b', 'logical', 2));
    const page = await methods.readAcceptedMainHistory(identity);
    expect(page).toMatchObject({ position: 2, generation: 1, count: 1 });
    expect(page.turns[0]).toMatchObject({
      logicalTurnId: 'logical',
      revision: 2,
      acceptedPosition: 2,
    });
    expect(await accept(await source('stale', 'logical', 1))).toMatchObject({
      status: 'already_committed',
      acceptedRevision: 2,
    });
  });
  test('hard deletion retains a per-turn floor and permits later independent work', async () => {
    const newer = await source('newer', 'logical', 2),
      old = await source('old', 'logical', 1);
    await accept(newer);
    const filter = { user: ownerId, messageId: newer.assistantMessageId };
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages()
          .deleteMany(filter)
          .then(() => undefined),
      ),
    );
    expect(await accept(old)).toMatchObject({ status: 'already_committed', acceptedRevision: 2 });
    expect(await accept(await source('later'))).toMatchObject({ status: 'committed' });
    expect(
      (await methods.readAcceptedMainHistory(identity)).turns.map((turn) => turn.logicalTurnId),
    ).toEqual(['later']);
    expect(
      await states().findOne({ recordKind: 'revision_floor', logicalTurnId: 'logical' }).lean(),
    ).toMatchObject({ revisionFloor: 2 });
  });
  test('source edits invalidate generation but locks and receipt attachments do not', async () => {
    const turn = await source('a');
    await accept(turn);
    const filter = { user: ownerId, messageId: turn.userMessageId };
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages()
          .updateOne(filter, {
            $inc: { __v: 1 },
            $set: { attachments: [{ type: 'memory', memory: { type: 'update', key: 'style' } }] },
          })
          .then(() => undefined),
      ),
    );
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(0);
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages()
          .updateOne(filter, { $set: { text: 'Cancel the draft.' } })
          .then(() => undefined),
      ),
    );
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(1);
  });
  test('content-only authored edits invalidate history while preserving accepted identity', async () => {
    const turn = await source('content-edit');
    const filter = { user: ownerId, messageId: turn.assistantMessageId };
    await messages().updateOne(filter, {
      $set: { content: [{ type: 'text', text: 'I will wait.' }] },
    });
    await accept(turn);
    const before = await messages().findOne(filter).select('+acceptedMainContext').orFail().lean();
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () =>
        messages().updateOne(filter, {
          $set: { 'content.0.text': 'The corrected authored answer.' },
        }),
      ),
    );
    const after = await messages().findOne(filter).select('+acceptedMainContext').orFail().lean();
    expect(after.text).toBe(before.text);
    expect(mainContinuityMessageEvidence(after).text).toBe('The corrected authored answer.');
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(1);
    expect(after.acceptedMainContext).toEqual(before.acceptedMainContext);
    expect(after.metadata).toEqual(before.metadata);
  });

  test('rolls back native position and marker with the inherited transaction', async () => {
    const turn = await source('rollback');
    await expect(
      transaction(async () => {
        await accept(turn);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await states().countDocuments({ recordKind: 'domain' })).toBe(0);
    expect(
      (
        await messages()
          .findOne({ messageId: turn.assistantMessageId })
          .select('+acceptedMainContext')
          .orFail()
          .lean()
      ).acceptedMainContext,
    ).toBeUndefined();
  });
  test('receipt-only content appends preserve generation while a completed tool result changes source', async () => {
    const turn = await source('phase-b');
    await accept(turn);
    const filter = { user: ownerId, messageId: turn.assistantMessageId };
    const append = (content: unknown) =>
      transaction(() =>
        methods.mutateAcceptedMainContinuitySources(filter, () =>
          messages().updateOne(filter, { $push: { content } }),
        ),
      );
    await append({ type: 'memory', memory: { type: 'update', key: 'style' } });
    await append({ type: 'think', think: 'Private system reasoning.' });
    await append({ type: 'tool_call', tool_call: { id: 'call', name: 'search' } });
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(0);
    await append({
      type: 'tool_call',
      tool_call: { id: 'call', name: 'search', output: 'The requested record exists.' },
    });
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(1);
  });
  test('legacy inputs and revision evidence remain intact for every epoch cursor', async () => {
    const authority = 'a'.repeat(64),
      key = sha(`${identity.continuityDomainId}\0${authority}`);
    const legacy = await states().create({
      ...identity,
      domainEpochKey: key,
      contextEpoch: authority,
      stableAuthoritySha256: authority,
      acceptedRevisions: [{ logicalTurnId: 'old', revision: 4 }],
      semanticCompaction: {
        version: 1,
        summary: 'Historic draft remains private.',
        sourceDigest: 'b'.repeat(64),
        generatedAt: new Date(),
      },
    });
    const before = legacy.toObject();
    await states().collection.createIndex(
      { ownerId: 1, agentId: 1, contextEpoch: 1 },
      { unique: true },
    );
    await methods.ensureAcceptedMainDomain(identity);
    expect({
      ...(await states().findOne({ domainEpochKey: key }).orFail().lean()),
      recordKind: undefined,
    }).toEqual({ ...before, recordKind: undefined });
    const a = await methods.readLegacyMainInput(identity);
    expect(await methods.readLegacyMainInput(identity)).toEqual(a);
    expect(a.artifact).toMatchObject({ kind: 'legacy_state', id: key });
    expect(await methods.readLegacyMainInput(identity, { state: a.stateCursor })).toMatchObject({
      complete: true,
    });
    expect(await methods.readLegacyMainInput(identity)).toEqual(a);
    expect(await accept(await source('late-old', 'old', 2))).toMatchObject({
      status: 'already_committed',
      acceptedRevision: 4,
    });
    expect(
      (await states().collection.indexes()).some(
        (index) => index.name === 'ownerId_1_agentId_1_contextEpoch_1',
      ),
    ).toBe(false);
  });
  test('reads bounded exact ranges without changing the immutable legacy artifact', async () => {
    const authority = 'a'.repeat(64),
      key = sha(`${identity.continuityDomainId}\0${authority}`);
    const turns = Array.from({ length: 70 }, (_, i) => ({
      logicalTurnId: `old-${i}`,
      revision: 1,
      assistantMessageId: `old-answer-${i}`,
      userMessageId: `old-user-${i}`,
      conversationId: 'conversation',
      origin: 'interactive',
      userText: `Source ${i}`,
      assistantText: `Answer ${i}`,
      committedAt: new Date(0),
    }));
    await states().create({
      ...identity,
      domainEpochKey: key,
      contextEpoch: authority,
      stableAuthoritySha256: authority,
      pendingCompactionTurns: turns.slice(0, 67),
      acceptedTurns: turns.slice(67),
    });
    await methods.ensureAcceptedMainDomain(identity);
    const original = await states().findOne({ domainEpochKey: key }).lean();
    const first = await methods.readLegacyMainInput(identity);
    expect(first.artifact?.sourceTurns).toHaveLength(64);
    expect(first.artifact?.sourceRange).toEqual({ artifactId: key, start: 0, end: 64, total: 70 });
    const last = await methods.readLegacyMainInput(identity, { sourceOffset: 64 });
    expect(last.artifact?.sourceTurns.map((turn) => turn.logicalTurnId)).toEqual(
      turns.slice(64).map((turn) => turn.logicalTurnId),
    );
    const exact = await methods.readLegacyMainInput(identity, {
      range: { artifactId: key, start: 4, end: 7, total: 70 },
    });
    expect(exact.artifact?.sourceTurns.map((turn) => turn.logicalTurnId)).toEqual([
      'old-4',
      'old-5',
      'old-6',
    ]);
    expect(await states().findOne({ domainEpochKey: key }).lean()).toEqual(original);
  });
  test('unknown historical identity leaves the legacy index intact', async () => {
    await states().collection.insertOne({
      ...identity,
      domainEpochKey: 'unmapped',
      contextEpoch: 'unmapped',
      stableAuthoritySha256: 'a'.repeat(64),
    } as never);
    await states().collection.createIndex(
      { ownerId: 1, agentId: 1, contextEpoch: 1 },
      { unique: true },
    );
    await expect(methods.ensureMainContinuityIndexes()).rejects.toThrow(
      'main_continuity_legacy_identity_mismatch',
    );
    expect(
      (await states().collection.indexes()).some(
        (index) => index.name === 'ownerId_1_agentId_1_contextEpoch_1',
      ),
    ).toBe(true);
    await states().collection.dropIndex('ownerId_1_agentId_1_contextEpoch_1');
  });
  test('requires the existing transaction before source mutation', async () => {
    const turn = await source('outside');
    const filter = { user: ownerId, messageId: turn.userMessageId };
    await expect(
      methods.mutateAcceptedMainContinuitySources(filter, () => messages().deleteMany(filter)),
    ).rejects.toThrow('main_continuity_mutation_transaction_required');
    expect(await messages().exists(filter)).not.toBeNull();
  });
  test('retains a deletion floor before the first legacy reconciliation read', async () => {
    const turn = await source('unclassified', 'old-logical', 4);
    const authority = 'a'.repeat(64);
    const key = sha(`${identity.continuityDomainId}\0${authority}`);
    await states().create({
      ...identity,
      domainEpochKey: key,
      contextEpoch: authority,
      stableAuthoritySha256: authority,
      acceptedTurns: [
        {
          ...turn,
          committedAt: new Date(),
          userText: 'Keep private.',
          assistantText: 'I will wait.',
        },
      ],
    });
    const filter = { user: ownerId, messageId: turn.userMessageId };
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () => messages().deleteMany(filter)),
    );
    expect(
      await states().findOne({ recordKind: 'revision_floor', logicalTurnId: 'old-logical' }).lean(),
    ).toMatchObject({ revisionFloor: 4, deletedRevisionFloor: 4 });
    expect((await methods.readAcceptedMainHistory(identity)).generation).toBe(1);
    expect((await methods.readLegacyMainInput(identity)).artifact).toMatchObject({
      retiredSources: [{ logicalTurnId: 'old-logical', revision: 4, reason: 'source_deleted' }],
    });
    expect(await accept(await source('late-legacy', 'old-logical', 3))).toMatchObject({
      status: 'already_committed',
      acceptedRevision: 4,
    });
  });
  test('keys distinguish domains, epochs and per-turn floors', () => {
    expect(
      new Set(
        ['domain', 'epoch', 'revision_floor'].map((kind) =>
          mainContinuityStorageKey(kind, identity.continuityDomainId, 'same'),
        ),
      ).size,
    ).toBe(3);
  });
  test('imports a retained pending source revision after the old revision cache evicts it', async () => {
    const old = await source('old-source', 'old-logical', 4);
    const authority = 'a'.repeat(64);
    await states().create({
      ...identity,
      domainEpochKey: sha(`${identity.continuityDomainId}\0${authority}`),
      contextEpoch: authority,
      stableAuthoritySha256: authority,
      pendingCompactionTurns: [
        {
          ...old,
          committedAt: new Date(),
          userText: 'Keep private.',
          assistantText: 'I will wait.',
        },
      ],
      acceptedRevisions: Array.from({ length: 128 }, (_, i) => ({
        logicalTurnId: `later-${i}`,
        revision: 1,
      })),
    });
    expect(await accept(await source('late-old-presentation', 'old-logical', 3))).toMatchObject({
      status: 'already_committed',
      acceptedRevision: 4,
    });
  });
  test('a lower deletion floor must not hide a higher retained legacy revision', async () => {
    const high = await source('retained-high', 'shared-logical', 4);
    const low = await source('deleted-low', 'shared-logical', 2);
    const authority = 'a'.repeat(64);
    await states().create({
      ...identity,
      domainEpochKey: sha(`${identity.continuityDomainId}\0${authority}`),
      contextEpoch: authority,
      stableAuthoritySha256: authority,
      pendingCompactionTurns: [low, high].map((turn) => ({
        ...turn,
        committedAt: new Date(),
        userText: 'Keep private.',
        assistantText: 'I will wait.',
      })),
    });
    const filter = { user: ownerId, messageId: low.userMessageId };
    await transaction(() =>
      methods.mutateAcceptedMainContinuitySources(filter, () => messages().deleteMany(filter)),
    );
    expect(
      await states()
        .findOne({ recordKind: 'revision_floor', logicalTurnId: 'shared-logical' })
        .lean(),
    ).toMatchObject({ revisionFloor: 2, deletedRevisionFloor: 2 });
    expect(await accept(await source('late-middle', 'shared-logical', 3))).toMatchObject({
      status: 'already_committed',
      acceptedRevision: 4,
    });
  });
});

// Authored content matches the existing message formatter's content-first selection.
test.each([
  [{ text: 'Fallback only.' }, 'Fallback only.'],
  [
    { text: 'Old cached text.', content: [{ type: 'text', text: 'Edited content.' }] },
    'Edited content.',
  ],
  [{ text: 'Old cached text.', content: [{ type: 'text', text: '' }] }, ''],
  [
    {
      text: 'Old cached text.',
      content: [{ type: 'text', text: { value: 'Structured content.' } }],
    },
    'Structured content.',
  ],
  [
    { text: 'Fallback only.', content: [{ type: 'memory' }, { type: 'text', text: {} }] },
    'Fallback only.',
  ],
])('Main evidence retains authored text precedence: %j', (message, text) => {
  expect(mainContinuityMessageEvidence(message).text).toBe(text);
});
test('content-first text keeps structured completed tool outcomes and ignores activity', () => {
  const message = {
    text: 'Old.',
    content: [
      { type: 'text', text: 'Current.' },
      {
        type: 'tool_call',
        tool_call: {
          id: 'call',
          function: { name: 'lookup' },
          output: { state: 'completed', found: false },
        },
      },
    ],
  };
  const expected = {
    text: 'Current.',
    toolPairs: [
      { callId: 'call', toolName: 'lookup', outcome: '{"state":"completed","found":false}' },
    ],
  };
  expect(mainContinuityMessageEvidence(message)).toEqual(expected);
  expect(
    mainContinuityMessageEvidence({
      ...message,
      content: [...message.content, { type: 'agent_update' }, { type: 'memory' }],
    }),
  ).toEqual(expected);
});
