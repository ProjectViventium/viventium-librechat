/* === VIVENTIUM START ===
 * Feature: Scheduling is Main later.
 * Purpose: A trusted scheduler wake omits scheduler transport rows, carries every visible prior
 * answer to Main under the protected-history guard, and fails typed when that source cannot be
 * carried. Interactive turns keep their existing behavior.
 * === VIVENTIUM END === */
const { EModelEndpoint } = require('librechat-data-provider');
const mockGetMessages = jest.fn();
jest.mock('~/models', () => ({ getMessages: (...args) => mockGetMessages(...args) }));
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
  isTrustedSchedulerWake,
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
 * loaded chain, omitting scheduler transport rows by type on a trusted wake (client.js).
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
  const trusted = isTrustedSchedulerWake(req);
  return BaseClient.getMessagesForConversation({
    messages: [...history, current],
    parentMessageId: current.messageId,
    skipCondition: (message) => trusted && isSchedulerTransportRow(message),
  });
}

function admit(req, instance, carried) {
  return captureMainContextSnapshot(req, {
    agent: { id: 'agent' },
    messages: carried.map((message) => ({
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
  ['a body that only claims scheduler origin', { viventiumOrigin: 'scheduler', viventiumActorKind: 'system' }],
])('%s on a scheduled thread keeps its existing history and guard', async (_label, body) => {
  mockGetMessages.mockResolvedValue(legacyScheduledThread(10));
  const req = { user: { id: OWNER }, body: { conversationId: CONVERSATION, ...body } };
  const instance = client(req);

  const history = await instance.loadHistory(CONVERSATION, 'hidden-9');
  const carried = carriedToMain(req, history, 'hidden-9');

  expect(history).toHaveLength(30);
  expect(carried).toHaveLength(31);
  expect(() => admit(req, instance, carried)).toThrow(
    expect.objectContaining({ code: 'source_context_unavailable', status: 413 }),
  );
});
