const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { Message, Conversation, ViventiumMainContinuityState } = require('~/db/models');

jest.mock('~/server/services/Config/app');
jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  ...jest.requireActual('~/server/services/viventium/conversationRecallService'),
  scheduleConversationRecallSync: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'owner' };
    next();
  },
  validateMessageReq: jest.requireActual('~/server/middleware/validateMessageReq'),
}));

const db = require('./Message');
const router = require('~/server/routes/messages');
const conversationId = '00000000-0000-4000-8000-000000000012';
const stamp = { agentId: 'agent', stableAuthoritySha256: 'a'.repeat(64) };
const identity = Object.freeze({ ownerId: 'owner', ...stamp });
const req = {
  user: { id: 'owner' },
  body: {},
  _viventiumAcceptedMainCompactionIdentityV1: identity,
};
const assistant = {
  messageId: 'answer',
  conversationId,
  parentMessageId: 'question',
  isCreatedByUser: false,
  text: 'Saved answer.',
  unfinished: false,
};
const binding = { responseMessageId: 'answer', identity };
let server;
let app;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  await Message.init();
  await ViventiumMainContinuityState.init();
  app = express();
  app.use(express.json());
  app.use('/api/messages', router);
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Message.deleteMany({});
  await Conversation.deleteMany({});
  await ViventiumMainContinuityState.deleteMany({});
  await Conversation.create({
    user: 'owner',
    conversationId,
    agent_id: 'agent',
    endpoint: 'agents',
  });
});
const read = () => Message.findOne({ user: 'owner', messageId: 'answer' }).lean();
async function seed() {
  await Message.create({
    ...assistant,
    user: 'owner',
    metadata: {
      sibling: 'old',
      viventium: { mainContext: stamp, receipt: 'old' },
    },
  });
}

test('only the exact trusted root system write creates Main provenance', async () => {
  await db.saveMessage(
    req,
    { ...assistant, metadata: { sibling: 'keep' } },
    {
      operationKind: 'system',
      mainContextBinding: binding,
    },
  );
  expect((await read()).metadata).toEqual({ sibling: 'keep', viventium: { mainContext: stamp } });
});

test.each([
  ['no binding', req, undefined, assistant],
  ['wrong root', req, { ...binding, responseMessageId: 'different' }, assistant],
  ['copied identity', req, { ...binding, identity: { ...identity } }, assistant],
  [
    'body-only identity',
    { user: req.user, body: { _viventiumAcceptedMainCompactionIdentityV1: identity } },
    binding,
    assistant,
  ],
  ['owner mismatch', { ...req, user: { id: 'different' } }, binding, assistant],
  ['user message', req, binding, { ...assistant, isCreatedByUser: true }],
  [
    'guest voice',
    { ...req, body: { voiceMode: true, viventiumActorTrust: 'unknown' } },
    binding,
    assistant,
  ],
])('%s cannot manufacture a root stamp', async (_name, requestValue, bindingValue, message) => {
  await db.saveMessage(requestValue, message, {
    operationKind: 'system',
    mainContextBinding: bindingValue,
  });
  const row = await Message.findOne({ messageId: 'answer', user: requestValue.user.id }).lean();
  expect(row.metadata?.viventium?.mainContext).toBeUndefined();
});

test('owner voice root retains its existing side-effect permission', async () => {
  await db.saveMessage(
    {
      ...req,
      body: {
        voiceMode: true,
        viventiumActorTrust: 'owner_participant',
        viventiumCanAuthorizeSideEffects: true,
      },
    },
    assistant,
    {
      operationKind: 'system',
      mainContextBinding: binding,
    },
  );
  expect((await read()).metadata?.viventium?.mainContext).toEqual(stamp);
});

