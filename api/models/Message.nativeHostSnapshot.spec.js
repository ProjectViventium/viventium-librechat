/* === VIVENTIUM START === Released Native steps retain canonical source through host saves. === */
const mongoose = require('mongoose');
const { createHash } = require('node:crypto');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Message } = require('~/db/models');

jest.mock('~/server/services/Config/app');
jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  ...jest.requireActual('~/server/services/viventium/conversationRecallService'),
  scheduleConversationRecallSync: jest.fn(),
}));

const db = require('~/models');
const { saveMessage, updateMessage } = require('./Message');
const user = 'synthetic-owner';
const conversationId = '00000000-0000-4000-8000-000000000024';
const transaction = (operation) => mongoose.connection.transaction(operation);
const backgroundText = 'A verified background finding.';
const background = {
  version: 1,
  invocationId: 'invocation',
  deliveryId: 'd'.repeat(64),
  text: backgroundText,
  textSha256: createHash('sha256').update(backgroundText).digest('hex'),
  sources: [{ cortexId: 'cortex', cortexName: 'Synthetic cortex', insightSha256: 'e'.repeat(64) }],
};
const acknowledgement = {
  state: 'failed',
  logical_turn_id: 'logical',
  revision: 1,
  presentation_ref: 'voice:synthetic-call:interrupted',
};
const completedCortex = {
  type: 'cortex_insight',
  cortex_id: 'cortex',
  status: 'complete',
  insight: 'Saved finding.',
};
let server;
let identity;
let req;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  await Message.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Message.deleteMany({});
  await Message.create([
    {
      user,
      conversationId,
      messageId: 'question',
      isCreatedByUser: true,
      text: 'Inspect the state.',
    },
    {
      user,
      conversationId,
      messageId: 'answer',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: true,
      text: 'Working.',
      content: [{ type: 'text', text: 'Working.' }],
    },
  ]);
  identity = {
    userId: user,
    conversationId,
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
    source: await db.captureNativeResponseSource(user, conversationId, 'question'),
    admittedAt: Date.now(),
    recoverUntil: Date.now() + 86_400_000,
  };
  await db.admitNativeResponse(identity, transaction);
  await db.settleNativeResponse(identity, 'unsupported');
  req = { user: { id: user }, body: {}, _viventiumNativeResponseIdentity: identity };
});
const read = () => Message.findOne({ user, messageId: 'answer' }).select('+nativeResponse').lean();
const save = (kind, update) =>
  kind === 'snapshot'
    ? saveMessage(
        req,
        { conversationId, isCreatedByUser: false, ...update },
        { operationKind: 'system' },
      )
    : updateMessage(req, update, { operationKind: 'system' });

test.each(['snapshot', 'augmentation'])(
  'retains released source and failed presentation through shared %s',
  async (kind) => {
    expect(
      await db.prepareNativeMainBackgroundInput(identity, background, transaction, 'current_main'),
    ).toBe(true);
    await Message.updateOne(
      { user, messageId: 'answer' },
      {
        $set: {
          'metadata.viventium.deliveryAcknowledgement': acknowledgement,
          content: [{ type: 'text', text: 'Working.' }, completedCortex],
        },
      },
    );
    const before = await read();
    expect(before.nativeResponse).toMatchObject({
      status: 'unsupported',
      streamId: identity.streamId,
      invocationId: identity.invocationId,
    });
    await save(kind, {
      messageId: 'answer',
      text: 'Main final answer.',
      unfinished: false,
      error: false,
      content: [
        { type: 'text', text: 'Main final answer.' },
        ...(kind === 'snapshot'
          ? [{ type: 'cortex_brewing', cortex_id: 'cortex', status: 'running' }]
          : [completedCortex]),
      ],
      metadata: { viventium: { sibling: 'current host metadata' } },
      nativeResponse: { ...identity, streamId: 'forged' },
    });
    const after = await read();
    expect(after).toMatchObject({ text: 'Main final answer.', unfinished: false, error: false });
    expect(after.nativeResponse).toEqual(before.nativeResponse);
    expect(after.metadata.viventium).toMatchObject({
      backgroundInputs: [background],
      backgroundInputReceipts: before.metadata.viventium.backgroundInputReceipts,
      deliveryAcknowledgement: acknowledgement,
      sibling: 'current host metadata',
    });
    expect(after.content.filter((part) => part.cortex_id === 'cortex')).toEqual([completedCortex]);
    const { createReleasedMainPublicPartOwner } = require('@librechat/api');
    expect(await createReleasedMainPublicPartOwner(identity, db).verifySource()).toBe(true);
  },
);

