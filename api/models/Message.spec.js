const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { logger, messageSchema } = require('@librechat/data-schemas');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
let mockNativeResponseManager;

jest.mock('~/models', () => ({
  ...jest.requireActual('~/models'),
  ...jest.requireActual('@librechat/data-schemas').createNativeResponseMethods(require('mongoose')),
  saveConvo: jest.fn(async (_req, conversation) => conversation),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => { req.user = { id: 'user123' }; next(); },
  validateMessageReq: (_req, _res, next) => next(),
}));
jest.mock('~/server/services/viventium/nativeResponseService', () => ({
  mutateNativeResponseSources: (filter, operation, kind) => {
    const transaction = jest
      .requireActual('@librechat/api')
      .createGlassHiveTerminalCallbackTransactionService(require('mongoose'));
    return require('~/models').mutateNativeResponseSources(
      filter,
      operation,
      (identity) => mockNativeResponseManager
        ? mockNativeResponseManager.revokeNativeResponse(identity)
        : Promise.resolve({ status: 'revoked' }),
      transaction.runGlassHiveTerminalCallbackTransaction,
      async (identity) => mockNativeResponseManager?.retireNativeResponse(identity),
      kind,
    );
  },
}));

const mockScheduleConversationRecallSync = jest.fn();

jest.mock('~/server/services/viventium/conversationRecallService', () => {
  const actual = jest.requireActual('~/server/services/viventium/conversationRecallService');
  return {
    ...actual,
    scheduleConversationRecallSync: (...args) => mockScheduleConversationRecallSync(...args),
  };
});

const {
  saveMessage,
  getMessages,
  getMessageAncestorBranch,
  getLatestRecallEligibleMessageCreatedAt,
  updateMessage,
  deleteMessages,
  bulkSaveMessages,
  updateMessageText,
  deleteMessagesSince,
  recordMessage,
  __testables: { buildMessageAncestorBranchPipeline },
} = require('./Message');

test('ordinary message edits cannot forge or erase internal memory admission state', () => {
  const { sanitizeMessageForPersistence } = require('./Message').__testables;
  expect(
    sanitizeMessageForPersistence({
      text: 'safe',
      savedMemoryWrite: { status: 'running' },
      'savedMemoryWrite.owner': 'forged',
      $set: { 'savedMemoryWrite.status': 'completed', text: 'safe' },
      $unset: { savedMemoryWrite: 1 },
      $rename: { content: 'savedMemoryWrite' },
    }),
  ).toEqual({ text: 'safe', $set: { text: 'safe' }, $unset: {}, $rename: {} });
});

test('ordinary message edits cannot forge or erase native response admission', () => {
  const { sanitizeMessageForPersistence } = require('./Message').__testables;
  expect(
    sanitizeMessageForPersistence({
      text: 'safe',
      nativeResponse: { status: 'completed' },
      'nativeResponse.invocationId': 'forged',
      $set: { 'nativeResponse.status': 'completed', text: 'safe' },
      $unset: { nativeResponse: 1 },
      $rename: { content: 'nativeResponse' },
    }),
  ).toEqual({ text: 'safe', $set: { text: 'safe' }, $unset: {}, $rename: {} });
});

test('ordinary message edits cannot forge or erase accepted Main projection identity', () => {
  const { sanitizeMessageForPersistence } = require('./Message').__testables;
  expect(
    sanitizeMessageForPersistence({
      text: 'safe',
      acceptedMainContext: { revision: 1 },
      'acceptedMainContext.logicalTurnId': 'forged',
      $set: { 'acceptedMainContext.revision': 2, text: 'safe' },
      $unset: { acceptedMainContext: 1 },
      $rename: { content: 'acceptedMainContext' },
    }),
  ).toEqual({ text: 'safe', $set: { text: 'safe' }, $unset: {}, $rename: {} });
});

jest.mock('~/server/services/Config/app');

/**
 * @type {import('mongoose').Model<import('@librechat/data-schemas').IMessage>}
 */
let Message;

const PRIVATE_FEELING_FIELD = 'cortex_delivery_feeling_snapshot';

function privateFeelingContent(canary) {
  return [
    {
      type: 'text',
      text: 'Visible public text.',
      metadata: {
        publicLabel: 'preserved',
        nested: {
          keep: 'public',
          [PRIVATE_FEELING_FIELD]: {
            capsule: canary,
            snapshotHash: 'a'.repeat(64),
          },
        },
      },
    },
  ];
}

function expectPrivateFeelingAbsent(value, canary) {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(PRIVATE_FEELING_FIELD);
  expect(serialized).not.toContain(canary);
}

