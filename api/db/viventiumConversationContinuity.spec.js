/* === VIVENTIUM START ===
 * Feature: Conversation legacy continuity (real Mongo, real compaction runner).
 * Purpose: A long legacy scheduled thread that the protected carrier cannot hold intact is carried
 * as an exact reviewed summary of its oldest turns plus its newer answers intact. The summary is
 * bound to the covered rows, a changed row invalidates it, and an unreviewed summary is never
 * used: the turn then still fails typed.
 * === VIVENTIUM END === */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { createModels } = require('@librechat/data-schemas');
const createViventiumConversationContinuity = require('./viventiumConversationContinuity');
const { resetPromptRegistryForTests } = require('../server/services/viventium/promptRegistry');
const {
  captureMainContextSnapshot,
  isSchedulerTransportRow,
  traceMainHistoryAncestry,
  withReconciledHistoryAncestry,
} = require('../server/services/viventium/ViventiumMainContextService');
const {
  createSchedulerInteractionContext,
  setTrustedInteractionContext,
} = require('../server/services/viventium/interactionContext');
const {
  projectConversationContinuity,
  resolveConversationContinuity,
} = require('../server/services/viventium/ViventiumConversationContinuityService');

const OWNER = 'owner-legacy-thread';
const CONVERSATION = 'conversation-legacy-thread';
const NO_PARENT = '00000000-0000-0000-0000-000000000000';
const ENVELOPE_TEXT = 'Run the private daily review.';
const AGENT = { id: 'main-agent', provider: 'openAI', model: 'synthetic-main' };
const REVIEW_APPROVED = JSON.stringify({ approved: true, reason: 'Faithful test fixture.' });
const REVIEW_REJECTED = JSON.stringify({ approved: false, reason: 'Drops the latest rate.' });

