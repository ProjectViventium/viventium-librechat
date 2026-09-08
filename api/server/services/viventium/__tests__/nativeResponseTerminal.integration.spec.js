/* === VIVENTIUM START === Actual host/Mongo Stop persistence precedes cancellation publication. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels, createNativeResponseMethods } = require('@librechat/data-schemas');
const mockModels = {};
let mockManager, mockDependencies;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createNativeResponseRecoveryService: (deps) => {
    mockDependencies = deps;
    return jest.requireActual('@librechat/api').createNativeResponseRecoveryService(deps);
  },
  GenerationJobManager: new Proxy(
    {},
    {
      get:
        (_target, key) =>
        (...args) =>
          mockManager[key](...args),
    },
  ),
}));
jest.mock('~/models', () => mockModels);
jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (operation) =>
    require('mongoose').connection.transaction(operation),
}));
const { GenerationJobManagerClass, InMemoryJobStore, InMemoryEventTransport } =
  jest.requireActual('@librechat/api');
const {
  installNativeResponseRecovery,
  recoverNativeResponses,
  recoverNativeResponse,
  getService,
} = require('../nativeResponseService');
const { sanitizeVoiceAssistantMessageForPersistence } = require('../voiceArtifactText');
let server, methods, store, transport, identity, job;
const user = new mongoose.Types.ObjectId().toString();
const transaction = (operation) => mongoose.connection.transaction(operation);
const partial = 'Accepted Stop partial.';
const mainContext = { agentId: 'agent', stableAuthoritySha256: 'd'.repeat(64) };
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  mongoose.set('transactionAsyncLocalStorage', true);
  createModels(mongoose);
  await mongoose.models.Message.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  methods = createNativeResponseMethods(mongoose);
  Object.assign(mockModels, methods, {
    mutateAcceptedMainContinuitySources: (_filter, operation) => operation(),
    getMessages: (filter) => mongoose.models.Message.find(filter).lean(),
    getMessage: (filter) => mongoose.models.Message.findOne(filter).lean(),
  });
  await mongoose.models.Message.deleteMany({});
  await mongoose.models.Message.create([
    {
      user,
      conversationId: 'conversation',
      messageId: 'source',
      text: 'Request.',
      isCreatedByUser: true,
    },
    {
      user,
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'source',
      text: 'Earlier checkpoint.',
      content: [{ type: 'text', text: 'Earlier checkpoint.' }],
      isCreatedByUser: false,
      unfinished: true,
      attachments: [{ type: 'file', file_id: 'kept' }],
      metadata: { viventium: { mainContext }, sibling: 'retained' },
    },
  ]);
  store = new InMemoryJobStore();
  transport = new InMemoryEventTransport();
  transport.emitAbort = jest.fn(async () => undefined);
  mockManager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  await installNativeResponseRecovery();
  job = await mockManager.createJob('stream', user, 'conversation', {
    interactionContext: {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'conversation',
      revision: 1,
      source_event_id: 'request',
    },
  });
  await mockManager.updateMetadata('stream', {
    responseMessageId: 'answer',
    sender: 'AI',
    userMessage: { messageId: 'source', conversationId: 'conversation', text: 'Request.' },
  });
  identity = {
    userId: user,
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: job.createdAt,
    logicalTurnId: job.metadata.interactionContext.logical_turn_id,
    revision: job.metadata.interactionContext.revision,
    invocationId: 'native-invocation',
    bodySha256: 'b'.repeat(64),
    originSha256: 'c'.repeat(64),
    providerId: 'provider',
    agentId: 'agent',
    source: await methods.captureNativeResponseSource(user, 'conversation', 'source'),
    admittedAt: Date.now(),
    recoverUntil: Date.now() + 86400000,
    deliveryContext: { surface: 'web' },
  };
  store.setContentParts('stream', [{ type: 'text', text: partial }]);
  getService();
  identity.originSha256 = require('@librechat/api').nativeResponseOrigin('http://native.test/v1');
  mockDependencies.resolveRoute = async () => ({ baseURL: 'http://native.test/v1', headers: {} });
});
afterEach(async () => {
  jest.restoreAllMocks();
  await mockManager.destroy();
});

async function admit(context = { surface: 'web' }, required = false) {
  identity.deliveryContext = context;
  identity.deliveryDispositionRequired = required;
  expect(await mockManager.bindNativeResponse(identity)).toBe(true);
  await methods.admitNativeResponse(identity, transaction);
}

test.each(['failed', 'cancelled'])(
  'authoritative %s publishes a durable error FINAL and reopens',
  async (state) => {
    await admit();
    mockDependencies.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            object: 'glasshive.request.result',
            state,
            invocation_id: identity.invocationId,
            stream_id: identity.streamId,
            message_id: identity.responseMessageId,
            body_sha256: identity.bodySha256,
            agent_id: identity.agentId,
            conversation_id: identity.conversationId,
            request_id: 'request',
            run_id: 'run',
          }),
        ),
    );
    const done = jest.spyOn(transport, 'emitDone');
    expect(await recoverNativeResponse(identity)).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    const final = done.mock.calls[0][1];
    expect(final).toMatchObject({
      final: true,
      requestMessage: { messageId: 'source' },
      responseMessage: {
        messageId: 'answer',
        error: true,
        unfinished: false,
        content: expect.arrayContaining([
          expect.objectContaining({ type: 'error', error_class: `native_response_${state}` }),
        ]),
      },
    });
    expect(final.responseMessage.nativeResponse).toBeUndefined();
    expect(final.memoryWriterScheduled).toBeUndefined();
    const row = await methods.getNativeResponse(user, 'answer');
    expect(row.nativeResponse).toMatchObject({
      status: state,
      terminalSnapshotStoredAt: expect.any(Number),
      finalReplayStoredAt: expect.any(Number),
    });
    expect(row.nativeResponse.stopSnapshotStoredAt).toBeUndefined();
    expect((await store.getJob('stream')).status).not.toBe('running');
    expect((await store.getJob('stream')).finalEvent).toBe(JSON.stringify(final));
    expect(mockDependencies.fetch).toHaveBeenCalledTimes(1);
  },
);

function upstream(state) {
  mockDependencies.fetch = jest.fn(
    async () =>
      new Response(
        JSON.stringify({
          version: 1,
          object: 'glasshive.request.result',
          state,
          invocation_id: identity.invocationId,
          stream_id: identity.streamId,
          message_id: identity.responseMessageId,
          body_sha256: identity.bodySha256,
          agent_id: identity.agentId,
          conversation_id: identity.conversationId,
          request_id: 'request',
          run_id: 'run',
        }),
      ),
  );
}

test.each(['failed', 'cancelled'])(
  'recovers legacy unmarked %s without another invocation',
  async (state) => {
    await admit();
    upstream(state);
    await mockManager.revokeNativeResponse(identity);
    await methods.settleNativeResponse(identity, state);
    await recoverNativeResponses();
    const row = await methods.getNativeResponse(user, 'answer');
    expect(row.nativeResponse.terminalSnapshotStoredAt).toEqual(expect.any(Number));
    expect(row.nativeResponse.finalReplayStoredAt).toEqual(expect.any(Number));
    expect((await store.getJob('stream')).finalEvent).toBeTruthy();
    expect(mockDependencies.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
    expect(mockDependencies.fetch).toHaveBeenCalledTimes(1);
  },
);

test('recovers after Mongo acceptance and failed transport with the same canonical FINAL', async () => {
  await admit();
  upstream('failed');
  const original = transport.emitDone.bind(transport);
  jest
    .spyOn(transport, 'emitDone')
    .mockRejectedValueOnce(new Error('transport_down'))
    .mockImplementation(original);
  await expect(recoverNativeResponse(identity)).rejects.toThrow('transport_down');
  const before = await methods.getNativeResponse(user, 'answer');
  expect(before.nativeResponse.terminalSnapshotStoredAt).toEqual(expect.any(Number));
  expect(before.nativeResponse.finalReplayStoredAt).toBeUndefined();
  const firstFinal = (await store.getJob('stream')).finalEvent;
  expect(await recoverNativeResponse(identity)).toBe(true);
  expect((await store.getJob('stream')).finalEvent).toBe(firstFinal);
  expect(mockDependencies.fetch).toHaveBeenCalledTimes(1);
});

test('source edit after exact result lookup wins before terminal materialization', async () => {
  await admit();
  upstream('failed');
  const read = mockDependencies.fetch;
  mockDependencies.fetch = jest.fn(async (...args) => {
    const result = await read(...args);
    await methods.mutateNativeResponseSources(
      { user, messageId: 'source' },
      () => mongoose.models.Message.updateOne({ user, messageId: 'source' }, { text: 'Changed' }),
      (id) => mockManager.revokeNativeResponse(id),
      transaction,
      (id) => mockManager.retireNativeResponse(id),
    );
    return result;
  });
  await expect(recoverNativeResponse(identity)).rejects.toThrow('source_changed');
  expect(
    (await methods.getNativeResponse(user, 'answer')).nativeResponse.terminalSnapshotStoredAt,
  ).toBeUndefined();
  expect((await store.getJob('stream')).finalEvent).toBeUndefined();
});

test.each(['answer', 'source'])(
  'retired %s skips lookup and never publishes a terminal FINAL',
  async (messageId) => {
    await admit();
    upstream('failed');
    if (messageId === 'source') await recoverNativeResponse(identity);
    await methods.mutateNativeResponseSources(
      { user, messageId },
      () => mongoose.models.Message.updateOne({ user, messageId }, { text: 'Edited' }),
      (id) => mockManager.revokeNativeResponse(id),
      transaction,
      (id) => mockManager.retireNativeResponse(id),
    );
    mockDependencies.fetch.mockClear();
    await recoverNativeResponses();
    expect(mockDependencies.fetch).not.toHaveBeenCalled();
    expect(
      (await methods.getNativeResponse(user, 'answer')).nativeResponse.terminalSnapshotStoredAt,
    ).toBeUndefined();
    expect(await store.getJob('stream')).toBeNull();
  },
);

test('Stop snapshot wins over the cancelled upstream result without another cancellation action', async () => {
  await admit();
  upstream('cancelled');
  expect((await mockManager.abortJob('stream', 'user_cancelled')).success).toBe(true);
  const row = await methods.getNativeResponse(user, 'answer');
  expect(row.nativeResponse.stopSnapshotStoredAt).toEqual(expect.any(Number));
  expect(row.nativeResponse.terminalSnapshotStoredAt).toBeUndefined();
  expect(row.error).toBe(false);
  expect(mockDependencies.fetch).not.toHaveBeenCalled();
});

test('unavailable exact job authority leaves no terminal success receipt', async () => {
  await admit();
  upstream('failed');
  jest.spyOn(store, 'cancelNativeResponse').mockResolvedValue({ status: 'unavailable' });
  await expect(recoverNativeResponse(identity)).rejects.toThrow('terminal_authority_unavailable');
  expect((await methods.getNativeResponse(user, 'answer')).nativeResponse.status).toBe('pending');
  expect((await store.getJob('stream')).finalEvent).toBeUndefined();
});

test.each([
  { surface: 'voice' },
  { surface: 'telegram', authenticated: true, audioRequested: true },
])('terminal %j uses existing audio skip and clean public projection', async (context) => {
  await admit(context);
  upstream('failed');
  const done = jest.spyOn(transport, 'emitDone');
  expect(await recoverNativeResponse(identity)).toBe(true);
  expect(done.mock.calls[0][1].responseMessage.metadata.viventium.deliveryDisposition.audio).toBe(
    'skip',
  );
  expect(done.mock.calls[0][1].responseMessage.nativeResponse).toBeUndefined();
});

test('assistant edit after snapshot acceptance fences delayed terminal publication', async () => {
  await admit();
  upstream('failed');
  let release, enter;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    enter = resolve;
  });
  const original = transport.emitDone.bind(transport);
  const done = jest.spyOn(transport, 'emitDone').mockImplementation(async (...args) => {
    enter();
    await gate;
    return original(...args);
  });
  const recovering = recoverNativeResponse(identity);
  await reached;
  await methods.mutateNativeResponseSources(
    { user, messageId: 'answer' },
    () =>
      mongoose.models.Message.updateOne({ user, messageId: 'answer' }, { text: 'Explicit edit' }),
    (id) => mockManager.revokeNativeResponse(id),
    transaction,
    (id) => mockManager.retireNativeResponse(id),
  );
  release();
  expect(await recovering).toBe(false);
  expect((await methods.getNativeResponse(user, 'answer')).text).toBe('Explicit edit');
  expect(
    (await methods.getNativeResponse(user, 'answer')).nativeResponse.terminalSnapshotStoredAt,
  ).toBeUndefined();
  expect(await store.getJob('stream')).toBeNull();
  expect(done).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  'retired first page cannot starve current job; delete between batches: %s',
  async (deleteRetired) => {
    await admit();
    upstream('cancelled');
    await mockManager.revokeNativeResponse(identity);
    await methods.settleNativeResponse(identity, 'cancelled');
    const older = Array.from({ length: 100 }, (_, index) => ({
      user,
      conversationId: 'conversation',
      messageId: `retired-${index}`,
      parentMessageId: 'source',
      isCreatedByUser: false,
      unfinished: false,
      text: 'Retired fixture.',
      nativeResponse: {
        ...identity,
        responseMessageId: `retired-${index}`,
        streamId: `retired-${index}`,
        invocationId: `retired-invocation-${index}`,
        admittedAt: identity.admittedAt - 1000 + Math.floor(index / 2),
        status: 'cancelled',
      },
    }));
    await mongoose.models.Message.collection.insertMany(older);
    const first = await methods.listNativeResponses();
    expect(first).toHaveLength(100);
    expect(first.some((row) => row.messageId === identity.responseMessageId)).toBe(false);
    expect((await store.getJob(identity.streamId)).nativeResponse).toEqual(identity);
    const readJob = store.getJob.bind(store);
    let retiredDeleted = false;
    const lookup = jest.spyOn(store, 'getJob').mockImplementation(async (streamId) => {
      if (deleteRetired && !retiredDeleted && streamId.startsWith('retired-')) {
        retiredDeleted = true;
        await mongoose.models.Message.deleteMany({ messageId: /^retired-/ });
      }
      return readJob(streamId);
    });
    await recoverNativeResponses();
    await recoverNativeResponses();
    const stillFirst = await methods.listNativeResponses();
    if (deleteRetired) expect(stillFirst).toEqual([]);
    else
      expect(stillFirst.map((row) => row.messageId).sort()).toEqual(
        first.map((row) => row.messageId).sort(),
      );
    expect(lookup.mock.calls.some(([stream]) => stream.startsWith('retired-'))).toBe(true);
    expect(mockDependencies.fetch).toHaveBeenCalledTimes(1);
    expect(
      (await methods.getNativeResponse(user, 'answer')).nativeResponse.finalReplayStoredAt,
    ).toEqual(expect.any(Number));
  },
);

test('cursor error closes the actual cursor and allows the next pass', async () => {
  await admit();
  const list = mockModels.listNativeResponses;
  const cursors = [];
  jest.spyOn(mockModels, 'listNativeResponses').mockImplementation((...args) => {
    const query = list(...args);
    const makeCursor = query.cursor.bind(query);
    query.cursor = (options) => {
      const cursor = makeCursor(options);
      cursors.push(cursor);
      jest.spyOn(cursor, 'close');
      if (cursors.length === 1)
        cursor.once('cursor', (driver) => {
          jest
            .spyOn(driver, 'next')
            .mockRejectedValueOnce(new Error('synthetic_cursor_read_failed'));
        });
      return cursor;
    };
    return query;
  });
  const visited = jest.fn();
  await expect(getService().scanRecoverable(visited)).rejects.toThrow(
    'synthetic_cursor_read_failed',
  );
  expect(cursors[0].close).toHaveBeenCalledTimes(1);
  expect(visited).not.toHaveBeenCalled();
  await getService().scanRecoverable(visited);
  expect(visited).toHaveBeenCalledTimes(1);
  expect(cursors[1].close).toHaveBeenCalledTimes(1);
});

test('overlapping recovery passes share one scan and close after a handler failure', async () => {
  await admit();
  const list = mockModels.listNativeResponses;
  const cursors = [];
  const listing = jest.spyOn(mockModels, 'listNativeResponses').mockImplementation((...args) => {
    const query = list(...args);
    const makeCursor = query.cursor.bind(query);
    query.cursor = (options) => {
      const cursor = makeCursor(options);
      cursors.push(cursor);
      jest.spyOn(cursor, 'close');
      return cursor;
    };
    return query;
  });
  let release, entered;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const handle = jest.fn(async () => {
    entered();
    await waiting;
    throw new Error('synthetic_handler_failed');
  });
  const first = getService().scanRecoverable(handle);
  await started;
  const second = getService().scanRecoverable(handle);
  expect(first).toBe(second);
  expect(listing).toHaveBeenCalledTimes(1);
  release();
  await expect(first).rejects.toThrow('synthetic_handler_failed');
  expect(cursors[0].close).toHaveBeenCalledTimes(1);
  expect(handle).toHaveBeenCalledTimes(1);
  await getService().scanRecoverable(async () => {});
  expect(listing).toHaveBeenCalledTimes(2);
  expect(cursors[1].close).toHaveBeenCalledTimes(1);
});
