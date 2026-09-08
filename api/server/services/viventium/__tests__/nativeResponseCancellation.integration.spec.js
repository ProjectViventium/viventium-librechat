/* === VIVENTIUM START === Actual host/Mongo Stop persistence precedes cancellation publication. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels, createNativeResponseMethods } = require('@librechat/data-schemas');
const mockModels = {};
let mockManager;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
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

test.each(['pending', 'prepared'])(
  'Stop persists the %s partial before provider abort and FINAL',
  async (status) => {
    await admit();
    if (status === 'prepared')
      await methods.prepareNativeResponse(
        identity,
        {
          text: 'Unaccepted final.',
          authoritySha256: 'a'.repeat(64),
          requestId: 'request',
          runId: 'run',
          responseJson: '{}',
        },
        transaction,
      );
    const observations = [];
    const emitAbort = jest.spyOn(transport, 'emitAbort').mockImplementation(async () => {
      const row = await methods.getNativeResponse(user, 'answer');
      observations.push(row.text);
      // Cancellation result delivery cannot settle before the Stop snapshot anymore.
      await methods.settleNativeResponse(identity, 'cancelled');
    });
    const emitDone = jest
      .spyOn(transport, 'emitDone')
      .mockImplementation(async (_stream, final) => {
        const row = await methods.getNativeResponse(user, 'answer');
        observations.push(row.text);
        expect(final.responseMessage.text).toBe(row.text);
        expect(final.responseMessage.content).toEqual(row.content);
        expect(final.responseMessage.nativeResponse).toBeUndefined();
        expect(final.responseMessage.metadata.viventium.mainContext).toEqual(mainContext);
      });
    const result = await mockManager.abortJob('stream', 'user_cancelled');
    expect(result.success).toBe(true);
    expect(observations).toEqual([partial, partial]);
    expect(emitAbort).toHaveBeenCalledTimes(1);
    expect(emitDone).toHaveBeenCalledTimes(1);
    expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
      text: partial,
      unfinished: true,
      error: false,
      finish_reason: 'incomplete',
      nativeResponse: { status: 'cancelled' },
      attachments: [{ type: 'file', file_id: 'kept' }],
    });
    expect(
      (
        await methods.saveNativeResponseSnapshot(
          user,
          { messageId: 'answer', text: 'Late producer error.', error: true, unfinished: false },
          identity,
        )
      ).text,
    ).toBe(partial);
    expect((await mockManager.abortJob('stream', 'user_cancelled')).success).toBe(false);
    expect(emitDone).toHaveBeenCalledTimes(1);
  },
);

test.each(['failed', 'cancelled', 'deleted', 'edited'])(
  'a prior %s result cannot become a successful Stop snapshot',
  async (state) => {
    await admit();
    if (state === 'deleted') await mongoose.models.Message.deleteOne({ user, messageId: 'answer' });
    else if (state === 'edited') {
      await methods.settleNativeResponse(identity, 'cancelled');
      await mongoose.models.Message.updateOne(
        { user, messageId: 'answer' },
        { $set: { text: 'Explicit correction.' } },
      );
    } else await methods.settleNativeResponse(identity, state);
    const before = await methods.getNativeResponse(user, 'answer');
    const abort = jest.spyOn(transport, 'emitAbort');
    const done = jest.spyOn(transport, 'emitDone');
    const result = await mockManager.abortJob('stream', 'user_cancelled');
    expect(result).toMatchObject({ success: false, nativeResponse: 'unavailable' });
    expect(abort).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(await methods.getNativeResponse(user, 'answer')).toEqual(before);
    expect(await store.getJob('stream')).not.toBeNull();
  },
);

test('storage failure cannot emit successful cancellation or clean up the retained job', async () => {
  await admit();
  mockModels.settleNativeResponse = async () => {
    throw new Error('Storage unavailable');
  };
  const abort = jest.spyOn(transport, 'emitAbort');
  const done = jest.spyOn(transport, 'emitDone');
  expect(await mockManager.abortJob('stream', 'user_cancelled')).toMatchObject({
    success: false,
    nativeResponse: 'unavailable',
  });
  expect(abort).not.toHaveBeenCalled();
  expect(done).not.toHaveBeenCalled();
  expect((await methods.getNativeResponse(user, 'answer')).text).toBe('Earlier checkpoint.');
  expect(await store.getJob('stream')).not.toBeNull();
});
test.each([
  [{ surface: 'voice' }, false, '**Spoken answer.** https://example.test/'],
  [
    { surface: 'telegram', authenticated: true, audioRequested: true },
    true,
    '<emotion>Answer.</emotion>\n{MSG_BREAK}\nMore.',
  ],
  [
    { surface: 'telegram', authenticated: true, audioRequested: false },
    false,
    '<emotion>Opt out.</emotion>',
  ],
  [
    { surface: 'telegram', authenticated: false, audioRequested: false },
    false,
    'Answer.\n{SKIP_VOICE}',
  ],
  [
    { surface: 'telegram', authenticated: true, audioRequested: false },
    false,
    'Example:\n```\n{SKIP_VOICE}\n```',
  ],
])('Stop uses the same public projection for %j', async (context, required, raw) => {
  await admit(context, required);
  const content = [
    { type: 'text', text: raw, metadata: { cortex_delivery_feeling_snapshot: 'private-canary' } },
  ];
  store.setContentParts('stream', content);
  const result = await mockManager.abortJob('stream', 'user_cancelled');
  expect(result.success).toBe(true);
  const row = await methods.getNativeResponse(user, 'answer');
  const expected = sanitizeVoiceAssistantMessageForPersistence(
    {
      body: {
        voiceMode: context.surface === 'voice',
        viventiumSurface: context.surface,
        telegramAudioRequested: context.audioRequested,
      },
    },
    { text: raw, content },
  );
  expect(row.text).toBe(expected.text);
  expect(result.text).toBe(row.text);
  expect(result.content).toEqual(row.content);
  expect(result.finalEvent.responseMessage.content).toEqual(row.content);
  expect(JSON.stringify(result.finalEvent)).not.toContain('private-canary');
  expect(result.finalEvent.responseMessage.nativeResponse).toBeUndefined();
  if (required)
    expect(row.metadata.viventium.deliveryDisposition).toMatchObject({
      audio: 'skip',
      valid: false,
    });
});

test('a job bound before Mongo admission cannot publish or fabricate a Stop snapshot', async () => {
  expect(await mockManager.bindNativeResponse(identity)).toBe(true);
  const done = jest.spyOn(transport, 'emitDone');
  expect(await mockManager.abortJob('stream', 'user_cancelled')).toMatchObject({
    success: false,
    nativeResponse: 'unavailable',
  });
  expect(done).not.toHaveBeenCalled();
  expect((await methods.getNativeResponse(user, 'answer')).text).toBe('Earlier checkpoint.');
});

test('acknowledged cancellation activity augments the already-saved partial', async () => {
  await admit();
  job.abortController.signal.addEventListener('abort', () => {
    job.abortController.signal._viventiumHarnessCancellationDelivery = Promise.resolve({
      delivered: true,
    });
  });
  const result = await mockManager.abortJob('stream', 'user_cancelled');
  expect(result.success).toBe(true);
  const row = await methods.getNativeResponse(user, 'answer');
  expect(row.text).toBe(partial);
  expect(row.content).toContainEqual({
    type: 'harness_activity',
    harness_activity: {
      event: 'cancelled',
      summary: 'The harness turn was cancelled.\n',
    },
  });
  expect(result.finalEvent.responseMessage.content).toEqual([{ type: 'text', text: partial }]);
  expect(result.finalEvent.responseMessage.metadata.viventium.mainContext).toEqual(mainContext);
  expect(row.metadata.viventium.mainContext).toEqual(mainContext);
  expect(row.finish_reason).toBe('incomplete');
});
test('an explicit edit wins while the Stop owner awaits its atomic write', async () => {
  await admit();
  let release, entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const settle = mockModels.settleNativeResponse;
  let intercepted = false;
  mockModels.settleNativeResponse = async (...args) => {
    if (!intercepted) {
      intercepted = true;
      entered();
      await held;
    }
    return settle(...args);
  };
  const emit = jest.spyOn(transport, 'emitDone');
  const stopping = mockManager.abortJob('stream', 'user_cancelled');
  await started;
  try {
    await methods.mutateNativeResponseSources(
      { user, messageId: 'answer' },
      () =>
        mongoose.models.Message.updateOne(
          { user, messageId: 'answer' },
          { $set: { text: 'Explicit correction.' } },
        ),
      (value) => mockManager.revokeNativeResponse(value),
      transaction,
      (value) => mockManager.retireNativeResponse(value),
      'edit',
    );
  } finally {
    release();
  }
  expect(await stopping).toMatchObject({ success: false, nativeResponse: 'unavailable' });
  expect((await methods.getNativeResponse(user, 'answer')).text).toBe('Explicit correction.');
  expect(emit).not.toHaveBeenCalled();
});

test.each(['emitAbort', 'emitDone'])(
  'recovery after %s fails uses the saved Stop snapshot without a provider call',
  async (method) => {
    await admit();
    jest.spyOn(transport, method).mockRejectedValueOnce(new Error('Transport unavailable'));
    await expect(mockManager.abortJob('stream', 'user_cancelled')).rejects.toThrow(
      'Transport unavailable',
    );
    const before = await methods.getNativeResponse(user, 'answer');
    const firstFinal = (await store.getJob('stream')).finalEvent;
    expect(before.nativeResponse.stopSnapshotStoredAt).toEqual(expect.any(Number));
    expect(before.nativeResponse.finalReplayStoredAt).toBeUndefined();
    store.setContentParts('stream', [{ type: 'text', text: 'Mutable retry input.' }]);
    const oldManager = mockManager;
    const replayTransport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
    const delivered = jest.spyOn(replayTransport, 'emitDone');
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('Unexpected provider call'));
    mockManager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: replayTransport,
    });
    try {
      await installNativeResponseRecovery();
      await recoverNativeResponses();
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(delivered.mock.calls[0][1])).toBe(firstFinal);
      const after = await methods.getNativeResponse(user, 'answer');
      expect(after.text).toBe(before.text);
      expect(after.content).toEqual(before.content);
      expect(after.metadata).toEqual(before.metadata);
      expect(after.nativeResponse.finalReplayStoredAt).toEqual(expect.any(Number));
      expect(await store.getJob('stream')).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      await recoverNativeResponses();
      expect(delivered).toHaveBeenCalledTimes(1);
    } finally {
      await oldManager.destroy();
    }
  },
);

test('failed replay marking retains the first FINAL until exact retry succeeds', async () => {
  await admit();
  const mark = mockModels.markNativeResponseReplayStored;
  mockModels.markNativeResponseReplayStored = jest
    .fn()
    .mockRejectedValueOnce(new Error('Storage unavailable'))
    .mockImplementation(mark);
  const done = jest.spyOn(transport, 'emitDone');
  expect(await mockManager.abortJob('stream', 'user_cancelled')).toMatchObject({
    success: false,
    nativeResponse: 'unavailable',
  });
  const first = (await store.getJob('stream')).finalEvent;
  expect(
    (await methods.getNativeResponse(user, 'answer')).nativeResponse.finalReplayStoredAt,
  ).toBeUndefined();
  const result = await mockManager.abortJob('stream', 'user_cancelled', identity);
  expect(result.success).toBe(true);
  expect(JSON.stringify(result.finalEvent)).toBe(first);
  expect(done.mock.calls.map((call) => JSON.stringify(call[1]))).toEqual([first, first]);
});

test.each(['answer', 'source'])(
  'an explicit %s edit after Stop persistence blocks a held FINAL and later recovery',
  async (messageId) => {
    await admit();
    let entered, release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const emit = transport.emitDone.bind(transport);
    const delivered = jest.fn();
    transport.subscribe('stream', { onChunk: jest.fn(), onDone: delivered });
    jest.spyOn(transport, 'emitDone').mockImplementationOnce(async (...args) => {
      entered();
      await held;
      return emit(...args);
    });
    const stopping = mockManager.abortJob('stream', 'user_cancelled');
    await started;
    try {
      await methods.mutateNativeResponseSources(
        { user, messageId },
        () =>
          mongoose.models.Message.updateOne(
            { user, messageId },
            { $set: { text: 'Explicit correction.' } },
          ),
        (value) => mockManager.revokeNativeResponse(value),
        transaction,
        (value) => mockManager.retireNativeResponse(value),
        'edit',
      );
    } finally {
      release();
    }
    expect(await stopping).toMatchObject({ success: false, nativeResponse: 'unavailable' });
    expect(delivered).not.toHaveBeenCalled();
    expect(
      (await methods.getNativeResponse(user, 'answer')).nativeResponse.stopSnapshotStoredAt,
    ).toBeUndefined();
    expect(await recoverNativeResponse(identity)).toBe(false);
  },
);

test('a stored Stop recovers even when job-store failure leaves the original producer registered', async () => {
  await admit();
  expect(mockManager.hasLocalNativeResponseProducer(identity)).toBe(true);
  jest
    .spyOn(store, 'finishNativeResponse')
    .mockRejectedValueOnce(new Error('Job store unavailable'));
  const done = jest.spyOn(transport, 'emitDone');
  await expect(mockManager.abortJob('stream', 'user_cancelled')).rejects.toThrow(
    'Job store unavailable',
  );
  expect(
    (await methods.getNativeResponse(user, 'answer')).nativeResponse.stopSnapshotStoredAt,
  ).toEqual(expect.any(Number));
  expect(mockManager.hasLocalNativeResponseProducer(identity)).toBe(true);
  expect(done).not.toHaveBeenCalled();
  await recoverNativeResponses();
  expect(done).toHaveBeenCalledTimes(1);
  expect(done.mock.calls[0][1].responseMessage.text).toBe(partial);
  expect(
    (await methods.getNativeResponse(user, 'answer')).nativeResponse.finalReplayStoredAt,
  ).toEqual(expect.any(Number));
});

test.each([false, true])(
  'actual unsupported handoff respects a concurrent Stop: %s',
  async (stopWins) => {
    const { createNativeResponseRecoveryService, nativeResponseOrigin } =
      jest.requireActual('@librechat/api');
    identity.originSha256 = nativeResponseOrigin('http://native.test/v1');
    await admit();
    let entered, releaseWrite;
    const held = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const release = jest.fn((value) => mockManager.settleNativeResponse(value, 'unsupported'));
    const db = {
      ...methods,
      settleNativeResponse: async (...args) => {
        if (stopWins && args[1] === 'unsupported') {
          entered();
          await held;
        }
        return methods.settleNativeResponse(...args);
      },
    };
    const owner = createNativeResponseRecoveryService({
      db,
      transaction,
      bind: (value) => mockManager.bindNativeResponse(value),
      commit: (value, digest) => mockManager.commitNativeResponse(value, digest),
      revoke: (value) => mockManager.revokeNativeResponse(value),
      release,
      resolveRoute: async () => ({ baseURL: 'http://native.test/v1', headers: {} }),
      fetch: async () =>
        new Response(
          JSON.stringify({
            version: 1,
            object: 'glasshive.request.result',
            state: 'unsupported',
            invocation_id: identity.invocationId,
            stream_id: identity.streamId,
            message_id: identity.responseMessageId,
            body_sha256: identity.bodySha256,
            agent_id: identity.agentId,
            conversation_id: identity.conversationId,
          }),
          { status: 200 },
        ),
    });
    const recovering = owner.recover(identity);
    if (stopWins) {
      await started;
      try {
        expect((await mockManager.abortJob('stream', 'user_cancelled')).success).toBe(true);
      } finally {
        releaseWrite();
      }
      await expect(recovering).rejects.toThrow('handoff_unavailable');
      expect(release).not.toHaveBeenCalled();
      expect(await methods.getNativeResponse(user, 'answer')).toMatchObject({
        text: partial,
        nativeResponse: { status: 'cancelled', stopSnapshotStoredAt: expect.any(Number) },
      });
    } else {
      expect(await recovering).toBeNull();
      expect(release).toHaveBeenCalledWith(identity);
      expect((await methods.getNativeResponse(user, 'answer')).nativeResponse.status).toBe(
        'unsupported',
      );
      expect((await store.getJob('stream')).nativeResponse).toBeUndefined();
      expect(await store.getNativeResponseCommit(identity)).toMatchObject({ status: 'revoked' });
      const final = {
        final: true,
        responseMessage: { messageId: 'answer', text: 'Host graph answer.' },
      };
      const emitted = jest.spyOn(transport, 'emitDone');
      await mockManager.emitDone('stream', final);
      expect(emitted).toHaveBeenCalledWith('stream', final);
      expect((await store.getJob('stream')).finalEvent).toBe(JSON.stringify(final));
    }
  },
);

/* === VIVENTIUM END === */
