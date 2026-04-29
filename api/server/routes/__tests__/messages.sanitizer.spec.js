const express = require('express');
const request = require('supertest');
const { ContentTypes, ToolCallTypes } = require('librechat-data-provider');

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'user-public-safe' };
    next();
  },
  validateMessageReq: (_req, _res, next) => next(),
}));

jest.mock('~/models', () => ({
  saveConvo: jest.fn(),
  getMessage: jest.fn(),
  saveMessage: jest.fn(async (_req, message) => message),
  getMessages: jest.fn(),
  updateMessage: jest.fn(),
  deleteMessages: jest.fn(),
}));

jest.mock('~/models/Conversation', () => ({
  getConvosQueried: jest.fn(),
}));

jest.mock('~/db/models', () => ({
  Message: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(() => []),
  replaceArtifactContent: jest.fn(),
}));

const { getMessage, getMessages, saveMessage } = require('~/models');
const router = require('../messages');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', router);
  return app;
}

function duplicateToolCallContent() {
  return [
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'toolu_projects',
        name: 'projects_list',
        args: {},
        type: ToolCallTypes.TOOL_CALL,
      },
    },
    {
      type: ContentTypes.TOOL_CALL,
      tool_call: {
        id: 'toolu_projects',
        name: 'projects_list',
        args: '{}',
        type: ToolCallTypes.TOOL_CALL,
        progress: 1,
        output: '[{"project_id":"prj_public_safe"}]',
      },
    },
  ];
}

describe('messages route content sanitization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sanitizes duplicate tool snapshots on the conversation message route', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-1',
        conversationId: 'conversation-1',
        isCreatedByUser: false,
        content: duplicateToolCallContent(),
      },
    ]);

    const res = await request(createApp()).get('/api/messages/conversation-1').expect(200);

    expect(res.body[0].content).toHaveLength(1);
    expect(res.body[0].content[0].tool_call.progress).toBe(1);
  });

  it('sanitizes duplicate tool snapshots before creating a branch', async () => {
    getMessage.mockResolvedValue({
      messageId: 'assistant-1',
      conversationId: 'conversation-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
      model: 'model',
      endpoint: 'agents',
      sender: 'Viventium',
      content: duplicateToolCallContent().map((part) => ({
        ...part,
        agentId: 'agent-a',
        groupId: 1,
      })),
    });

    const res = await request(createApp())
      .post('/api/messages/branch')
      .send({ messageId: 'assistant-1', agentId: 'agent-a' })
      .expect(201);

    expect(res.body.content).toHaveLength(1);
    expect(res.body.content[0].tool_call.progress).toBe(1);
    expect(saveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ content: res.body.content }),
      expect.anything(),
    );
  });
});