test.each([
  { ...identity, agentId: '' },
  { ...identity, stableAuthoritySha256: 'invalid' },
])('invalid captured authority does not stamp: %p', async (invalid) => {
  const captured = Object.freeze(invalid);
  await db.saveMessage(
    { ...req, _viventiumAcceptedMainCompactionIdentityV1: captured },
    assistant,
    {
      operationKind: 'system',
      mainContextBinding: { responseMessageId: 'answer', identity: captured },
    },
  );
  expect((await read()).metadata?.viventium?.mainContext).toBeUndefined();
});

test('later root binding cannot retag an already saved answer with current authority', async () => {
  await seed();
  const newer = Object.freeze({
    ownerId: 'owner',
    agentId: 'different-agent',
    stableAuthoritySha256: 'b'.repeat(64),
  });
  await db.saveMessage(
    { ...req, _viventiumAcceptedMainCompactionIdentityV1: newer },
    { ...assistant, metadata: { sibling: 'updated' } },
    {
      operationKind: 'system',
      mainContextBinding: { responseMessageId: 'answer', identity: newer },
    },
  );
  expect((await read()).metadata).toEqual({
    sibling: 'updated',
    viventium: { mainContext: stamp },
  });
});

test.each(['$min', '$max'])(
  'unsupported parent operator %s cannot create authority',
  async (operator) => {
    await Message.create({ ...assistant, user: 'owner' });
    await expect(
      db.updateMessage(req, {
        messageId: 'answer',
        [operator]: {
          metadata: { viventium: { mainContext: stamp } },
        },
      }),
    ).rejects.toThrow('main_context_parent_update_unsupported');
    expect((await read()).metadata?.viventium?.mainContext).toBeUndefined();
  },
);

test('actual message route cannot forge Main provenance', async () => {
  await request(app)
    .post('/api/messages/' + conversationId)
    .send({
      ...assistant,
      metadata: { sibling: 'keep', viventium: { mainContext: stamp, receipt: 'keep' } },
    })
    .expect(201);
  expect((await read()).metadata).toEqual({ sibling: 'keep', viventium: { receipt: 'keep' } });
});

test.each([
  {},
  null,
  { sibling: 'new', viventium: { mainContext: { agentId: 'forged' }, receipt: 'new' } },
])('actual route parent replacement preserves canonical authority: %p', async (metadata) => {
  await seed();
  await request(app)
    .post('/api/messages/' + conversationId)
    .send({ ...assistant, metadata })
    .expect(201);
  expect((await read()).metadata?.viventium?.mainContext).toEqual(stamp);
  if (metadata?.sibling) expect((await read()).metadata.sibling).toBe('new');
});

test.each([
  { metadata: { sibling: 'updated' } },
  { 'metadata.viventium': { receipt: 'updated' } },
  { $set: { metadata: { sibling: 'updated' } } },
  { $unset: { metadata: 1 } },
  { $unset: { 'metadata.viventium': 1 } },
  { $unset: { metadata: 1 }, $set: { text: 'Changed together.' } },
  { $set: { text: 'Changed together.' }, $unset: { metadata: 1 } },
  { $rename: { metadata: 'feedback.tag' } },
  { $rename: { 'metadata.viventium': 'feedback.tag' } },
  { $rename: { 'feedback.tag': 'metadata' } },
  {
    $set: { 'metadata.viventium.mainContext.agentId': 'forged' },
    $unset: { 'metadata.viventium.mainContext': 1 },
  },
])('ordinary update preserves saved authority under %p', async (update) => {
  await seed();
  await Message.updateOne({ messageId: 'answer' }, { 'feedback.tag': { sibling: 'replacement' } });
  await db.updateMessage(req, { messageId: 'answer', ...update });
  expect((await read()).metadata?.viventium?.mainContext).toEqual(stamp);
  if (update.$rename?.metadata) {
    expect((await read()).feedback.tag).toEqual({ sibling: 'old', viventium: { receipt: 'old' } });
  }
});

