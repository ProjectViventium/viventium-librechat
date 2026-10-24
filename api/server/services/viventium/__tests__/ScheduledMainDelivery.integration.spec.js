/* === VIVENTIUM START === Scheduled Main uses the existing outbox and real Mongo permit CAS. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { buildMainGenerationPresentation } = require('@librechat/api');
const mockMainVoiceTasks = {
  hydrateVoiceTaskByStreamId: jest.fn(async () => null),
  registerVoiceTaskDeliveryPresentation: jest.fn(),
  flushVoiceTaskPersistence: jest.fn(async () => {}),
  getVoiceTaskByStreamId: jest.fn(() => null),
  getVoiceTaskTraceBinding: jest.fn(() => null),
  snapshotEvent: jest.fn(() => null),
};
jest.mock('../VoiceTaskService', () => mockMainVoiceTasks);
jest.mock('~/models', () => ({ getConvo: jest.fn(async () => ({ endpoint: 'agents' })), getUserById: jest.fn(async () => ({ id: 'owner-main' })) }));
jest.mock('~/server/services/TelegramLinkService', () => ({ resolveTelegramMappingByUserId: jest.fn(async () => ({ telegramChatId: 'chat-main', telegramUserId: 'tg-main' })) }));
jest.mock('../CallSessionService', () => ({ getCallSession: jest.fn(async () => ({ userId: 'owner-main', conversationId: 'conversation-main', status: 'active', mode: 'call' })) }));
jest.mock('../GlassHiveCallbackBindingService', () => ({ isGlassHiveNonterminalAttentionCallback: () => false, recordGlassHiveSurfaceDeliveryOutcome: jest.fn(), fenceGlassHiveCallbackRunState: jest.fn() }));
jest.mock('../OrchestrationTraceLedgerService', () => ({ recordOrchestrationTraceDelivery: jest.fn() }));
jest.mock('../VoiceOrchestrationTraceService', () => ({ recordVoiceOrchestrationTraceBestEffort: jest.fn() }));
const { Message, ViventiumGlassHiveCallbackDelivery, GlassHiveTerminalCallbackResult } = require('~/db/models');
const { enqueueGlassHiveCallbackDelivery, claimPendingGlassHiveCallbackDeliveries, authorizeGlassHiveCallbackDeliveryDispatch, renewGlassHiveCallbackDeliveryDispatch,
  releaseGlassHiveCallbackDeliveryDispatch, markGlassHiveCallbackDeliverySent, markGlassHiveCallbackDeliveryUnknown,
  resolveGlassHiveVoicePresentation, reconcileGlassHiveSurfaceDeliveryProjections } = require('../GlassHiveCallbackDeliveryService');
let replica;
beforeAll(async () => { replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); await mongoose.connect(replica.getUri()); }, 30000);
afterAll(async () => { await mongoose.disconnect(); await replica?.stop({ doCleanup: true, force: true }); }, 15000);
beforeEach(async () => { await mongoose.connection.dropDatabase(); await ViventiumGlassHiveCallbackDelivery.syncIndexes(); });
async function fixture(surface = 'telegram') {
  const text = 'The scheduled result is ready.';
  const row = { deliveryKey: 'schedule-main', deliveryId: 'schedule-main', callbackMessageId: 'message-main',
    callbackId: 'callback_sha256:' + 'a'.repeat(64), originRef: 'binding-main', userId: 'owner-main', conversationId: 'conversation-main',
    surface, event: 'main.followup', text, fullText: text, status: 'pending', nextAttemptAt: new Date(0), expiresAt: new Date(Date.now() + 60000),
    telegramChatId: 'chat-main', telegramUserId: 'tg-main', voiceCallSessionId: 'call-main', voiceRequestId: 'stream-main',
    mainGenerationPresentation: buildMainGenerationPresentation({ streamId: 'stream-main', admissionId: 'admission-main' }, 'message-main', text) };
  await mongoose.connection.collection('viventium_scheduler_dispatch_intents').insertOne({ _id: 'admission-main', kind: 'schedule_due',
    status: 'accepted', dueState: 'delivery_queued', userId: row.userId, conversationId: row.conversationId, streamId: 'stream-main',
    bindingRef: row.originRef, resultMessageId: row.callbackMessageId, envelope: { principal: { tenant_id: 'tenant-main', owner_id: row.userId } } });
  await mongoose.connection.collection('viventium_glasshive_callback_bindings').insertOne({ _id: row.originRef, kind: 'schedule_binding',
    ownerId: row.userId, tenantId: 'tenant-main', conversationId: row.conversationId, active: true,
    destinations: [{ surface: 'librechat' }, { surface: 'telegram', telegramChatId: row.telegramChatId, telegramUserId: row.telegramUserId }] });
  await Message.create({ user: row.userId, conversationId: row.conversationId, messageId: row.callbackMessageId, isCreatedByUser: false, text });
  await ViventiumGlassHiveCallbackDelivery.create(row);
  const [claimed] = await claimPendingGlassHiveCallbackDeliveries({ surface, limit: 1, callbackId: row.callbackId, userId: row.userId,
    ...(surface === 'voice' ? { voiceCallSessionId: row.voiceCallSessionId } : {}) });
  expect(claimed).toBeDefined();
  return { row, input: { deliveryId: row.deliveryId, claimId: claimed.claimId, userId: row.userId,
    ...(surface === 'voice' ? { voiceCallSessionId: row.voiceCallSessionId } : {}) } };
}
test.each(['telegram', 'voice'])('%s Main claim, permit renewal, release, delivery and receipt need no worker result', async (surface) => {
  const f = await fixture(surface);
  const initial = await authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  expect(initial).toBeTruthy();
  expect(await renewGlassHiveCallbackDeliveryDispatch({ ...f.input, dispatchPermit: initial })).toMatchObject({ permitId: initial.permitId });
  expect(await releaseGlassHiveCallbackDeliveryDispatch({ ...f.input, dispatchPermit: initial })).toBe(true);
  const permit = await authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  expect(permit.permitGeneration).toBe(initial.permitGeneration + 1);
  if (surface === 'voice') expect(await resolveGlassHiveVoicePresentation({ ...f.input, dispatchPermit: permit, presentationRef: f.row.deliveryId,
    turnId: f.row.voiceRequestId, conversationId: f.row.conversationId })).toMatchObject({ text: f.row.text });
  expect(await markGlassHiveCallbackDeliverySent({ ...f.input, dispatchPermit: permit, telegramMessageIds: surface === 'telegram' ? ['transport-main'] : [] })).toMatchObject({ status: 'sent' });
  expect(await markGlassHiveCallbackDeliverySent({ ...f.input, dispatchPermit: permit })).toBeNull();
  expect(await GlassHiveTerminalCallbackResult.countDocuments()).toBe(0);
});
test('changed canonical reply or disabled binding cannot authorize', async () => {
  const f = await fixture();
  await Message.updateOne({ messageId: 'message-main' }, { $set: { text: 'Different text.' } });
  expect(await authorizeGlassHiveCallbackDeliveryDispatch(f.input)).toBeNull();
  await Message.updateOne({ messageId: 'message-main' }, { $set: { text: f.row.text } });
  await mongoose.connection.collection('viventium_glasshive_callback_bindings').updateOne({ _id: 'binding-main' }, { $set: { active: false } });
  expect(await authorizeGlassHiveCallbackDeliveryDispatch(f.input)).toBeNull();
});
test('unknown transport requires the issued permit and cannot be retried', async () => {
  const f = await fixture(); const permit = await authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  expect(await markGlassHiveCallbackDeliveryUnknown(f.input)).toBeNull();
  expect(await markGlassHiveCallbackDeliveryUnknown({ ...f.input, dispatchPermit: permit, reason: 'synthetic transport outcome unknown' })).toMatchObject({ status: 'delivery_unknown' });
  expect(await claimPendingGlassHiveCallbackDeliveries({ surface: 'telegram', limit: 1 })).toEqual([]);
});
/* === VIVENTIUM END === */


