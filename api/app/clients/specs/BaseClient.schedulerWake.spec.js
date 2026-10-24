/* === VIVENTIUM START ===
 * Feature: Scheduling is Main later.
 * Purpose: A trusted scheduler wake omits scheduler transport rows, carries every visible prior
 * answer to Main under the protected-history guard on every later surface, and fails typed when
 * that visible source cannot be carried.
 * === VIVENTIUM END === */
const { EModelEndpoint } = require('librechat-data-provider');
const mockGetMessages = jest.fn();
jest.mock('~/models', () => ({
  getMessages: (...args) => mockGetMessages(...args),
  getConvo: async () => ({ conversationId: CONVERSATION, endpoint: 'agents' }),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/models/balanceMethods', () => ({ checkBalance: jest.fn() }));
const BaseClient = require('../BaseClient');
const {
  createSchedulerInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');
const {
  captureMainContextSnapshot,
  isSchedulerTransportRow,
} = require('~/server/services/viventium/ViventiumMainContextService');

const OWNER = 'owner-scheduled';
const CONVERSATION = 'conversation-scheduled';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const PROMPT = 'Run the daily review.';

/** Legacy wakes: a trusted scheduler envelope, an unstamped visible answer and a hidden {NTA}. */
function legacyScheduledThread(count) {
  const rows = [];
  let parent = NO_PARENT;
  for (let index = 0; index < count; index += 1) {
    const envelope = `prompt-${index}`;
    const answer = `answer-${index}`;
    const hidden = `hidden-${index}`;
    rows.push(
      {
        user: OWNER,
        conversationId: CONVERSATION,
        messageId: envelope,
        parentMessageId: parent,
        isCreatedByUser: true,
        text: PROMPT,
        metadata: {
          viventium: {
            visibility: 'internal',
            interactionContext: { actor_kind: 'system', origin: 'scheduler', surface: 'workbench' },
          },
        },
      },
      {
        user: OWNER,
        conversationId: CONVERSATION,
        messageId: answer,
        parentMessageId: envelope,
        isCreatedByUser: false,
        text: `Review ${index}: printer rate is ${index + 3} per booklet.`,
        content: [
          { type: 'text', text: `Review ${index}: printer rate is ${index + 3} per booklet.` },
        ],
      },
      {
        user: OWNER,
        conversationId: CONVERSATION,
        messageId: hidden,
        parentMessageId: answer,
        isCreatedByUser: false,
        text: '{NTA}',
        content: [{ type: 'text', text: '{NTA}' }],
        metadata: { viventium: { visibility: 'internal' } },
      },
    );
    parent = hidden;
  }
  return rows;
}

function schedulerRequest() {
  const req = { user: { id: OWNER }, body: { conversationId: CONVERSATION } };
  setTrustedInteractionContext(
    req,
    createSchedulerInteractionContext({
      conversation_id: CONVERSATION,
      source_event_id: 'scheduler-stream',
      schedule_id: 'schedule-daily-review',
      schedule_run_id: 'run-next',
    }),
    { segment_stability: 'immediate', supersede_scope: 'response_only' },
    { commit_authority: 'server' },
  );
  return req;
}

function client(req) {
  const instance = new BaseClient('synthetic');
  instance.clientName = EModelEndpoint.agents;
  instance.user = OWNER;
  instance.options = { req, resendFiles: false };
  return instance;
}

/**
 * What Main actually receives: the agent message builder walks from the current input through the
 * loaded chain, omitting scheduler transport rows by their retained type (client.js).
 */
function carriedToMain(req, history, parentMessageId) {
  const current = {
    user: OWNER,
    conversationId: CONVERSATION,
    messageId: 'current-prompt',
    parentMessageId,
    isCreatedByUser: true,
    role: 'user',
    text: PROMPT,
  };
  return BaseClient.getMessagesForConversation({
    messages: [...history, current],
    parentMessageId: current.messageId,
    skipCondition: isSchedulerTransportRow,
  });
}

function admit(req, instance, carried) {
  return captureMainContextSnapshot(req, {
    agent: { id: 'agent' },
    messages: carried.map((message) => ({
      messageId: message.messageId,
      role: message.isCreatedByUser ? 'user' : 'assistant',
      content: message.text,
    })),
    visibleMessages: carried,
    historyAncestry: instance._viventiumHistoryAncestryV1,
    protectUnreconciledHistory: instance._viventiumHistoryAncestryV1?.hasUnreconciledSource,
  });
}

beforeEach(() => {
  mockGetMessages.mockReset();
});

test('an automatic parent at a scheduler envelope preserves every visible ancestor without its live draft', async () => {
  const envelope = {
    user: OWNER,
    conversationId: CONVERSATION,
    messageId: 'next-envelope',
    parentMessageId: 'hidden-1',
    isCreatedByUser: true,
    createdAt: '2026-03-26T20:00:00.000Z',
    text: 'Private scheduler transport.',
    metadata: {
      viventium: {
        visibility: 'internal',
        interactionContext: { actor_kind: 'system', origin: 'scheduler', surface: 'workbench' },
      },
    },
  };
  mockGetMessages.mockResolvedValue([
    ...legacyScheduledThread(2),
    envelope,
    {
      user: OWNER,
      conversationId: CONVERSATION,
      messageId: 'live-draft',
      parentMessageId: envelope.messageId,
      isCreatedByUser: false,
      unfinished: true,
      createdAt: '2026-03-26T20:00:01.000Z',
      text: '',
    },
  ]);
  const {
    resolveReusableConversationState,
  } = require('~/server/services/viventium/conversationThreading');
  const selected = await resolveReusableConversationState({
    conversationId: CONVERSATION,
    userId: OWNER,
    surface: 'telegram',
  });
  expect(selected.parentMessageId).toBe(envelope.messageId);
  expect(selected.messages).toHaveLength(8);
  const req = { user: { id: OWNER }, body: { conversationId: CONVERSATION } };
  const instance = client(req);
  const history = await instance.loadHistory(CONVERSATION, selected.parentMessageId);
  const carried = carriedToMain(req, history, selected.parentMessageId);
  expect(carried.map((row) => row.messageId)).toEqual(['answer-0', 'answer-1', 'current-prompt']);
  expect(instance._viventiumHistoryAncestryV1).toMatchObject({ complete: true });
  expect(instance._viventiumHistoryAncestryV1.skippedMessageIds).toContain(envelope.messageId);
  expect(admit(req, instance, carried).visibleMessageChain.map((row) => row.id)).toEqual([
    'answer-0',
    'answer-1',
    'current-prompt',
  ]);
});

test('a trusted scheduler wake carries every prior answer and omits only transport rows', async () => {
  mockGetMessages.mockResolvedValue(legacyScheduledThread(10));
  const req = schedulerRequest();
  const instance = client(req);

  const history = await instance.loadHistory(CONVERSATION, 'hidden-9');
  const carried = carriedToMain(req, history, 'hidden-9');

  // The facts from every visible prior answer reach Main; envelopes and {NTA} rows do not.
  expect(carried.map((message) => message.messageId)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `answer-${index}`),
    'current-prompt',
  ]);
  expect(carried.map((message) => message.text)).toContain(
    'Review 9: printer rate is 12 per booklet.',
  );
  expect(instance._viventiumHistoryAncestryV1).toMatchObject({ complete: true });
  expect(instance._viventiumHistoryAncestryV1.skippedMessageIds).toHaveLength(20);
  const snapshot = admit(req, instance, carried);
  expect(snapshot.visibleMessageChain).toHaveLength(11);
  expect(snapshot.visibleMessageChain.at(-1)).toMatchObject({ id: 'current-prompt', role: 'user' });
});

test('a trusted scheduler wake fails typed instead of dropping uncovered legacy answers', async () => {
  mockGetMessages.mockResolvedValue(legacyScheduledThread(140));
  const req = schedulerRequest();
  const instance = client(req);

  const history = await instance.loadHistory(CONVERSATION, 'hidden-139');
  const carried = carriedToMain(req, history, 'hidden-139');

  expect(carried).toHaveLength(141);
  expect(() => admit(req, instance, carried)).toThrow(
    expect.objectContaining({ code: 'source_context_unavailable', status: 413 }),
  );
});

test('the first scheduled occurrence has no prior source and is admitted', async () => {
  mockGetMessages.mockResolvedValue([]);
  const req = schedulerRequest();
  const instance = client(req);

  const history = await instance.loadHistory(CONVERSATION, NO_PARENT);

  expect(history).toEqual([]);
});

test.each([
  ['an interactive turn', {}],
  [
    'a body that only claims scheduler origin',
    { viventiumOrigin: 'scheduler', viventiumActorKind: 'system' },
  ],
])('%s carries all visible scheduled answers through the protected guard', async (_label, body) => {
  mockGetMessages.mockResolvedValue(legacyScheduledThread(10));
  const req = { user: { id: OWNER }, body: { conversationId: CONVERSATION, ...body } };
  const instance = client(req);

  const history = await instance.loadHistory(CONVERSATION, 'hidden-9');
  const carried = carriedToMain(req, history, 'hidden-9');

  expect(history).toHaveLength(30);
  expect(carried.map((message) => message.messageId)).toEqual([
    ...Array.from({ length: 10 }, (_, index) => `answer-${index}`),
    'current-prompt',
  ]);
  expect(instance._viventiumHistoryAncestryV1.skippedMessageIds).toHaveLength(20);
  expect(admit(req, instance, carried).visibleMessageChain).toHaveLength(11);
});

test.each([
  ['foreign origin', { actor_kind: 'system', origin: 'interactive' }],
  ['foreign actor', { actor_kind: 'external_user', origin: 'scheduler' }],
  ['untyped input', {}],
])('an internal input with %s remains protected source', async (_label, interactionContext) => {
  const rows = legacyScheduledThread(1);
  rows[0].metadata.viventium.interactionContext = interactionContext;
  mockGetMessages.mockResolvedValue(rows);
  const req = { user: { id: OWNER }, body: { conversationId: CONVERSATION } };
  const instance = client(req);
  const history = await instance.loadHistory(CONVERSATION, 'hidden-0');
  const carried = carriedToMain(req, history, 'hidden-0');
  expect(carried.map((message) => message.messageId)).toEqual([
    'prompt-0',
    'answer-0',
    'current-prompt',
  ]);
  expect(instance._viventiumHistoryAncestryV1.skippedMessageIds).toEqual(['hidden-0']);
  expect(() => admit(req, instance, carried)).toThrow(
    expect.objectContaining({ code: 'source_context_unavailable', status: 413 }),
  );
});