function legacyThread(count) {
  const rows = [];
  let parent = NO_PARENT;
  const at = (index, offset) => new Date(Date.UTC(2026, 7, 11) + index * 60_000 + offset);
  for (let index = 0; index < count; index += 1) {
    rows.push(
      {
        user: OWNER,
        conversationId: CONVERSATION,
        messageId: `envelope-${index}`,
        parentMessageId: parent,
        isCreatedByUser: true,
        text: ENVELOPE_TEXT,
        createdAt: at(index, 0),
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
        messageId: `answer-${index}`,
        parentMessageId: `envelope-${index}`,
        isCreatedByUser: false,
        text: `Review ${index}: printer rate is ${index + 3} per booklet.`,
        createdAt: at(index, 1),
      },
      {
        user: OWNER,
        conversationId: CONVERSATION,
        messageId: `hidden-${index}`,
        parentMessageId: `answer-${index}`,
        isCreatedByUser: false,
        text: '{NTA}',
        createdAt: at(index, 2),
        metadata: { viventium: { visibility: 'internal' } },
      },
    );
    parent = `hidden-${index}`;
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

/** The trusted wake's carried chain: visible answers, then the current scheduled prompt. */
function carriedChain(rows) {
  const answers = rows.filter((row) => !isSchedulerTransportRow(row));
  const current = {
    user: OWNER,
    conversationId: CONVERSATION,
    messageId: 'current-prompt',
    parentMessageId: rows.at(-1).messageId,
    isCreatedByUser: true,
    text: ENVELOPE_TEXT,
  };
  return [...answers, current];
}

function compactor(calls, review = REVIEW_APPROVED) {
  return async (call) => {
    calls.push(call);
    if (call.stage === 'review') return review;
    return JSON.stringify({
      version: 1,
      summary: 'Scheduled reviews tracked the per-booklet printer rate, rising by one each run.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: ['The latest covered review set the printer rate at 94 per booklet.'],
      durableIdentifiers: ['schedule-daily-review'],
      recurrenceOutcomes: ['Each covered review completed with an updated rate.'],
      toolPairs: [],
    });
  };
}

function evidence(call) {
  return JSON.parse(
    call.prompt
      .split('<untrusted_conversation_data_v1>')[1]
      .split('</untrusted_conversation_data_v1>')[0],
  );
}

function admit(req, carried, proof) {
  return captureMainContextSnapshot(req, {
    agent: AGENT,
    messages: carried.map((message) => ({
      role: message.isCreatedByUser ? 'user' : 'assistant',
      content: message.text,
    })),
    visibleMessages: carried,
    historyAncestry: proof,
    protectUnreconciledHistory: proof?.hasUnreconciledSource === true || carried.length > 1,
  });
}

describe('Conversation legacy continuity', () => {
  let server;
  let database;
  let Message;
  let Continuity;
  let promptDirectory;
  let previousBundle;

  beforeAll(async () => {
    previousBundle = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-continuity-prompts-'));
    const prompts = {};
    for (const name of ['continuity_compaction', 'continuity_compaction_review']) {
      const text = fs.readFileSync(
        path.resolve(__dirname, '../../viventium/source_of_truth/prompts/main', `${name}.md`),
        'utf8',
      );
      const [, frontmatter, body] = text.split('---\n');
      const metadata = yaml.load(frontmatter);
      prompts[metadata.id] = { metadata, body };
    }
    process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = path.join(promptDirectory, 'bundle.json');
    fs.writeFileSync(process.env.VIVENTIUM_PROMPT_BUNDLE_PATH, JSON.stringify({ prompts }));
    resetPromptRegistryForTests();
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Message = createModels(database).Message;
    Continuity = createViventiumConversationContinuity(database);
    await Promise.all([Message.syncIndexes(), Continuity.syncIndexes()]);
  });

  afterAll(async () => {
    await database?.disconnect();
    await server?.stop();
    if (previousBundle === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previousBundle;
    resetPromptRegistryForTests();
    fs.rmSync(promptDirectory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await Promise.all([Message.collection.deleteMany({}), Continuity.collection.deleteMany({})]);
  });

  async function seed(count) {
    const rows = legacyThread(count);
    await Message.insertMany(rows);
    return rows;
  }

  function resolve(req, carried, calls, review) {
    return resolveConversationContinuity({
      req,
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carried,
      Model: Continuity,
      MessageModel: Message,
      executeCompactor: compactor(calls, review),
    });
  }

  test('a 140-occurrence legacy thread is admitted as a reviewed summary plus its intact newer answers', async () => {
    const rows = await seed(140);
    const req = schedulerRequest();
    const carried = carriedChain(rows);
    const proof = traceMainHistoryAncestry({
      messages: rows,
      headId: rows.at(-1).messageId,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      isSkippable: isSchedulerTransportRow,
    });
    // Without reconciliation the protected carrier cannot hold this history: typed, not silent.
    expect(() => admit(schedulerRequest(), carried, proof)).toThrow(
      expect.objectContaining({ code: 'source_context_unavailable', status: 413 }),
    );

    const calls = [];
    const projection = await resolve(req, carried, calls);

    // The runner generated and reviewed one claim over the oldest 92 answers.
    expect(calls.map((call) => call.stage || 'compaction')).toEqual(['compaction', 'review']);
    const payload = evidence(calls[0]);
    expect(payload.acceptedOlderTurns).toHaveLength(92);
    expect(payload.acceptedOlderTurns[91]).toMatchObject({
      assistantMessageId: 'answer-91',
      assistantText: 'Review 91: printer rate is 94 per booklet.',
      userText: '',
    });
    expect(JSON.stringify(payload)).not.toContain(ENVELOPE_TEXT);

    expect(projection.coveredIds).toHaveLength(92);
    expect(projection.messages.map((message) => message.messageId)).toEqual([
      ...Array.from({ length: 48 }, (_, index) => `answer-${index + 92}`),
      'current-prompt',
    ]);
    expect(projection.capsule).toContain('reviewed summary of the 92 oldest visible messages');
    expect(projection.capsule).toContain('94 per booklet');

    const reconciled = withReconciledHistoryAncestry(proof, projection.coveredIds, projection.messages);
    const snapshot = admit(req, projection.messages, reconciled);
    expect(snapshot.visibleMessageChain).toHaveLength(49);
    expect(snapshot.visibleMessageChain.at(-1)).toMatchObject({ id: 'current-prompt' });

    // A later turn reuses the same exact summary without another model call.
    const again = [];
    const reused = await resolve(schedulerRequest(), carried, again);
    expect(again).toHaveLength(0);
    expect(reused.coveredIds).toEqual(projection.coveredIds);
  });

  test('a changed covered answer invalidates the summary instead of reusing it', async () => {
    const rows = await seed(140);
    const carried = carriedChain(rows);
    await resolve(schedulerRequest(), carried, []);
    const record = await Continuity.findOne({ ownerId: OWNER, conversationId: CONVERSATION }).lean();
    expect(record).toMatchObject({ status: 'ready', throughMessageId: 'answer-91' });

    const edited = carried.map((message) =>
      message.messageId === 'answer-10' ? { ...message, text: 'Review 10: rate withdrawn.' } : message,
    );
    const projection = projectConversationContinuity(record, edited);
    expect(projection).toMatchObject({ stale: true, coveredIds: [] });
    expect(projection.messages).toBe(edited);
  });

  test('an unapproved summary is never used and the turn still fails typed', async () => {
    const rows = await seed(140);
    const req = schedulerRequest();
    const carried = carriedChain(rows);
    const calls = [];

    const projection = await resolve(req, carried, calls, REVIEW_REJECTED);

    expect(calls.filter((call) => call.stage === 'review').length).toBeGreaterThan(0);
    expect(projection).toBeNull();
    const record = await Continuity.findOne({ ownerId: OWNER, conversationId: CONVERSATION }).lean();
    expect(record).toMatchObject({ status: 'degraded' });
    const proof = traceMainHistoryAncestry({
      messages: rows,
      headId: rows.at(-1).messageId,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      isSkippable: isSchedulerTransportRow,
    });
    expect(() => admit(req, carried, proof)).toThrow(
      expect.objectContaining({ code: 'source_context_unavailable', status: 413 }),
    );
  });

  test('short or fully stamped histories are carried as they are, without a lookup', async () => {
    const rows = await seed(10);
    const projection = await resolve(schedulerRequest(), carriedChain(rows), []);
    expect(projection).toBeNull();
    expect(await Continuity.countDocuments({})).toBe(0);
  });
});
