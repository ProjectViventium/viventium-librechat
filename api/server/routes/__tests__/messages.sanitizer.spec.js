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
    meiliSearch: jest.fn(),
  },
}));

jest.mock('~/server/services/Artifacts/update', () => ({
  findAllArtifacts: jest.fn(() => []),
  replaceArtifactContent: jest.fn(),
}));

const { getMessage, getMessages, saveMessage, updateMessage } = require('~/models');
const { getConvosQueried } = require('~/models/Conversation');
const { Message } = require('~/db/models');
const { findAllArtifacts, replaceArtifactContent } = require('~/server/services/Artifacts/update');
const router = require('../messages');

const PRIVATE_FEELING_FIELD = 'cortex_delivery_feeling_snapshot';

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

function expectPrivateFeelingAbsent(value, canary) {
  expect(JSON.stringify(value)).not.toContain(PRIVATE_FEELING_FIELD);
  expect(JSON.stringify(value)).not.toContain(canary);
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

  it('redacts a legacy unaccepted cortex insight and its private delivery identity', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-private-receipt',
        conversationId: 'conversation-private-receipt',
        isCreatedByUser: false,
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            insight: 'PRIVATE_SYNTHETIC_UNACCEPTED_INSIGHT',
            cortex_delivery_acceptance: 'retryable',
            cortex_delivery_surface: 'web',
            cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_STREAM_ID',
            cortex_delivery_message_revision: 7,
            cortex_graph_result_hash: 'b'.repeat(64),
            cortex_delivery_feeling_snapshot: {
              capsule: 'PRIVATE_SYNTHETIC_CANARY',
              snapshotHash: 'a'.repeat(64),
            },
            cortex_delivery_acceptance_public: 'preserved-near-match',
          },
          {
            type: ContentTypes.CORTEX_INSIGHT,
            insight: 'Accepted insight remains visible.',
            cortex_delivery_acceptance: 'accepted',
          },
          {
            type: ContentTypes.CORTEX_INSIGHT,
            insight: 'Normal insight remains visible.',
          },
        ],
      },
    ]);

    const res = await request(createApp())
      .get('/api/messages/conversation-private-receipt')
      .expect(200);

    const [unaccepted, accepted, normal] = res.body[0].content;
    expect(unaccepted).not.toHaveProperty('insight');
    expect(unaccepted).not.toHaveProperty('cortex_delivery_acceptance');
    expect(unaccepted).not.toHaveProperty('cortex_delivery_surface');
    expect(unaccepted).not.toHaveProperty('cortex_delivery_stream_id');
    expect(unaccepted).not.toHaveProperty('cortex_delivery_message_revision');
    expect(unaccepted).not.toHaveProperty('cortex_graph_result_hash');
    expect(unaccepted).not.toHaveProperty('cortex_delivery_feeling_snapshot');
    expect(unaccepted.cortex_delivery_acceptance_public).toBe('preserved-near-match');
    expect(accepted.insight).toBe('Accepted insight remains visible.');
    expect(normal.insight).toBe('Normal insight remains visible.');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_UNACCEPTED_INSIGHT');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_STREAM_ID');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_CANARY');
  });

  it('keeps a migrated legacy insight visible without exposing private delivery identity', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-migrated-receipt',
        conversationId: 'conversation-migrated-receipt',
        isCreatedByUser: false,
        content: [
          {
            type: ContentTypes.CORTEX_INSIGHT,
            insight: 'Migrated insight remains visible.',
            cortex_delivery_acceptance: 'ledger',
            cortex_delivery_surface: 'web',
            cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_MIGRATED_STREAM_ID',
            cortex_delivery_message_revision: 8,
            cortex_graph_result_hash: 'd'.repeat(64),
            cortex_delivery_acceptance_public: 'preserved-near-match',
            cortex_delivery_stream_id_public: 'preserved-near-match',
          },
        ],
      },
    ]);

    const res = await request(createApp())
      .get('/api/messages/conversation-migrated-receipt')
      .expect(200);

    const migrated = res.body[0].content[0];
    expect(migrated.insight).toBe('Migrated insight remains visible.');
    expect(migrated).not.toHaveProperty('cortex_delivery_acceptance');
    expect(migrated).not.toHaveProperty('cortex_delivery_surface');
    expect(migrated).not.toHaveProperty('cortex_delivery_stream_id');
    expect(migrated).not.toHaveProperty('cortex_delivery_message_revision');
    expect(migrated).not.toHaveProperty('cortex_graph_result_hash');
    expect(migrated.cortex_delivery_acceptance_public).toBe('preserved-near-match');
    expect(migrated.cortex_delivery_stream_id_public).toBe('preserved-near-match');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_MIGRATED_STREAM_ID');
  });

  it('recursively removes private Feelings receipts from malformed GET content before export', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-nested-receipt',
        conversationId: 'conversation-nested-receipt',
        isCreatedByUser: false,
        content: [
          null,
          {
            type: ContentTypes.TEXT,
            text: 'Visible text.',
            metadata: {
              nested: [
                {
                  [PRIVATE_FEELING_FIELD]: {
                    capsule: 'PRIVATE_SYNTHETIC_NESTED_GET_CANARY',
                  },
                },
              ],
            },
          },
        ],
      },
      {
        messageId: 'assistant-non-array-receipt',
        conversationId: 'conversation-nested-receipt',
        isCreatedByUser: false,
        content: {
          type: ContentTypes.TEXT,
          text: 'Legacy malformed content.',
          envelope: {
            [PRIVATE_FEELING_FIELD]: {
              capsule: 'PRIVATE_SYNTHETIC_NON_ARRAY_GET_CANARY',
            },
          },
        },
      },
    ]);

    const res = await request(createApp())
      .get('/api/messages/conversation-nested-receipt')
      .expect(200);

    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_NESTED_GET_CANARY');
    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_NON_ARRAY_GET_CANARY');
    expect(res.body[0].content[0].text).toBe('Visible text.');
    expect(res.body[1].content.text).toBe('Legacy malformed content.');
  });

  it('removes dotted keys containing the exact private Feelings path segment from public output', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-dotted-private-receipt',
        conversationId: 'conversation-dotted-private-receipt',
        content: [
          {
            type: ContentTypes.TEXT,
            text: 'Visible dotted route text.',
            'metadata.cortex_delivery_feeling_snapshot': {
              capsule: 'PRIVATE_SYNTHETIC_DOTTED_ROUTE_CANARY',
            },
            'metadata.cortex_delivery_feeling_snapshot_public': 'preserved-near-match',
          },
        ],
      },
    ]);

    const res = await request(createApp())
      .get('/api/messages/conversation-dotted-private-receipt')
      .expect(200);

    expect(res.body[0].content[0]).not.toHaveProperty('metadata.cortex_delivery_feeling_snapshot');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_DOTTED_ROUTE_CANARY');
    expect(res.body[0].content[0].text).toBe('Visible dotted route text.');
    expect(res.body[0].content[0]['metadata.cortex_delivery_feeling_snapshot_public']).toBe(
      'preserved-near-match',
    );
  });

  it('recursively removes private Feelings receipts from search results', async () => {
    Message.meiliSearch.mockResolvedValue({
      hits: [
        {
          messageId: 'assistant-search-receipt',
          conversationId: 'conversation-search-receipt',
          content: [
            {
              type: ContentTypes.TEXT,
              text: 'Search-visible text.',
              exportEnvelope: {
                values: [
                  {
                    [PRIVATE_FEELING_FIELD]: {
                      capsule: 'PRIVATE_SYNTHETIC_SEARCH_EXPORT_CANARY',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    getConvosQueried.mockResolvedValue({
      convoMap: {
        'conversation-search-receipt': { title: 'Search result', model: 'model' },
      },
    });
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-search-receipt',
        isCreatedByUser: false,
        endpoint: 'agents',
      },
    ]);

    const res = await request(createApp()).get('/api/messages?search=visible').expect(200);

    expect(res.body.messages[0].content[0].text).toBe('Search-visible text.');
    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_SEARCH_EXPORT_CANARY');
  });

  it('recursively removes private Feelings receipts from POST mutation responses', async () => {
    const res = await request(createApp())
      .post('/api/messages/conversation-post-receipt')
      .send({
        messageId: 'assistant-post-receipt',
        conversationId: 'conversation-post-receipt',
        isCreatedByUser: false,
        content: {
          type: ContentTypes.TEXT,
          text: 'Visible POST text.',
          nested: [
            {
              [PRIVATE_FEELING_FIELD]: {
                capsule: 'PRIVATE_SYNTHETIC_POST_CANARY',
              },
            },
          ],
        },
      })
      .expect(201);

    expect(res.body.content.text).toBe('Visible POST text.');
    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_POST_CANARY');
    const persistedMessage = saveMessage.mock.calls[0][1];
    expectPrivateFeelingAbsent(persistedMessage, 'PRIVATE_SYNTHETIC_POST_CANARY');
    expect(persistedMessage.content.text).toBe('Visible POST text.');
  });

  it('recursively removes private Feelings receipts from PUT mutation responses', async () => {
    updateMessage.mockResolvedValue({
      messageId: 'assistant-put-receipt',
      conversationId: 'conversation-put-receipt',
      text: 'Updated text.',
      content: [
        {
          type: ContentTypes.TEXT,
          text: 'Updated text.',
          metadata: {
            [PRIVATE_FEELING_FIELD]: {
              capsule: 'PRIVATE_SYNTHETIC_PUT_CANARY',
            },
          },
        },
      ],
    });

    const res = await request(createApp())
      .put('/api/messages/conversation-put-receipt/assistant-put-receipt')
      .send({ text: 'Updated text.', model: 'model' })
      .expect(200);

    expect(res.body.text).toBe('Updated text.');
    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_PUT_CANARY');
  });

  it('edits an artifact by targeted path without rewriting pending legacy recovery content', async () => {
    getMessage.mockResolvedValue({
      messageId: 'assistant-artifact-receipt',
      conversationId: 'conversation-artifact-receipt',
      text: 'Original artifact.',
      content: [
        {
          type: ContentTypes.TEXT,
          text: 'Original artifact.',
        },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          insight: 'PRIVATE_SYNTHETIC_PENDING_ARTIFACT_INSIGHT',
          cortex_delivery_acceptance: 'retryable',
          cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_PENDING_ARTIFACT_STREAM',
          cortex_graph_result_hash: 'e'.repeat(64),
          [PRIVATE_FEELING_FIELD]: {
            capsule: 'PRIVATE_SYNTHETIC_ARTIFACT_CANARY',
          },
        },
      ],
    });
    findAllArtifacts.mockReturnValue([
      {
        source: 'content',
        partIndex: 0,
      },
    ]);
    replaceArtifactContent.mockReturnValue('Updated artifact.');
    updateMessage.mockResolvedValue({
      messageId: 'assistant-artifact-receipt',
      conversationId: 'conversation-artifact-receipt',
      text: 'Original artifact.',
      content: [
        { type: ContentTypes.TEXT, text: 'Updated artifact.' },
        {
          type: ContentTypes.CORTEX_INSIGHT,
          insight: 'PRIVATE_SYNTHETIC_PENDING_ARTIFACT_INSIGHT',
          cortex_delivery_acceptance: 'retryable',
          cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_PENDING_ARTIFACT_STREAM',
          cortex_graph_result_hash: 'e'.repeat(64),
          [PRIVATE_FEELING_FIELD]: {
            capsule: 'PRIVATE_SYNTHETIC_ARTIFACT_CANARY',
          },
        },
      ],
    });

    const res = await request(createApp())
      .post('/api/messages/artifact/assistant-artifact-receipt')
      .send({ index: 0, original: 'Original artifact.', updated: 'Updated artifact.' })
      .expect(200);

    expect(res.body.content[0].text).toBe('Updated artifact.');
    expectPrivateFeelingAbsent(res.body, 'PRIVATE_SYNTHETIC_ARTIFACT_CANARY');
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE_SYNTHETIC_PENDING_ARTIFACT_INSIGHT');
    expect(saveMessage).not.toHaveBeenCalled();
    expect(updateMessage).toHaveBeenCalledWith(
      expect.any(Object),
      {
        messageId: 'assistant-artifact-receipt',
        'content.0.text': 'Updated artifact.',
      },
      { context: 'POST /api/messages/artifact/:messageId' },
    );
  });

  it('updates indexed content by targeted path without rewriting pending legacy recovery content', async () => {
    getMessages.mockResolvedValue([
      {
        messageId: 'assistant-indexed-update',
        conversationId: 'conversation-indexed-update',
        tokenCount: 20,
        content: [
          { type: ContentTypes.TEXT, text: 'Original text.' },
          {
            type: ContentTypes.CORTEX_INSIGHT,
            insight: 'PRIVATE_SYNTHETIC_PENDING_INDEXED_INSIGHT',
            cortex_delivery_acceptance: 'retryable',
            cortex_delivery_stream_id: 'PRIVATE_SYNTHETIC_PENDING_INDEXED_STREAM',
            cortex_graph_result_hash: 'f'.repeat(64),
            [PRIVATE_FEELING_FIELD]: {
              capsule: 'PRIVATE_SYNTHETIC_INDEXED_UPDATE_CANARY',
            },
          },
        ],
      },
    ]);
    updateMessage.mockResolvedValue({
      messageId: 'assistant-indexed-update',
      conversationId: 'conversation-indexed-update',
      text: 'Updated text.',
    });

    await request(createApp())
      .put('/api/messages/conversation-indexed-update/assistant-indexed-update')
      .send({ text: 'Updated text.', index: 0, model: 'model' })
      .expect(200);

    const persistedUpdate = updateMessage.mock.calls[0][1];
    expectPrivateFeelingAbsent(persistedUpdate, 'PRIVATE_SYNTHETIC_INDEXED_UPDATE_CANARY');
    expect(persistedUpdate).toEqual({
      messageId: 'assistant-indexed-update',
      'content.0.text': 'Updated text.',
      tokenCount: expect.any(Number),
    });
    expect(persistedUpdate).not.toHaveProperty('content');
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
      content: duplicateToolCallContent().map((part, index) => ({
        ...part,
        agentId: 'agent-a',
        groupId: 1,
        ...(index === 1
          ? {
              metadata: {
                keep: 'public',
                [PRIVATE_FEELING_FIELD]: {
                  capsule: 'PRIVATE_SYNTHETIC_BRANCH_CANARY',
                },
              },
            }
          : {}),
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
    expectPrivateFeelingAbsent(saveMessage.mock.calls[0][1], 'PRIVATE_SYNTHETIC_BRANCH_CANARY');
    expect(saveMessage.mock.calls[0][1].content[0].metadata.keep).toBe('public');
  });
});
