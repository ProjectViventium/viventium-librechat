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
  createConversationContinuityStore,
  planConversationContinuityClaim,
  resolveConversationContinuity,
  ensureConversationLegacyContinuity,
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
      messageId: message.messageId,
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
    require('@librechat/api').resetMainCompactionSchedulingForTests();
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

  test('current-carrier legacy claims pass their exact plan through review and completion', async () => {
    const rows = await seed(140),
      carried = carriedChain(rows),
      calls = [];
    const resolver = jest.fn(async (plan) => {
      expect(plan.coveredSource.length).toBeGreaterThan(0);
      expect(plan.throughMessageId).toBe(plan.coveredSource.at(-1).id);
      return { carrierMaxUtf8Bytes: 185108, reservedContextUtf8Bytes: 64042 };
    });
    const record = await ensureConversationLegacyContinuity({
      req: schedulerRequest(),
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carried,
      Model: Continuity,
      MessageModel: Message,
      executeCompactor: compactor(calls),
      resolveOutputCarrier: resolver,
      maxClaims: 1,
    });
    expect(record.status).toBe('ready');
    expect(calls.map((call) => call.stage || 'compaction')).toEqual(['compaction', 'review']);
    expect(calls[0].claim.outputContract).toMatchObject({
      consumer: 'conversation_legacy',
      carrierMaxUtf8Bytes: 185108,
      reservedUtf8Bytes: expect.any(Number),
    });
    expect(calls[0].claim.outputContract.maxJsonUtf8Bytes).toBeGreaterThan(67030);
    expect(resolver.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(resolver.mock.calls.map(([plan]) => plan.sourceDigest)).size).toBe(1);
    expect(await Message.countDocuments({ user: OWNER, conversationId: CONVERSATION })).toBe(
      rows.length,
    );
  });

  test('unavailable legacy peer allocation is typed degradation without provider or source loss', async () => {
    const rows = await seed(140),
      carried = carriedChain(rows),
      execute = jest.fn();
    let outcome;
    const compaction = {
      ensureAcceptedMainCompaction: async (input) => {
        outcome = await input.claimCompaction({});
        return outcome;
      },
    };
    const record = await ensureConversationLegacyContinuity({
      req: schedulerRequest(),
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carried,
      Model: Continuity,
      MessageModel: Message,
      executeCompactor: execute,
      resolveOutputCarrier: async () => null,
      foreground: false,
      compaction,
    });
    expect(outcome).toEqual({ status: 'degraded', reason: 'context_budget' });
    expect(execute).not.toHaveBeenCalled();
    expect(record).toBeNull();
    expect(await Continuity.countDocuments({ ownerId: OWNER, conversationId: CONVERSATION })).toBe(0);
    expect(await Message.countDocuments({ user: OWNER, conversationId: CONVERSATION })).toBe(
      rows.length,
    );
  });

  test('background native migration reloads each committed prefix and preserves original rows', async () => {
    const rows = legacyThread(200);
    for (const row of rows)
      if (!row.isCreatedByUser) row.text += ' Exact retained source.'.repeat(120);
    await Message.insertMany(rows);
    const carried = carriedChain(rows);
    const before = JSON.stringify(carried);
    const calls = [];
    const callLiveness = jest
      .spyOn(
        require('../server/services/viventium/CallSessionService'),
        'getActiveCallSessionForMainMaintenance',
      )
      .mockResolvedValue(null);
    try {
      const record = await ensureConversationLegacyContinuity({
        req: schedulerRequest(),
        agent: AGENT,
        ownerId: OWNER,
        conversationId: CONVERSATION,
        orderedMessages: carried,
        Model: Continuity,
        MessageModel: Message,
        foreground: false,
        executeCompactor: compactor(calls),
      });
      const generation = calls.filter((call) => call.stage !== 'review');
      expect(generation.length).toBeGreaterThan(1);
      expect(generation.length).toBeLessThanOrEqual(4);
      expect(generation[1].claim.previousSemanticCompaction).toEqual(
        expect.objectContaining({ summary: expect.any(String) }),
      );
      const sources = generation.map((call) =>
        call.claim.sourceTurns.map((turn) => turn.assistantMessageId),
      );
      expect(new Set(sources.flat()).size).toBe(sources.flat().length);
      expect(record.status).toBe('ready');
      const projected = projectConversationContinuity(record, carried);
      expect([...projected.coveredIds, ...projected.messages.map((row) => row.messageId)]).toEqual(
        carried.map((row) => row.messageId),
      );
      expect(JSON.stringify(carried)).toBe(before);
      expect(await Message.countDocuments({ user: OWNER, conversationId: CONVERSATION })).toBe(
        rows.length,
      );
    } finally {
      callLiveness.mockRestore();
    }
  });

  test('the actual legacy store renews the measured same-source correction inside the enclosing budget', async () => {
    const rows = await seed(140);
    const carried = carriedChain(rows);
    const plan = planConversationContinuityClaim({ record: null, orderedMessages: carried });
    const base = Date.now();
    let elapsedMs = 0;
    const store = createConversationContinuityStore({
      Model: Continuity,
      MessageModel: Message,
      now: () => new Date(base + elapsedMs),
    });
    const lease = await store.claim({
      ownerId: OWNER,
      conversationId: CONVERSATION,
      plan,
      leaseId: 'owned-correction-lease',
    });
    const calls = [];
    const renewCompaction = jest.fn((input) =>
      store.renew({ ...input, ownerId: OWNER, conversationId: CONVERSATION }),
    );
    const ordinary = compactor(calls);
    const result =
      await require('../server/services/viventium/ViventiumMainCompactionService').ensureAcceptedMainCompaction(
        {
          ownerId: OWNER,
          agentId: AGENT.id,
          stableAuthoritySha256: 'e'.repeat(64),
          agent: AGENT,
          deadlineAt: new Date(base + 600000),
          now: () => base + elapsedMs,
          executionBudget: { completionReserveMs: 200000 },
          claimCompaction: async () => ({
            status: 'claimed',
            domainEpochKey: 'owned-legacy-repair',
            leaseId: lease.leaseId,
            leaseExpiresAt: lease.expiresAt,
            sourceDigest: plan.sourceDigest,
            sourceBytes: plan.sourceBytes,
            sourceTurns: plan.sourceTurns,
            previousSemanticCompaction: plan.previousSemanticCompaction,
          }),
          renewCompaction,
          completeCompaction: (input) =>
            store.complete({
              ...input,
              ownerId: OWNER,
              conversationId: CONVERSATION,
              plan,
              review: input.semanticReview,
            }),
          rejectCompaction: (input) =>
            store.reject({ ...input, ownerId: OWNER, conversationId: CONVERSATION }),
          executeCompactor: async (call) => {
            const duration = call.stage === 'review' ? 15590 : 145780;
            expect(call.timeoutMs).toBeGreaterThanOrEqual(duration);
            expect(base + elapsedMs + call.timeoutMs).toBeLessThanOrEqual(
              call.claim.leaseExpiresAt.getTime(),
            );
            expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(400000);
            elapsedMs += duration;
            call.reportCapacityRelease(true);
            const value = await ordinary(call);
            return calls.length === 2 ? REVIEW_REJECTED : value;
          },
        },
      );
    expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
    expect(renewCompaction).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBe(322740);
    const record = await store.load(OWNER, CONVERSATION);
    expect(record.status).toBe('ready');
    expect(record.lease).toBeNull();
    expect(record.coveredSource).toEqual(plan.coveredSource);
    expect(record.semanticReview).toMatchObject({
      approved: true,
      sourceDigest: plan.sourceDigest,
    });
    expect(await Message.countDocuments({ user: OWNER, conversationId: CONVERSATION })).toBe(
      rows.length,
    );
  });

  test('legacy renewal never revives an expired or replaced holder and prevents a competing claim', async () => {
    const rows = await seed(140);
    const plan = planConversationContinuityClaim({
      record: null,
      orderedMessages: carriedChain(rows),
    });
    const base = Date.now();
    let elapsedMs = 0;
    const store = createConversationContinuityStore({
      Model: Continuity,
      MessageModel: Message,
      now: () => new Date(base + elapsedMs),
    });
    const lease = await store.claim({
      ownerId: OWNER,
      conversationId: CONVERSATION,
      plan,
      leaseId: 'live-legacy-lease',
    });
    elapsedMs = 161370;
    expect(typeof store.renew).toBe('function');
    const renewal = {
      ownerId: OWNER,
      conversationId: CONVERSATION,
      leaseId: lease.leaseId,
      sourceDigest: plan.sourceDigest,
      leaseExpiresAt: lease.expiresAt,
      expiresAt: new Date(base + 400000),
    };
    for (const invalid of [
      { ...renewal, ownerId: 'another-owner' },
      { ...renewal, leaseId: 'replaced-holder' },
      { ...renewal, sourceDigest: 'f'.repeat(64) },
      { ...renewal, leaseExpiresAt: new Date(base + 299999) },
    ])
      expect((await store.renew(invalid)).status).toBe('stale_lease');
    expect(await store.renew(renewal)).toEqual({
      status: 'renewed',
      leaseExpiresAt: new Date(base + 400000),
    });
    const renewed = await store.load(OWNER, CONVERSATION);
    expect(
      await store.claim({
        ownerId: OWNER,
        conversationId: CONVERSATION,
        plan: { ...plan, recordVersion: renewed.version },
        leaseId: 'competitor',
      }),
    ).toBeNull();
    expect((await store.renew(renewal)).status).toBe('stale_lease');
    await Continuity.updateOne(
      { ownerId: OWNER, conversationId: CONVERSATION },
      { $set: { 'lease.expiresAt': new Date(base - 1000) } },
    );
    // The caller still observes a live clock; the atomic server-time predicate rejects expiry.
    elapsedMs = -2000;
    expect(
      (
        await store.renew({
          ...renewal,
          leaseExpiresAt: new Date(base - 1000),
          expiresAt: new Date(base + 200000),
        })
      ).status,
    ).toBe('stale_lease');
    expect((await store.load(OWNER, CONVERSATION)).lease.expiresAt).toEqual(new Date(base - 1000));
  });

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

    const reconciled = withReconciledHistoryAncestry(
      proof,
      projection.coveredIds,
      projection.messages,
    );
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
    const record = await Continuity.findOne({
      ownerId: OWNER,
      conversationId: CONVERSATION,
    }).lean();
    expect(record).toMatchObject({ status: 'ready', throughMessageId: 'answer-91' });

    const edited = carried.map((message) =>
      message.messageId === 'answer-10'
        ? { ...message, text: 'Review 10: rate withdrawn.' }
        : message,
    );
    const projection = projectConversationContinuity(record, edited);
    expect(projection).toMatchObject({ stale: true, coveredIds: [] });
    expect(projection.messages).toBe(edited);
  });

  test.each([REVIEW_APPROVED, REVIEW_REJECTED])(
    're-reviews a prior empty-array text projection before reusing its summary (%s)',
    async (review) => {
      const rows = await seed(140);
      const savedText = 'JOB-742 needs owner approval. Keep 17 boxes and the corrected rate.';
      await Message.updateOne(
        { messageId: 'answer-10' },
        { $set: { text: savedText, content: [] } },
      );
      const stored = await Message.find({ user: OWNER, conversationId: CONVERSATION })
        .sort({ createdAt: 1 })
        .lean();
      const carried = carriedChain(stored);
      await resolve(schedulerRequest(), carried, []);
      const accepted = await Continuity.findOne({
        ownerId: OWNER,
        conversationId: CONVERSATION,
      }).lean();
      const hash = (value) =>
        require('crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
      // Reproduce the previous source projection's approved digest, only in this isolated fixture.
      const oldCovered = accepted.coveredSource.map((row) =>
        row.id === 'answer-10' ? { ...row, sha256: hash([row.id, 'assistant', '']) } : row,
      );
      await Continuity.updateOne(
        { ownerId: OWNER, conversationId: CONVERSATION },
        {
          $set: {
            coveredSource: oldCovered,
            coveredDigest: hash(oldCovered.map((row) => [row.id, row.sha256])),
          },
        },
      );
      const previous = await Continuity.findOne({
        ownerId: OWNER,
        conversationId: CONVERSATION,
      }).lean();
      expect(projectConversationContinuity(previous, carried)).toMatchObject({
        stale: true,
        coveredIds: [],
      });
      expect(
        planConversationContinuityClaim({ record: previous, orderedMessages: carried }),
      ).toMatchObject({ previousSemanticCompaction: null });
      const beforeRows = await Message.find({}).sort({ messageId: 1 }).lean();
      const calls = [];
      const recovered = await resolve(schedulerRequest(), carried, calls, review);
      expect(calls.some((call) => call.stage === 'review')).toBe(true);
      const source = evidence(calls.find((call) => !call.stage || call.stage === 'compaction'));
      expect(source.acceptedOlderTurns).toContainEqual(
        expect.objectContaining({
          assistantMessageId: 'answer-10',
          assistantText: savedText,
        }),
      );
      const current = await Continuity.findOne({
        ownerId: OWNER,
        conversationId: CONVERSATION,
      }).lean();
      expect(current.lease).toBeNull();
      if (review === REVIEW_APPROVED) {
        expect(recovered.coveredIds).toHaveLength(92);
        expect(projectConversationContinuity(current, carried)).toMatchObject({ stale: false });
        expect(current.coveredSource.find((row) => row.id === 'answer-10').sha256).toBe(
          hash(['answer-10', 'assistant', savedText]),
        );
        const reloadedCalls = [];
        expect((await resolve(schedulerRequest(), carried, reloadedCalls)).coveredIds).toEqual(
          recovered.coveredIds,
        );
        expect(reloadedCalls).toHaveLength(0);
      } else {
        expect(recovered).toBeNull();
        expect(current).toMatchObject({
          status: 'ready',
          coveredSource: previous.coveredSource,
          coveredDigest: previous.coveredDigest,
          semanticReview: previous.semanticReview,
        });
        expect(current.lastError).toBeTruthy();
        expect(projectConversationContinuity(current, carried)).toMatchObject({
          stale: true,
          coveredIds: [],
        });
      }
      expect(await Message.find({}).sort({ messageId: 1 }).lean()).toEqual(beforeRows);
    },
  );

  test('an unapproved summary is never used and the turn still fails typed', async () => {
    const rows = await seed(140);
    const req = schedulerRequest();
    const carried = carriedChain(rows);
    const calls = [];

    const projection = await resolve(req, carried, calls, REVIEW_REJECTED);

    expect(calls.filter((call) => call.stage === 'review').length).toBeGreaterThan(0);
    expect(projection).toBeNull();
    const record = await Continuity.findOne({
      ownerId: OWNER,
      conversationId: CONVERSATION,
    }).lean();
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

  test('the same wake advances a reviewed smaller whole-turn prefix after an oversized claim', async () => {
    const rows = await seed(140);
    const carried = carriedChain(rows);
    const before = await Message.find({}).sort({ messageId: 1 }).lean();
    const calls = [];
    const fitting = compactor(calls);
    let generations = 0;
    const projection = await resolveConversationContinuity({
      req: schedulerRequest(),
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carried,
      Model: Continuity,
      MessageModel: Message,
      executeCompactor: async (call) => {
        if (call.stage !== 'review' && generations++ < 1) {
          calls.push(call);
          return JSON.stringify({
            version: 1,
            summary: 's'.repeat(20000),
            pendingAsks: [],
            commitments: [],
            corrections: [],
            decisions: [],
            durableIdentifiers: [],
            recurrenceOutcomes: [],
            toolPairs: [],
          });
        }
        return fitting(call);
      },
    });
    expect(calls.map((call) => call.stage || 'compaction')).toEqual([
      'compaction',
      'compaction',
      'review',
    ]);
    const first = calls[0].claim;
    const smaller = calls[1].claim;
    expect(smaller.sourceBytes).toBeLessThan(first.sourceBytes);
    expect(smaller.sourceDigest).not.toBe(first.sourceDigest);
    expect(smaller.sourceTurns.length).toBeLessThan(first.sourceTurns.length);
    expect(projection.coveredIds.length).toBeGreaterThan(0);
    expect(projection.messages.at(-1).messageId).toBe('current-prompt');
    expect(await Message.find({}).sort({ messageId: 1 }).lean()).toEqual(before);
    const record = await Continuity.findOne({
      ownerId: OWNER,
      conversationId: CONVERSATION,
    }).lean();
    expect(record.semanticReview).toMatchObject({ approved: true });
    expect(record.lease).toBeNull();
  });

  test.each(['unchanged source', 'transport failure'])(
    '%s ends the wake without another claim',
    async (kind) => {
      const rows = await seed(140);
      const carried = carriedChain(rows);
      const requests = [];
      const compaction = {
        ensureAcceptedMainCompaction: async (input) => {
          const claim = await input.claimCompaction({});
          requests.push(claim);
          await input.rejectCompaction({ leaseId: claim.leaseId, reason: 'unaccepted' });
          return {
            status: 'degraded',
            reason: 'unaccepted',
            ...(kind === 'unchanged source' ? { nextSourceTargetBytes: claim.sourceBytes } : {}),
          };
        },
      };
      const record = await ensureConversationLegacyContinuity({
        req: schedulerRequest(),
        agent: AGENT,
        ownerId: OWNER,
        conversationId: CONVERSATION,
        orderedMessages: carried,
        Model: Continuity,
        MessageModel: Message,
        compaction,
      });
      expect(requests).toHaveLength(1);
      expect(record.coveredSource).toEqual([]);
      expect(record.lease).toBeNull();
    },
  );

  test('the owning turn cancellation signal prevents a smaller follow-on claim', async () => {
    const rows = await seed(140);
    const controller = new AbortController();
    const requests = [];
    const compaction = {
      ensureAcceptedMainCompaction: async (input) => {
        expect(input.signal).toBe(controller.signal);
        const claim = await input.claimCompaction({});
        requests.push(claim);
        await input.rejectCompaction({ leaseId: claim.leaseId, reason: 'unaccepted' });
        controller.abort();
        return {
          status: 'degraded',
          reason: 'unaccepted',
          nextSourceTargetBytes: Math.floor(claim.sourceBytes / 2),
        };
      },
    };
    await ensureConversationLegacyContinuity({
      req: schedulerRequest(),
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carriedChain(rows),
      Model: Continuity,
      MessageModel: Message,
      compaction,
      signal: controller.signal,
    });
    expect(requests).toHaveLength(1);
  });

  test('smaller unaccepted claims stop at the existing six-claim bound', async () => {
    const rows = await seed(1000);
    const requests = [];
    const compaction = {
      ensureAcceptedMainCompaction: async (input) => {
        const claim = await input.claimCompaction({});
        requests.push(claim);
        await input.rejectCompaction({ leaseId: claim.leaseId, reason: 'unaccepted' });
        return {
          status: 'degraded',
          reason: 'unaccepted',
          nextSourceTargetBytes: Math.floor(claim.sourceBytes / 2),
        };
      },
    };
    await ensureConversationLegacyContinuity({
      req: schedulerRequest(),
      agent: AGENT,
      ownerId: OWNER,
      conversationId: CONVERSATION,
      orderedMessages: carriedChain(rows),
      Model: Continuity,
      MessageModel: Message,
      compaction,
    });
    expect(requests).toHaveLength(6);
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index].sourceBytes).toBeLessThan(requests[index - 1].sourceBytes);
      expect(requests[index].sourceDigest).not.toBe(requests[index - 1].sourceDigest);
    }
  });

  test('short or fully stamped histories are carried as they are, without a lookup', async () => {
    const rows = await seed(10);
    const projection = await resolve(schedulerRequest(), carriedChain(rows), []);
    expect(projection).toBeNull();
    expect(await Continuity.countDocuments({})).toBe(0);
  });
});
