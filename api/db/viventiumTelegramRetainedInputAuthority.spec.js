/* === VIVENTIUM START ===
 * Feature: Durable source authority for retained Telegram inputs (real Mongo).
 * Purpose: A retained input's ingress row, shaped as the prepared-input pipeline leaves it (stream
 * bound, authority unbound), becomes exactly the authority the durable Telegram dispatcher reads,
 * once, for its own owner and stream only.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const createViventiumTelegramIngressEvent = require('./viventiumTelegramIngressEvent');
const {
  bindRetainedTelegramIngressAuthority,
} = require('../server/services/viventium/TelegramIngressAuthorityService');

const OWNER = 'owner-telegram-retained';
const SOURCE_EVENT = 'e'.repeat(64);
const STREAM = 'telegram-stream-retained';
const CONVERSATION = 'conversation-telegram-retained';

describe('Retained Telegram input authority', () => {
  let server;
  let database;
  let Ingress;

  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Ingress = createViventiumTelegramIngressEvent(database);
    await Ingress.syncIndexes();
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
  });

  beforeEach(async () => {
    await Ingress.collection.deleteMany({});
    // As the prepared-input pipeline leaves a completed retained turn: stream bound, no authority.
    await Ingress.collection.insertOne({
      dedupeKey: 'm:-100123:81',
      libreChatUserId: OWNER,
      telegramUserId: 'telegram-user-1',
      telegramChatId: '-100123',
      telegramMessageId: '81',
      sourceSequence: 81,
      sourceOrderScope: 'f'.repeat(64),
      sourceEventId: SOURCE_EVENT,
      conversationId: CONVERSATION,
      streamId: STREAM,
      inputState: 'completed',
      authorityBoundAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
  });

  /** The durable Telegram dispatcher's exact ingress authority query. */
  function dispatcherAuthority() {
    return Ingress.findOne({
      streamId: STREAM,
      conversationId: CONVERSATION,
      libreChatUserId: OWNER,
      authorityBoundAt: { $type: 'date' },
    }).lean();
  }

  const bind = (overrides = {}) =>
    bindRetainedTelegramIngressAuthority({
      ownerId: OWNER,
      sourceEventId: SOURCE_EVENT,
      streamId: STREAM,
      IngressModel: Ingress,
      ...overrides,
    });

  test('an unbound retained row is invisible to the dispatcher until its stream binds it', async () => {
    await expect(dispatcherAuthority()).resolves.toBeNull();

    await bind();

    const bound = await dispatcherAuthority();
    expect(bound?.authorityBoundAt).toBeInstanceOf(Date);
    expect(bound).toMatchObject({ sourceEventId: SOURCE_EVENT, telegramChatId: '-100123' });
  });

  test('a continued admission of the same stream keeps the first binding time', async () => {
    await bind();
    const first = (await dispatcherAuthority()).authorityBoundAt.getTime();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await bind();

    expect((await dispatcherAuthority()).authorityBoundAt.getTime()).toBe(first);
  });

  test.each([
    ['another stream', { streamId: 'telegram-stream-other' }],
    ['another owner', { ownerId: 'owner-other' }],
    ['another source event', { sourceEventId: 'd'.repeat(64) }],
  ])('%s fails closed and binds nothing', async (_label, overrides) => {
    await expect(bind(overrides)).rejects.toMatchObject({
      code: 'TELEGRAM_INGRESS_AUTHORITY_UNAVAILABLE',
    });
    await expect(dispatcherAuthority()).resolves.toBeNull();
  });
});