test('host graph keeps foreground flags and a new successful augmentation can clear its prior presentation', async () => {
  await Message.updateOne(
    { user, messageId: 'answer' },
    {
      $set: {
        'metadata.viventium.deliveryAcknowledgement': { ...acknowledgement, state: 'committed' },
      },
    },
  );
  await save('snapshot', {
    messageId: 'answer',
    text: 'Host continues.',
    unfinished: true,
    error: false,
    metadata: { viventium: { sibling: 'host' } },
  });
  let after = await read();
  expect(after).toMatchObject({ text: 'Host continues.', unfinished: true, error: false });
  expect(after.metadata.viventium.deliveryAcknowledgement.state).toBe('committed');
  await save('augmentation', {
    messageId: 'answer',
    text: 'Promoted answer.',
    unfinished: false,
    error: false,
    metadata: { viventium: { messageRevision: 2 } },
  });
  after = await read();
  expect(after).toMatchObject({ text: 'Promoted answer.', unfinished: false, error: false });
  expect(after.metadata.viventium.deliveryAcknowledgement).toBeUndefined();
  expect(after.metadata.viventium.messageRevision).toBe(2);
});

test.each([
  ['committed', 1, 1],
  ['committed', 3, 2],
  ['failed', 1, 2],
])(
  'augmentation keeps %s receipt revision %s when requested revision is %s',
  async (state, revision, requestedRevision) => {
    const prior = { ...acknowledgement, state, revision };
    await Message.updateOne(
      { user, messageId: 'answer' },
      {
        $set: { 'metadata.viventium.deliveryAcknowledgement': prior },
      },
    );
    await save('augmentation', {
      messageId: 'answer',
      text: 'Host result.',
      unfinished: false,
      error: false,
      metadata: { viventium: { messageRevision: requestedRevision } },
    });
    expect((await read()).metadata.viventium.deliveryAcknowledgement).toEqual(prior);
  },
);

test.each([
  ['failed', acknowledgement],
  ['new revision', { ...acknowledgement, state: 'committed', revision: 2 }],
  ['same revision', { ...acknowledgement, state: 'committed', presentation_ref: 'voice:new' }],
])(
  'a concurrent %s receipt rejects host promotion so its caller can publish a child',
  async (_kind, winner) => {
    const prior = { ...acknowledgement, state: 'committed' };
    await Message.updateOne(
      { user, messageId: 'answer' },
      {
        $set: { 'metadata.viventium.deliveryAcknowledgement': prior },
      },
    );
    let release;
    let entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const write = Message.findOneAndUpdate.bind(Message);
    const spy = jest.spyOn(Message, 'findOneAndUpdate').mockImplementationOnce((...args) => {
      entered();
      return held.then(() => write(...args));
    });
    const updating = save('augmentation', {
      messageId: 'answer',
      text: 'New presentation.',
      unfinished: false,
      error: false,
      metadata: { viventium: { messageRevision: 2 } },
    });
    try {
      await started;
      await Message.updateOne(
        { user, messageId: 'answer' },
        {
          $set: { 'metadata.viventium.deliveryAcknowledgement': winner },
        },
      );
      release();
      await expect(updating).rejects.toThrow('native_response_presentation_changed');
      const after = await read();
      expect(after.text).toBe('Working.');
      expect(after.metadata.viventium.deliveryAcknowledgement).toEqual(winner);
    } finally {
      release();
      spy.mockRestore();
    }
  },
);