describe('Message Operations', () => {
  let mongoServer;
  let mockReq;
  let mockMessageData;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    const mongoUri = mongoServer.getUri();
    Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
    await mongoose.connect(mongoUri);
    await Message.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    // Clear database
    await Message.deleteMany({});
    mockScheduleConversationRecallSync.mockClear();

    mockReq = {
      user: { id: 'user123' },
      config: {
        interfaceConfig: {
          temporaryChatRetention: 24, // Default 24 hours
        },
      },
    };

    mockMessageData = {
      messageId: 'msg123',
      conversationId: uuidv4(),
      text: 'Hello, world!',
      user: 'user123',
    };
  });

  /* === VIVENTIUM START === Native publication survives non-content Message bookkeeping. === */
  describe.each(['pending', 'prepared', 'completed'])(
    'native response bookkeeping (%s)',
    (status) => {
      let store;
      let transport;
      let methods;
      let identity;
      let candidateDigest;
      let finalEvent;

      beforeEach(async () => {
        const { InMemoryJobStore, InMemoryEventTransport, GenerationJobManagerClass } =
          jest.requireActual('@librechat/api');
        store = new InMemoryJobStore();
        transport = new InMemoryEventTransport();
        mockNativeResponseManager = new GenerationJobManagerClass({
          jobStore: store,
          eventTransport: transport,
        });
        mockNativeResponseManager.initialize();
        methods = require('~/models');
        const user = mockReq.user.id;
        const conversationId = mockMessageData.conversationId;
        await Message.create([
          { ...mockMessageData, messageId: 'native-source', isCreatedByUser: true },
          {
            ...mockMessageData,
            messageId: 'native-answer',
            parentMessageId: 'native-source',
            isCreatedByUser: false,
            unfinished: true,
            text: 'In progress.',
          },
        ]);
        const claim = await store.claimLogicalTurn('native-stream', user, {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: conversationId,
          revision: 1,
          source_event_id: 'native-source',
        });
        const job = await store.createJob('native-stream', user, conversationId, {
          responseMessageId: 'native-answer',
          interactionContext: claim.interactionContext,
          userMessage: { messageId: 'native-source' },
        });
        identity = {
          userId: user,
          conversationId,
          responseMessageId: 'native-answer',
          streamId: 'native-stream',
          jobCreatedAt: job.createdAt,
          logicalTurnId: claim.interactionContext.logical_turn_id,
          revision: claim.interactionContext.revision,
          invocationId: 'native-invocation',
          bodySha256: 'b'.repeat(64),
          providerId: 'native-provider',
          agentId: 'native-agent',
          originSha256: 'c'.repeat(64),
          source: await methods.captureNativeResponseSource(user, conversationId, 'native-source'),
          admittedAt: Date.now(),
          recoverUntil: Date.now() + 86_400_000,
        };
        const transaction = (operation) => mongoose.connection.transaction(operation);
        mongoose.set('transactionAsyncLocalStorage', true);
        expect(await mockNativeResponseManager.bindNativeResponse(identity)).toBe(true);
        await methods.admitNativeResponse(identity, transaction);
        candidateDigest = undefined;
        finalEvent = undefined;
        if (status !== 'pending') await prepareNative();
        if (status === 'completed') await completeNative();
      });

      afterEach(async () => {
        await mockNativeResponseManager?.destroy();
        mockNativeResponseManager = undefined;
      });

      async function prepareNative() {
        candidateDigest = await methods.prepareNativeResponse(
          identity,
          {
            text: 'Canonical native answer.',
            authoritySha256: 'a'.repeat(64),
            requestId: 'native-request',
            runId: 'native-run',
            responseJson: '{"saved":true}',
          },
          (operation) => mongoose.connection.transaction(operation),
        );
      }

      async function completeNative() {
        if (!candidateDigest) await prepareNative();
        const saved = await methods.materializeNativeResponse(
          identity,
          candidateDigest,
          (bound, digest) => mockNativeResponseManager.commitNativeResponse(bound, digest),
          (operation) => mongoose.connection.transaction(operation),
        );
        finalEvent = { final: true, responseMessage: saved };
        expect(await mockNativeResponseManager.finishNativeResponse(identity, finalEvent)).toBe(
          true,
        );
      }

      test.each([
        ['assistant token count', 'native-answer', { tokenCount: 42 }],
        ['current user token count', 'native-source', { tokenCount: 42 }],
        [
          'Phase B content merge',
          'native-answer',
          {
            content: [
              { type: 'text', text: 'Canonical native answer.' },
              {
                type: 'cortex_insight',
                insight: 'A background contribution.',
                cortex_id: 'background',
                status: 'complete',
              },
            ],
          },
        ],
        [
          'memory admission receipt',
          'native-answer',
          {
            $addToSet: {
              attachments: {
                type: 'memory',
                messageId: 'native-answer',
                memory: {
                  type: 'error',
                  key: 'system',
                  value: JSON.stringify({ errorType: 'writer_unavailable' }),
                },
              },
            },
          },
        ],
      ])('preserves admission and exact FINAL after %s', async (name, messageId, update) => {
        if (name === 'current user token count') {
          const BaseClient = require('~/app/clients/BaseClient');
          const client = Object.create(BaseClient.prototype);
          client.options = { req: mockReq, resendFiles: true };
          client.inputTokensKey = 'input_tokens';
          client.calculateCurrentTokenCount = () => 42;
          await client.updateUserMessageTokenCount({
            usage: { input_tokens: 100 },
            tokenCountMap: {},
            userMessage: { messageId, tokenCount: 1 },
            userMessagePromise: Promise.resolve(),
            opts: {},
          });
        } else if (name === 'Phase B content merge') {
          const {
            persistCortexPartsToCanonicalMessage,
          } = require('~/server/services/viventium/BackgroundCortexFollowUpService');
          await persistCortexPartsToCanonicalMessage({
            req: mockReq,
            responseMessageId: messageId,
            cortexParts: [update.content[1]],
            maxAttempts: 1,
          });
        } else {
          await updateMessage(mockReq, { messageId, ...update }, { operationKind: 'system' });
        }
        const unchanged = await methods.getNativeResponse(
          identity.userId,
          identity.responseMessageId,
        );
        expect(unchanged.nativeResponse).toMatchObject({
          status,
          invocationId: identity.invocationId,
        });
        expect(await store.getJob(identity.streamId)).toMatchObject({ nativeResponse: identity });
        if (status !== 'completed') await completeNative();
        const retained = await methods.getNativeResponse(
          identity.userId,
          identity.responseMessageId,
        );
        expect(retained).toMatchObject({
          text: 'Canonical native answer.',
          unfinished: false,
          nativeResponse: {
            status: 'completed',
            invocationId: identity.invocationId,
            candidateSha256: candidateDigest,
          },
        });
        const changed = await Message.findOne({ user: identity.userId, messageId }).lean();
        if (update.tokenCount) expect(changed.tokenCount).toBe(42);
        if (update.content)
          expect(changed.content).toEqual(expect.arrayContaining([update.content[1]]));
        if (update.$addToSet)
          expect(changed.attachments).toContainEqual(update.$addToSet.attachments);
        expect(await store.getNativeResponseCommit(identity)).toEqual({
          status: 'committed',
          candidateSha256: candidateDigest,
        });
        expect(await store.getJob(identity.streamId)).toMatchObject({
          nativeResponse: identity,
          finalEvent: JSON.stringify(finalEvent),
        });
        const delivered = jest.fn();
        await mockNativeResponseManager.subscribe(identity.streamId, jest.fn(), delivered);
        expect(delivered).toHaveBeenCalledTimes(1);
        expect(delivered).toHaveBeenCalledWith(finalEvent);
        expect(await methods.markNativeResponseReplayStored(identity)).toBe(true);
        expect(await mockNativeResponseManager.settleNativeResponse(identity)).toBe(true);
      });

      test.each([true, false])(
        'system metadata preserves the completed delivery decision, present: %s',
        async (present) => {
          if (status !== 'completed') await completeNative();
          const canonical = {
            version: 1,
            audio: 'skip',
            required: true,
            valid: true,
            source: 'model',
          };
          await Message.updateOne(
            { user: identity.userId, messageId: identity.responseMessageId },
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
          await updateMessage(
            mockReq,
            {
              messageId: identity.responseMessageId,
              text: 'An obsolete snapshot.',
              metadata: {
                added: true,
                viventium: {
                  sibling: 'after',
                  deliveryDisposition: { ...canonical, audio: 'eligible' },
                },
              },
            },
            { operationKind: 'system' },
          );
          const saved = await methods.getNativeResponse(
            identity.userId,
            identity.responseMessageId,
          );
          expect(saved).toMatchObject({
            text: 'Canonical native answer.',
            unfinished: false,
            nativeResponse: { status: 'completed', invocationId: identity.invocationId },
          });
          expect(saved.metadata).toEqual({
            keep: true,
            added: true,
            viventium: {
              sibling: 'after',
              ...(present ? { deliveryDisposition: canonical } : {}),
            },
          });
          expect(await store.getJob(identity.streamId)).toMatchObject({
            nativeResponse: identity,
            finalEvent: JSON.stringify(finalEvent),
          });
        },
      );

    test('a system snapshot returns the native owner result without a second save', async () => {
        const saved = await saveMessage(
          mockReq,
          {
            ...mockMessageData,
            messageId: identity.responseMessageId,
            parentMessageId: 'native-source',
            isCreatedByUser: false,
            unfinished: true,
            text: 'A generation checkpoint.',
          },
          { operationKind: 'system' },
        );
        expect(saved.text).toBe(
          status === 'completed'
            ? 'Canonical native answer.'
            : status === 'prepared'
              ? 'In progress.'
              : 'A generation checkpoint.',
        );
        expect(saved.nativeResponse).toBeUndefined();
        expect(
          await methods.getNativeResponse(identity.userId, identity.responseMessageId),
        ).toMatchObject({ nativeResponse: { status, invocationId: identity.invocationId } });
      expect(await store.getJob(identity.streamId)).toMatchObject({ nativeResponse: identity });
    });

    test('a recovered BSON-null identity retains the original publication and exact FINAL', async () => {
      if (status !== 'completed') await completeNative();
      await Message.collection.updateOne(
        { user: identity.userId, messageId: identity.responseMessageId },
        {
          $set: {
            'nativeResponse.sourceOrderScope': null,
            'nativeResponse.sourceSequence': null,
            'nativeResponse.deliveryDispositionRequired': null,
            'nativeResponse.deliveryContext': null,
          },
        },
      );
      const saved = await methods.getNativeResponse(identity.userId, identity.responseMessageId);
      expect(saved.nativeResponse).toHaveProperty('sourceOrderScope', null);
      expect(
        await mockNativeResponseManager.finishNativeResponse(saved.nativeResponse, finalEvent),
      ).toBe(true);
      expect(await store.getNativeResponseCommit(saved.nativeResponse)).toEqual({
        status: 'committed',
        candidateSha256: candidateDigest,
      });
      expect(await store.getJob(identity.streamId)).toMatchObject({
        nativeResponse: identity,
        finalEvent: JSON.stringify(finalEvent),
      });
    });

      test.each(['edit', 'delete'])(
        '%s retires replay and retains any accepted publication',
        async (action) => {
          if (action === 'edit') {
            await updateMessage(
              mockReq,
              { messageId: identity.responseMessageId, text: 'Explicit correction.' },
              { operationKind: 'edit' },
            );
            expect(
              await methods.getNativeResponse(identity.userId, identity.responseMessageId),
            ).toMatchObject({
              text: 'Explicit correction.',
              nativeResponse: { status: 'cancelled' },
            });
          } else {
            await deleteMessages({ user: identity.userId, messageId: identity.responseMessageId });
            expect(
              await methods.getNativeResponse(identity.userId, identity.responseMessageId),
            ).toBeNull();
          }
          expect(await store.getJob(identity.streamId)).toBeNull();
          const receipt = await store.getNativeResponseCommit(identity);
          if (status === 'completed') {
            expect(receipt).toEqual({ status: 'committed', candidateSha256: candidateDigest });
          } else {
            expect(receipt.status).not.toBe('committed');
          }
          expect(
            await store.getNativeResponseCommit({ ...identity, invocationId: 'other' }),
          ).not.toMatchObject({ status: 'committed' });
          const delivered = jest.fn();
          transport.subscribe(identity.streamId, { onChunk: jest.fn(), onDone: delivered });
          expect(
            await mockNativeResponseManager.finishNativeResponse(
              identity,
              finalEvent || { final: true, responseMessage: { text: 'Obsolete answer.' } },
            ),
          ).toBe(false);
          expect(delivered).not.toHaveBeenCalled();
        },
      );

      test('a user-source edit cancels only unaccepted dependent answers', async () => {
        await updateMessage(
          mockReq,
          { messageId: 'native-source', text: 'Changed request.' },
          { operationKind: 'edit' },
        );
        const saved = await methods.getNativeResponse(identity.userId, identity.responseMessageId);
        expect(saved.nativeResponse.status).toBe(
          status === 'completed' ? 'completed' : 'cancelled',
        );
        if (status === 'completed') {
          expect(saved.text).toBe('Canonical native answer.');
          expect(await store.getNativeResponseCommit(identity)).toMatchObject({
            status: 'committed',
            candidateSha256: candidateDigest,
          });
          expect(await mockNativeResponseManager.finishNativeResponse(identity, finalEvent)).toBe(
            true,
          );
        } else {
          expect(await store.getNativeResponseCommit(identity)).toMatchObject({
            status: 'revoked',
          });
        }
      });

      test('explicit POST replacement is not swallowed by immutable snapshot preservation', async () => {
        const express = require('express');
        const request = require('supertest');
        const app = express();
        app.use(express.json());
        app.use('/api/messages', require('~/server/routes/messages'));
        const response = await request(app)
          .post(`/api/messages/${identity.conversationId}`)
          .send({
            messageId: identity.responseMessageId,
            conversationId: identity.conversationId,
            user: identity.userId,
            isCreatedByUser: false,
            text: 'Explicit replacement.',
            content: [{ type: 'text', text: 'Explicit replacement.' }],
            metadata: { operationKind: 'system' },
          });
        expect(response.status).toBe(201);
        expect(response.body.text).toBe('Explicit replacement.');
        expect(response.body.nativeResponse).toBeUndefined();
        expect(
          await methods.getNativeResponse(identity.userId, identity.responseMessageId),
        ).toMatchObject({
          text: 'Explicit replacement.',
          nativeResponse: { status: 'cancelled' },
        });
        expect(await store.getJob(identity.streamId)).toBeNull();
      });
    },
  );
  /* === VIVENTIUM END === */

  describe('saveMessage', () => {
    it('bulk replacement cannot overwrite another owner at the same message id', async () => {
      await Message.create({
        ...mockMessageData,
        user: 'original-owner',
        text: 'Original owner text.',
      });
      await bulkSaveMessages([
        { ...mockMessageData, user: 'another-owner', text: 'Foreign replacement.' },
      ]).catch(() => undefined);
      expect(
        await Message.findOne({
          messageId: mockMessageData.messageId,
          user: 'original-owner',
        }).lean(),
      ).toMatchObject({ text: 'Original owner text.' });
    });

    it('cannot overwrite a native completion admitted after the ordinary snapshot read', async () => {
      await Message.create({ ...mockMessageData, isCreatedByUser: false, unfinished: true });
      const db = require('~/models');
      const guard = jest
        .spyOn(db, 'saveNativeResponseSnapshot')
        .mockImplementationOnce(async () => {
          await Message.updateOne(
            { messageId: mockMessageData.messageId },
            {
              $set: {
                nativeResponse: { status: 'completed', invocationId: 'native-winner' },
                text: 'Canonical native answer.',
                unfinished: false,
              },
            },
          );
          return undefined;
        });
      try {
        const saved = await saveMessage(
          mockReq,
          {
            ...mockMessageData,
            isCreatedByUser: false,
            unfinished: true,
            text: 'Late checkpoint.',
          },
          { operationKind: 'system' },
        );
        expect(saved.text).toBe('Canonical native answer.');
        expect(saved.unfinished).toBe(false);
        expect((await Message.findOne({ messageId: mockMessageData.messageId })).text).toBe(
          'Canonical native answer.',
        );
      } finally {
        guard.mockRestore();
      }
    });

    it('should save a message for an authenticated user', async () => {
      const result = await saveMessage(mockReq, mockMessageData);

      expect(result.messageId).toBe('msg123');
      expect(result.user).toBe('user123');
      expect(result.text).toBe('Hello, world!');

      // Verify the message was actually saved to the database
      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(savedMessage).toBeTruthy();
      expect(savedMessage.text).toBe('Hello, world!');
      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: 'user123',
        conversationId: mockMessageData.conversationId,
      });
    });

    it('strips private Feelings receipts before save without mutating visible content', async () => {
      const content = privateFeelingContent('PRIVATE_SYNTHETIC_SAVE_CANARY');
      Object.freeze(content[0].metadata.nested[PRIVATE_FEELING_FIELD]);
      Object.freeze(content[0].metadata.nested);
      Object.freeze(content[0].metadata);
      Object.freeze(content[0]);
      Object.freeze(content);

      await saveMessage(mockReq, {
        ...mockMessageData,
        content,
        isCreatedByUser: false,
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(savedMessage.content, 'PRIVATE_SYNTHETIC_SAVE_CANARY');
      expect(savedMessage.content[0]).toMatchObject({
        type: 'text',
        text: 'Visible public text.',
        metadata: { publicLabel: 'preserved', nested: { keep: 'public' } },
      });
      expect(content[0].metadata.nested[PRIVATE_FEELING_FIELD].capsule).toBe(
        'PRIVATE_SYNTHETIC_SAVE_CANARY',
      );
      expectPrivateFeelingAbsent(
        mockScheduleConversationRecallSync.mock.calls,
        'PRIVATE_SYNTHETIC_SAVE_CANARY',
      );
    });

    it('strips dotted content keys containing the exact private Feelings path segment', async () => {
      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [
          {
            type: 'text',
            text: 'Visible dotted-key content.',
            'metadata.cortex_delivery_feeling_snapshot': {
              capsule: 'PRIVATE_SYNTHETIC_DOTTED_MODEL_CANARY',
            },
            'metadata.cortex_delivery_feeling_snapshot_public': 'preserved-near-match',
          },
        ],
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(savedMessage.content[0]).not.toHaveProperty(
        'metadata.cortex_delivery_feeling_snapshot',
      );
      expect(JSON.stringify(savedMessage.content)).not.toContain(
        'PRIVATE_SYNTHETIC_DOTTED_MODEL_CANARY',
      );
      expect(savedMessage.content[0]['metadata.cortex_delivery_feeling_snapshot_public']).toBe(
        'preserved-near-match',
      );
      expect(savedMessage.content[0].text).toBe('Visible dotted-key content.');
    });

    it('should throw an error for unauthenticated user', async () => {
      mockReq.user = null;
      await expect(saveMessage(mockReq, mockMessageData)).rejects.toThrow('User not authenticated');
    });

    it('should handle invalid conversation ID gracefully', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      try {
        mockMessageData.conversationId = 'invalid-id';
        mockMessageData.content = privateFeelingContent('PRIVATE_SYNTHETIC_INVALID_ID_CANARY');
        const result = await saveMessage(mockReq, mockMessageData);
        expect(result).toBeUndefined();
        expectPrivateFeelingAbsent(infoSpy.mock.calls, 'PRIVATE_SYNTHETIC_INVALID_ID_CANARY');
      } finally {
        infoSpy.mockRestore();
      }
    });

    it('logs only bounded structural facts for an invalid conversation ID', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
      const invalidConversationId = 'invalid-owner@example.test-private-conversation';
      const privateInsight = 'PRIVATE_SYNTHETIC_INVALID_ID_INSIGHT';
      const privateCapsule = 'PRIVATE_SYNTHETIC_INVALID_ID_CAPSULE';
      try {
        await saveMessage(
          mockReq,
          {
            ...mockMessageData,
            conversationId: invalidConversationId,
            text: privateInsight,
            content: [
              {
                type: 'cortex_insight',
                insight: privateInsight,
                cortex_delivery_feeling_snapshot: { capsule: privateCapsule },
              },
            ],
          },
          { context: 'PRIVATE_SYNTHETIC_INVALID_CONTEXT' },
        );

        const diagnostics = JSON.stringify([...warnSpy.mock.calls, ...infoSpy.mock.calls]);
        expect(diagnostics).toContain('invalid_conversation_id');
        expect(diagnostics).not.toContain(invalidConversationId);
        expect(diagnostics).not.toContain('owner@example.test');
        expect(diagnostics).not.toContain(privateInsight);
        expect(diagnostics).not.toContain(privateCapsule);
        expect(diagnostics).not.toContain('PRIVATE_SYNTHETIC_INVALID_CONTEXT');
        expect(diagnostics).not.toContain('cortex_insight');
      } finally {
        infoSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('strips private Feelings receipts from serializable non-plain content objects', async () => {
      class SerializableContentPart {
        constructor() {
          this.type = 'text';
          this.text = 'Visible class content.';
          this.metadata = new Map([
            ['keep', 'public'],
            [PRIVATE_FEELING_FIELD, { capsule: 'PRIVATE_SYNTHETIC_NON_PLAIN_CANARY' }],
          ]);
        }
      }

      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [new SerializableContentPart()],
        isCreatedByUser: false,
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(savedMessage.content, 'PRIVATE_SYNTHETIC_NON_PLAIN_CANARY');
      expect(savedMessage.content[0]).toMatchObject({
        type: 'text',
        text: 'Visible class content.',
        metadata: { keep: 'public' },
      });
    });

    it('does not trust a plain content object that spoofs BSON metadata', async () => {
      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [
          {
            _bsontype: 'ObjectId',
            type: 'text',
            text: 'Visible spoof-resistant content.',
            [PRIVATE_FEELING_FIELD]: {
              capsule: 'PRIVATE_SYNTHETIC_BSON_SPOOF_CANARY',
            },
          },
        ],
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(savedMessage.content, 'PRIVATE_SYNTHETIC_BSON_SPOOF_CANARY');
      expect(savedMessage.content[0].text).toBe('Visible spoof-resistant content.');
    });

    it('does not trust a custom content object that spoofs an ObjectId', async () => {
      class ObjectIdSpoof {
        constructor() {
          this._bsontype = 'ObjectId';
          this.type = 'text';
          this.text = 'Visible custom-object content.';
          this[PRIVATE_FEELING_FIELD] = {
            capsule: 'PRIVATE_SYNTHETIC_CUSTOM_BSON_SPOOF_CANARY',
          };
        }

        toHexString() {
          return 'a'.repeat(24);
        }
      }

      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [new ObjectIdSpoof()],
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(
        savedMessage.content,
        'PRIVATE_SYNTHETIC_CUSTOM_BSON_SPOOF_CANARY',
      );
      expect(savedMessage.content[0].text).toBe('Visible custom-object content.');
    });

    it('preserves an authentic ObjectId in normal public content metadata', async () => {
      const referenceId = new mongoose.Types.ObjectId();

      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [
          {
            type: 'text',
            text: 'Visible ObjectId-backed content.',
            metadata: { referenceId },
          },
        ],
      });

      const savedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(savedMessage.content[0].metadata.referenceId).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(savedMessage.content[0].metadata.referenceId.toHexString()).toBe(
        referenceId.toHexString(),
      );
    });

    it('should mirror assistant visible content text into the legacy text field', async () => {
      const result = await saveMessage(mockReq, {
        messageId: 'assistant-content-text',
        conversationId: uuidv4(),
        text: '',
        isCreatedByUser: false,
        content: [
          { type: 'think', think: 'private reasoning' },
          { type: 'text', text: 'Visible assistant answer.' },
        ],
      });

      expect(result.text).toBe('Visible assistant answer.');

      const savedMessage = await Message.findOne({
        messageId: 'assistant-content-text',
        user: 'user123',
      }).lean();

      expect(savedMessage.text).toBe('Visible assistant answer.');
      expect(savedMessage.text).not.toContain('private reasoning');
    });

    it('should preserve structural boundaries between multiple visible assistant parts', async () => {
      const result = await saveMessage(mockReq, {
        messageId: 'assistant-parallel-content-text',
        conversationId: uuidv4(),
        text: 'Base answer.Added answer.',
        isCreatedByUser: false,
        content: [
          { type: 'text', text: 'Base answer.', agentId: 'agent-main', groupId: 1 },
          { type: 'text', text: 'Added answer.', agentId: 'agent-main____1', groupId: 1 },
        ],
      });

      expect(result.text).toBe('Base answer.\n\nAdded answer.');

      const savedMessage = await Message.findOne({
        messageId: 'assistant-parallel-content-text',
        user: 'user123',
      }).lean();

      expect(savedMessage.text).toBe('Base answer.\n\nAdded answer.');
    });

    it('should preserve an explicitly different sanitized text across multiple content parts', async () => {
      const result = await saveMessage(mockReq, {
        messageId: 'assistant-sanitized-multi-content-text',
        conversationId: uuidv4(),
        text: 'Sanitized visible answer.',
        isCreatedByUser: false,
        content: [
          { type: 'text', text: '<voice>First raw part.</voice>' },
          { type: 'text', text: '<voice>Second raw part.</voice>' },
        ],
      });

      expect(result.text).toBe('Sanitized visible answer.');
    });

    it('should preserve existing assistant text when content text is only a placeholder', async () => {
      const result = await saveMessage(mockReq, {
        messageId: 'assistant-placeholder-content-text',
        conversationId: uuidv4(),
        text: 'Already visible.',
        isCreatedByUser: false,
        content: [{ type: 'text', text: 'Generation in progress.' }],
      });

      expect(result.text).toBe('Already visible.');
    });

    it('should not overwrite non-voice assistant text when content includes reasoning and text', async () => {
      const result = await saveMessage(mockReq, {
        messageId: 'assistant-existing-text-with-content',
        conversationId: uuidv4(),
        text: 'Keep the original visible text.',
        isCreatedByUser: false,
        content: [
          { type: 'reasoning', reasoning: 'private reasoning' },
          { type: 'text', text: 'Different generated content text.' },
        ],
      });

      expect(result.text).toBe('Keep the original visible text.');

      const savedMessage = await Message.findOne({
        messageId: 'assistant-existing-text-with-content',
        user: 'user123',
      }).lean();

      expect(savedMessage.text).toBe('Keep the original visible text.');
      expect(savedMessage.text).not.toContain('private reasoning');
      expect(savedMessage.text).not.toContain('Different generated content text.');
    });
  });

  describe('updateMessageText', () => {
    it('should update message text for the authenticated user', async () => {
      // First save a message
      await saveMessage(mockReq, mockMessageData);
      mockScheduleConversationRecallSync.mockClear();

      // Then update it
      await updateMessageText(mockReq, { messageId: 'msg123', text: 'Updated text' });

      // Verify the update
      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(updatedMessage.text).toBe('Updated text');
      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: 'user123',
        conversationId: mockMessageData.conversationId,
      });
    });
  });

  describe('updateMessage', () => {
    it('should update a message for the authenticated user', async () => {
      // First save a message
      await saveMessage(mockReq, mockMessageData);
      mockScheduleConversationRecallSync.mockClear();

      const result = await updateMessage(mockReq, { messageId: 'msg123', text: 'Updated text' });

      expect(result.messageId).toBe('msg123');
      expect(result.text).toBe('Updated text');

      // Verify in database
      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(updatedMessage.text).toBe('Updated text');
      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: 'user123',
        conversationId: mockMessageData.conversationId,
      });
    });

    it('strips private Feelings receipts before structured content updates', async () => {
      await saveMessage(mockReq, mockMessageData);
      const content = privateFeelingContent('PRIVATE_SYNTHETIC_UPDATE_CANARY');

      await updateMessage(mockReq, { messageId: 'msg123', content });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(updatedMessage.content, 'PRIVATE_SYNTHETIC_UPDATE_CANARY');
      expect(updatedMessage.content[0].metadata.nested.keep).toBe('public');
      expect(content[0].metadata.nested[PRIVATE_FEELING_FIELD].capsule).toBe(
        'PRIVATE_SYNTHETIC_UPDATE_CANARY',
      );
    });

    it('fails closed instead of replacing pending legacy recovery content', async () => {
      const pendingContent = [
        { type: 'text', text: 'Original visible text.' },
        {
          type: 'cortex_insight',
          insight: 'PRIVATE_SYNTHETIC_PENDING_MODEL_INSIGHT',
          cortex_delivery_acceptance: 'retryable',
          cortex_delivery_surface: 'web',
          cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_PENDING_MODEL_STREAM',
          cortex_delivery_message_revision: 11,
          cortex_graph_result_hash: 'f'.repeat(64),
          [PRIVATE_FEELING_FIELD]: {
            capsule: 'PRIVATE_SYNTHETIC_PENDING_MODEL_CAPSULE',
            snapshotHash: 'a'.repeat(64),
          },
        },
      ];
      await Message.create({ ...mockMessageData, content: pendingContent });

      await expect(
        updateMessage(mockReq, {
          messageId: 'msg123',
          content: [{ type: 'text', text: 'Unrelated replacement.' }, pendingContent[1]],
        }),
      ).rejects.toMatchObject({
        code: 'pending_cortex_recovery_full_content_update_forbidden',
      });

      const unchanged = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(unchanged.content[0].text).toBe('Original visible text.');
      expect(JSON.stringify(unchanged.content)).toContain(
        'PRIVATE_SYNTHETIC_PENDING_MODEL_INSIGHT',
      );
      expect(JSON.stringify(unchanged.content)).toContain(
        'PRIVATE_SYNTHETIC_PENDING_MODEL_CAPSULE',
      );
    });

    it('strips private Feelings receipts from operator and dotted content updates', async () => {
      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [{ type: 'text', text: 'Original.' }],
      });

      await updateMessage(mockReq, {
        messageId: 'msg123',
        $set: {
          'content.0.text': 'Updated through an operator.',
          'content.0.metadata.keep': 'public',
          [`content.0.metadata.${PRIVATE_FEELING_FIELD}`]: {
            capsule: 'PRIVATE_SYNTHETIC_OPERATOR_CANARY',
          },
        },
      });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(updatedMessage.content, 'PRIVATE_SYNTHETIC_OPERATOR_CANARY');
      expect(updatedMessage.content[0]).toMatchObject({
        text: 'Updated through an operator.',
        metadata: { keep: 'public' },
      });
    });

    it('strips private Feelings receipts from null-prototype operator payloads', async () => {
      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [{ type: 'text', text: 'Original null-prototype content.' }],
      });
      const operatorPayload = Object.create(null);
      operatorPayload['content.0.text'] = 'Updated safely.';
      operatorPayload[`content.0.metadata.${PRIVATE_FEELING_FIELD}`] = {
        capsule: 'PRIVATE_SYNTHETIC_NULL_PROTOTYPE_CANARY',
      };

      await updateMessage(mockReq, { messageId: 'msg123', $set: operatorPayload });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(updatedMessage.content, 'PRIVATE_SYNTHETIC_NULL_PROTOTYPE_CANARY');
      expect(updatedMessage.content[0].text).toBe('Updated safely.');
    });

    it('allows an operator update to remove a legacy private Feelings receipt', async () => {
      await Message.create({
        ...mockMessageData,
        content: [
          {
            type: 'text',
            text: 'Legacy visible text.',
            metadata: {
              [PRIVATE_FEELING_FIELD]: {
                capsule: 'PRIVATE_SYNTHETIC_LEGACY_CLEANUP_CANARY',
              },
            },
          },
        ],
      });

      await updateMessage(mockReq, {
        messageId: 'msg123',
        $unset: { [`content.0.metadata.${PRIVATE_FEELING_FIELD}`]: 1 },
      });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expectPrivateFeelingAbsent(updatedMessage.content, 'PRIVATE_SYNTHETIC_LEGACY_CLEANUP_CANARY');
      expect(updatedMessage.content[0].text).toBe('Legacy visible text.');
    });

    it('blocks operator renames that would create or move a private Feelings field', async () => {
      await saveMessage(mockReq, {
        ...mockMessageData,
        content: [
          {
            type: 'text',
            text: 'Visible rename-safe text.',
            metadata: { publicValue: 'preserved' },
          },
        ],
      });

      await updateMessage(mockReq, {
        messageId: 'msg123',
        $rename: {
          'content.0.metadata.publicValue': `content.0.metadata.${PRIVATE_FEELING_FIELD}`,
        },
      });

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' }).lean();
      expect(updatedMessage.content[0].metadata.publicValue).toBe('preserved');
      expect(JSON.stringify(updatedMessage.content)).not.toContain(PRIVATE_FEELING_FIELD);
    });

    it('can override immutable timestamps for callback anchor repair', async () => {
      await saveMessage(mockReq, mockMessageData);
      mockScheduleConversationRecallSync.mockClear();
      const repairedCreatedAt = new Date('2026-04-28T14:00:02.000Z');
      const repairedUpdatedAt = new Date('2026-04-28T14:00:03.000Z');

      await updateMessage(
        mockReq,
        {
          messageId: 'msg123',
          text: 'Callback result.',
          createdAt: repairedCreatedAt,
          updatedAt: repairedUpdatedAt,
        },
        { context: 'test.timestamp-override', overrideTimestamp: true },
      );

      const updatedMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(updatedMessage.text).toBe('Callback result.');
      expect(updatedMessage.createdAt.toISOString()).toBe(repairedCreatedAt.toISOString());
      expect(updatedMessage.updatedAt.toISOString()).toBe(repairedUpdatedAt.toISOString());
      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: 'user123',
        conversationId: mockMessageData.conversationId,
      });
    });

    it('should throw an error if message is not found', async () => {
      await expect(
        updateMessage(mockReq, { messageId: 'nonexistent', text: 'Test' }),
      ).rejects.toThrow('Message not found or user not authorized.');
    });
  });

  describe('deleteMessagesSince', () => {
    it('should delete messages only for the authenticated user', async () => {
      const conversationId = uuidv4();

      // Create multiple messages in the same conversation
      await saveMessage(mockReq, {
        messageId: 'msg1',
        conversationId,
        text: 'First message',
        user: 'user123',
        createdAt: new Date('2026-04-21T10:00:00.000Z'),
      });

      await saveMessage(mockReq, {
        messageId: 'msg2',
        conversationId,
        text: 'Second message',
        user: 'user123',
        createdAt: new Date('2026-04-21T10:00:01.000Z'),
      });

      await saveMessage(mockReq, {
        messageId: 'msg3',
        conversationId,
        text: 'Third message',
        user: 'user123',
        createdAt: new Date('2026-04-21T10:00:02.000Z'),
      });

      // Delete messages since message2 (this should only delete messages created AFTER msg2)
      await deleteMessagesSince(mockReq, {
        messageId: 'msg2',
        conversationId,
      });

      // Verify msg1 and msg2 remain, msg3 is deleted
      const remainingMessages = await Message.find({ conversationId, user: 'user123' });
      expect(remainingMessages).toHaveLength(2);
      expect(remainingMessages.map((m) => m.messageId)).toContain('msg1');
      expect(remainingMessages.map((m) => m.messageId)).toContain('msg2');
      expect(remainingMessages.map((m) => m.messageId)).not.toContain('msg3');
    });

    it('should return undefined if no message is found', async () => {
      const result = await deleteMessagesSince(mockReq, {
        messageId: 'nonexistent',
        conversationId: 'convo123',
      });
      expect(result).toBeUndefined();
    });
  });

  describe('getMessages', () => {
    it('should retrieve messages with the correct filter', async () => {
      const conversationId = uuidv4();

      // Save some messages
      await saveMessage(mockReq, {
        messageId: 'msg1',
        conversationId,
        text: 'First message',
        user: 'user123',
      });

      await saveMessage(mockReq, {
        messageId: 'msg2',
        conversationId,
        text: 'Second message',
        user: 'user123',
      });

      const messages = await getMessages({ conversationId });
      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('First message');
      expect(messages[1].text).toBe('Second message');
    });
  });

  /* === VIVENTIUM START ===
   * Feature: Bounded GlassHive conversation-context projection.
   * Purpose: Prove delegation preparation follows one indexed ancestor branch instead of loading
   * and sorting an entire large conversation in application memory.
   * === VIVENTIUM END === */
  describe('getMessageAncestorBranch', () => {
    it('uses one bounded graph query and ignores a large unrelated branch', async () => {
      const conversationId = uuidv4();
      const branch = Array.from({ length: 48 }, (_, index) => ({
        user: 'user123',
        conversationId,
        messageId: `relevant-${index}`,
        parentMessageId: index > 0 ? `relevant-${index - 1}` : 'root',
        text: `Relevant ${index}`,
        isCreatedByUser: index % 2 === 0,
      }));
      const unrelated = Array.from({ length: 2000 }, (_, index) => ({
        user: 'user123',
        conversationId,
        messageId: `unrelated-${index}`,
        parentMessageId: 'root',
        text: `Unrelated ${index}`,
        isCreatedByUser: index % 2 === 0,
      }));
      await Message.insertMany([...branch, ...unrelated]);

      const startedAt = performance.now();
      const messages = await getMessageAncestorBranch({
        user: 'user123',
        conversationId,
        messageId: 'relevant-47',
        maxAncestors: 32,
      });
      const elapsedMs = performance.now() - startedAt;
      const pipeline = buildMessageAncestorBranchPipeline({
        user: 'user123',
        conversationId,
        messageId: 'relevant-47',
        maxAncestors: 32,
      });

      expect(pipeline[0]).toEqual({
        $match: { user: 'user123', conversationId, messageId: 'relevant-47' },
      });
      expect(pipeline).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ $sort: expect.anything() })]),
      );
      expect(pipeline.find((stage) => stage.$graphLookup)?.$graphLookup).toEqual(
        expect.objectContaining({
          from: Message.collection.name,
          connectFromField: 'parentMessageId',
          connectToField: 'messageId',
          maxDepth: 31,
          restrictSearchWithMatch: { user: 'user123', conversationId },
        }),
      );
      expect(messages).toHaveLength(33);
      expect(messages.map((message) => message.messageId)).toEqual(
        Array.from({ length: 33 }, (_, index) => `relevant-${47 - index}`),
      );
      expect(messages.some((message) => message.messageId.startsWith('unrelated-'))).toBe(false);
      expect(elapsedMs).toBeLessThan(1000);
    });
  });

  describe('recordMessage', () => {
    it('schedules conversation recall sync for direct recordMessage writes', async () => {
      const conversationId = uuidv4();

      const result = await recordMessage({
        user: 'user123',
        endpoint: 'agents',
        messageId: 'recorded-msg',
        conversationId,
        text: 'Recorded directly',
        isCreatedByUser: true,
      });

      expect(result).toBeTruthy();
      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: 'user123',
        conversationId,
      });
    });

    it('strips private Feelings receipts before direct record writes', async () => {
      const conversationId = uuidv4();
      const content = privateFeelingContent('PRIVATE_SYNTHETIC_RECORD_CANARY');

      await recordMessage({
        user: 'user123',
        endpoint: 'agents',
        messageId: 'recorded-private-receipt',
        conversationId,
        content,
        isCreatedByUser: false,
      });

      const savedMessage = await Message.findOne({
        messageId: 'recorded-private-receipt',
        user: 'user123',
      }).lean();
      expectPrivateFeelingAbsent(savedMessage.content, 'PRIVATE_SYNTHETIC_RECORD_CANARY');
      expect(savedMessage.content[0].metadata.publicLabel).toBe('preserved');
      expect(content[0].metadata.nested[PRIVATE_FEELING_FIELD]).toBeDefined();
    });
  });

  describe('getLatestRecallEligibleMessageCreatedAt', () => {
    it('excludes the current live user turn from vector-corpus freshness', async () => {
      await Message.create([
        {
          user: 'user123',
          messageId: 'previous-user-turn',
          conversationId: 'freshness-conversation',
          isCreatedByUser: true,
          text: 'Earlier accepted context.',
          createdAt: new Date('2026-04-09T16:25:23.880Z'),
          updatedAt: new Date('2026-04-09T16:25:23.880Z'),
        },
        {
          user: 'user123',
          messageId: 'current-user-turn',
          conversationId: 'freshness-conversation',
          isCreatedByUser: true,
          text: 'Current live question already present in the foreground transcript.',
          createdAt: new Date('2026-04-09T17:26:43.153Z'),
          updatedAt: new Date('2026-04-09T17:26:43.153Z'),
        },
        {
          user: 'user123',
          messageId: 'current-assistant-turn',
          parentMessageId: 'current-user-turn',
          conversationId: 'freshness-conversation',
          isCreatedByUser: false,
          text: 'An in-flight response that is not part of the prior recall corpus yet.',
          createdAt: new Date('2026-04-09T17:26:44.153Z'),
          updatedAt: new Date('2026-04-09T17:26:44.153Z'),
        },
      ]);

      const result = await getLatestRecallEligibleMessageCreatedAt({
        user: 'user123',
        excludeMessageId: 'current-user-turn',
        excludeParentMessageId: 'current-user-turn',
      });

      expect(new Date(result).toISOString()).toBe('2026-04-09T16:25:23.880Z');
    });

    it('skips assistant recall-echo replies when computing freshness eligibility', async () => {
      await Message.create([
        {
          user: 'user123',
          messageId: 'source-msg',
          conversationId: uuidv4(),
          isCreatedByUser: true,
          text: 'QA-only synthetic recall marker for testing: VIV-RAG-QA-20260409-1626-ONYX-FJ42. This is not a personal preference or durable memory.',
          createdAt: new Date('2026-04-09T16:25:23.880Z'),
          updatedAt: new Date('2026-04-09T16:25:23.880Z'),
        },
        {
          user: 'user123',
          messageId: 'meta-assistant',
          parentMessageId: 'meta-user',
          conversationId: 'meta-convo',
          isCreatedByUser: false,
          sender: 'Viventium',
          text: 'Let me search for that. **VIV-RAG-QA-20260409-1626-ONYX-FJ42**',
          attachments: [
            {
              type: 'file_search',
              file_search: {
                sources: [{ fileId: 'conversation_recall:user123:all' }],
              },
            },
          ],
          createdAt: new Date('2026-04-09T17:26:42.770Z'),
          updatedAt: new Date('2026-04-09T17:26:42.770Z'),
        },
        {
          user: 'user123',
          messageId: 'meta-user',
          conversationId: 'meta-convo',
          isCreatedByUser: true,
          text: 'Earlier today I told you a QA-only synthetic recall marker in another chat. What exact marker was it? Use file_search if needed and answer with only the exact marker.',
          createdAt: new Date('2026-04-09T17:26:43.153Z'),
          updatedAt: new Date('2026-04-09T17:26:43.153Z'),
        },
      ]);

      const result = await getLatestRecallEligibleMessageCreatedAt({ user: 'user123' });
      expect(new Date(result).toISOString()).toBe('2026-04-09T16:25:23.880Z');
    });
  });

  describe('deleteMessages', () => {
    it('should delete messages with the correct filter', async () => {
      // Save some messages for different users
      await saveMessage(mockReq, mockMessageData);
      await saveMessage(
        { user: { id: 'user456' } },
        {
          messageId: 'msg456',
          conversationId: uuidv4(),
          text: 'Other user message',
          user: 'user456',
        },
      );

      await deleteMessages({ user: 'user123' });

      // Verify only user123's messages were deleted
      const user123Messages = await Message.find({ user: 'user123' });
      const user456Messages = await Message.find({ user: 'user456' });

      expect(user123Messages).toHaveLength(0);
      expect(user456Messages).toHaveLength(1);
    });
  });

  describe('Conversation Hijacking Prevention', () => {
    it("should not allow editing a message in another user's conversation", async () => {
      const attackerReq = { user: { id: 'attacker123' } };
      const victimConversationId = uuidv4();
      const victimMessageId = 'victim-msg-123';

      // First, save a message as the victim (but we'll try to edit as attacker)
      const victimReq = { user: { id: 'victim123' } };
      await saveMessage(victimReq, {
        messageId: victimMessageId,
        conversationId: victimConversationId,
        text: 'Victim message',
        user: 'victim123',
      });

      // Attacker tries to edit the victim's message
      await expect(
        updateMessage(attackerReq, {
          messageId: victimMessageId,
          conversationId: victimConversationId,
          text: 'Hacked message',
        }),
      ).rejects.toThrow('Message not found or user not authorized.');

      // Verify the original message is unchanged
      const originalMessage = await Message.findOne({
        messageId: victimMessageId,
        user: 'victim123',
      });
      expect(originalMessage.text).toBe('Victim message');
    });

    it("should not allow deleting messages from another user's conversation", async () => {
      const attackerReq = { user: { id: 'attacker123' } };
      const victimConversationId = uuidv4();
      const victimMessageId = 'victim-msg-123';

      // Save a message as the victim
      const victimReq = { user: { id: 'victim123' } };
      await saveMessage(victimReq, {
        messageId: victimMessageId,
        conversationId: victimConversationId,
        text: 'Victim message',
        user: 'victim123',
      });

      // Attacker tries to delete from victim's conversation
      const result = await deleteMessagesSince(attackerReq, {
        messageId: victimMessageId,
        conversationId: victimConversationId,
      });

      expect(result).toBeUndefined();

      // Verify the victim's message still exists
      const victimMessage = await Message.findOne({
        messageId: victimMessageId,
        user: 'victim123',
      });
      expect(victimMessage).toBeTruthy();
      expect(victimMessage.text).toBe('Victim message');
    });

    it("should not allow inserting a new message into another user's conversation", async () => {
      const attackerReq = { user: { id: 'attacker123' } };
      const victimConversationId = uuidv4();

      // Attacker tries to save a message - this should succeed but with attacker's user ID
      const result = await saveMessage(attackerReq, {
        conversationId: victimConversationId,
        text: 'Inserted malicious message',
        messageId: 'new-msg-123',
        user: 'attacker123',
      });

      expect(result).toBeTruthy();
      expect(result.user).toBe('attacker123');

      // Verify the message was saved with the attacker's user ID, not as an anonymous message
      const savedMessage = await Message.findOne({ messageId: 'new-msg-123' });
      expect(savedMessage.user).toBe('attacker123');
      expect(savedMessage.conversationId).toBe(victimConversationId);
    });

    it('should allow retrieving messages from any conversation', async () => {
      const victimConversationId = uuidv4();

      // Save a message in the victim's conversation
      const victimReq = { user: { id: 'victim123' } };
      await saveMessage(victimReq, {
        messageId: 'victim-msg',
        conversationId: victimConversationId,
        text: 'Victim message',
        user: 'victim123',
      });

      // Anyone should be able to retrieve messages by conversation ID
      const messages = await getMessages({ conversationId: victimConversationId });
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Victim message');
    });
  });

  describe('isTemporary message handling', () => {
    beforeEach(() => {
      // Reset mocks before each test
      jest.clearAllMocks();
    });

    it('should save a message with expiredAt when isTemporary is true', async () => {
      // Mock app config with 24 hour retention
      mockReq.config.interfaceConfig.temporaryChatRetention = 24;

      mockReq.body = { isTemporary: true };

      const beforeSave = new Date();
      const result = await saveMessage(mockReq, mockMessageData);
      const afterSave = new Date();

      expect(result.messageId).toBe('msg123');
      expect(result.expiredAt).toBeDefined();
      expect(result.expiredAt).toBeInstanceOf(Date);

      // Verify expiredAt is approximately 24 hours in the future
      const expectedExpirationTime = new Date(beforeSave.getTime() + 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 24 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('should save a message without expiredAt when isTemporary is false', async () => {
      mockReq.body = { isTemporary: false };

      const result = await saveMessage(mockReq, mockMessageData);

      expect(result.messageId).toBe('msg123');
      expect(result.expiredAt).toBeNull();
    });

    it('should save a message without expiredAt when isTemporary is not provided', async () => {
      // No isTemporary in body
      mockReq.body = {};

      const result = await saveMessage(mockReq, mockMessageData);

      expect(result.messageId).toBe('msg123');
      expect(result.expiredAt).toBeNull();
    });

    it('persists explicit QA-run provenance as memory-ineligible structured metadata', async () => {
      mockReq.body = {
        viventiumQaRun: true,
        viventiumQaRunId: 'qa-run-123',
        viventiumEvalIsolation: { conversationRecall: true },
      };

      const result = await saveMessage(mockReq, {
        ...mockMessageData,
        metadata: { existing: 'preserved' },
      });

      expect(result.metadata).toMatchObject({
        existing: 'preserved',
        viventium: {
          qaRun: true,
          qaRunId: 'qa-run-123',
          memoryEligible: false,
        },
      });
      expect(mockScheduleConversationRecallSync).not.toHaveBeenCalled();
    });

    it('keeps proactive recall scheduling enabled for ordinary messages', async () => {
      mockReq.body = {};

      await saveMessage(mockReq, mockMessageData);

      expect(mockScheduleConversationRecallSync).toHaveBeenCalledWith({
        userId: mockReq.user.id,
        conversationId: mockMessageData.conversationId,
      });
    });

    it('should use custom retention period from config', async () => {
      // Mock app config with 48 hour retention
      mockReq.config.interfaceConfig.temporaryChatRetention = 48;

      mockReq.body = { isTemporary: true };

      /* === VIVENTIUM START ===
       * Feature: Test stability (time-based expiredAt assertions)
       * Purpose: saveMessage computes expiredAt relative to "now" at execution time; use a before/after range to avoid flakiness from async work.
       * Added: 2026-02-06
       */
      const beforeSave = Date.now();
      const result = await saveMessage(mockReq, mockMessageData);
      const afterSave = Date.now();

      expect(result.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 48 hours in the future.
      const retentionMs = 48 * 60 * 60 * 1000;
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        beforeSave + retentionMs - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(afterSave + retentionMs + 1000);
      /* === VIVENTIUM END === */
    });

    it('should handle minimum retention period (1 hour)', async () => {
      // Mock app config with less than minimum retention
      mockReq.config.interfaceConfig.temporaryChatRetention = 0.5; // Half hour - should be clamped to 1 hour

      mockReq.body = { isTemporary: true };

      /* === VIVENTIUM START ===
       * Feature: Test stability (time-based expiredAt assertions)
       * Purpose: saveMessage computes expiredAt relative to "now" at execution time; use a before/after range to avoid flakiness from async work.
       * Added: 2026-02-06
       */
      const beforeSave = Date.now();
      const result = await saveMessage(mockReq, mockMessageData);
      const afterSave = Date.now();

      expect(result.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 1 hour in the future (minimum)
      const retentionMs = 1 * 60 * 60 * 1000;
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        beforeSave + retentionMs - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(afterSave + retentionMs + 1000);
      /* === VIVENTIUM END === */
    });

    it('should handle maximum retention period (8760 hours)', async () => {
      // Mock app config with more than maximum retention
      mockReq.config.interfaceConfig.temporaryChatRetention = 10000; // Should be clamped to 8760 hours

      mockReq.body = { isTemporary: true };

      /* === VIVENTIUM START ===
       * Feature: Test stability (time-based expiredAt assertions)
       * Purpose: saveMessage computes expiredAt relative to "now" at execution time; use a before/after range to avoid flakiness from async work.
       * Added: 2026-02-06
       */
      const beforeSave = Date.now();
      const result = await saveMessage(mockReq, mockMessageData);
      const afterSave = Date.now();

      expect(result.expiredAt).toBeDefined();

      // Verify expiredAt is approximately 8760 hours (1 year) in the future
      const retentionMs = 8760 * 60 * 60 * 1000;
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        beforeSave + retentionMs - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(afterSave + retentionMs + 1000);
      /* === VIVENTIUM END === */
    });

    it('should handle missing config gracefully', async () => {
      // Simulate missing config - should use default retention period
      delete mockReq.config;

      mockReq.body = { isTemporary: true };

      const beforeSave = new Date();
      const result = await saveMessage(mockReq, mockMessageData);
      const afterSave = new Date();

      // Should still save the message with default retention period (30 days)
      expect(result.messageId).toBe('msg123');
      expect(result.expiredAt).toBeDefined();
      expect(result.expiredAt).toBeInstanceOf(Date);

      // Verify expiredAt is approximately 30 days in the future (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 720 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        new Date(afterSave.getTime() + 720 * 60 * 60 * 1000 + 1000).getTime(),
      );
    });

    it('should use default retention when config is not provided', async () => {
      // Mock getAppConfig to return empty config
      mockReq.config = {}; // Empty config

      mockReq.body = { isTemporary: true };

      const beforeSave = new Date();
      const result = await saveMessage(mockReq, mockMessageData);

      expect(result.expiredAt).toBeDefined();

      // Default retention is 30 days (720 hours)
      const expectedExpirationTime = new Date(beforeSave.getTime() + 30 * 24 * 60 * 60 * 1000);
      const actualExpirationTime = new Date(result.expiredAt);

      expect(actualExpirationTime.getTime()).toBeGreaterThanOrEqual(
        expectedExpirationTime.getTime() - 1000,
      );
      expect(actualExpirationTime.getTime()).toBeLessThanOrEqual(
        expectedExpirationTime.getTime() + 1000,
      );
    });

    it('should not update expiredAt on message update', async () => {
      // First save a temporary message
      mockReq.config.interfaceConfig.temporaryChatRetention = 24;

      mockReq.body = { isTemporary: true };
      const savedMessage = await saveMessage(mockReq, mockMessageData);
      const originalExpiredAt = savedMessage.expiredAt;

      // Now update the message without isTemporary flag
      mockReq.body = {};
      const updatedMessage = await updateMessage(mockReq, {
        messageId: 'msg123',
        text: 'Updated text',
      });

      // expiredAt should not be in the returned updated message object
      expect(updatedMessage.expiredAt).toBeUndefined();

      // Verify in database that expiredAt wasn't changed
      const dbMessage = await Message.findOne({ messageId: 'msg123', user: 'user123' });
      expect(dbMessage.expiredAt).toEqual(originalExpiredAt);
    });

    it('should preserve expiredAt when saving existing temporary message', async () => {
      // First save a temporary message
      mockReq.config.interfaceConfig.temporaryChatRetention = 24;

      mockReq.body = { isTemporary: true };
      const firstSave = await saveMessage(mockReq, mockMessageData);
      const originalExpiredAt = firstSave.expiredAt;

      // Wait a bit to ensure time difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Save again with same messageId but different text
      const updatedData = { ...mockMessageData, text: 'Updated text' };
      const secondSave = await saveMessage(mockReq, updatedData);

      // Should update text but create new expiredAt
      expect(secondSave.text).toBe('Updated text');
      expect(secondSave.expiredAt).toBeDefined();
      expect(new Date(secondSave.expiredAt).getTime()).toBeGreaterThan(
        new Date(originalExpiredAt).getTime(),
      );
    });

    it('should handle bulk operations with temporary messages', async () => {
      // This test verifies bulkSaveMessages doesn't interfere with expiredAt
      const messages = [
        {
          messageId: 'bulk1',
          conversationId: uuidv4(),
          text: 'Bulk message 1',
          user: 'user123',
          expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        {
          messageId: 'bulk2',
          conversationId: uuidv4(),
          text: 'Bulk message 2',
          user: 'user123',
          expiredAt: null,
        },
      ];

      await bulkSaveMessages(messages);

      const savedMessages = await Message.find({
        messageId: { $in: ['bulk1', 'bulk2'] },
      }).lean();

      expect(savedMessages).toHaveLength(2);

      const bulk1 = savedMessages.find((m) => m.messageId === 'bulk1');
      const bulk2 = savedMessages.find((m) => m.messageId === 'bulk2');

      expect(bulk1.expiredAt).toBeDefined();
      expect(bulk2.expiredAt).toBeNull();
    });

    it('strips private Feelings receipts from bulk message writes', async () => {
      const content = privateFeelingContent('PRIVATE_SYNTHETIC_BULK_CANARY');
      const messages = [
        {
          messageId: 'bulk-private-receipt',
          conversationId: uuidv4(),
          text: 'Visible public text.',
          content,
          user: 'user123',
        },
      ];

      await bulkSaveMessages(messages);

      const savedMessage = await Message.findOne({ messageId: 'bulk-private-receipt' }).lean();
      expectPrivateFeelingAbsent(savedMessage.content, 'PRIVATE_SYNTHETIC_BULK_CANARY');
      expect(savedMessage.content[0].metadata.nested.keep).toBe('public');
      expect(messages[0].content[0].metadata.nested[PRIVATE_FEELING_FIELD]).toBeDefined();
    });
  });

  describe('Message cursor pagination', () => {
    /**
     * Helper to create messages with specific timestamps
     * Uses collection.insertOne to bypass Mongoose timestamps
     */
    const createMessageWithTimestamp = async (index, conversationId, createdAt) => {
      const messageId = uuidv4();
      await Message.collection.insertOne({
        messageId,
        conversationId,
        user: 'user123',
        text: `Message ${index}`,
        isCreatedByUser: index % 2 === 0,
        createdAt,
        updatedAt: createdAt,
      });
      return Message.findOne({ messageId }).lean();
    };

    /**
     * Simulates the pagination logic from api/server/routes/messages.js
     * This tests the exact query pattern used in the route
     */
    const getMessagesByCursor = async ({
      conversationId,
      user,
      pageSize = 25,
      cursor = null,
      sortBy = 'createdAt',
      sortDirection = 'desc',
    }) => {
      const sortOrder = sortDirection === 'asc' ? 1 : -1;
      const sortField = ['createdAt', 'updatedAt'].includes(sortBy) ? sortBy : 'createdAt';
      const cursorOperator = sortDirection === 'asc' ? '$gt' : '$lt';

      const filter = { conversationId, user };
      if (cursor) {
        filter[sortField] = { [cursorOperator]: new Date(cursor) };
      }

      const messages = await Message.find(filter)
        .sort({ [sortField]: sortOrder })
        .limit(pageSize + 1)
        .lean();

      let nextCursor = null;
      if (messages.length > pageSize) {
        messages.pop(); // Remove extra item used to detect next page
        // Create cursor from the last RETURNED item (not the popped one)
        nextCursor = messages[messages.length - 1][sortField];
      }

      return { messages, nextCursor };
    };

    it('should return messages for a conversation with pagination', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 30 messages to test pagination
      for (let i = 0; i < 30; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000); // Each 1 minute apart
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      // Fetch first page (pageSize 25)
      const page1 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(page1.messages).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Fetch second page using cursor
      const page2 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
        cursor: page1.nextCursor,
      });

      // Should get remaining 5 messages
      expect(page2.messages).toHaveLength(5);
      expect(page2.nextCursor).toBeNull();

      // Verify no duplicates and no gaps
      const allMessageIds = [
        ...page1.messages.map((m) => m.messageId),
        ...page2.messages.map((m) => m.messageId),
      ];
      const uniqueIds = new Set(allMessageIds);

      expect(uniqueIds.size).toBe(30); // All 30 messages accounted for
      expect(allMessageIds.length).toBe(30); // No duplicates
    });

    it('should not skip message at page boundary (item 26 bug fix)', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T12:00:00.000Z');

      // Create exactly 26 messages
      const messages = [];
      for (let i = 0; i < 26; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        const msg = await createMessageWithTimestamp(i, conversationId, createdAt);
        messages.push(msg);
      }

      // The 26th message (index 25) should be on page 2
      const item26 = messages[25];

      // Fetch first page with pageSize 25
      const page1 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(page1.messages).toHaveLength(25);
      expect(page1.nextCursor).toBeTruthy();

      // Item 26 should NOT be in page 1
      const page1Ids = page1.messages.map((m) => m.messageId);
      expect(page1Ids).not.toContain(item26.messageId);

      // Fetch second page
      const page2 = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
        cursor: page1.nextCursor,
      });

      // Item 26 MUST be in page 2 (this was the bug - it was being skipped)
      expect(page2.messages).toHaveLength(1);
      expect(page2.messages[0].messageId).toBe(item26.messageId);
    });

    it('should sort by createdAt DESC by default', async () => {
      const conversationId = uuidv4();

      // Create messages with specific timestamps
      const msg1 = await createMessageWithTimestamp(
        1,
        conversationId,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const msg2 = await createMessageWithTimestamp(
        2,
        conversationId,
        new Date('2026-01-02T00:00:00.000Z'),
      );
      const msg3 = await createMessageWithTimestamp(
        3,
        conversationId,
        new Date('2026-01-03T00:00:00.000Z'),
      );

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      // Should be sorted by createdAt DESC (newest first) by default
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].messageId).toBe(msg3.messageId);
      expect(result.messages[1].messageId).toBe(msg2.messageId);
      expect(result.messages[2].messageId).toBe(msg1.messageId);
    });

    it('should support ascending sort direction', async () => {
      const conversationId = uuidv4();

      const msg1 = await createMessageWithTimestamp(
        1,
        conversationId,
        new Date('2026-01-01T00:00:00.000Z'),
      );
      const msg2 = await createMessageWithTimestamp(
        2,
        conversationId,
        new Date('2026-01-02T00:00:00.000Z'),
      );

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        sortDirection: 'asc',
      });

      // Should be sorted by createdAt ASC (oldest first)
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].messageId).toBe(msg1.messageId);
      expect(result.messages[1].messageId).toBe(msg2.messageId);
    });

    it('should handle empty conversation', async () => {
      const conversationId = uuidv4();

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      expect(result.messages).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });

    it('should only return messages for the specified user', async () => {
      const conversationId = uuidv4();
      const createdAt = new Date();

      // Create a message for user123
      await Message.collection.insertOne({
        messageId: uuidv4(),
        conversationId,
        user: 'user123',
        text: 'User message',
        createdAt,
        updatedAt: createdAt,
      });

      // Create a message for a different user
      await Message.collection.insertOne({
        messageId: uuidv4(),
        conversationId,
        user: 'otherUser',
        text: 'Other user message',
        createdAt,
        updatedAt: createdAt,
      });

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
      });

      // Should only return user123's message
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].user).toBe('user123');
    });

    it('should handle exactly pageSize number of messages (no next page)', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create exactly 25 messages (equal to default pageSize)
      for (let i = 0; i < 25; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 25,
      });

      expect(result.messages).toHaveLength(25);
      expect(result.nextCursor).toBeNull(); // No next page
    });

    it('should handle pageSize of 1', async () => {
      const conversationId = uuidv4();
      const baseTime = new Date('2026-01-01T00:00:00.000Z');

      // Create 3 messages
      for (let i = 0; i < 3; i++) {
        const createdAt = new Date(baseTime.getTime() - i * 60000);
        await createMessageWithTimestamp(i, conversationId, createdAt);
      }

      // Fetch with pageSize 1
      let cursor = null;
      const allMessages = [];

      for (let page = 0; page < 5; page++) {
        const result = await getMessagesByCursor({
          conversationId,
          user: 'user123',
          pageSize: 1,
          cursor,
        });

        allMessages.push(...result.messages);
        cursor = result.nextCursor;

        if (!cursor) {
          break;
        }
      }

      // Should get all 3 messages without duplicates
      expect(allMessages).toHaveLength(3);
      const uniqueIds = new Set(allMessages.map((m) => m.messageId));
      expect(uniqueIds.size).toBe(3);
    });

    it('should handle messages with same createdAt timestamp', async () => {
      const conversationId = uuidv4();
      const sameTime = new Date('2026-01-01T12:00:00.000Z');

      // Create multiple messages with the exact same timestamp
      const messages = [];
      for (let i = 0; i < 5; i++) {
        const msg = await createMessageWithTimestamp(i, conversationId, sameTime);
        messages.push(msg);
      }

      const result = await getMessagesByCursor({
        conversationId,
        user: 'user123',
        pageSize: 10,
      });

      // All messages should be returned
      expect(result.messages).toHaveLength(5);
    });
  });
});