test('a parent rename cannot promote untrusted sibling data into Main authority', async () => {
  await Message.create({
    ...assistant,
    user: 'owner',
    feedback: {
      rating: 'thumbsUp',
      tag: {
        sibling: 'kept',
        viventium: { mainContext: stamp, receipt: 'kept' },
      },
    },
  });
  await db.updateMessage(req, { messageId: 'answer', $rename: { 'feedback.tag': 'metadata' } });
  expect((await read()).metadata).toEqual({ sibling: 'kept', viventium: { receipt: 'kept' } });
});

test('record and bulk metadata writes preserve each owner and message stamp', async () => {
  await seed();
  await db.recordMessage({ ...assistant, user: 'owner', metadata: { sibling: 'recorded' } });
  expect((await read()).metadata).toEqual({
    sibling: 'recorded',
    viventium: { mainContext: stamp },
  });
  await db.bulkSaveMessages([
    { ...assistant, user: 'owner', metadata: { sibling: 'bulk' } },
    {
      ...assistant,
      messageId: 'other',
      user: 'owner',
      metadata: { viventium: { mainContext: stamp } },
    },
  ]);
  expect((await read()).metadata).toEqual({ sibling: 'bulk', viventium: { mainContext: stamp } });
  expect(
    (await Message.findOne({ messageId: 'other' }).lean()).metadata?.viventium?.mainContext,
  ).toBeUndefined();
});

test('later system bubbles sharing the request do not inherit the root stamp', async () => {
  await db.saveMessage(req, assistant, { operationKind: 'system', mainContextBinding: binding });
  await db.saveMessage(req, { ...assistant, messageId: 'follow-up' }, { operationKind: 'system' });
  expect((await read()).metadata?.viventium?.mainContext).toEqual(stamp);
  expect(
    (await Message.findOne({ messageId: 'follow-up' }).lean()).metadata?.viventium?.mainContext,
  ).toBeUndefined();
});

test('text-only writes retain the stamp without an extra Message read', async () => {
  await seed();
  const readSpy = jest.spyOn(Message, 'findOne');
  try {
    await db.updateMessage(req, { messageId: 'answer', text: 'Edited text.' });
    expect(readSpy).not.toHaveBeenCalled();
  } finally {
    readSpy.mockRestore();
  }
  expect((await read()).metadata.viventium.mainContext).toEqual(stamp);
});

test('real constructor and awaited BaseClient start persist the stamp before prompt building', async () => {
  const AgentClient = require('~/server/controllers/agents/client');
  const { persistAssistantSnapshot } = require('~/server/controllers/agents/request').__testables;
  const rootReq = { user: { id: 'owner' }, body: {} };
  const client = new AgentClient({
    req: rootReq,
    agent: Object.freeze({
      id: 'agent',
      instructions: 'Authored instruction',
      tools: [],
      model_parameters: {
        model: 'synthetic',
        configuration: {
          defaultHeaders: { 'X-GlassHive-Stable-Authority-SHA256': stamp.stableAuthoritySha256 },
        },
      },
    }),
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
  });
  client.setMessageOptions = jest.fn(async () => ({
    userMessageId: 'question',
    responseMessageId: 'answer',
    conversationId,
    parentMessageId: 'parent',
  }));
  client.buildMessages = jest.fn();
  await client.handleStartMethods('Question', {
    onStart: async (userMessage, responseMessageId) => {
      await persistAssistantSnapshot({
        req: rootReq,
        streamId: 'root',
        userId: 'owner',
        client,
        conversationId,
        userMessage,
        responseMessageId,
        sender: 'Assistant',
        aggregatedContent: [],
        fallbackText: 'In progress.',
        context: 'synthetic initial root',
        mainContextBinding: {
          responseMessageId,
          identity: rootReq._viventiumAcceptedMainCompactionIdentityV1,
        },
      });
      expect((await read()).metadata.viventium.mainContext).toEqual(stamp);
      expect(client.buildMessages).not.toHaveBeenCalled();
    },
  });
});

