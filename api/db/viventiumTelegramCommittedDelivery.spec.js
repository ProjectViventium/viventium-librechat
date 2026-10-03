/* === VIVENTIUM START ===
 * Feature: Committed delivery coverage of an accepted Telegram input (real Mongo).
 * Purpose: An input not bound to its own started stream settles only through the answer that
 * authored it, so an author that never ran cannot leave its input silently settled. An admitted
 * input, and legacy coverage without ownership, keep their settlement.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const { telegramInputConversationGeneration } = require('@librechat/api');
const {
  committedDeliveryFilter,
} = require('../server/services/viventium/telegramCommittedDelivery');

const OWNER = 'owner-committed-delivery';
const CONVERSATION = 'conversation-committed-delivery';

describe('committed delivery coverage of an accepted Telegram input', () => {
  let server;
  let database;
  let Message;
  const record = {
    libreChatUserId: OWNER,
    conversationId: CONVERSATION,
    requestedConversationId: CONVERSATION,
    conversationGeneration: 'c'.repeat(64),
    sourceOrderScope: 'b'.repeat(64),
    sourceEventId: 'a'.repeat(64),
    sourceMessageId: 'input-message',
    sourceSequence: 12,
  };

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Message = createModels(database).Message;
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await Message.deleteMany({});
  });

  const committedAnswer = (messageId, source) =>
    Message.create({
      messageId,
      user: OWNER,
      conversationId: CONVERSATION,
      isCreatedByUser: false,
      unfinished: false,
      text: 'answer',
      metadata: {
        viventium: {
          deliveryAcknowledgement: { state: 'committed', logical_turn_id: 'turn', revision: 2 },
          deliverySourceCoverage: {
            logical_turn_id: 'turn',
            revision: 2,
            source_order_scope: record.sourceOrderScope,
            source_conversation_generation: telegramInputConversationGeneration(record),
            sources: [
              {
                source_event_id: record.sourceEventId,
                source_message_id: record.sourceMessageId,
                source_sequence: record.sourceSequence,
                ...source,
              },
            ],
          },
        },
      },
    });
  const settles = async (state) =>
    Boolean(await Message.exists(committedDeliveryFilter({ ...record, state })));

  test('an answer that did not author an unbound input never settles it', async () => {
    await committedAnswer('answer-not-authoring', { owned: false });
    await expect(settles('ready')).resolves.toBe(false);
    await expect(settles('admitted')).resolves.toBe(true);
  });

  test('the authoring answer, or legacy coverage without ownership, settles it', async () => {
    await committedAnswer('answer-authoring', { owned: true });
    await expect(settles('ready')).resolves.toBe(true);
    await Message.deleteMany({});
    await committedAnswer('answer-legacy', {});
    await expect(settles('ready')).resolves.toBe(true);
  });
});
/* === VIVENTIUM END === */
