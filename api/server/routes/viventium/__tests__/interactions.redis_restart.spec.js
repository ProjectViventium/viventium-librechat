const crypto = require('crypto');
const express = require('express');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const {
  GenerationJobManager,
  InMemoryEventTransport,
  InMemoryJobStore,
  RedisEventTransport,
  RedisJobStore,
} = require('@librechat/api');

const mockMessageUpdateOne = jest.fn();
const mockMessageFindOne = jest.fn();
const mockRecordTelegramTransportReceipt = jest.fn();
const mockCommitAcceptedMainTurnFromPresentation = jest.fn();
let mockDeliveryRows = [];
let mockInteractionDurableEffectModel;
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
    findOne: (...args) => mockMessageFindOne(...args),
    updateOne: (...args) => mockMessageUpdateOne(...args),
  },
  Conversation: {
    updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
  },
  ViventiumCortexInsightDelivery: mockDeliveryModel,
  InteractionDurableEffect: {
    findOne: (...args) => mockInteractionDurableEffectModel.findOne(...args),
    findOneAndUpdate: (...args) => mockInteractionDurableEffectModel.findOneAndUpdate(...args),
  },
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

async function dispatch(app, body, adapterSecret = 'adapter-secret') {
  const res = response();
  const req = request(body);
  req.headers['x-viventium-adapter-secret'] = adapterSecret;
  app.handle(req, res, (error) => {
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

function committedVoiceEffect(overrides = {}) {
  const recordedAt = new Date('2026-09-01T12:00:00.000Z');
  return {
    schemaVersion: 1,
    effectKey: `effect_${'1'.repeat(64)}`,
    ownerId: 'voice-owner',
    conversationId: 'voice-conversation',
    logicalTurnId: 'voice-logical-turn',
    logicalTurnRevision: 2,
    sourceEventId: 'voice:call-1:item-1',
    sourceRevision: 2,
    responseMessageId: 'voice-response',
    presentationRevision: 2,
    surface: 'voice',
    effectOrdinal: 0,
    effectOccurrenceRef: `ghbi_${'2'.repeat(64)}`,
    effectKind: 'durable_work_accepted',
    adapterId: 'glasshive.worker_delegate.v1',
    routeId: 'worker_delegate_once',
    operation: 'delegate',
    canonicalArgsSha256: `sha256:${'3'.repeat(64)}`,
    voiceAuthorityRef: `voice_authority_${'4'.repeat(64)}`,
    voice: {
      callSessionId: 'call-1',
      voiceTurnId: 'voice-turn-1',
      mode: 'call',
      callModeRevision: 1,
      speakerSessionRevision: 1,
      segmentRevisionDigest: `sha256:${'5'.repeat(64)}`,
      ownerParticipantDigest: `sha256:${'6'.repeat(64)}`,
    },
    providerIdempotencyKey: 'voice-provider-key',
    providerIdempotencyMode: 'deterministic_reconciliation',
    status: 'committed',
    claimRevision: 1,
    claimTokenHash: `sha256:${'7'.repeat(64)}`,
    attemptCount: 1,
    providerReceiptRef: 'voice-work-ref',
    providerResultSha256: `sha256:${'8'.repeat(64)}`,
    replayResult: { status: 'ok', workRef: 'voice-work-ref' },
    committedAt: recordedAt,
    lastTransitionAt: recordedAt,
    transitionRevision: 2,
    createdAt: recordedAt,
    ...overrides,
  };
}

async function configureEmptyRestartedProjection() {
  await GenerationJobManager.destroy();
  GenerationJobManager.configure({
    jobStore: new InMemoryJobStore(),
    eventTransport: new InMemoryEventTransport(),
    isRedis: true,
    cleanupOnComplete: false,
  });
  await GenerationJobManager.initialize();
}

describe('Durable delivery acknowledgement after Redis restart', () => {
  let mongoServer;
  const database = new mongoose.Mongoose();

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await database.connect(mongoServer.getUri());
    mockInteractionDurableEffectModel = createModels(database).InteractionDurableEffect;
    await mockInteractionDurableEffectModel.syncIndexes();
  });

  beforeEach(async () => {
    await mockInteractionDurableEffectModel.deleteMany({});
    mockMessageFindOne.mockReset().mockReturnValue(query(() => null));
  });

  afterEach(async () => {
    delete process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET;
    delete process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET;
    await GenerationJobManager.destroy();
    for (const client of redisTestClients.splice(0)) {
      client.disconnect();
    }
  });

  afterAll(async () => {
    await database.disconnect();
    await mongoServer.stop();
  });

  test('records and replays the exact Voice effect acknowledgement after the Redis projection is lost', async () => {
    await mockInteractionDurableEffectModel.create(committedVoiceEffect());
    await configureEmptyRestartedProjection();
    process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    let terminalMessageWrites = 0;
    mockMessageUpdateOne.mockReset().mockImplementation(async (_query, update) => {
      if (update?.$set?.unfinished === false && terminalMessageWrites === 0) {
        terminalMessageWrites += 1;
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    });
    mockMessageFindOne.mockImplementation(() =>
      query(() => (terminalMessageWrites > 0 ? { _id: 'voice-response-row' } : null)),
    );
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    const acknowledgement = {
      logical_turn_id: 'voice-logical-turn',
      revision: 2,
      state: 'committed',
      effect_ref: 'voice-work-ref',
      presentation_ref: 'voice-playout-1',
    };
    await expect(
      GenerationJobManager.acknowledgeDurableEffectDelivery(acknowledgement, 'voice'),
    ).resolves.toMatchObject({ status: 'not_found' });
    const app = createApp(require('../interactions'));

    const first = await dispatch(app, acknowledgement);
    const second = await dispatch(app, acknowledgement);

    expect(first).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: false },
    });
    expect(second).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    await expect(
      mockInteractionDurableEffectModel.findOne({ providerReceiptRef: 'voice-work-ref' }).lean(),
    ).resolves.toMatchObject({
      transitionRevision: 3,
      deliveryAcknowledgement: {
        state: 'committed_effect',
        effectRef: 'voice-work-ref',
        logicalTurnId: 'voice-logical-turn',
        revision: 2,
        surface: 'voice',
        presentationRef: 'voice-playout-1',
      },
    });
    expect(terminalMessageWrites).toBe(1);
  });

  test('records and replays the exact Telegram effect acknowledgement after the Redis projection is lost', async () => {
    await mockInteractionDurableEffectModel.create(
      committedVoiceEffect({
        ownerId: 'telegram-owner',
        conversationId: 'telegram-conversation',
        logicalTurnId: 'telegram-logical-turn',
        sourceEventId: 'telegram:chat-1:message-1',
        responseMessageId: 'telegram-response',
        surface: 'telegram',
        providerReceiptRef: 'telegram-work-ref',
        voiceAuthorityRef: undefined,
        voice: undefined,
      }),
    );
    await configureEmptyRestartedProjection();
    process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    let terminalMessageWrites = 0;
    mockMessageUpdateOne.mockReset().mockImplementation(async (_query, update) => {
      if (update?.$set?.unfinished === false && terminalMessageWrites === 0) {
        terminalMessageWrites += 1;
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    });
    mockMessageFindOne.mockImplementation(() =>
      query(() => (terminalMessageWrites > 0 ? { _id: 'telegram-response-row' } : null)),
    );
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    const acknowledgement = {
      logical_turn_id: 'telegram-logical-turn',
      revision: 2,
      state: 'committed',
      effect_ref: 'telegram-work-ref',
      presentation_ref: 'telegram:chat-1:message-9',
    };
    const app = createApp(require('../interactions'));

    const first = await dispatch(app, acknowledgement);
    const second = await dispatch(app, acknowledgement);

    expect(first).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: false },
    });
    expect(second).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    await expect(
      mockInteractionDurableEffectModel.findOne({ providerReceiptRef: 'telegram-work-ref' }).lean(),
    ).resolves.toMatchObject({
      transitionRevision: 3,
      deliveryAcknowledgement: {
        state: 'committed_effect',
        effectRef: 'telegram-work-ref',
        logicalTurnId: 'telegram-logical-turn',
        revision: 2,
        surface: 'telegram',
        presentationRef: 'telegram:chat-1:message-9',
      },
    });
    expect(terminalMessageWrites).toBe(1);
  });

  test('keeps the restarted Redis projection bound to the exact Voice effect reference', async () => {
    await configureEmptyRestartedProjection();
    const job = await GenerationJobManager.createJob(
      'voice-projection-stream',
      'voice-owner',
      'voice-conversation',
      {
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'voice',
          conversation_id: 'voice-conversation',
          logical_turn_id: 'voice-projection-turn',
          revision: 1,
          source_event_id: 'voice:projection:event-1',
        },
        adapterCapabilities: {
          segment_stability: 'provisional',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: { commit_authority: 'external_adapter' },
      },
    );
    await GenerationJobManager.updateMetadata('voice-projection-stream', {
      responseMessageId: 'voice-projection-response',
    });
    await expect(
      GenerationJobManager.markDurableEffectReceipt({
        streamId: 'voice-projection-stream',
        userId: 'voice-owner',
        sourceEventId: 'voice:projection:event-1',
        responseMessageId: 'voice-projection-response',
        effectKind: 'durable_work_accepted',
        effectRef: 'voice-work-ref',
      }),
    ).resolves.toBe(true);
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext.logical_turn_id,
      revision: job.metadata.interactionContext.revision,
      state: 'committed',
      presentation_ref: 'voice-playout-1',
    };

    await expect(
      GenerationJobManager.acknowledgeDurableEffectDelivery(
        { ...acknowledgement, effect_ref: 'wrong-work-ref' },
        'voice',
      ),
    ).resolves.toMatchObject({ status: 'conflict' });
    const projectionAfterConflict = await GenerationJobManager.getJob('voice-projection-stream');
    expect(projectionAfterConflict.metadata.deliveryAcknowledgement).toBeUndefined();
    await expect(
      GenerationJobManager.acknowledgeDurableEffectDelivery(
        { ...acknowledgement, effect_ref: 'voice-work-ref' },
        'voice',
      ),
    ).resolves.toMatchObject({
      status: 'recorded',
      acknowledgement: { state: 'committed_effect', effect_ref: 'voice-work-ref' },
    });
  });

  test.each([
    ['effect reference', { effect_ref: 'wrong-work-ref' }, 'adapter-secret'],
    ['logical turn', { logical_turn_id: 'wrong-turn' }, 'adapter-secret'],
    ['revision', { revision: 3 }, 'adapter-secret'],
    ['adapter surface', {}, 'telegram-secret'],
  ])(
    'rejects a wrong exact Voice %s without mutation after Redis loss',
    async (_name, patch, secret) => {
      await mockInteractionDurableEffectModel.create(committedVoiceEffect());
      await configureEmptyRestartedProjection();
      process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
      process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET = 'telegram-secret';
      mockMessageUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
      const app = createApp(require('../interactions'));

      const result = await dispatch(
        app,
        {
          logical_turn_id: 'voice-logical-turn',
          revision: 2,
          state: 'committed',
          effect_ref: 'voice-work-ref',
          presentation_ref: 'voice-playout-1',
          ...patch,
        },
        secret,
      );

      expect(result).toMatchObject({
        statusCode: 409,
        body: { acknowledged: false, error: 'conflict' },
      });
      await expect(
        mockInteractionDurableEffectModel.findOne({ providerReceiptRef: 'voice-work-ref' }).lean(),
      ).resolves.toMatchObject({ transitionRevision: 2 });
      const row = await mockInteractionDurableEffectModel
        .findOne({ providerReceiptRef: 'voice-work-ref' })
        .lean();
      expect(row.deliveryAcknowledgement).toBeUndefined();
      expect(mockMessageUpdateOne).not.toHaveBeenCalled();
    },
  );

  test('keeps a Mongo Voice acknowledgement retryable when the terminal Message write fails once', async () => {
    await mockInteractionDurableEffectModel.create(committedVoiceEffect());
    await configureEmptyRestartedProjection();
    process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    let terminalMessageWrites = 0;
    mockMessageUpdateOne
      .mockReset()
      .mockRejectedValueOnce(new Error('synthetic Message write outage'))
      .mockImplementationOnce(async () => {
        terminalMessageWrites += 1;
        return { matchedCount: 1, modifiedCount: 1 };
      });
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    const acknowledgement = {
      logical_turn_id: 'voice-logical-turn',
      revision: 2,
      state: 'committed',
      effect_ref: 'voice-work-ref',
      presentation_ref: 'voice-playout-1',
    };
    const app = createApp(require('../interactions'));

    const first = await dispatch(app, acknowledgement);
    const rowAfterFailure = await mockInteractionDurableEffectModel
      .findOne({ providerReceiptRef: 'voice-work-ref' })
      .lean();
    const second = await dispatch(app, acknowledgement);
    const rowAfterRetry = await mockInteractionDurableEffectModel
      .findOne({ providerReceiptRef: 'voice-work-ref' })
      .lean();

    expect(first).toMatchObject({
      statusCode: 503,
      body: { acknowledged: false, error: 'persistence_unavailable' },
    });
    expect(second).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    expect(rowAfterFailure.deliveryAcknowledgement).toMatchObject({
      effectRef: 'voice-work-ref',
      surface: 'voice',
    });
    expect(rowAfterRetry.deliveryAcknowledgement).toEqual(rowAfterFailure.deliveryAcknowledgement);
    expect(rowAfterRetry.transitionRevision).toBe(3);
    expect(terminalMessageWrites).toBe(1);
  });

  test('keeps a Mongo Voice acknowledgement retryable when the exact provisional Message is missing once', async () => {
    await mockInteractionDurableEffectModel.create(committedVoiceEffect());
    await configureEmptyRestartedProjection();
    process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    let terminalMessageWrites = 0;
    mockMessageUpdateOne.mockReset().mockImplementation(async (_query, update) => {
      if (update?.$set?.unfinished === false && terminalMessageWrites === 0) {
        terminalMessageWrites += 1;
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return { matchedCount: 1, modifiedCount: 1 };
    });
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    const acknowledgement = {
      logical_turn_id: 'voice-logical-turn',
      revision: 2,
      state: 'committed',
      effect_ref: 'voice-work-ref',
      presentation_ref: 'voice-playout-1',
    };
    const app = createApp(require('../interactions'));

    const first = await dispatch(app, acknowledgement);
    const second = await dispatch(app, acknowledgement);

    expect(first).toMatchObject({
      statusCode: 503,
      body: { acknowledged: false, error: 'persistence_unavailable' },
    });
    expect(second).toMatchObject({
      statusCode: 200,
      body: { acknowledged: true, idempotent: true },
    });
    expect(terminalMessageWrites).toBe(1);
    expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(1);
  });

  if (process.env.REDIS_URI) {
    test('accepts the second and third exact acknowledgement as one durable no-op', async () => {
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
  } else {
    test.skip('accepts the second and third exact acknowledgement as one durable no-op (requires REDIS_URI)', () => {
      expect.hasAssertions();
    });
  }
});
