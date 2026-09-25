const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const { Constants, EModelEndpoint } = require('librechat-data-provider');
const { formatAgentMessages } = require('~/app/clients/prompts/formatMessages');
const BaseClient = require('~/app/clients/BaseClient');
const {
  captureMainContextSnapshot,
  bindMainContextSnapshot,
} = require('../ViventiumMainContextService');
const { loadAcceptedMainContext } = require('../ViventiumMainContinuityService');

let mongo;
let Message;
let Conversation;
const owner = 'synthetic-owner';
const conversationId = 'synthetic-old-main';
const provider = 'glasshive-harness';
const model = 'codex-cli:gpt-5.6-sol';

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  Message = mongoose.models.Message;
  Conversation = mongoose.models.Conversation;
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Message.deleteMany({});
  await Conversation.deleteMany({});
  await Conversation.create({
    user: owner,
    conversationId,
    endpoint: 'agents',
    agent_id: 'main-agent',
    model,
  });
  await Message.create([
    {
      user: owner,
      conversationId,
      messageId: 'old-user',
      parentMessageId: '',
      sender: 'User',
      text: 'Keep the signed decision.',
      isCreatedByUser: true,
    },
    {
      user: owner,
      conversationId,
      messageId: 'old-answer',
      parentMessageId: 'old-user',
      sender: 'AI',
      text: 'Approval is still pending.',
      isCreatedByUser: false,
      unfinished: false,
    },
    {
      user: owner,
      conversationId,
      messageId: 'new-user',
      parentMessageId: 'old-answer',
      sender: 'User',
      text: 'What is the next step?',
      isCreatedByUser: true,
    },
  ]);
});

function agent() {
  return {
    id: 'main-agent',
    provider,
    model,
    instructions: 'Synthetic policy.',
    model_parameters: {
      model,
      configuration: {
        defaultHeaders: {
          'X-GlassHive-Stable-Authority-SHA256': 'a'.repeat(64),
        },
      },
    },
  };
}

async function storedBranch() {
  const rows = await Message.find({ user: owner, conversationId }).lean();
  const byId = new Map(rows.map((row) => [row.messageId, row]));
  const branch = [];
  let current = byId.get('new-user');
  while (current) {
    branch.unshift(current);
    current = byId.get(current.parentMessageId);
  }
  return branch;
}

async function captureReloaded({ prune = false } = {}) {
  const branch = await storedBranch();
  const formatted = formatAgentMessages(
    (prune ? branch.slice(1) : branch).map((row) => ({
      role: row.isCreatedByUser ? 'user' : 'assistant',
      content: row.text,
    })),
  );
  const target = agent();
  const snapshot = captureMainContextSnapshot(
    { user: { id: owner }, body: { conversationId } },
    {
      agent: target,
      visibleMessages: branch,
      messages: formatted,
      protectUnreconciledHistory: true,
      routeFacts: { primary: { provider, model } },
    },
  );
  bindMainContextSnapshot(target, snapshot);
  return { branch, snapshot, headers: target.model_parameters.configuration.defaultHeaders };
}

async function captureFromLoadedHistory() {
  const client = new BaseClient('synthetic');
  client.clientName = EModelEndpoint.agents;
  client.user = owner;
  client.addPreviousAttachments = async (messages) => messages;
  const prior = await client.loadHistory(conversationId, 'old-answer');
  const current = await Message.findOne({
    user: owner,
    conversationId,
    messageId: 'new-user',
  }).lean();
  const branch = [...prior, current];
  const formatted = formatAgentMessages(
    branch.map((row) => ({
      role: row.isCreatedByUser ? 'user' : 'assistant',
      content: row.text,
    })),
  );
  return captureMainContextSnapshot(
    { user: { id: owner }, body: { conversationId } },
    {
      agent: agent(),
      visibleMessages: branch,
      messages: formatted,
      historyAncestry: client._viventiumHistoryAncestryV1,
      protectUnreconciledHistory: client._viventiumHistoryAncestryV1.hasUnreconciledSource,
    },
  );
}

