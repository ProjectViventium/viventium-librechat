const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
let mockManager;

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    GenerationJobManager: {
      revokeNativeResponse: (...args) => mockManager.revokeNativeResponse(...args),
      retireNativeResponse: (...args) => mockManager.retireNativeResponse(...args),
    },
  };
});

const {
  GenerationJobManagerClass,
  InMemoryJobStore,
  InMemoryEventTransport,
} = require('@librechat/api');
const { Message, ViventiumMainContinuityState } = require('~/db/models');
const db = require('~/models');
const { mutateNativeResponseSources } = require('../nativeResponseService');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('../GlassHiveTerminalCallbackTransaction');

const transaction = (operation) =>
  runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' });
const user = new mongoose.Types.ObjectId().toString();
const conversationId = '00000000-0000-4000-8000-000000000011';
const candidate = {
  text: 'Canonical answer.',
  authoritySha256: 'a'.repeat(64),
  requestId: 'request',
  runId: 'native-run',
  responseJson: '{}',
};
function gate() {
  let release;
  let enter;
  return {
    held: new Promise((resolve) => {
      release = resolve;
    }),
    entered: new Promise((resolve) => {
      enter = resolve;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}

describe('native host transaction retry with actual Mongo and generation owner', () => {
  let server;
  let identity;
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(server.getUri());
    await Message.init();
    await ViventiumMainContinuityState.init();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await server.stop();
  });
  beforeEach(async () => {
    await Message.deleteMany({});
    await ViventiumMainContinuityState.deleteMany({});
    await Message.create([
      {
        user,
        conversationId,
        messageId: 'question',
        isCreatedByUser: true,
        text: 'Original request.',
      },
      {
        user,
        conversationId,
        messageId: 'answer',
        parentMessageId: 'question',
        isCreatedByUser: false,
        unfinished: true,
        text: 'In progress.',
      },
    ]);
    const store = new InMemoryJobStore();
    mockManager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
    });
    mockManager.initialize();
    const claim = await store.claimLogicalTurn('stream', user, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: conversationId,
      revision: 1,
      source_event_id: 'request',
    });
    const job = await store.createJob('stream', user, conversationId, {
      responseMessageId: 'answer',
      interactionContext: claim.interactionContext,
      userMessage: { messageId: 'question' },
    });
    identity = {
      userId: user,
      conversationId,
      responseMessageId: 'answer',
      streamId: 'stream',
      jobCreatedAt: job.createdAt,
      logicalTurnId: claim.interactionContext.logical_turn_id,
      revision: claim.interactionContext.revision,
      invocationId: 'invocation',
      bodySha256: 'b'.repeat(64),
      providerId: 'provider',
      agentId: 'main',
      originSha256: 'c'.repeat(64),
      source: await db.captureNativeResponseSource(user, conversationId, 'question'),
      admittedAt: Date.now(),
      recoverUntil: Date.now() + 86400000,
    };
    if (!(await mockManager.bindNativeResponse(identity)))
      throw new Error('native test admission failed');
  });
  afterEach(async () => {
    await mockManager.destroy();
  });

  it('an edit retries a real admission race through the unchanged A1/B2 host boundary', async () => {
    const paused = gate();
    let attempts = 0;
    const editing = mutateNativeResponseSources(
      { user, messageId: 'question' },
      async () => {
        if (++attempts === 1) {
          paused.enter();
          await paused.held;
        }
        return Message.updateOne({ user, messageId: 'question' }, { text: 'Edited request.' });
      },
      'edit',
    );
    await paused.entered;
    try {
      await db.admitNativeResponse(identity, transaction);
    } finally {
      paused.release();
    }
    await editing;
    expect(attempts).toBeGreaterThan(1);
    expect((await db.getNativeResponse(user, 'answer')).nativeResponse.status).toBe('cancelled');
    expect((await Message.findOne({ user, messageId: 'question' }).lean()).text).toBe(
      'Edited request.',
    );
    expect(await mockManager.commitNativeResponse(identity, 'd'.repeat(64))).toMatchObject({
      status: 'revoked',
    });
  });

  it('system augmentation retries materialization and keeps both canonical text and new parts', async () => {
    await db.admitNativeResponse(identity, transaction);
    const digest = await db.prepareNativeResponse(identity, candidate, transaction);
    const paused = gate();
    const write = Message.findOneAndUpdate.bind(Message);
    const intercepted = jest
      .spyOn(Message, 'findOneAndUpdate')
      .mockImplementationOnce((...args) => {
        paused.enter();
        return paused.held.then(() => write(...args));
      });
    const contribution = { type: 'cortex_insight', text: 'Background contribution.' };
    const augmenting = db.updateMessage(
      { user: { id: user } },
      {
        messageId: 'answer',
        text: 'Old partial.',
        content: [{ type: 'text', text: 'Old partial.' }, contribution],
      },
      { operationKind: 'system' },
    );
    await paused.entered;
    try {
      await db.materializeNativeResponse(
        identity,
        digest,
        (bound, sha) => mockManager.commitNativeResponse(bound, sha),
        transaction,
      );
    } finally {
      paused.release();
    }
    await augmenting;
    intercepted.mockRestore();
    expect(await db.getNativeResponse(user, 'answer')).toMatchObject({
      text: candidate.text,
      unfinished: false,
      content: [{ type: 'text', text: candidate.text }, contribution],
    });
  });

  it.each([
    ['question', 'revokeNativeResponse'],
    ['answer', 'retireNativeResponse'],
  ])(
    'replays %s mutation safely after the actual generation owner %s already ran',
    async (messageId, method) => {
      await db.admitNativeResponse(identity, transaction);
      const action = jest.spyOn(mockManager, method);
      let attempts = 0;
      await mutateNativeResponseSources(
        { user, messageId },
        async () => {
          if (++attempts === 1) {
            const error = new mongoose.mongo.MongoServerError({
              message: 'synthetic conflict after generation fence',
              code: 112,
            });
            error.addErrorLabel('TransientTransactionError');
            throw error;
          }
          return Message.updateOne({ user, messageId }, { text: 'Explicit correction.' });
        },
        'edit',
      );
      expect(attempts).toBe(2);
      expect(action).toHaveBeenCalledTimes(2);
      expect((await Message.findOne({ user, messageId }).lean()).text).toBe('Explicit correction.');
      expect((await db.getNativeResponse(user, 'answer')).nativeResponse.status).toBe('cancelled');
      expect(await mockManager.commitNativeResponse(identity, 'd'.repeat(64))).toMatchObject({
        status: method === 'retireNativeResponse' ? 'unavailable' : 'revoked',
      });
      if (method === 'retireNativeResponse') {
        expect(await mockManager.getJob('stream')).toBeUndefined();
        expect(
          await mockManager.finishNativeResponse(identity, {
            final: true,
            responseMessage: { messageId: 'answer', text: 'Obsolete.' },
          }),
        ).toBe(false);
      }
    },
  );
});
