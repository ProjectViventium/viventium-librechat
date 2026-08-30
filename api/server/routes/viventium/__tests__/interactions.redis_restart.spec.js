const crypto = require('crypto');
const express = require('express');
const Redis = require('ioredis');
const {
  GenerationJobManager,
  RedisEventTransport,
  RedisJobStore,
} = require('@librechat/api');

const mockMessageUpdateOne = jest.fn();
const mockRecordTelegramTransportReceipt = jest.fn();
const mockCommitAcceptedMainTurnFromPresentation = jest.fn();
let mockDeliveryRows = [];
const redisTestClients = [];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function matches(row, filter = {}) {
  return Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(row[key]);
      if ('$gt' in expected) return new Date(row[key]).getTime() > new Date(expected.$gt).getTime();
      if ('$ne' in expected) return row[key] !== expected.$ne;
    }
    return row[key] === expected;
  });
}

function query(read) {
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    session: jest.fn(() => chain),
    lean: jest.fn(async () => clone(read())),
  };
  return chain;
}

const mockDeliveryModel = {
  find: jest.fn((filter = {}) =>
    query(() => mockDeliveryRows.filter((row) => matches(row, filter))),
  ),
  findOne: jest.fn((filter = {}) =>
    query(() => mockDeliveryRows.find((row) => matches(row, filter)) || null),
  ),
  findOneAndUpdate: jest.fn(),
};

jest.mock('~/db/models', () => ({
  Message: {
    updateOne: (...args) => mockMessageUpdateOne(...args),
  },
  Conversation: {
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
  ViventiumCortexInsightDelivery: mockDeliveryModel,
}));

jest.mock('~/server/services/viventium/TelegramReplyProvenanceService', () => ({
  recordTelegramTransportReceipt: (...args) => mockRecordTelegramTransportReceipt(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) =>
    mockCommitAcceptedMainTurnFromPresentation(...args),
}));

function createApp(router) {
  const app = express();
  app.use('/api/viventium/interactions', router);
  return app;
}

function request(body) {
  return {
    method: 'POST',
    url: '/api/viventium/interactions/delivery-ack',
    originalUrl: '/api/viventium/interactions/delivery-ack',
    path: '/delivery-ack',
    headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
    body,
    get(name) {
      return this.headers[name.toLowerCase()] || '';
    },
  };
}

function response() {
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader: jest.fn(),
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.writableEnded = true;
      res.resolve();
      return res;
    },
  };
  res.done = new Promise((resolve) => {
    res.resolve = resolve;
  });
  return res;
}

async function dispatch(app, body) {
  const res = response();
  app.handle(request(body), res, (error) => {
    if (error) throw error;
    if (!res.writableEnded) res.resolve();
  });
  await res.done;
  return res;
}

function createRedisServices(redisUri) {
  const publisher = new Redis(redisUri, {
    enableReadyCheck: true,
    maxRetriesPerRequest: 1,
  });
  const subscriber = publisher.duplicate();
  redisTestClients.push(publisher, subscriber);
  return {
    jobStore: new RedisJobStore(publisher, { runningTtl: 300 }),
    eventTransport: new RedisEventTransport(publisher, subscriber, {
      closeSubscriberOnDestroy: true,
    }),
    isRedis: true,
    cleanupOnComplete: false,
  };
}

const redisTest = process.env.REDIS_URI ? test : test.skip;

describe('Telegram Cortex delivery acknowledgement after Redis restart', () => {
  afterEach(async () => {
    delete process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET;
    await GenerationJobManager.destroy();
    for (const client of redisTestClients.splice(0)) {
      client.disconnect();
    }
  });

  redisTest('accepts the second and third exact acknowledgement as one durable no-op', async () => {
    const redisUri = process.env.REDIS_URI;
    const suffix = Date.now().toString(16);
    const streamId = `cortex-route-restart-${suffix}`;
    const graphResultHash = 'a'.repeat(64);
    const presentationRef = 'telegram:chat-a:message-a';
    const presentationClaimToken = 'cidl_claim-1';
    const presentationLeaseToken = 'cidl_presentation-lease-1';
    const receiptHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          messageId: 'follow-up-a',
          presentationRef,
          revision: 1,
          surface: 'telegram',
          claimToken: presentationClaimToken,
          claimGeneration: 1,
          graphResultHash,
          presentationLeaseToken,
        }),
      )
      .digest('hex');
    mockDeliveryRows = [
      {
        deliveryId: 'cidl_delivery',
        userId: 'owner-a',
        parentMessageId: 'parent-a',
        status: 'sent',
        persistenceStatus: 'persisted',
        persistedMessageId: 'follow-up-a',
        messageRevision: 1,
        requiredSurfaces: ['telegram'],
        presentedSurfaces: ['telegram'],
        presentationReceiptHashes: [receiptHash],
        claimToken: '',
        claimGeneration: 1,
        graphResultHash,
        events: [
          {
            transition: 'presented',
            claimToken: presentationClaimToken,
            claimGeneration: 1,
            surface: 'telegram',
            receiptHash,
          },
        ],
      },
    ];
    mockMessageUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 0 });
    mockRecordTelegramTransportReceipt.mockReset().mockResolvedValue({ status: 'sent' });
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET = 'adapter-secret';

    await GenerationJobManager.destroy();
    GenerationJobManager.configure(createRedisServices(redisUri));
    await GenerationJobManager.initialize();
    const createdJob = await GenerationJobManager.createJob(
      streamId,
      'owner-a',
      'conversation-a',
      {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conversation-a',
        logical_turn_id: `turn-${suffix}`,
        revision: 1,
        source_event_id: `source-${suffix}`,
        source_order_scope: suffix.padStart(64, 'b').slice(-64),
        source_sequence: 1,
      },
      deliveryPolicy: { commit_authority: 'external_adapter' },
      },
    );
    await GenerationJobManager.updateMetadata(streamId, { responseMessageId: 'parent-a' });
    await GenerationJobManager.bindCortexPresentation(streamId, {
      ownerId: 'owner-a',
      messageId: 'follow-up-a',
      parentMessageId: 'parent-a',
      revision: 1,
      generation: 1,
      deliveryIds: ['cidl_delivery'],
      deliveryReceipts: [{ deliveryId: 'cidl_delivery', graphResultHash }],
      claimToken: presentationClaimToken,
      presentationLeaseToken,
    });
    const acknowledgement = {
      logical_turn_id: createdJob.metadata.interactionContext.logical_turn_id,
      revision: createdJob.metadata.interactionContext.revision,
      state: 'committed',
      presentation_ref: presentationRef,
    };
    await expect(
      GenerationJobManager.acknowledgeDelivery(acknowledgement, 'telegram'),
    ).resolves.toMatchObject({ status: 'recorded', idempotent: false });

    await GenerationJobManager.destroy();
    GenerationJobManager.configure(createRedisServices(redisUri));
    await GenerationJobManager.initialize();

    const app = createApp(require('../interactions'));
    const second = await dispatch(app, acknowledgement);
    const third = await dispatch(app, acknowledgement);

    expect(second).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    expect(third).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    expect(mockDeliveryModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockDeliveryRows[0]).toEqual(expect.objectContaining({ status: 'sent' }));
  });
});
