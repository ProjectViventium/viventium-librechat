const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { messageSchema } = require('@librechat/data-schemas');
const { getMessages } = require('./Message');

jest.mock('~/server/services/Config/app');
jest.mock('~/models', () => ({
  ...jest.requireActual('~/models/Message'),
  getConvo: jest.requireActual('~/models/Conversation').getConvo,
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: req.headers['x-test-user'] || 'owner' };
    next();
  },
  validateMessageReq: jest.requireActual('~/server/middleware/validateMessageReq'),
}));
const { Conversation } = require('~/db/models');
const messagesRouter = require('~/server/routes/messages');

let server;
let Message;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Message.deleteMany({});
  await Conversation.deleteMany({});
});

test.each([
  ['/api/messages/conversation', 'completed'],
  ['/api/messages/conversation/answer', 'completed'],
  ['/api/messages/conversation', 'failed'],
  ['/api/messages/conversation/answer', 'failed'],
])('browser route %s carries delayed memory state through %s', async (route, terminal) => {
  const app = express();
  app.use('/api/messages', messagesRouter);
  await Conversation.create({ user: 'owner', conversationId: 'conversation', endpoint: 'agents' });
  await Message.create({
    user: 'owner',
    messageId: 'answer',
    conversationId: 'conversation',
    text: 'Visible answer',
    savedMemoryWrite: {
      status: 'pending',
      owner: 'PRIVATE_OWNER',
      source: { input: 'PRIVATE_INPUT' },
    },
  });
  for (const status of ['pending', 'running', terminal]) {
    const attachments = status === terminal ? [{ type: 'memory', status }] : [];
    await Message.updateOne(
      { messageId: 'answer' },
      { 'savedMemoryWrite.status': status, attachments },
    );
    const response = await request(app).get(route).expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ memoryWriteStatus: status, attachments });
    for (const key of ['_id', '__v', 'user', 'savedMemoryWrite', 'nativeResponse']) {
      expect(response.body[0]).not.toHaveProperty(key);
    }
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_');
  }
  await request(app).get(route).set('x-test-user', 'another-owner').expect(404);
});

test.each(['pending', 'running', 'completed', 'failed'])(
  'public reads expose only memory write state %s',
  async (status) => {
    await Message.create({
      user: 'owner',
      messageId: 'answer',
      conversationId: 'conversation',
      text: 'Visible answer',
      savedMemoryWrite: {
        owner: 'PRIVATE_RUNTIME',
        status,
        source: {
          input: 'PRIVATE_INPUT',
          interactionContextJson: 'PRIVATE_CONTEXT',
          digest: 'PRIVATE_DIGEST',
        },
      },
      nativeResponse: { invocationId: 'PRIVATE_INVOCATION' },
      attachments: [{ type: 'file', file_id: 'visible-file' }],
    });
    const [row] = await getMessages({ user: 'owner', messageId: 'answer' });
    expect(row).toMatchObject({
      text: 'Visible answer',
      memoryWriteStatus: status,
      attachments: [{ type: 'file', file_id: 'visible-file' }],
    });
    expect(JSON.stringify(row)).not.toContain('PRIVATE_');
    expect(row.savedMemoryWrite).toBeUndefined();
    expect(row.nativeResponse).toBeUndefined();
    expect(await getMessages({ user: 'another-owner', messageId: 'answer' })).toEqual([]);
  },
);

test('ordinary messages have no invented memory state and source selection stays internal', async () => {
  await Message.create({
    user: 'owner',
    messageId: 'plain',
    conversationId: 'conversation',
    text: 'An answer',
  });
  const [plain] = await getMessages({ user: 'owner', messageId: 'plain' });
  expect(plain).not.toHaveProperty('memoryWriteStatus');
  await Message.create({
    user: 'owner',
    messageId: 'admitted',
    conversationId: 'conversation',
    text: 'Another answer',
    savedMemoryWrite: { owner: 'runtime', status: 'pending', source: { input: 'private source' } },
  });
  const [internal] = await getMessages(
    { user: 'owner', messageId: 'admitted' },
    'messageId savedMemoryWrite.status',
  );
  expect(internal.savedMemoryWrite).toEqual({ status: 'pending' });
  expect(internal.text).toBeUndefined();
});
