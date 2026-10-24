/* === VIVENTIUM START === Source-reference persistence uses the real history and binding adapters. === */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
let mockHostDependencies;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createScheduleDueHost: (dependencies) => {
    mockHostDependencies = dependencies;
    return {};
  },
}));
jest.mock('~/models', () => ({ getConvo: jest.fn(), getUserById: jest.fn() }));
jest.mock('../GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: jest.fn(),
}));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: jest.fn() }));
jest.mock('../CallSessionService', () => ({ getActiveCallSessionForConversation: jest.fn() }));
jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: jest.fn(),
}));
const { ensureScheduledConversationBinding } = require('@librechat/api');
const { Message } = require('~/db/models');
require('../ScheduleDueService');
let mongo;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 30000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
}, 15000);

test('real adapters persist one canonical source identity without text copies and deny changed, foreign or deleted originals', async () => {
  const text = 'Exact original\nKeep the file and the task together.';
  await Message.create({
    user: 'source-owner',
    conversationId: 'source-conversation',
    messageId: 'source-message',
    isCreatedByUser: true,
    text,
    metadata: { viventium: { interactionContext: { source_event_id: 'source-event' } } },
  });
  await Message.create({
    user: 'source-owner',
    conversationId: 'source-conversation',
    messageId: 'response-message',
    parentMessageId: 'source-message',
    isCreatedByUser: false,
    text: 'Main answer.',
  });
  const input = {
    ownerId: 'source-owner',
    conversationId: 'source-conversation',
    sourceEventId: 'source-event',
    taskText: text,
    sources: [{ source_event_id: 'source-event', source_message_id: 'source-message', text }],
  };
  const taskSource = await mockHostDependencies.prepareTaskSource(input);
  const alias = await mockHostDependencies.prepareTaskSource({
    ...input,
    sourceEventId: 'response-message',
    sources: undefined,
  });
  expect(alias).toEqual(taskSource);
  const values = {
    store: mockHostDependencies.store,
    tenantId: 'test',
    ownerId: input.ownerId,
    conversationId: 'selected-destination',
    sourceConversationId: input.conversationId,
    taskText: text,
    taskSource,
    sourceEventId: input.sourceEventId,
    destinations: [{ surface: 'librechat' }],
  };
  const one = await ensureScheduledConversationBinding(values);
  const two = await ensureScheduledConversationBinding({
    ...values,
    sourceEventId: 'response-message',
    taskSource: alias,
  });
  expect(one._id).toBe(two._id);
  const rows = await mongoose.connection
    .collection('viventium_glasshive_callback_bindings')
    .find({ kind: 'schedule_binding' })
    .toArray();
  expect(rows).toHaveLength(1);
  expect(rows[0].taskText).toBeUndefined();
  expect(rows[0].taskSource.messageIds).toEqual(['source-message']);
  expect(await mockHostDependencies.readBindingTaskText(rows[0])).toBe(text);
  await expect(
    mockHostDependencies.readBindingTaskText({ ...rows[0], ownerId: 'foreign-owner' }),
  ).rejects.toThrow('schedule_task_source_unavailable');
  await Message.updateOne({ messageId: 'source-message' }, { $set: { text: 'Mutated original' } });
  await expect(mockHostDependencies.readBindingTaskText(rows[0])).rejects.toThrow(
    'schedule_task_source_unavailable',
  );
  await Message.deleteOne({ messageId: 'source-message' });
  await expect(mockHostDependencies.readBindingTaskText(rows[0])).rejects.toThrow(
    'schedule_task_source_unavailable',
  );
  expect(await Message.countDocuments()).toBe(1);
});
/* === VIVENTIUM END === */