test('chat-only Main recognizes the same persisted reply without a worker effect or replay', async () => {
  const f = await fixture();
  const message = await Message.findOne({ messageId: f.row.callbackMessageId }).lean();
  const input = { body: { event: 'main.followup', callback_id: 'scheduled:web-main', origin_ref: f.row.originRef }, message,
    text: message.text, deliveryContext: { ownerId: f.row.userId, conversationId: f.row.conversationId,
      originRef: f.row.originRef, destinations: [{ surface: 'librechat' }],
      mainGenerationPresentation: { streamId: 'stream-main', admissionId: 'admission-main' } } };
  const count = await ViventiumGlassHiveCallbackDelivery.countDocuments();
  expect(await enqueueGlassHiveCallbackDelivery(input)).toMatchObject({ configured: 0, enqueued: 0, linkedWebCommitted: true });
  expect(await enqueueGlassHiveCallbackDelivery(input)).toMatchObject({ linkedWebCommitted: true });
  expect(await Message.countDocuments()).toBe(1);
  expect(await ViventiumGlassHiveCallbackDelivery.countDocuments()).toBe(count);
  expect(await GlassHiveTerminalCallbackResult.countDocuments()).toBe(0);
  await mongoose.connection.collection('viventium_glasshive_callback_bindings').updateOne({ _id: 'binding-main' }, { $set: { active: false } });
  await expect(enqueueGlassHiveCallbackDelivery(input)).rejects.toThrow('glasshive_linked_main_presentation_invalid');
});