test.each(['source', 'receipt', 'presentation', 'cortex'])(
  'shared host snapshot retries when concurrent %s wins after its read',
  async (mutation) => {
    if (mutation === 'receipt')
      await db.prepareNativeMainBackgroundInput(identity, background, transaction, 'current_main');
    let release;
    let entered;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const update = Message.findOneAndUpdate.bind(Message);
    let intercepted = false;
    let writes = 0;
    const spy = jest.spyOn(Message, 'findOneAndUpdate').mockImplementation((...args) => {
      writes++;
      if (!intercepted) {
        intercepted = true;
        entered();
        return held.then(() => update(...args));
      }
      return update(...args);
    });
    const saving = save('snapshot', {
      messageId: 'answer',
      text: 'Host final.',
      unfinished: false,
      error: false,
      content: [{ type: 'text', text: 'Host final.' }],
      metadata: { viventium: { sibling: 'host' } },
    });
    try {
      await started;
      if (mutation === 'source')
        expect(
          await db.prepareNativeMainBackgroundInput(
            identity,
            background,
            transaction,
            'current_main',
          ),
        ).toBe(true);
      else if (mutation === 'receipt')
        expect(
          await db.recordNativeMainBackgroundInputReceipt(identity, {
            deliveryId: background.deliveryId,
            textSha256: background.textSha256,
            status: 'unavailable',
          }),
        ).toBe(true);
      else
        await Message.updateOne(
          { user, messageId: 'answer' },
          {
            $set:
              mutation === 'presentation'
                ? { 'metadata.viventium.deliveryAcknowledgement': acknowledgement }
                : { content: [{ type: 'text', text: 'Working.' }, completedCortex] },
          },
        );
    } finally {
      release();
    }
    try {
      await saving;
    } finally {
      spy.mockRestore();
    }
    expect(writes).toBeGreaterThan(1);
    const after = await read();
    expect(after).toMatchObject({
      text: 'Host final.',
      unfinished: false,
      error: false,
      nativeResponse: { streamId: identity.streamId, status: 'unsupported' },
    });
    if (['source', 'receipt'].includes(mutation)) {
      expect(after.metadata.viventium.backgroundInputs).toEqual([background]);
      expect(after.metadata.viventium.backgroundInputReceipts[0].status).toBe(
        mutation === 'source' ? 'offered' : 'unavailable',
      );
    } else if (mutation === 'presentation')
      expect(after.metadata.viventium.deliveryAcknowledgement).toEqual(acknowledgement);
    else
      expect(after.content.filter((part) => part.cortex_id === 'cortex')).toEqual([
        completedCortex,
      ]);
  },
);
/* === VIVENTIUM END === */

