/* === VIVENTIUM START === Direct-parent proof uses authored history and existing Mongo fences. === */
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { NativeResponseIdentity, NativeResponseCommit } from '~/types/nativeResponse';
import { createModels } from '~/models';
import {
  createNativeResponseMethods,
  nativeResponseSource,
  nativeResponseParentSource,
} from './nativeResponse';

const user = new mongoose.Types.ObjectId().toString();
const candidate = {
  text: 'Continued answer.',
  authoritySha256: 'a'.repeat(64),
  requestId: 'request',
  runId: 'run',
  responseJson: '{}',
};
const transaction = <T>(operation: () => Promise<T>) => mongoose.connection.transaction(operation);
let server: MongoMemoryReplSet;
let methods: ReturnType<typeof createNativeResponseMethods>;
let identity: NativeResponseIdentity;
const messages = () => mongoose.models.Message;
const parentFilter = { user, conversationId: 'conversation', messageId: 'prior' };
const parent = () => messages().findOne(parentFilter).orFail().lean();
const revoke = jest.fn(async (): Promise<NativeResponseCommit> => ({ status: 'revoked' }));
const retire = jest.fn(async () => undefined);
const commit = async (
  _identity: NativeResponseIdentity,
  digest: string,
): Promise<NativeResponseCommit> => ({ status: 'committed', candidateSha256: digest });
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  createModels(mongoose);
  await messages().init();
  methods = createNativeResponseMethods(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await messages().deleteMany({});
  await messages().create([
    {
      user,
      conversationId: 'conversation',
      messageId: 'original',
      text: 'Start.',
      isCreatedByUser: true,
    },
    {
      ...parentFilter,
      parentMessageId: 'original',
      text: 'Old cached text.',
      content: [{ type: 'text', text: 'Authored partial.' }],
      isCreatedByUser: false,
      unfinished: true,
      error: false,
    },
    {
      user,
      conversationId: 'conversation',
      messageId: 'continue',
      parentMessageId: 'prior',
      text: 'Continue',
      isCreatedByUser: true,
    },
    {
      user,
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'continue',
      text: '',
      isCreatedByUser: false,
      unfinished: true,
    },
  ]);
  const now = Date.now();
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
    source: await methods.captureNativeResponseSource(user, 'conversation', 'continue'),
    admittedAt: now,
    recoverUntil: now + 86_400_000,
  };
  revoke.mockClear();
  retire.mockClear();
});
async function capture() {
  const authored = nativeResponseParentSource(await parent());
  identity.source = await methods.captureNativeResponseSource(
    user,
    'conversation',
    'continue',
    authored,
  );
  return authored;
}
const edit = (operation: () => Promise<unknown>, kind: 'edit' | 'delete' | 'system' = 'edit') =>
  methods.mutateNativeResponseSources(parentFilter, operation, revoke, transaction, retire, kind);

