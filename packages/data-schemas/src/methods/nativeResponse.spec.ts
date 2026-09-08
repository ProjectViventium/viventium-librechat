/* === VIVENTIUM START === Real Mongo transaction fences for native result publication. === */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { NativeResponseIdentity, NativeResponseCommit } from '~/types/nativeResponse';
import type { IMessage } from '~/types/message';
import { createModels } from '~/models';
import { createNativeResponseMethods, normalizeNativeResponseIdentity, nativeResponseParentSource } from './nativeResponse';

describe('native response source and final persistence', () => {
  let server: MongoMemoryReplSet;
  let methods: ReturnType<typeof createNativeResponseMethods>;
  let identity: NativeResponseIdentity;
  const user = new mongoose.Types.ObjectId().toString();
  const transaction = <T>(operation: () => Promise<T>) =>
    mongoose.connection.transaction(operation);
  const candidate = {
    text: 'The saved answer.',
    authoritySha256: 'a'.repeat(64),
    requestId: 'native-request',
    runId: 'native-run',
    responseJson: '{"saved":true}',
  };
  const commit = jest.fn(
    async (_identity: NativeResponseIdentity, digest: string): Promise<NativeResponseCommit> => ({
      status: 'committed',
      candidateSha256: digest,
    }),
  );
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());
    mongoose.set('transactionAsyncLocalStorage', true);
    createModels(mongoose);
    await mongoose.models.Message.init();
    methods = createNativeResponseMethods(mongoose);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await mongoose.models.Message.deleteMany({});
    await mongoose.models.Message.create([
      {
        messageId: 'question',
        user,
        conversationId: 'conversation',
        isCreatedByUser: true,
        text: 'Original request.',
      },
      {
        messageId: 'answer',
        user,
        conversationId: 'conversation',
        parentMessageId: 'question',
        isCreatedByUser: false,
        unfinished: true,
        text: 'In progress.',
        attachments: [{ type: 'file', file_id: 'kept' }],
      },
    ]);
    identity = {
      userId: user,
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: 1,
      logicalTurnId: 'logical',
      revision: 1,
      invocationId: 'invocation',
      bodySha256: 'b'.repeat(64),
      providerId: 'provider',
      agentId: 'agent',
      originSha256: 'c'.repeat(64),
      source: await methods.captureNativeResponseSource(user, 'conversation', 'question'),
      admittedAt: Date.now(),
      recoverUntil: Date.now() + 86_400_000,
    };
    commit.mockClear();
  });
  it('checks native evidence source without writes and rejects changed or foreign source bytes', async () => {
    const before = await mongoose.models.Message.findOne({ messageId: 'question' }).lean();
    expect(await methods.nativeResponseSourceMatches(identity)).toBe(true);
    expect(await mongoose.models.Message.findOne({ messageId: 'question' }).lean()).toEqual(before);
    expect(await methods.nativeResponseSourceMatches({ ...identity, userId: new mongoose.Types.ObjectId().toString() })).toBe(false);
    await mongoose.models.Message.updateOne({ messageId: 'question' }, { $set: { text: 'Changed input.' } });
    expect(await methods.nativeResponseSourceMatches(identity)).toBe(false);
  });
  it('rejects an edited selected parent when reading graph evidence', async () => {
    const parent = await mongoose.models.Message.create({ user, messageId: 'selected-parent',
      conversationId: 'conversation', isCreatedByUser: false, text: 'Original context.' });
    await mongoose.models.Message.updateOne({ messageId: 'question' }, { $set: { parentMessageId: 'selected-parent' } });
    identity.source = await methods.captureNativeResponseSource(user, 'conversation', 'question', nativeResponseParentSource(parent));
    expect(await methods.nativeResponseSourceMatches(identity)).toBe(true);
    await mongoose.models.Message.updateOne({ messageId: 'selected-parent' }, { $set: { text: 'Changed context.' } });
    expect(await methods.nativeResponseSourceMatches(identity)).toBe(false);
  });
  it.each(['failed', 'cancelled'] as const)(
    'materializes exact upstream %s and preserves it through augmentation',
    async (state) => {
      await methods.admitNativeResponse(identity, transaction);
      const authorize = jest.fn(async () => true);
      const saved = await methods.materializeNativeResponseTerminal(
        identity,
        state,
        authorize,
        transaction,
        (message) => message,
      );
      expect(saved).toMatchObject({
        error: true,
        unfinished: false,
        finish_reason: 'incomplete',
        nativeResponse: { status: state, terminalSnapshotStoredAt: expect.any(Number) },
        attachments: [{ type: 'file', file_id: 'kept' }],
      });
      expect(saved?.nativeResponse?.stopSnapshotStoredAt).toBeUndefined();
      expect(await methods.markNativeResponseReplayStored(identity)).toBe(true);
      const augmented = await methods.saveNativeResponseSnapshot(
        user,
        { messageId: 'answer', text: 'Late', error: false, content: [] },
        identity,
        'augmentation',
      );
      expect(augmented).toMatchObject({ text: saved?.text, error: true, unfinished: false });
      expect(augmented?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'error', error_class: `native_response_${state}` }),
        ]),
      );
    },
  );
  it('requires current publication authority for legacy unmarked terminal rows', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await methods.settleNativeResponse(identity, 'cancelled');
    await expect(
      methods.materializeNativeResponseTerminal(
        identity,
        'cancelled',
        async () => false,
        transaction,
        (message) => message,
      ),
    ).rejects.toThrow('terminal_authority_unavailable');
    expect(
      (await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.terminalSnapshotStoredAt,
    ).toBeUndefined();
    expect(
      await methods.materializeNativeResponseTerminal(
        identity,
        'cancelled',
        async () => true,
        transaction,
        (message) => message,
      ),
    ).toMatchObject({ error: true });
  });
  it('does not replace explicit Stop with an upstream terminal result', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await methods.settleNativeResponse(identity, 'cancelled', {
      text: 'Stopped partial',
      content: [],
    });
    const authorize = jest.fn(async () => true);
    expect(
      await methods.materializeNativeResponseTerminal(
        identity,
        'cancelled',
        authorize,
        transaction,
        (message) => message,
      ),
    ).toBeNull();
    expect(authorize).not.toHaveBeenCalled();
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe('Stopped partial');
  });
  it('rejects changed source before storing terminal proof', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await mongoose.models.Message.updateOne(
      { messageId: 'question' },
      { $set: { text: 'Changed' } },
    );
    await expect(
      methods.materializeNativeResponseTerminal(
        identity,
        'failed',
        async () => true,
        transaction,
        (message) => message,
      ),
    ).rejects.toThrow('source_changed');
  });
  it.each(['question', 'answer'])(
    'explicit edit of %s retires terminal snapshot and replay',
    async (messageId) => {
      await methods.admitNativeResponse(identity, transaction);
      await methods.materializeNativeResponseTerminal(
        identity,
        'failed',
        async () => true,
        transaction,
        (message) => message,
      );
      const retire = jest.fn(async () => undefined);
      await methods.mutateNativeResponseSources(
        { user, messageId },
        () =>
          mongoose.models.Message.updateOne({ user, messageId }, { $set: { text: 'Edited' } }).then(
            () => undefined,
          ),
        async () => ({ status: 'revoked' }),
        transaction,
        retire,
      );
      expect(retire).toHaveBeenCalledTimes(1);
      expect(
        (await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.terminalSnapshotStoredAt,
      ).toBeUndefined();
      expect(await methods.markNativeResponseReplayStored(identity)).toBe(false);
    },
  );
  it('admits an existing owner/source once, privately', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await methods.admitNativeResponse(identity, transaction);
    expect(
      (await mongoose.model<IMessage>('Message').findOne({ messageId: 'answer' }).lean())
        ?.nativeResponse,
    ).toBeUndefined();
    await expect(
      methods.admitNativeResponse({ ...identity, invocationId: 'other' }, transaction),
    ).rejects.toThrow();
    await expect(
      methods.admitNativeResponse({ ...identity, userId: 'other' }, transaction),
    ).rejects.toThrow();
  });
  it('omits explicit undefined request facts in BSON and admits the same identity twice', async () => {
    identity = {
      ...identity,
      sourceOrderScope: undefined,
      sourceSequence: undefined,
      deliveryDispositionRequired: undefined,
      deliveryContext: undefined,
    };
    await methods.admitNativeResponse(identity, transaction);
    await methods.admitNativeResponse(identity, transaction);
    const saved = await mongoose.models.Message.collection.findOne({ user, messageId: 'answer' });
    for (const key of [
      'sourceOrderScope',
      'sourceSequence',
      'deliveryDispositionRequired',
      'deliveryContext',
    ]) {
      expect(saved?.nativeResponse).not.toHaveProperty(key);
    }
  });
  it('re-admits historical BSON null optionals without changing their saved identity or accepting changed facts', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await mongoose.models.Message.collection.updateOne(
      { user, messageId: 'answer' },
      {
        $set: {
          'nativeResponse.sourceOrderScope': null,
          'nativeResponse.sourceSequence': null,
          'nativeResponse.deliveryDispositionRequired': null,
          'nativeResponse.deliveryContext': null,
        },
      },
    );
    const previous = (await methods.getNativeResponse(user, 'answer'))?.nativeResponse;
    await methods.admitNativeResponse(identity, transaction);
    expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse).toEqual(previous);
    for (const changed of [
      { revision: identity.revision + 1 },
      { agentId: 'another-agent' },
      { bodySha256: 'd'.repeat(64) },
      { originSha256: 'd'.repeat(64) },
      { source: { ...identity.source, digest: 'd'.repeat(64) } },
      { sourceOrderScope: 'e'.repeat(64), sourceSequence: 1 },
      { deliveryDispositionRequired: false },
      { deliveryContext: { surface: 'web' as const } },
    ]) {
      await expect(
        methods.admitNativeResponse({ ...identity, ...changed }, transaction),
      ).rejects.toThrow();
    }
  });
  it('normalizes only absent declared optional facts, preserving false, zero and mandatory nulls', () => {
    const input = {
      ...identity,
      sourceSequence: 0,
      deliveryDispositionRequired: false,
      sourceOrderScope: null,
      deliveryContext: null,
      originSha256: null,
    } as unknown as NativeResponseIdentity;
    const normalized = normalizeNativeResponseIdentity(input);
    expect(normalized).toMatchObject({
      sourceSequence: 0,
      deliveryDispositionRequired: false,
      originSha256: null,
      source: identity.source,
      invocationId: identity.invocationId,
    });
    expect(normalized).not.toHaveProperty('sourceOrderScope');
    expect(normalized).not.toHaveProperty('deliveryContext');
    expect(input).toHaveProperty('sourceOrderScope', null);
  });
  it('rejects changed source content and source recreation under the same message ID', async () => {
    await mongoose.models.Message.updateOne(
      { messageId: 'question' },
      { $set: { text: 'Edited.' } },
    );
    await expect(methods.admitNativeResponse(identity, transaction)).rejects.toThrow(
      'source_changed',
    );
    await mongoose.models.Message.deleteOne({ messageId: 'question' });
    await mongoose.models.Message.create({
      user,
      messageId: 'question',
      conversationId: 'conversation',
      isCreatedByUser: true,
      text: 'Original request.',
    });
    await expect(methods.admitNativeResponse(identity, transaction)).rejects.toThrow(
      'source_changed',
    );
  });
  it('reuses a prepared candidate across a crash and persists one canonical answer', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    expect((await methods.getNativeResponse(user, 'answer'))?.unfinished).toBe(true);
    expect(await methods.prepareNativeResponse(identity, candidate, transaction)).toBe(digest);
    const saved = await methods.materializeNativeResponse(identity, digest, commit, transaction);
    expect(saved).toMatchObject({
      text: candidate.text,
      unfinished: false,
      attachments: [{ type: 'file', file_id: 'kept' }],
    });
    expect(
      (await methods.materializeNativeResponse(identity, digest, commit, transaction))?.text,
    ).toBe(candidate.text);
    await expect(
      methods.prepareNativeResponse(
        identity,
        { ...candidate, text: 'Another answer' },
        transaction,
      ),
    ).rejects.toThrow('candidate_conflict');
  });
  it('never materializes after Stop won publication', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await expect(
      methods.materializeNativeResponse(
        identity,
        digest,
        async () => ({ status: 'revoked' }),
        transaction,
      ),
    ).rejects.toThrow('publication_revoked');
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe('In progress.');
  });
  it('source edit revokes an uncommitted candidate before changing the source', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    const revoke = jest.fn(async (): Promise<NativeResponseCommit> => ({ status: 'revoked' }));
    await methods.mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => mongoose.models.Message.updateOne({ messageId: 'question' }, { text: 'Edited.' }),
      revoke,
      transaction,
      async () => undefined,
    );
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: identity.invocationId }),
    );
    await expect(
      methods.materializeNativeResponse(identity, digest, commit, transaction),
    ).rejects.toThrow();
  });
  it('an admission committed after the edit snapshot is fenced by the actual source write', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let attempts = 0;
    const revoke = jest.fn(async (): Promise<NativeResponseCommit> => ({ status: 'revoked' }));
    const editing = methods.mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => {
        if (++attempts === 1) {
          entered();
          await held;
        }
        return mongoose.models.Message.updateOne(
          { user, messageId: 'question' },
          { text: 'Edited.' },
        );
      },
      revoke,
      transaction,
      async () => undefined,
      'edit',
    );
    await started;
    try {
      await methods.admitNativeResponse(identity, transaction);
    } finally {
      release();
    }
    await editing;
    expect(attempts).toBeGreaterThan(1);
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: identity.invocationId }),
    );
    expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.status).toBe(
      'cancelled',
    );
    await expect(methods.prepareNativeResponse(identity, candidate, transaction)).rejects.toThrow();
  });

  it('an edit committed after admission reads the source prevents that admission', async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const Message = mongoose.models.Message;
    const originalUpdate = Message.updateOne.bind(Message);
    const lock = jest.spyOn(Message, 'updateOne').mockImplementationOnce((...args) => {
      entered();
      return held.then(() => originalUpdate(...args)) as ReturnType<typeof Message.updateOne>;
    });
    const admitted = methods.admitNativeResponse(identity, transaction).then(
      () => 'unexpected admission',
      (error: Error) => error.message,
    );
    await started;
    try {
      await methods.mutateNativeResponseSources(
        { user, messageId: 'question' },
        async () => Message.updateOne({ user, messageId: 'question' }, { text: 'Edited.' }),
        async () => ({ status: 'revoked' }),
        transaction,
        async () => undefined,
        'edit',
      );
    } finally {
      release();
    }
    expect(await admitted).toContain('source_changed');
    lock.mockRestore();
    expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse).toBeUndefined();
  });

  it('bulk deletion does not rewrite messages that own no native admission', async () => {
    const Message = mongoose.models.Message;
    await Message.insertMany(
      Array.from({ length: 1000 }, (_, index) => ({
        user,
        messageId: `bulk-${index}`,
        conversationId: 'bulk-conversation',
        text: 'Stored history.',
      })),
    );
    const updates = jest.spyOn(Message, 'updateOne');
    const reads = jest.spyOn(Message, 'find');
    const revoke = jest.fn(async (): Promise<NativeResponseCommit> => ({ status: 'revoked' }));
    const retire = jest.fn(async () => undefined);
    const result = await methods.mutateNativeResponseSources(
      { user, conversationId: 'bulk-conversation' },
      async () => Message.deleteMany({ user, conversationId: 'bulk-conversation' }),
      revoke,
      transaction,
      retire,
      'delete',
    );
    expect(result.deletedCount).toBe(1000);
    expect(updates).not.toHaveBeenCalled();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
    expect(retire).not.toHaveBeenCalled();
    expect(await Message.countDocuments({ user })).toBe(2);
    updates.mockRestore();
    reads.mockRestore();
  });
  it('an edit after publication permits only the committed historical candidate', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => mongoose.models.Message.updateOne({ messageId: 'question' }, { text: 'Edited.' }),
      async () => ({ status: 'committed', candidateSha256: digest }),
      transaction,
      async () => undefined,
    );
    expect(
      (await methods.materializeNativeResponse(identity, digest, commit, transaction))?.text,
    ).toBe(candidate.text);
  });
  it('never recreates a deleted source or assistant even after publication committed', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => mongoose.models.Message.deleteOne({ messageId: 'question' }),
      async () => ({ status: 'committed', candidateSha256: digest }),
      transaction,
      async () => undefined,
    );
    await expect(
      methods.materializeNativeResponse(identity, digest, commit, transaction),
    ).rejects.toThrow('source_changed');
    await mongoose.models.Message.deleteOne({ messageId: 'answer' });
    await expect(
      methods.materializeNativeResponse(identity, digest, commit, transaction),
    ).rejects.toThrow('candidate_missing');
    expect(await mongoose.models.Message.countDocuments()).toBe(0);
  });
  it('a late ordinary snapshot cannot overwrite the published answer or disclose admission', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    const saved = await methods.saveNativeResponseSnapshot(
      user,
      {
        messageId: 'answer',
        text: 'Old partial.',
        content: [{ type: 'text', text: 'Old partial.' }],
        unfinished: true,
      },
      identity,
    );
    expect(saved).toMatchObject({ text: candidate.text, unfinished: false });
    expect(saved?.nativeResponse).toBeUndefined();
    expect(JSON.stringify(saved)).not.toContain('candidateJson');
  });
  it.each(['pending', 'prepared'])(
    'system augmentation persists beside a %s admission without claiming completion',
    async (status) => {
      await methods.admitNativeResponse(identity, transaction);
      if (status === 'prepared')
        await methods.prepareNativeResponse(identity, candidate, transaction);
      const contribution = { type: 'cortex_insight', text: 'Background contribution.' };
      await transaction(() =>
        methods.saveNativeResponseSnapshot(
          user,
          {
            messageId: 'answer',
            tokenCount: 42,
            unfinished: false,
            content: [contribution],
          },
          identity,
          'augmentation',
        ),
      );
      expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
        tokenCount: 42,
        unfinished: true,
        content: [contribution],
        nativeResponse: { status },
      });
    },
  );
  it.each(['pending', 'prepared'])('atomic Stop saves a %s partial only once', async (status) => {
    await methods.admitNativeResponse(identity, transaction);
    if (status === 'prepared')
      await methods.prepareNativeResponse(identity, candidate, transaction);
    const partial = {
      text: 'Accepted partial.',
      content: [{ type: 'text', text: 'Accepted partial.' }],
    };
    const saved = await transaction(() =>
      methods.settleNativeResponse(identity, 'cancelled', partial),
    );
    expect(saved).toMatchObject({
      text: partial.text,
      content: partial.content,
      unfinished: true,
      error: false,
      finish_reason: 'incomplete',
    });
    expect(saved).not.toHaveProperty('nativeResponse');
    const stopped = await methods.getNativeResponse(user, 'answer');
    expect(stopped?.nativeResponse?.stopSnapshotStoredAt).toEqual(expect.any(Number));
    expect(await methods.listNativeResponses()).toEqual([stopped]);
    expect(
      await methods.settleNativeResponse(identity, 'cancelled', {
        text: 'Late different partial.',
        content: [],
      }),
    ).toBeNull();
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe(partial.text);
  });

  it.each(['question', 'answer'])(
    'editing %s retires a stored Stop and removes its replay authority',
    async (messageId) => {
      await methods.admitNativeResponse(identity, transaction);
      await methods.settleNativeResponse(identity, 'cancelled', { text: 'Partial.', content: [] });
      const retire = jest.fn(async () => undefined);
      await methods.mutateNativeResponseSources(
        { user, messageId },
        () =>
          mongoose.models.Message.updateOne({ user, messageId }, { $set: { text: 'Correction.' } }),
        async () => ({ status: 'revoked' }),
        transaction,
        retire,
        'edit',
      );
      expect(retire).toHaveBeenCalledWith(
        expect.objectContaining({ invocationId: identity.invocationId }),
      );
      expect(
        (await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.stopSnapshotStoredAt,
      ).toBeUndefined();
      expect(
        (await methods.listNativeResponses()).every(
          (row) =>
            row.nativeResponse?.status === 'cancelled' &&
            !row.nativeResponse?.stopSnapshotStoredAt &&
            !row.nativeResponse?.terminalSnapshotStoredAt,
        ),
      ).toBe(true);
    },
  );

  it('only a marked Stop can store its existing replay receipt', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await methods.settleNativeResponse(identity, 'cancelled');
    expect(await methods.markNativeResponseReplayStored(identity)).toBe(false);
    await mongoose.models.Message.updateOne(
      { user, messageId: 'answer' },
      { $set: { 'nativeResponse.status': 'pending' } },
    );
    await methods.settleNativeResponse(identity, 'cancelled', { text: 'Partial.', content: [] });
    expect(await methods.markNativeResponseReplayStored(identity)).toBe(true);
    expect(
      (await methods.listNativeResponses()).every(
        (row) =>
          row.nativeResponse?.status === 'cancelled' &&
          !row.nativeResponse?.stopSnapshotStoredAt &&
          !row.nativeResponse?.terminalSnapshotStoredAt,
      ),
    ).toBe(true);
  });

  it('an explicit edit before the Stop compare-and-set cannot be overwritten', async () => {
    await methods.admitNativeResponse(identity, transaction);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const Message = mongoose.models.Message;
    const update = Message.findOneAndUpdate.bind(Message);
    const intercepted = jest
      .spyOn(Message, 'findOneAndUpdate')
      .mockImplementationOnce((...args) => {
        const query = update(...args);
        const lean = query.lean.bind(query);
        query.lean = (() => {
          entered();
          return held.then(() => lean());
        }) as typeof query.lean;
        return query;
      });
    const stopped = transaction(() =>
      methods.settleNativeResponse(identity, 'cancelled', {
        text: 'Stop partial.',
        content: [{ type: 'text', text: 'Stop partial.' }],
      }),
    );
    await started;
    try {
      await methods.mutateNativeResponseSources(
        { user, messageId: 'answer' },
        () =>
          Message.updateOne(
            { user, messageId: 'answer' },
            { $set: { text: 'Explicit correction.' } },
          ),
        async () => ({ status: 'revoked' }),
        transaction,
        async () => undefined,
        'edit',
      );
    } finally {
      release();
    }
    expect(await stopped).toBeNull();
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe('Explicit correction.');
    intercepted.mockRestore();
  });

  it.each(['cancelled', 'failed'] as const)(
    'terminal %s augmentation preserves the saved answer and failure semantics',
    async (status) => {
      await methods.admitNativeResponse(identity, transaction);
      await methods.settleNativeResponse(identity, status);
      await mongoose.models.Message.updateOne(
        { user, messageId: 'answer' },
        {
          $set: {
            text: 'Saved terminal partial.',
            finish_reason: 'incomplete',
            metadata: { viventium: { sibling: 'original' } },
          },
        },
      );
      const before = await methods.getNativeResponse(user, 'answer');
      const contribution = { type: 'cortex_insight', text: 'Background contribution.' };
      const saved = await transaction(() =>
        methods.saveNativeResponseSnapshot(
          user,
          {
            messageId: 'answer',
            text: 'Stale producer text.',
            unfinished: true,
            error: !before!.error,
            finish_reason: 'stop',
            content: [
              { type: 'text', text: 'Stale producer text.' },
              { type: 'error', error: 'Stale producer error.' },
              contribution,
            ],
            metadata: { viventium: { added: 'ordinary metadata' } },
          },
          identity,
          'augmentation',
        ),
      );
      expect(saved).toMatchObject({
        text: before!.text,
        error: before!.error,
        unfinished: before!.unfinished,
        finish_reason: before!.finish_reason,
        metadata: { viventium: { sibling: 'original', added: 'ordinary metadata' } },
      });
      expect(saved?.content).toEqual([
        { type: 'text', text: before!.text },
        ...(before!.content || []).filter((part) => part.type === 'error'),
        contribution,
      ]);
      expect(saved?.nativeResponse).toBeUndefined();
      expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
        nativeResponse: { status, invocationId: identity.invocationId },
      });
      const late = await methods.saveNativeResponseSnapshot(
        user,
        { messageId: 'answer', text: 'Late original snapshot.', unfinished: false },
        identity,
      );
      expect(late?.text).toBe(before!.text);
    },
  );

  it.each(['pending', 'completed'] as const)(
    'keeps an early completed cortex through a stale native %s snapshot',
    async (state) => {
      await methods.admitNativeResponse(identity, transaction);
      if (state === 'completed') {
        const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
        await methods.materializeNativeResponse(identity, digest, commit, transaction);
      }
      const complete = {
        type: 'cortex_insight', cortex_id: 'background-source', status: 'complete',
        insight: 'A verified earlier constraint.',
      };
      await methods.saveNativeResponseSnapshot(user, {
        messageId: 'answer', content: [complete],
      }, identity, 'augmentation');
      // Both a snapshot that predates activation and one that predates completion can arrive late.
      for (const oldParts of [[], [{
        type: 'cortex_brewing', cortex_id: 'background-source', status: 'running',
      }]]) {
        await methods.saveNativeResponseSnapshot(user, {
          messageId: 'answer', unfinished: true,
          content: [{ type: 'text', text: 'Final streamed answer.' }, ...oldParts],
        }, identity);
        const saved = await methods.getNativeResponse(user, 'answer');
        const cortex = saved?.content?.filter((part) => part.cortex_id === 'background-source');
        expect(cortex).toEqual([complete]);
        if (state === 'completed') expect(saved?.text).toBe(candidate.text);
      }
      const updated = { ...complete, insight: 'A later authoritative result.' };
      await methods.saveNativeResponseSnapshot(user, {
        messageId: 'answer', content: [updated],
      }, identity, 'augmentation');
      const saved = await methods.getNativeResponse(user, 'answer');
      expect(saved?.content?.filter((part) => part.cortex_id === 'background-source')).toEqual([updated]);
    },
  );

  it('retries a foreground snapshot when cortex augmentation wins the real Mongo race', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    const contribution = { type: 'cortex_insight', cortex_id: 'source', status: 'complete', insight: 'Verified finding.' };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const Message = mongoose.models.Message;
    const update = Message.findOneAndUpdate.bind(Message);
    const intercepted = jest.spyOn(Message, 'findOneAndUpdate').mockImplementationOnce((...args) => {
      entered();
      return held.then(() => update(...args)) as ReturnType<typeof Message.findOneAndUpdate>;
    });
    let attempts = 0;
    const saving = transaction(() => {
      attempts++;
      return methods.saveNativeResponseSnapshot(user, {
        messageId: 'answer', unfinished: true, content: [{ type: 'text', text: 'Stream text.' }],
      }, identity);
    });
    await started;
    try {
      await transaction(() => methods.saveNativeResponseSnapshot(user, {
        messageId: 'answer', content: [contribution],
      }, identity, 'augmentation'));
    } finally { release(); }
    await saving;
    intercepted.mockRestore();
    expect(attempts).toBeGreaterThan(1);
    expect((await methods.getNativeResponse(user, 'answer'))?.content).toEqual([
      { type: 'text', text: candidate.text }, contribution,
    ]);
  });

  it('system augmentation retries across materialization without losing parts or canonical fields', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    const canonical = { version: 1, audio: 'skip', source: 'model', valid: true, required: true };
    const contribution = { type: 'cortex_insight', text: 'Background contribution.' };
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const Message = mongoose.models.Message;
    const update = Message.findOneAndUpdate.bind(Message);
    const intercepted = jest
      .spyOn(Message, 'findOneAndUpdate')
      .mockImplementationOnce((...args) => {
        entered();
        return held.then(() => update(...args)) as ReturnType<typeof Message.findOneAndUpdate>;
      });
    let attempts = 0;
    const augmenting = transaction(() => {
      attempts++;
      return methods.saveNativeResponseSnapshot(
        user,
        {
          messageId: 'answer',
          text: 'Old partial.',
          unfinished: false,
          content: [{ type: 'text', text: 'Old partial.' }, contribution],
          metadata: { viventium: { sibling: 'added', deliveryDisposition: { audio: 'eligible' } } },
        },
        identity,
        'augmentation',
      );
    });
    await started;
    try {
      await methods.materializeNativeResponse(
        identity,
        digest,
        commit,
        transaction,
        (_candidate, message) => ({
          ...message,
          metadata: { viventium: { deliveryDisposition: canonical } },
        }),
      );
    } finally {
      release();
    }
    await augmenting;
    intercepted.mockRestore();
    expect(attempts).toBeGreaterThan(1);
    expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
      text: candidate.text,
      unfinished: false,
      nativeResponse: { status: 'completed' },
      content: [{ type: 'text', text: candidate.text }, contribution],
      metadata: { viventium: { sibling: 'added', deliveryDisposition: canonical } },
    });
  });
  it('recovers the crash after actual Message save until final replay is durably stored', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    expect((await methods.listNativeResponses()).map((row) => row.messageId)).toEqual(['answer']);
    expect(
      await methods.markNativeResponseReplayStored({ ...identity, invocationId: 'other' }),
    ).toBe(false);
    expect(await methods.markNativeResponseReplayStored(identity)).toBe(true);
    expect(await methods.markNativeResponseReplayStored(identity)).toBe(true);
    expect(
      (await methods.listNativeResponses()).every(
        (row) =>
          row.nativeResponse?.status === 'cancelled' &&
          !row.nativeResponse?.stopSnapshotStoredAt &&
          !row.nativeResponse?.terminalSnapshotStoredAt,
      ),
    ).toBe(true);
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe(candidate.text);
  });
  it.each([true, false])(
    'completed snapshot preserves canonical disposition presence: %s',
    async (present) => {
      await methods.admitNativeResponse(identity, transaction);
      const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
      await methods.materializeNativeResponse(identity, digest, commit, transaction);
      const canonical = { version: 1, audio: 'skip', required: true, valid: true, source: 'model' };
      await mongoose.models.Message.updateOne(
        { messageId: 'answer' },
        {
          metadata: {
            keep: true,
            viventium: {
              sibling: 'before',
              ...(present ? { deliveryDisposition: canonical } : {}),
            },
          },
        },
      );
      await methods.saveNativeResponseSnapshot(user, {
        messageId: 'answer',
        metadata: {
          changed: true,
          viventium: { sibling: 'after', deliveryDisposition: { ...canonical, audio: 'eligible' } },
        },
      });
      const saved = await methods.getNativeResponse(user, 'answer');
      expect(saved?.metadata).toEqual({
        keep: true,
        changed: true,
        viventium: {
          sibling: 'after',
          ...(present ? { deliveryDisposition: canonical } : {}),
        },
      });
    },
  );
  it.each([true, false])('snapshot preserves native tool evidence presence: %s', async (present) => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    const evidence = { logicalTurnId: 'turn', revision: 1, evidence: { run_id: 'current' } };
    await mongoose.models.Message.updateOne({ messageId: 'answer' }, {
      metadata: { viventium: { ...(present ? { nativeToolEvidence: evidence } : {}) } },
    });
    await methods.saveNativeResponseSnapshot(user, { messageId: 'answer', metadata: { viventium: {
      nativeToolEvidence: { evidence: { run_id: 'foreign' } }, sibling: 'kept',
    } } });
    const saved = await methods.getNativeResponse(user, 'answer');
    expect(saved?.metadata?.viventium).toEqual({ sibling: 'kept', ...(present ? { nativeToolEvidence: evidence } : {}) });
  });
  it('a late checkpoint cannot upsert an assistant deleted after dispatch', async () => {
    await methods.admitNativeResponse(identity, transaction);
    await mongoose.models.Message.deleteOne({ messageId: 'answer' });
    await expect(
      methods.saveNativeResponseSnapshot(user, { messageId: 'answer', unfinished: true }, identity),
    ).rejects.toThrow('message_deleted');
  });
  it('a completed answer stays recoverable when only its historical user source is edited', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    const retire = jest.fn(async () => undefined);
    await methods.mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => mongoose.models.Message.updateOne({ messageId: 'question' }, { text: 'Edited.' }),
      async () => ({ status: 'committed', candidateSha256: digest }),
      transaction,
      retire,
    );
    expect(retire).not.toHaveBeenCalled();
    expect((await methods.listNativeResponses()).map((row) => row.messageId)).toEqual(['answer']);
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe(candidate.text);
  });
  it('a retirement failure rejects the assistant edit and keeps its saved answer', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.materializeNativeResponse(identity, digest, commit, transaction);
    await expect(
      methods.mutateNativeResponseSources(
        { user, messageId: 'answer' },
        async () =>
          mongoose.models.Message.updateOne({ messageId: 'answer' }, { text: 'User correction.' }),
        async () => ({ status: 'committed', candidateSha256: digest }),
        transaction,
        async () => {
          throw new Error('retirement unavailable');
        },
      ),
    ).rejects.toThrow('retirement unavailable');
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe(candidate.text);
    expect((await methods.listNativeResponses()).map((row) => row.messageId)).toEqual(['answer']);
  });
  it('an explicit assistant edit wins over a prepared answer even after publication committed', async () => {
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await methods.mutateNativeResponseSources(
      { user, messageId: 'answer' },
      async () =>
        mongoose.models.Message.updateOne({ messageId: 'answer' }, { text: 'User correction.' }),
      async () => ({ status: 'committed', candidateSha256: digest }),
      transaction,
      async () => undefined,
    );
    await expect(
      methods.materializeNativeResponse(identity, digest, commit, transaction),
    ).rejects.toThrow();
    expect((await methods.getNativeResponse(user, 'answer'))?.text).toBe('User correction.');
  });
  it.each(['edit', 'delete'])(
    'explicit assistant %s retires a completed native replay',
    async (action) => {
      await methods.admitNativeResponse(identity, transaction);
      const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
      await methods.materializeNativeResponse(identity, digest, commit, transaction);
      const retire = jest.fn(async () => undefined);
      await methods.mutateNativeResponseSources(
        { user, messageId: 'answer' },
        async () =>
          action === 'delete'
            ? mongoose.models.Message.deleteOne({ messageId: 'answer' })
            : mongoose.models.Message.updateOne(
                { messageId: 'answer' },
                { text: 'User correction.' },
              ),
        async () => ({ status: 'committed', candidateSha256: digest }),
        transaction,
        retire,
      );
      expect(retire).toHaveBeenCalledWith(
        expect.objectContaining({ invocationId: identity.invocationId }),
      );
      expect(
        (await methods.listNativeResponses()).every(
          (row) =>
            row.nativeResponse?.status === 'cancelled' &&
            !row.nativeResponse?.stopSnapshotStoredAt &&
            !row.nativeResponse?.terminalSnapshotStoredAt,
        ),
      ).toBe(true);
      const row = await methods.getNativeResponse(user, 'answer');
      if (action === 'delete') expect(row).toBeNull();
      else expect(row?.text).toBe('User correction.');
    },
  );
});
/* === VIVENTIUM END === */