/* VIVENTIUM: the actual canonical writer owns Direct and released native finals identically. */
describe.each(['direct', 'native-host'])('shared host final Message writer %s', (path) => {
  const context = {
    conversation_id: conversationId,
    logical_turn_id: 'logical',
    revision: 1,
    surface: 'telegram',
  };
  beforeEach(async () => {
    if (path === 'direct') {
      await Message.updateOne({ user, messageId: 'answer' }, { $unset: { nativeResponse: 1 } });
      delete req._viventiumNativeResponseIdentity;
    }
    const {
      userId,
      conversationId: convo,
      responseMessageId,
      streamId,
      jobCreatedAt,
      logicalTurnId,
      revision,
      source,
    } = identity;
    req._viventiumHostResponseIdentity = {
      userId,
      conversationId: convo,
      responseMessageId,
      streamId,
      jobCreatedAt,
      logicalTurnId,
      revision,
      source,
      surface: 'telegram',
    };
    req._viventiumHostResponseIsCurrent = jest.fn().mockResolvedValue(true);
  });
  const finish = (final = true) =>
    saveMessage(
      req,
      {
        messageId: 'answer',
        conversationId,
        parentMessageId: 'question',
        isCreatedByUser: false,
        unfinished: true,
        error: false,
        text: '',
        content: [],
        attachments: [{ file_id: 'output-file', filename: 'result.txt' }],
        metadata: { viventium: { interactionContext: context } },
      },
      { operationKind: 'system', hostGenerationComplete: final },
    );
  test('stamps actual file-only final and keeps its proof private', async () => {
    const saved = await finish();
    expect(saved.hostFinal).toBeUndefined();
    const row = await Message.findOne({ user, messageId: 'answer' })
      .select('+hostFinal +nativeResponse')
      .lean();
    expect(row.hostFinal).toMatchObject({
      version: 1,
      source: identity.source,
      streamId: 'stream',
    });
    expect(path === 'direct' ? row.nativeResponse : row.nativeResponse.status).toBe(
      path === 'direct' ? undefined : 'unsupported',
    );
    expect(await db.readHostResponseFinal({ userId: user, streamId: 'stream' })).toMatchObject({
      text: '',
      attachments: [{ file_id: 'output-file' }],
    });
    expect((await db.getMessages({ user, messageId: 'answer' }))[0].hostFinal).toBeUndefined();
  });
  test('does not stamp partial or grant replay when Stop wins at final save', async () => {
    await finish(false);
    expect(await db.readHostResponseFinal({ userId: user, streamId: 'stream' })).toBeNull();
    req._viventiumHostResponseIsCurrent.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(finish()).resolves.toMatchObject({
      text: '',
      attachments: [{ file_id: 'output-file' }],
    });
    expect(
      (await Message.findOne({ user, messageId: 'answer' }).select('+hostFinal').lean()).hostFinal,
    ).toBeUndefined();
  });
  test('keeps the actual ordinary final when the optional author lookup fails', async () => {
    req._viventiumHostResponseIsCurrent.mockRejectedValue(new Error('job_store_unavailable'));
    await expect(finish()).resolves.toMatchObject({
      text: '',
      attachments: [{ file_id: 'output-file' }],
    });
    expect(
      (await Message.findOne({ user, messageId: 'answer' }).select('+hostFinal').lean()).hostFinal,
    ).toBeUndefined();
    expect(await db.readHostResponseFinal({ userId: user, streamId: 'stream' })).toBeNull();
  });
  test('preserves the actual native snapshot guard rejection without retry', async () => {
    const error = new Error('native_snapshot_rejected');
    const guard = jest.spyOn(db, 'saveNativeResponseSnapshot').mockRejectedValueOnce(error);
    try {
      await expect(finish()).rejects.toBe(error);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(
        (await Message.findOne({ user, messageId: 'answer' }).select('+hostFinal').lean())
          .hostFinal,
      ).toBeUndefined();
    } finally {
      guard.mockRestore();
    }
  });
  test('client save, update and import cannot forge, clear or expose the private receipt', async () => {
    await finish();
    const prior = (await Message.findOne({ user, messageId: 'answer' }).select('+hostFinal').lean())
      .hostFinal;
    await saveMessage(req, {
      messageId: 'answer',
      conversationId,
      hostFinal: { version: 99 },
      text: 'edited',
    });
    await updateMessage(req, {
      messageId: 'answer',
      $unset: { hostFinal: 1 },
      $set: { 'hostFinal.streamId': 'forged' },
    });
    const after = (await Message.findOne({ user, messageId: 'answer' }).select('+hostFinal').lean())
      .hostFinal;
    expect(after).toEqual(prior);
    expect(await db.readHostResponseFinal({ userId: user, streamId: 'stream' })).toBeNull();
    const { sanitizeMessageForPersistence } = require('./Message').__testables;
    expect(
      sanitizeMessageForPersistence({
        hostFinal: prior,
        $setOnInsert: { hostFinal: prior },
        text: 'safe',
      }),
    ).toEqual({ $setOnInsert: {}, text: 'safe' });
  });
});