test('new capture requires its selected parent but old admissions retain exact source identity', async () => {
  const oldSource = identity.source;
  await expect(
    methods.captureNativeResponseSource(user, 'conversation', 'continue', null),
  ).rejects.toThrow('parent');
  await methods.admitNativeResponse(identity, transaction);
  await methods.admitNativeResponse(identity, transaction);
  expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.source).toEqual(
    oldSource,
  );
  expect(oldSource).not.toHaveProperty('parent');
  expect(oldSource).toEqual(
    nativeResponseSource(await messages().findOne({ user, messageId: 'continue' }).orFail().lean()),
  );
});
test('capture keeps the authored proof; a later content-only parent edit rejects admission', async () => {
  const authored = nativeResponseParentSource(await parent());
  await messages().updateOne(parentFilter, {
    $set: { 'content.0.text': 'Changed after history loaded.' },
  });
  identity.source = await methods.captureNativeResponseSource(
    user,
    'conversation',
    'continue',
    authored,
  );
  expect(identity.source.parent).toEqual(authored);
  await expect(methods.admitNativeResponse(identity, transaction)).rejects.toThrow(
    'parent_changed',
  );
});
test.each([
  'foreign-owner',
  'foreign-conversation',
  'recreated',
  'deleted',
  'user-role',
  'wrong-anchor',
])('parent identity rejects %s before admission', async (change) => {
  await capture();
  if (change === 'deleted' || change === 'recreated') {
    const old = await parent();
    await messages().deleteOne(parentFilter);
    if (change === 'recreated') {
      await messages().create({ ...old, _id: new mongoose.Types.ObjectId() });
    }
  } else if (change === 'wrong-anchor') {
    identity.source.parent = { ...identity.source.parent!, messageId: 'original' };
  } else if (change === 'foreign-owner') {
    await messages().updateOne(parentFilter, {
      $set: { user: new mongoose.Types.ObjectId().toString() },
    });
  } else if (change === 'foreign-conversation') {
    await messages().updateOne(parentFilter, { $set: { conversationId: 'other' } });
  } else {
    await messages().updateOne(parentFilter, { $set: { isCreatedByUser: true } });
  }
  await expect(methods.admitNativeResponse(identity, transaction)).rejects.toThrow('parent');
});
test('historical assistant parent proofs keep their exact identity without a role field', async () => {
  await capture();
  delete identity.source.parent!.isCreatedByUser;
  const originalProof = JSON.stringify(identity.source);
  await methods.admitNativeResponse(identity, transaction);
  await methods.admitNativeResponse(identity, transaction);
  expect(JSON.stringify((await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.source)).toBe(originalProof);
});

test('successive authored user segments retain an explicit role-bound native parent', async () => {
  await messages().deleteOne(parentFilter);
  await messages().updateOne({ user, messageId: 'continue' }, { $set: { parentMessageId: 'original' } });
  const previousInput = await messages().findOne({ user, messageId: 'original' }).orFail().lean();
  const proof = nativeResponseParentSource(previousInput);
  identity.source = await methods.captureNativeResponseSource(user, 'conversation', 'continue', proof);
  await expect(methods.admitNativeResponse(identity, transaction)).resolves.toBeUndefined();
  expect(proof.isCreatedByUser).toBe(true);
  await messages().updateOne({ _id: previousInput._id }, { $set: { isCreatedByUser: false } });
  await expect(methods.admitNativeResponse(identity, transaction)).rejects.toThrow('parent_changed');
});

test('receipt, activity, feedback and token bookkeeping preserve the authored parent and prior answer', async () => {
  await capture();
  const before = await parent();
  await methods.admitNativeResponse(identity, transaction);
  await edit(
    () =>
      messages().updateOne(parentFilter, {
        $push: { content: { type: 'agent_update', status: 'completed' } },
        $set: {
          tokenCount: 19,
          'metadata.feedback': 'positive',
          attachments: [{ type: 'memory' }],
        },
      }),
    'system',
  );
  const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
  expect(
    (await methods.materializeNativeResponse(identity, digest, commit, transaction)).text,
  ).toBe(candidate.text);
  const after = await parent();
  expect(after.text).toBe(before.text);
  expect(after.content?.[0]).toEqual(before.content?.[0]);
  expect(revoke).not.toHaveBeenCalled();
});
test.each(['edit', 'delete'] as const)(
  'an explicit parent %s revokes a prepared continuation',
  async (kind) => {
    await capture();
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    await edit(
      () =>
        kind === 'edit'
          ? messages().updateOne(parentFilter, { $set: { 'content.0.text': 'Edited.' } })
          : messages().deleteOne(parentFilter),
      kind,
    );
    expect(revoke).toHaveBeenCalledWith(
      expect.objectContaining({ invocationId: identity.invocationId }),
    );
    expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse?.status).toBe(
      'cancelled',
    );
    await expect(
      methods.materializeNativeResponse(identity, digest, commit, transaction),
    ).rejects.toThrow();
  },
);
test('authority unavailable prevents a parent edit from invalidating publication silently', async () => {
  await capture();
  await methods.admitNativeResponse(identity, transaction);
  revoke.mockResolvedValueOnce({ status: 'unavailable' });
  await expect(
    edit(() => messages().updateOne(parentFilter, { $set: { text: 'Rejected edit.' } })),
  ).rejects.toThrow('authority_unavailable');
  expect((await parent()).text).toBe('Old cached text.');
});
test('a parent mutation retires its child Stop replay using the existing marker', async () => {
  await capture();
  await methods.admitNativeResponse(identity, transaction);
  await methods.settleNativeResponse(identity, 'cancelled', {
    text: 'Stopped child.',
    content: [{ type: 'text', text: 'Stopped child.' }],
  });
  await edit(() => messages().updateOne(parentFilter, { $set: { 'content.0.text': 'Edited.' } }));
  expect(retire).toHaveBeenCalledWith(
    expect.objectContaining({ invocationId: identity.invocationId }),
  );
  expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse).not.toHaveProperty(
    'stopSnapshotStoredAt',
  );
});
test('completed child keeps its historical result when its parent is edited afterward', async () => {
  await capture();
  await methods.admitNativeResponse(identity, transaction);
  const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
  await methods.materializeNativeResponse(identity, digest, commit, transaction);
  const before = await methods.getNativeResponse(user, 'answer');
  await edit(() =>
    messages().updateOne(parentFilter, { $set: { 'content.0.text': 'Later parent correction.' } }),
  );
  expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse).toEqual(
    before?.nativeResponse,
  );
  expect(revoke).not.toHaveBeenCalled();
});

