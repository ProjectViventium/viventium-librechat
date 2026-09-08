/* === VIVENTIUM START === Message deletion binds the authenticated selected conversation. === */
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const mockOwner = new mongoose.Types.ObjectId().toString();
const mockOtherOwner = new mongoose.Types.ObjectId().toString();

jest.mock('~/models', () => ({
  getConvo: (user, conversationId) =>
    require('mongoose').models.Conversation.findOne({ user, conversationId }).lean(),
  deleteMessages: (filter) => require('mongoose').models.Message.deleteMany(filter),
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: mockOwner };
    next();
  },
  validateMessageReq: require('~/server/middleware/validateMessageReq'),
}));
jest.mock('~/models/Conversation', () => ({ getConvosQueried: jest.fn() }));
jest.mock('~/db/models', () => {
  const connection = require('mongoose');
  require('@librechat/data-schemas').createModels(connection);
  return { Message: connection.models.Message };
});
jest.mock('~/server/services/Artifacts/update', () => ({}));
jest.mock('~/server/services/viventium/historicalVoiceTextRepair', () => ({}));

let server, app;
beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri());
  createModels(mongoose);
  await mongoose.models.Message.init();
  app = express();
  app.use(express.json());
  app.use('/api/messages', require('~/server/routes/messages'));
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Promise.all([
    mongoose.models.Message.deleteMany({}),
    mongoose.models.Conversation.deleteMany({}),
  ]);
  await mongoose.models.Conversation.create([
    { user: mockOwner, conversationId: 'selected', title: 'Selected', endpoint: 'agents' },
    { user: mockOwner, conversationId: 'other-owned', title: 'Other', endpoint: 'agents' },
    { user: mockOtherOwner, conversationId: 'foreign', title: 'Foreign', endpoint: 'agents' },
  ]);
});

test('deletes the selected message and preserves another owner', async () => {
  await mongoose.models.Message.create([
    { user: mockOwner, messageId: 'shared-id', conversationId: 'selected', text: 'Selected.' },
    {
      user: mockOtherOwner,
      messageId: 'foreign-id',
      conversationId: 'foreign',
      text: 'Keep foreign.',
    },
  ]);
  const response = await request(app).delete('/api/messages/selected/shared-id');
  expect(response.status).toBe(204);
  expect(
    await mongoose.models.Message.findOne({ user: mockOwner, messageId: 'shared-id' }),
  ).toBeNull();
  expect(
    await mongoose.models.Message.findOne({ user: mockOtherOwner, messageId: 'foreign-id' }).lean(),
  ).toMatchObject({ text: 'Keep foreign.' });
});

test.each([
  ['other-owned', () => mockOwner],
  ['foreign', () => mockOtherOwner],
])('an owned conversation URL cannot delete a message in %s', async (conversationId, owner) => {
  await mongoose.models.Message.create({
    user: owner(),
    messageId: 'unselected',
    conversationId,
    text: 'Keep.',
  });
  const response = await request(app).delete('/api/messages/selected/unselected');
  expect(response.status).toBe(204);
  expect(await mongoose.models.Message.findOne({ messageId: 'unselected' }).lean()).toMatchObject({
    text: 'Keep.',
  });
});

test('the actual conversation validator still rejects a foreign conversation', async () => {
  await mongoose.models.Message.create({
    user: mockOtherOwner,
    messageId: 'foreign-answer',
    conversationId: 'foreign',
    text: 'Keep.',
  });
  expect((await request(app).delete('/api/messages/foreign/foreign-answer')).status).toBe(404);
  expect(await mongoose.models.Message.countDocuments()).toBe(1);
});
/* === VIVENTIUM END === */