test.each([true, false])(
  'native final recovery requires original stamped authority (stamped=%s)',
  async (stamped) => {
    const api = require('@librechat/api');
    const methods = require('~/models');
    const store = new api.InMemoryJobStore();
    const manager = new api.GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new api.InMemoryEventTransport(),
    });
    manager.initialize();
    const spies = [
      'bindNativeResponse',
      'commitNativeResponse',
      'revokeNativeResponse',
      'finishNativeResponse',
      'getJob',
      'acknowledgeStreamDelivery',
      'settleNativeResponse',
    ].map((name) =>
      jest
        .spyOn(api.GenerationJobManager, name)
        .mockImplementation((...args) => manager[name](...args)),
    );
    const transaction = (operation) =>
      require('~/server/services/viventium/GlassHiveTerminalCallbackTransaction').runGlassHiveTerminalCallbackTransaction(
        operation,
        { retry: 'native' },
      );
    try {
      const claim = await store.claimLogicalTurn('native-root', 'owner', {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: conversationId,
        revision: 1,
        source_event_id: 'source',
      });
      const job = await store.createJob('native-root', 'owner', conversationId, {
        responseMessageId: 'answer',
        interactionContext: claim.interactionContext,
        userMessage: { messageId: 'question' },
        deliveryPolicy: { commit_authority: 'server' },
      });
      await Message.create({
        user: 'owner',
        messageId: 'question',
        conversationId,
        isCreatedByUser: true,
        text: 'Question',
      });
      await db.saveMessage(
        req,
        {
          ...assistant,
          unfinished: true,
          metadata: {
            sibling: 'kept',
            viventium: { interactionContext: claim.interactionContext },
          },
        },
        {
          operationKind: 'system',
          ...(stamped ? { mainContextBinding: binding } : {}),
        },
      );
      const admittedAt = Date.now();
      const nativeIdentity = {
        userId: 'owner',
        conversationId,
        responseMessageId: 'answer',
        streamId: 'native-root',
        jobCreatedAt: job.createdAt,
        logicalTurnId: claim.interactionContext.logical_turn_id,
        revision: 1,
        invocationId: 'invocation',
        bodySha256: 'b'.repeat(64),
        originSha256: 'c'.repeat(64),
        providerId: 'provider',
        agentId: 'agent',
        source: await methods.captureNativeResponseSource('owner', conversationId, 'question'),
        admittedAt,
        recoverUntil: admittedAt + api.NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
      };
      expect(await manager.bindNativeResponse(nativeIdentity)).toBe(true);
      await methods.admitNativeResponse(nativeIdentity, transaction);
      const candidate = {
        text: 'Canonical native answer.',
        authoritySha256: 'd'.repeat(64),
        requestId: 'request',
        runId: 'run',
        responseJson: '{}',
      };
      const digest = await methods.prepareNativeResponse(nativeIdentity, candidate, transaction);
      await methods.materializeNativeResponse(
        nativeIdentity,
        digest,
        (bound, sha) => manager.commitNativeResponse(bound, sha),
        transaction,
      );
      const recovered =
        await require('~/server/services/viventium/nativeResponseService').recoverNativeResponse(
          JSON.parse(JSON.stringify(nativeIdentity)),
        );
      expect(recovered).toBe(stamped);
      const row = await Message.findOne({ messageId: 'answer' })
        .select('+nativeResponse +acceptedMainContext')
        .lean();
      expect(row.text).toBe(candidate.text);
      expect(row.metadata.sibling).toBe('kept');
      expect(Boolean(row.nativeResponse.finalReplayStoredAt)).toBe(stamped);
      expect(Boolean(row.acceptedMainContext)).toBe(stamped);
      expect(row.metadata.viventium.mainContext).toEqual(stamped ? stamp : undefined);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      await manager.destroy();
    }
  },
);