test('parent edit snapshot retries when child admission wins before the actual edit write', async () => {
  await capture();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let attempts = 0;
  const editing = edit(async () => {
    if (++attempts === 1) {
      entered();
      await held;
    }
    return messages().updateOne(parentFilter, {
      $set: { 'content.0.text': 'Edit won after retry.' },
    });
  });
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
});
test('parent edit winning after admission reads its parent prevents stale admission', async () => {
  await capture();
  const parentId = (await parent())._id.toString();
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let intercepted = false;
  const Message = messages(),
    original = Message.updateOne.bind(Message);
  const spy = jest.spyOn(Message, 'updateOne').mockImplementation((...args) => {
    if (!intercepted && String(args[0]?._id) === parentId) {
      intercepted = true;
      entered();
      return held.then(() => original(...args)) as ReturnType<typeof Message.updateOne>;
    }
    return original(...args);
  });
  const admitting = methods.admitNativeResponse(identity, transaction).then(
    () => 'unexpected_success',
    (error: Error) => error.message,
  );
  await started;
  try {
    await edit(() =>
      Message.updateOne(parentFilter, { $set: { 'content.0.text': 'Edit before parent lock.' } }),
    );
  } finally {
    release();
  }
  try {
    expect(await admitting).toContain('parent_changed');
  } finally {
    spy.mockRestore();
  }
  expect((await methods.getNativeResponse(user, 'answer'))?.nativeResponse).toBeUndefined();
});
test.each(['edit', 'delete'] as const)(
  'publication winner preserves history but never recreates a parent after %s',
  async (kind) => {
    await capture();
    await methods.admitNativeResponse(identity, transaction);
    const digest = await methods.prepareNativeResponse(identity, candidate, transaction);
    revoke.mockResolvedValueOnce({ status: 'committed', candidateSha256: digest });
    await edit(
      () =>
        kind === 'edit'
          ? messages().updateOne(parentFilter, { $set: { 'content.0.text': 'Later correction.' } })
          : messages().deleteOne(parentFilter),
      kind,
    );
    if (kind === 'delete')
      await expect(
        methods.materializeNativeResponse(identity, digest, commit, transaction),
      ).rejects.toThrow('parent_changed');
    else
      expect(
        (await methods.materializeNativeResponse(identity, digest, commit, transaction)).text,
      ).toBe(candidate.text);
  },
);
test('changed parent files reject preparation; receipt-only fields do not hide that source change', async () => {
  await capture();
  await methods.admitNativeResponse(identity, transaction);
  await messages().updateOne(parentFilter, { $set: { files: [{ file_id: 'changed-file' }] } });
  await expect(methods.prepareNativeResponse(identity, candidate, transaction)).rejects.toThrow(
    'parent_changed',
  );
});
test('explicit root capture does not invent a parent proof', async () => {
  const root = await methods.captureNativeResponseSource(user, 'conversation', 'original', null);
  expect(root).not.toHaveProperty('parent');
  expect(root).toEqual(await methods.captureNativeResponseSource(user, 'conversation', 'original'));
});