test('Main Telegram authorization accepts the actual user-ID-only direct-message mapping', async () => {
  const f = await fixture();
  await ViventiumGlassHiveCallbackDelivery.updateOne({ deliveryId: f.row.deliveryId }, { $set: { telegramChatId: 'tg-main' } });
  await mongoose.connection.collection('viventium_glasshive_callback_bindings').updateOne({ _id: 'binding-main' }, { $set: {
    destinations: [{ surface: 'telegram', telegramChatId: 'tg-main', telegramUserId: 'tg-main' }] } });
  require('~/server/services/TelegramLinkService').resolveTelegramMappingByUserId.mockResolvedValueOnce({ telegramUserId: 'tg-main' });
  expect(await authorizeGlassHiveCallbackDeliveryDispatch(f.input)).toBeTruthy();
});


test('pending scheduled Main Voice rehydrates after projection markers clear and task state is absent', async () => {
  const f = await fixture('voice');
  await ViventiumGlassHiveCallbackDelivery.updateOne({ deliveryId: f.row.deliveryId }, { $set: {
    status: 'pending', claimId: '', claimedAt: null, leaseExpiresAt: null,
    projectionPendingAt: null, projectionAppliedAt: new Date(), projectionNextAttemptAt: null,
  } });
  mockMainVoiceTasks.registerVoiceTaskDeliveryPresentation.mockClear();
  mockMainVoiceTasks.flushVoiceTaskPersistence.mockClear();
  expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ scanned: 1 });
  expect(mockMainVoiceTasks.registerVoiceTaskDeliveryPresentation).toHaveBeenCalledWith(
    expect.objectContaining({ deliveryId: f.row.deliveryId, mainGenerationPresentation: f.row.mainGenerationPresentation }),
    { userId: f.row.userId, callSessionId: f.row.voiceCallSessionId },
  );
  expect(mockMainVoiceTasks.flushVoiceTaskPersistence).toHaveBeenCalledTimes(1);
  const current = await ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: f.row.deliveryId }).lean();
  expect(current.projectionNextAttemptAt).toBeInstanceOf(Date);
  expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ scanned: 0 });
  expect(await Message.countDocuments()).toBe(1);
  expect(await GlassHiveTerminalCallbackResult.countDocuments()).toBe(0);
});


test('actual scheduled Main Voice enqueue uses its canonical Main proof, publishes, and rejects revoked authority', async () => {
  const f = await fixture('voice');
  await ViventiumGlassHiveCallbackDelivery.deleteMany({});
  const message = await Message.findOne({ messageId: f.row.callbackMessageId }).lean();
  const input = { body: { event: 'main.followup', callback_id: 'scheduled:voice-main', origin_ref: f.row.originRef }, message,
    text: message.text, deliveryContext: { ownerId: f.row.userId, conversationId: f.row.conversationId,
      originRef: f.row.originRef, destinations: [{ surface: 'librechat' }, { surface: 'voice',
        voiceCallSessionId: f.row.voiceCallSessionId, voiceRequestId: f.row.voiceRequestId }],
      mainGenerationPresentation: { streamId: 'stream-main', admissionId: 'admission-main' } } };
  mockMainVoiceTasks.registerVoiceTaskDeliveryPresentation.mockClear();
  expect(await enqueueGlassHiveCallbackDelivery(input)).toMatchObject({ configured: 1, enqueued: 1, unresolved: 0 });
  const saved = await ViventiumGlassHiveCallbackDelivery.findOne({ surface: 'voice' }).lean();
  expect(saved).toMatchObject({ callbackMessageId: message.messageId, fullText: message.text,
    mainGenerationPresentation: f.row.mainGenerationPresentation });
  expect(saved.workerCompletionPresentation).toBeNull();
  expect(mockMainVoiceTasks.registerVoiceTaskDeliveryPresentation).toHaveBeenCalledWith(
    expect.objectContaining({ deliveryId: saved.deliveryId, mainGenerationPresentation: f.row.mainGenerationPresentation }),
    { userId: f.row.userId, callSessionId: f.row.voiceCallSessionId },
  );
  const [claimed] = await claimPendingGlassHiveCallbackDeliveries({ surface: 'voice', limit: 1,
    userId: f.row.userId, voiceCallSessionId: f.row.voiceCallSessionId });
  expect(await authorizeGlassHiveCallbackDeliveryDispatch({ deliveryId: saved.deliveryId,
    claimId: claimed.claimId, userId: f.row.userId, voiceCallSessionId: f.row.voiceCallSessionId })).toBeTruthy();
  await ViventiumGlassHiveCallbackDelivery.deleteMany({});
  await mongoose.connection.collection('viventium_glasshive_callback_bindings').updateOne({ _id: f.row.originRef }, { $set: { active: false } });
  await expect(enqueueGlassHiveCallbackDelivery(input)).rejects.toThrow('voice_main_generation_presentation_invalid');
  expect(await ViventiumGlassHiveCallbackDelivery.countDocuments()).toBe(0);
  expect(await Message.countDocuments()).toBe(1);
  expect(await GlassHiveTerminalCallbackResult.countDocuments()).toBe(0);
});