test('old Mongo history survives Core V1 capture and reload with same route and exact protected text', async () => {
  expect(
    await loadAcceptedMainContext({
      ownerId: owner,
      agentId: 'main-agent',
      stableAuthoritySha256: 'a'.repeat(64),
    }),
  ).toMatchObject({ status: 'empty' });
  const beforeRows = await Message.find({ user: owner, conversationId })
    .sort({ createdAt: 1 })
    .lean();
  const first = await captureReloaded();
  const after = await captureReloaded();
  const afterRows = await Message.find({ user: owner, conversationId })
    .sort({ createdAt: 1 })
    .lean();
  const chain = JSON.parse(
    Buffer.from(first.headers['X-Viventium-Visible-Message-Chain-B64'], 'base64'),
  );

  expect(first.snapshot.snapshotSha256).toBe(after.snapshot.snapshotSha256);
  expect(first.snapshot.routeFacts.primary).toMatchObject({ provider, model });
  expect(first.headers['X-Viventium-Main-Context-Owner']).toBe('core');
  expect(chain.map(({ id, accepted_source }) => [id, accepted_source === true])).toEqual([
    ['old-user', true],
    ['old-answer', true],
    ['new-user', false],
  ]);
  expect(afterRows).toEqual(beforeRows);
  expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toMatchObject({
    agent_id: 'main-agent',
    model,
  });
});

test('old source trimmed by context pruning stops before a Core V1 claim', async () => {
  await expect(captureReloaded({ prune: true })).rejects.toMatchObject({
    code: 'source_context_unavailable',
    status: 413,
  });
  expect(await Message.countDocuments({ user: owner, conversationId })).toBe(3);
});

test.each([
  ['missing root', async () => Message.deleteOne({ messageId: 'old-user' })],
  [
    'foreign-conversation root',
    async () =>
      Message.updateOne(
        { messageId: 'old-user' },
        { $set: { conversationId: 'other-conversation' } },
      ),
  ],
  [
    'cyclic root',
    async () =>
      Message.updateOne({ messageId: 'old-user' }, { $set: { parentMessageId: 'old-answer' } }),
  ],
  [
    'all ancestors absent',
    async () => Message.deleteMany({ messageId: { $in: ['old-user', 'old-answer'] } }),
  ],
])('%s stops before binding a shortened Core claim', async (_name, damage) => {
  await damage();
  await expect(captureFromLoadedHistory()).rejects.toMatchObject({
    code: 'source_context_unavailable',
    status: 413,
  });
});

test('a complete selected branch permits an explicit passive transcript skip', async () => {
  await Message.create({
    user: owner,
    conversationId,
    messageId: 'passive',
    parentMessageId: 'old-user',
    sender: 'User',
    text: 'Ambient transcript.',
    isCreatedByUser: true,
    metadata: { viventium: { type: 'listen_only_transcript', mode: 'listen_only' } },
  });
  await Message.updateOne({ messageId: 'old-answer' }, { $set: { parentMessageId: 'passive' } });
  const snapshot = await captureFromLoadedHistory();
  expect(snapshot.visibleMessageChain.map((item) => item.id)).toEqual([
    'old-user',
    'old-answer',
    'new-user',
  ]);
});

test('the selected old branch excludes a sibling answer without losing its ancestry', async () => {
  await Message.create({
    user: owner,
    conversationId,
    messageId: 'sibling-answer',
    parentMessageId: 'old-user',
    sender: 'AI',
    text: 'Different branch.',
    isCreatedByUser: false,
    unfinished: false,
  });
  const snapshot = await captureFromLoadedHistory();
  expect(snapshot.visibleMessageChain.map((item) => item.id)).toEqual([
    'old-user',
    'old-answer',
    'new-user',
  ]);
});

test('a new root conversation still binds Core V1 with an empty ancestry proof', async () => {
  await Message.deleteMany({});
  const client = new BaseClient('synthetic');
  client.clientName = EModelEndpoint.agents;
  client.user = owner;
  client.addPreviousAttachments = async (messages) => messages;
  expect(await client.loadHistory(conversationId, Constants.NO_PARENT)).toEqual([]);
  const fresh = {
    messageId: 'fresh-user',
    parentMessageId: Constants.NO_PARENT,
    isCreatedByUser: true,
    text: 'Start a new conversation.',
  };
  const snapshot = captureMainContextSnapshot(
    { user: { id: owner }, body: { conversationId } },
    {
      agent: agent(),
      visibleMessages: [fresh],
      messages: formatAgentMessages([{ role: 'user', content: fresh.text }]),
      historyAncestry: client._viventiumHistoryAncestryV1,
    },
  );
  expect(client._viventiumHistoryAncestryV1).toMatchObject({
    complete: true,
    hasUnreconciledSource: false,
    messageIds: [],
  });
  expect(snapshot.visibleMessageChain.map((item) => item.id)).toEqual(['fresh-user']);
});
