'use strict';
jest.mock('../ViventiumMainContinuityService', () => require('./fixtures/mainContinuity')());
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { resetPromptRegistryForTests } = require('../promptRegistry');
const reviewApproved = JSON.stringify({ approved: true, reason: 'Faithful test fixture.' });
let promptDirectory;
let previousBundle;
beforeAll(() => {
  previousBundle = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-prompts-'));
  const prompts = {};
  for (const name of ['continuity_compaction', 'continuity_compaction_review']) {
    const text = fs.readFileSync(
      path.resolve(
        __dirname,
        '../../../../../viventium/source_of_truth/prompts/main',
        `${name}.md`,
      ),
      'utf8',
    );
    const [, frontmatter, body] = text.split('---\n');
    const metadata = yaml.load(frontmatter);
    prompts[metadata.id] = { metadata, body };
  }
  process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = path.join(promptDirectory, 'bundle.json');
  fs.writeFileSync(process.env.VIVENTIUM_PROMPT_BUNDLE_PATH, JSON.stringify({ prompts }));
  resetPromptRegistryForTests();
});
afterAll(() => {
  if (previousBundle === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previousBundle;
  resetPromptRegistryForTests();
  fs.rmSync(promptDirectory, { recursive: true, force: true });
});

const {
  commitAcceptedMainTurn,
  loadAcceptedMainContext,
  setMainContinuityPersistenceForTests,
} = require('../ViventiumMainContinuityService');
const {
  acquireInteractiveMainAdmissionFence,
  buildCompactionPrompt,
  compactorAgent,
  ensureAcceptedMainCompaction,
  loadAcceptedMainContextForAdmission,
  parseSemanticCompactionOutput,
  yieldAcceptedMainCompaction,
} = require('../ViventiumMainCompactionService');

function inMemoryPersistence() {
  const states = new Map();
  return {
    async read(key) {
      const value = states.get(key);
      return value ? structuredClone(value) : null;
    },
    async create(state) {
      if (states.has(state.domainEpochKey)) return false;
      states.set(state.domainEpochKey, structuredClone(state));
      return true;
    },
    async compareAndSwap(key, version, state) {
      const current = states.get(key);
      if (!current || current.version !== version) return false;
      states.set(key, structuredClone({ ...state, version: version + 1 }));
      return true;
    },
  };
}

describe('ViventiumMainCompactionService', () => {
  const identity = {
    ownerId: 'owner-1',
    agentId: 'main-agent',
    stableAuthoritySha256: 'e'.repeat(64),
  };

  beforeEach(() => {
    setMainContinuityPersistenceForTests(inMemoryPersistence());
    require('@librechat/api').resetMainCompactionSchedulingForTests();
  });
  afterEach(() => setMainContinuityPersistenceForTests(null));

  test('final renewed size call uses its current admitted budget after prompt preparation', async () => {
    let elapsedMs = 100000,
      generated = 0,
      advanced = false;
    const fitting = {
      version: 1,
      summary: 'Permission remains pending.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const wholeSource = [
      {
        logicalTurnId: 'bounded-source',
        revision: 1,
        userText: 'Keep pending permission.',
        assistantText: 'Permission remains pending.',
      },
    ];
    const claim = {
      status: 'claimed',
      leaseId: 'exact-renewal',
      domainEpochKey: 'clock-domain',
      sourceDigest: 'c'.repeat(64),
      sourceBytes: 500,
      previousSemanticCompaction: null,
      leaseExpiresAt: new Date(300000),
    };
    Object.defineProperty(claim, 'sourceTurns', {
      get() {
        // Two milliseconds of preparation crosses the existing measured admission threshold.
        if (generated === 2 && !advanced) {
          elapsedMs += 2;
          advanced = true;
        }
        return wholeSource;
      },
    });
    const renewal = jest.fn(async (input) => ({
      status: 'renewed',
      leaseExpiresAt: input.expiresAt,
    }));
    const calls = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      now: () => elapsedMs,
      deadlineAt: new Date(600000).toISOString(),
      executionBudget: {
        completionReserveMs: 200000,
        slowestCallMs: 160000,
        slowestCompactionCallMs: 160000,
        slowestReviewCallMs: 16000,
      },
      claimCompaction: async () => claim,
      renewCompaction: renewal,
      completeCompaction: async () => ({ status: 'compacted' }),
      rejectCompaction: async () => ({ status: 'degraded' }),
      executeCompactor: async (call) => {
        calls.push({ stage: call.stage || 'compaction', timeoutMs: call.timeoutMs });
        call.reportCapacityRelease(true);
        if (call.stage === 'review') {
          elapsedMs += 16000;
          return reviewApproved;
        }
        generated += 1;
        const duration = generated === 1 ? 10000 : generated === 2 ? 13999 : 170000;
        if (call.timeoutMs < duration) {
          elapsedMs += call.timeoutMs;
          throw Object.assign(new Error('Owned attempt deadline'), {
            code: 'main_compaction_provider_failed',
          });
        }
        elapsedMs += duration;
        return JSON.stringify(
          generated <= 2
            ? {
                ...fitting,
                pendingAsks: Array.from(
                  { length: 18 - generated },
                  (_, i) => `${i}:${'a'.repeat(900)}`,
                ),
              }
            : fitting,
        );
      },
    });
    expect(renewal).toHaveBeenCalledTimes(1);
    expect(claim.leaseExpiresAt).toEqual(new Date(400000));
    expect(calls[2]).toEqual({ stage: 'compaction', timeoutMs: 240000 });
    expect(result).toMatchObject({ status: 'compacted', attempts: 3 });
  });

  test('awaited additional repair renewal rejection closes its exact claim', async () => {
    let elapsedMs = 100000,
      generated = 0;
    const fitting = {
      version: 1,
      summary: 'Permission remains pending.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const claim = {
      status: 'claimed',
      leaseId: 'failed-renewal',
      domainEpochKey: 'failure-domain',
      sourceDigest: 'd'.repeat(64),
      sourceBytes: 500,
      previousSemanticCompaction: null,
      sourceTurns: [
        {
          logicalTurnId: 'complete-unit',
          revision: 1,
          userText: 'Keep permission.',
          assistantText: 'Permission remains pending.',
        },
      ],
      leaseExpiresAt: new Date(300000),
    };
    const rejection = jest.fn(async () => ({ status: 'degraded' }));
    const calls = [];
    const renewal = jest.fn(async () => {
      throw new Error('Synthetic store unavailable');
    });
    let result, failure;
    try {
      result = await ensureAcceptedMainCompaction({
        ...identity,
        now: () => elapsedMs,
        deadlineAt: new Date(600000).toISOString(),
        executionBudget: {
          completionReserveMs: 200000,
          slowestCallMs: 160000,
          slowestCompactionCallMs: 160000,
          slowestReviewCallMs: 16000,
        },
        claimCompaction: async () => claim,
        renewCompaction: renewal,
        completeCompaction: async () => ({ status: 'compacted' }),
        rejectCompaction: rejection,
        executeCompactor: async (call) => {
          calls.push(call.stage || 'compaction');
          call.reportCapacityRelease(true);
          generated += 1;
          elapsedMs += generated === 1 ? 20000 : 30000;
          return JSON.stringify({
            ...fitting,
            pendingAsks: Array.from(
              { length: 18 - generated },
              (_, i) => `${i}:${'a'.repeat(900)}`,
            ),
          });
        },
      });
    } catch (error) {
      failure = error.message;
    }
    expect(renewal).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(rejection).toHaveBeenCalledTimes(1);
    expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ leaseId: claim.leaseId }));
    expect(failure).toBeUndefined();
    expect(result.status).toBe('degraded');
  });

  test.each(['rejected', 'stopped'])(
    'review renewal closes the exact claim before child dispatch (%s)',
    async (mode) => {
      let elapsedMs = 100000,
        generated = 0,
        advanced = false;
      const controller = new AbortController();
      const source = [
        {
          logicalTurnId: 'review-source',
          revision: 1,
          userText: 'Keep permission pending.',
          assistantText: 'Permission is pending.',
        },
      ];
      const original = structuredClone(source);
      const candidate = {
        version: 1,
        summary: 'Permission remains pending.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const claim = {
        status: 'claimed',
        leaseId: 'review-renewal',
        domainEpochKey: 'review-domain',
        sourceDigest: 'f'.repeat(64),
        sourceBytes: 500,
        previousSemanticCompaction: null,
        leaseExpiresAt: new Date(300000),
      };
      Object.defineProperty(claim, 'sourceTurns', {
        get() {
          if (generated === 1 && !advanced) {
            elapsedMs += 2;
            advanced = true;
          }
          return source;
        },
      });
      const renewal = jest.fn(async (input) => {
        expect(input).toMatchObject({
          leaseId: claim.leaseId,
          sourceDigest: claim.sourceDigest,
          leaseExpiresAt: new Date(300000),
          expiresAt: new Date(400000),
        });
        if (mode === 'rejected') throw new Error('Synthetic review store unavailable');
        controller.abort('user_cancelled');
        return { status: 'renewed', leaseExpiresAt: input.expiresAt };
      });
      const rejection = jest.fn(async () => ({ status: 'degraded' }));
      const completed = jest.fn(async () => ({ status: 'compacted' }));
      const calls = [];
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        signal: controller.signal,
        now: () => elapsedMs,
        deadlineAt: new Date(600000).toISOString(),
        executionBudget: {
          completionReserveMs: 200000,
          slowestCallMs: 160000,
          slowestCompactionCallMs: 160000,
          slowestReviewCallMs: 16000,
        },
        claimCompaction: async () => claim,
        renewCompaction: renewal,
        completeCompaction: completed,
        rejectCompaction: rejection,
        executeCompactor: async (call) => {
          calls.push(call.stage || 'compaction');
          call.reportCapacityRelease(true);
          expect(call.timeoutMs).toBe(184000);
          generated += 1;
          elapsedMs += 184000;
          return JSON.stringify(candidate);
        },
      });
      expect(renewal).toHaveBeenCalledTimes(1);
      expect(calls).toEqual(['compaction']);
      expect(completed).not.toHaveBeenCalled();
      expect(rejection).toHaveBeenCalledTimes(1);
      expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ leaseId: claim.leaseId }));
      expect(source).toEqual(original);
      expect(result).toMatchObject({
        status: 'degraded',
        attempts: 1,
        reason: mode === 'stopped' ? 'compaction_cancelled' : 'review_provider_failed',
      });
    },
  );

  test('review store renewal rejection closes its exact claim without a review child', async () => {
    let elapsedMs = 100000;
    const source = [
      {
        logicalTurnId: 'review-await-source',
        revision: 1,
        userText: 'Keep pending permission.',
        assistantText: 'Permission is pending.',
      },
    ];
    const original = structuredClone(source);
    const candidate = {
      version: 1,
      summary: 'Permission remains pending.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const { createMainCompactionOutputContract } = require('@librechat/api');
    const claim = {
      status: 'claimed',
      leaseId: 'review-store-renewal',
      domainEpochKey: 'review-store-domain',
      sourceDigest: '9'.repeat(64),
      sourceBytes: 500,
      sourceTurns: source,
      previousSemanticCompaction: null,
      leaseExpiresAt: new Date(300000),
      outputContract: createMainCompactionOutputContract({
        consumer: 'accepted_core',
        carrierMaxUtf8Bytes: 128 * 1024,
        reservedUtf8Bytes: 1000,
      }),
    };
    const renewal = jest.fn(async () => {
      throw new Error('Synthetic review store unavailable');
    });
    const rejection = jest.fn(async () => ({ status: 'degraded' }));
    const completed = jest.fn(async () => ({ status: 'compacted' }));
    const calls = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      now: () => elapsedMs,
      deadlineAt: new Date(600000).toISOString(),
      executionBudget: {
        completionReserveMs: 200000,
        slowestCallMs: 160000,
        slowestCompactionCallMs: 160000,
        slowestReviewCallMs: 16000,
      },
      claimCompaction: async () => claim,
      renewCompaction: renewal,
      completeCompaction: completed,
      rejectCompaction: rejection,
      inspectCandidateCarrier: async () => {
        // An awaited carrier inspection consumes time after generation but before review admission.
        elapsedMs += 165000;
        return { ok: true };
      },
      executeCompactor: async (call) => {
        calls.push(call.stage || 'compaction');
        call.reportCapacityRelease(true);
        elapsedMs += 20000;
        return JSON.stringify(candidate);
      },
    });
    expect(renewal).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['compaction']);
    expect(completed).not.toHaveBeenCalled();
    expect(source).toEqual(original);
    expect(rejection).toHaveBeenCalledTimes(1);
    expect(rejection).toHaveBeenCalledWith(expect.objectContaining({ leaseId: claim.leaseId }));
    expect(result).toMatchObject({
      status: 'degraded',
      attempts: 1,
      reason: 'review_provider_failed',
    });
  });

  test('parses a JSON object without accepting prose around it', () => {
    expect(
      parseSemanticCompactionOutput(
        '```json\n{"version":1,"summary":"Earlier state.","pendingAsks":[],"commitments":[],"corrections":[],"decisions":[],"durableIdentifiers":[],"recurrenceOutcomes":[],"toolPairs":[]}\n```',
      ),
    ).toMatchObject({ version: 1, summary: 'Earlier state.' });
    expect(parseSemanticCompactionOutput('Here is the summary: {"version":1}')).toBeNull();
  });
  test('renders the same legacy provenance and retirement evidence into generation and review', () => {
    const legacyInputs = [
      {
        kind: 'legacy_state',
        id: 'old-state',
        sourceCoverage: 'incomplete',
        sourceTurns: [],
        unavailableSources: ['missing:1'],
        retiredSources: [{ logicalTurnId: 'deleted', revision: 2, reason: 'source_deleted' }],
      },
    ];
    const claim = { sourceDigest: 'a'.repeat(64), sourceTurns: [], legacyInputs };
    const candidate = { version: 1, summary: 'Historical source remains incomplete.' };
    for (const prompt of [
      buildCompactionPrompt(claim),
      buildCompactionPrompt(claim, '', candidate),
    ]) {
      expect(prompt).toContain(JSON.stringify(legacyInputs));
      expect(prompt).toContain('"sourceDigest":"' + claim.sourceDigest + '"');
      expect(prompt).toContain('Retired source content is not eligible active context');
    }
  });

  test('uses validator-owned constraints and structured correction feedback without changing attempts', async () => {
    const { mainCompactionOutputConstraints } = require('@librechat/api');
    for (let index = 1; index <= 4; index++) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `constraints-${index}`,
        revision: 1,
        conversationId: 'constraints-chat',
        userMessageId: `constraints-user-${index}`,
        assistantMessageId: `constraints-answer-${index}`,
        userText: 'Keep the relevant references.',
        assistantText: 'I will keep them.',
        origin: 'interactive',
      });
    }
    const calls = [];
    const rejectedCandidates = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executeCompactor: async (call) => {
        calls.push(call);
        const candidate = JSON.stringify({
          version: 1,
          summary: 'The references remain pending.',
          pendingAsks: [],
          commitments: [],
          corrections: [],
          decisions: [],
          recurrenceOutcomes: [],
          toolPairs: [],
          durableIdentifiers: Array.from(
            { length: mainCompactionOutputConstraints.maxItemsPerArray + 1 },
            (_, index) => `reference-${index}`,
          ),
        });
        rejectedCandidates.push(candidate);
        return candidate;
      },
    });
    expect(result).toMatchObject({ status: 'degraded', attempts: 2, reason: 'schema_invalid' });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.stage).not.toBe('review');
      expect(call.prompt).toContain('"consumer":"accepted_core"');
    }
    const payloads = calls.map(({ prompt }) =>
      JSON.parse(
        prompt
          .split('<untrusted_conversation_data_v1>')[1]
          .split('</untrusted_conversation_data_v1>')[0],
      ),
    );
    expect(payloads[0].priorRejection).toBeUndefined();
    expect(payloads[1].priorRejection).toEqual({
      code: 'schema_invalid',
      candidate: rejectedCandidates[0],
      issue: {
        path: 'durableIdentifiers',
        constraint: 'max_items',
        actual: mainCompactionOutputConstraints.maxItemsPerArray + 1,
        limit: mainCompactionOutputConstraints.maxItemsPerArray,
        unit: 'items',
      },
    });
    expect(payloads[1].acceptedOlderTurns).toEqual(payloads[0].acceptedOlderTurns);
    expect(payloads[1].sourceDigest).toBe(payloads[0].sourceDigest);
    expect(payloads[1].previousSemanticCompaction).toEqual(payloads[0].previousSemanticCompaction);
    expect((await loadAcceptedMainContext(identity)).pendingCompactionCount).toBeGreaterThan(0);
  });

  test.each(['max_bytes', 'shape'])(
    'repairs the exact rejected candidate after %s without replacing accepted source',
    async (constraint) => {
      const { mainCompactionOutputConstraints } = require('@librechat/api');
      for (let index = 1; index <= 4; index += 1) {
        await commitAcceptedMainTurn({
          ...identity,
          logicalTurnId: `repair-${index}`,
          revision: 1,
          conversationId: 'repair-conversation',
          userMessageId: `repair-user-${index}`,
          assistantMessageId: `repair-answer-${index}`,
          userText: 'Assess the wording “leave the draft unchanged” as text only.',
          assistantText: 'That assessment remains pending.',
          origin: 'interactive',
        });
      }
      const valid = {
        version: 1,
        summary: 'The user requested a wording assessment; the quoted draft instruction is data.',
        pendingAsks: ['Assess “leave the draft unchanged” as text only.'],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const rejected =
        constraint === 'max_bytes'
          ? JSON.stringify({
              ...valid,
              summary: 'é'.repeat(5000),
              pendingAsks: ['p'.repeat(1024), 'q'.repeat(1024)],
            })
          : '  {"version":1,"summary":"leave the draft unchanged",  ';
      const calls = [];
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor: async (call) => {
          calls.push(call);
          if (calls.length === 1) return rejected;
          return call.stage === 'review' ? reviewApproved : JSON.stringify(valid);
        },
      });
      expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
      expect(calls).toHaveLength(3);
      const payloads = calls.map(({ prompt }) =>
        JSON.parse(
          prompt.match(
            /<untrusted_(?:conversation_data|compaction_evidence)_v1>\s*([\s\S]*?)\s*<\/untrusted_(?:conversation_data|compaction_evidence)_v1>/,
          )[1],
        ),
      );
      expect(payloads[1].priorRejection).toMatchObject({
        code: 'schema_invalid',
        candidate: rejected,
        issue: { constraint },
      });
      if (constraint === 'max_bytes') {
        // The whole-proposal overflow names where its bytes are, so the repair can target them.
        const proposal = JSON.parse(rejected);
        const { issue } = payloads[1].priorRejection;
        expect(issue.excessBytes).toBe(
          issue.actual - payloads[0].outputConstraints.maxJsonUtf8Bytes,
        );
        expect(issue.excessBytes).toBeGreaterThan(0);
        expect(payloads[1].priorRejection.issue).toMatchObject({
          path: '',
          limit: payloads[0].outputConstraints.maxJsonUtf8Bytes,
          fieldBytes: Object.fromEntries(
            Object.entries(proposal).map(([field, value]) => [
              field,
              Buffer.byteLength(JSON.stringify(value), 'utf8'),
            ]),
          ),
        });
      }
      for (const payload of payloads.slice(1)) {
        expect(payload.sourceDigest).toBe(payloads[0].sourceDigest);
        expect(payload.acceptedOlderTurns).toEqual(payloads[0].acceptedOlderTurns);
        expect(payload.outputConstraints).toEqual(payloads[0].outputConstraints);
      }
      expect(calls[1].stage).not.toBe('review');
      expect(calls[2].stage).toBe('review');
      expect(payloads[2].priorRejection).toBeUndefined();
      expect(payloads[2].candidate).toEqual(valid);
    },
  );

  test('repairs an item byte limit on the same source even when a smaller whole claim exists', async () => {
    const valid = {
      version: 1,
      summary: 'The source remains pending.',
      pendingAsks: ['Keep permission required.'],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const invalid = JSON.stringify({ ...valid, pendingAsks: ['p'.repeat(1025)] });
    const calls = [];
    const completeCompaction = jest.fn().mockResolvedValue({ status: 'compacted' });
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      claimCompaction: async () => ({
        status: 'claimed',
        leaseId: 'item-limit',
        sourceDigest: 'a'.repeat(64),
        domainEpochKey: 'item-limit-epoch',
        sourceTurns: [],
        sourceBytes: 8000,
        previousSemanticCompaction: null,
        canReduceSource: true,
        leaseExpiresAt: new Date(Date.now() + 300000),
      }),
      completeCompaction,
      rejectCompaction: jest.fn().mockResolvedValue({ status: 'rejected' }),
      executeCompactor: async (call) => {
        calls.push(call);
        return calls.length === 1
          ? invalid
          : call.stage === 'review'
            ? reviewApproved
            : JSON.stringify(valid);
      },
    });
    expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
    expect(calls).toHaveLength(3);
    const payload = JSON.parse(
      calls[1].prompt.match(
        /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
      )[1],
    );
    expect(payload.priorRejection.issue).toMatchObject({
      path: 'pendingAsks.0',
      constraint: 'max_bytes',
    });
    expect(payload.sourceDigest).toBe('a'.repeat(64));
    expect(completeCompaction).toHaveBeenCalledTimes(1);
  });

  test('reuses the same identity and version of hydrated Core under final selected headroom without model work', async () => {
    const turns = [1, 2, 3].map((index) => ({
      logicalTurnId: `turn-${index}`,
      revision: 1,
      conversationId: 'conversation',
      userMessageId: `user-${index}`,
      assistantMessageId: `assistant-${index}`,
      origin: 'interactive',
      userText: 'u'.repeat(2048),
      assistantText: 'a'.repeat(2048),
      toolPairs: [],
      committedAt: new Date(),
    }));
    const semanticCompaction = {
      version: 1,
      summary: 'Keep approval required.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const context = Object.freeze({
      status: 'available',
      turns,
      sourceTurns: turns,
      semanticCompaction,
      version: 42,
      legacyPending: false,
      pendingCompactionTurns: [],
    });
    const req = { _viventiumAcceptedMainCarrierContextV1: { identity, context } };
    const ensureCompaction = jest.fn();
    const result = await loadAcceptedMainContextForAdmission({
      ...identity,
      req,
      ensureCompaction,
      outputCarrier: { carrierMaxUtf8Bytes: 128 * 1024, reservedContextUtf8Bytes: 12000 },
    });
    expect(result).toMatchObject({
      status: 'available',
      version: 42,
      sourceTurns: turns,
      semanticCompaction,
    });
    expect(result.capsule).toContain(semanticCompaction.summary);
    for (const turn of turns) expect(result.capsule).toContain(turn.userText);
    expect(ensureCompaction).not.toHaveBeenCalled();
    expect(context).not.toHaveProperty('capsule');
  });

  test('accepted compaction claim inherits the actual request-selected aggregate carrier', async () => {
    const outputCarrier = { carrierMaxUtf8Bytes: 128 * 1024, reservedContextUtf8Bytes: 25000 };
    const claimCompaction = jest.fn().mockResolvedValue({ status: 'empty' });
    const executeCompactor = jest.fn();
    await expect(
      ensureAcceptedMainCompaction({
        ...identity,
        req: { _viventiumAcceptedMainOutputCarrierV1: outputCarrier },
        claimCompaction,
        executeCompactor,
      }),
    ).resolves.toMatchObject({ status: 'empty' });
    expect(claimCompaction).toHaveBeenCalledWith(expect.objectContaining({ outputCarrier }));
    expect(executeCompactor).not.toHaveBeenCalled();
  });

  test.each(['available', 'context_budget'])(
    'uses one guarded admission repair and requires actual %s reload',
    async (state) => {
      const req = {};
      const source = {
        status: 'context_budget',
        sourceTurns: [{ exactSource: true }],
        semanticCompaction: { summary: 'Keep all prior permission state.' },
      };
      const loadContext = jest
        .fn()
        .mockResolvedValueOnce(source)
        .mockResolvedValue({ ...source, status: state });
      const ensureCompaction = jest.fn().mockResolvedValue({ status: 'compacted' });
      const operation = loadAcceptedMainContextForAdmission({
        ...identity,
        req,
        loadContext,
        ensureCompaction,
      });
      if (state === 'available')
        await expect(operation).resolves.toMatchObject({ status: 'available' });
      else {
        await expect(operation).rejects.toMatchObject({
          code: 'source_context_unavailable',
          status: 413,
        });
        await expect(
          loadAcceptedMainContextForAdmission({ ...identity, req, loadContext, ensureCompaction }),
        ).rejects.toMatchObject({ code: 'source_context_unavailable', status: 413 });
      }
      expect(ensureCompaction).toHaveBeenCalledTimes(1);
      expect(ensureCompaction).toHaveBeenCalledWith(
        expect.objectContaining({
          foreground: true,
          trigger: 'context_carrier',
          reallocateOutputCarrier: true,
        }),
      );
      expect(source.sourceTurns).toEqual([{ exactSource: true }]);
    },
  );

  test.each(['complete', 'source_changed', 'stopped', 'expired', 'provider_failed'])(
    'cold real runner retains full reviewed source within existing bounds (%s)',
    async (mode) => {
      let elapsedMs = 2061;
      const controller = new AbortController();
      if (mode === 'stopped') controller.abort('user_cancelled');
      const sourceTurns = [
        {
          logicalTurnId: 'cold-turn',
          revision: 1,
          userText: 'Keep the pending permission and exact locator.',
          assistantText: 'Permission is pending; locator /workspace/evidence/check.md.',
        },
      ];
      const original = structuredClone(sourceTurns);
      const candidate = {
        version: 1,
        summary: 'Permission remains pending.',
        pendingAsks: ['Confirm permission before any external action.'],
        commitments: [],
        corrections: ['Use the corrected locator.'],
        decisions: [],
        durableIdentifiers: ['/workspace/evidence/check.md'],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const claim = {
        status: 'claimed',
        leaseId: 'cold-lease',
        domainEpochKey: 'cold-domain',
        sourceDigest: 'a'.repeat(64),
        sourceTurns,
        sourceBytes: 500,
        previousSemanticCompaction: null,
        leaseExpiresAt: new Date(mode === 'expired' ? 0 : 300000),
      };
      const calls = [];
      const executionBudget = {};
      const completeCompaction = jest.fn(async () =>
        mode === 'source_changed' ? { status: 'stale_source' } : { status: 'compacted' },
      );
      const rejectCompaction = jest.fn(async () => ({ status: 'degraded' }));
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        signal: controller.signal,
        deadlineAt: new Date(600000).toISOString(),
        executionBudget,
        now: () => elapsedMs,
        claimCompaction: async () => claim,
        completeCompaction,
        rejectCompaction,
        executeCompactor: async (call) => {
          calls.push(call);
          const duration = call.stage === 'review' ? 16000 : 160000;
          call.reportCapacityRelease(true);
          if (call.timeoutMs < duration) {
            elapsedMs += call.timeoutMs;
            throw Object.assign(new Error('Owned attempt deadline'), {
              code: 'main_compaction_provider_failed',
            });
          }
          expect(call.timeoutMs).toBeLessThanOrEqual(240000);
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(claim.leaseExpiresAt.getTime());
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(400000);
          elapsedMs += duration;
          if (mode === 'provider_failed')
            throw Object.assign(new Error('Synthetic provider failure'), {
              code: 'main_compaction_provider_failed',
            });
          return call.stage === 'review' ? reviewApproved : JSON.stringify(candidate);
        },
      });
      expect(sourceTurns).toEqual(original);
      if (mode === 'complete' || mode === 'source_changed')
        expect(result.status).toBe(mode === 'complete' ? 'compacted' : 'stale_source');
      const { logger } = require('@librechat/data-schemas');
      const issued = logger.debug.mock.calls.filter(([event]) =>
        event.endsWith('Stage call issued'),
      );
      const settled = logger.debug.mock.calls.filter(([event]) =>
        event.endsWith('Stage call settled'),
      );
      expect(issued).toHaveLength(calls.length);
      expect(settled).toHaveLength(calls.length);
      if (mode === 'complete' || mode === 'source_changed') {
        expect(issued[0][1]).toMatchObject({
          stage: 'compaction',
          timeoutMs: 240000,
          compactionKnown: false,
          reviewKnown: false,
        });
        expect(settled[0][1]).toMatchObject({
          stage: 'compaction',
          elapsedMs: 160000,
          outcome: 'completed',
        });
        expect(settled[1][1]).toMatchObject({
          stage: 'review',
          elapsedMs: 16000,
          outcome: 'completed',
        });
        expect(result.status).toBe(mode === 'complete' ? 'compacted' : 'stale_source');
        expect(calls.map((c) => c.stage || 'compaction')).toEqual(['compaction', 'review']);
        expect(elapsedMs).toBe(178061);
        expect(completeCompaction).toHaveBeenCalledWith(
          expect.objectContaining({
            leaseId: claim.leaseId,
            sourceDigest: claim.sourceDigest,
            semanticCompaction: candidate,
            semanticReview: expect.objectContaining({ approved: true }),
          }),
        );
      } else {
        expect(calls).toHaveLength(mode === 'provider_failed' ? 1 : 0);
        expect(completeCompaction).not.toHaveBeenCalled();
        expect(result.status).toBe('degraded');
        if (mode === 'provider_failed')
          expect(settled[0][1]).toMatchObject({
            stage: 'compaction',
            elapsedMs: 160000,
            outcome: 'main_compaction_provider_failed',
          });
      }
    },
  );

  test.each(['third', 'fourth', 'stale_lease', 'stopped', 'deadline'])(
    'converging additional size repair reaches the same live renewal owner (%s)',
    async (mode) => {
      let elapsedMs = 100000;
      let generated = 0;
      const controller = new AbortController();
      const executionBudget = {
        completionReserveMs: 200000,
        slowestCallMs: 160000,
        slowestCompactionCallMs: 160000,
        slowestReviewCallMs: 16000,
      };
      const sourceTurns = [
        {
          logicalTurnId: 'size-turn',
          revision: 1,
          userText: 'Retain pending permission.',
          assistantText: 'Permission remains pending.',
        },
      ];
      const original = structuredClone(sourceTurns);
      const fitting = {
        version: 1,
        summary: 'Permission remains pending.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const claim = {
        status: 'claimed',
        leaseId: 'size-renewal',
        domainEpochKey: 'size-domain',
        sourceDigest: 'b'.repeat(64),
        sourceTurns,
        sourceBytes: 500,
        previousSemanticCompaction: null,
        leaseExpiresAt: new Date(300000),
      };
      const renewal = jest.fn(async (input) => {
        expect(elapsedMs).toBe(150000);
        expect(input).toMatchObject({
          leaseId: claim.leaseId,
          sourceDigest: claim.sourceDigest,
          leaseExpiresAt: new Date(300000),
          expiresAt: new Date(400000),
        });
        if (mode === 'stopped') controller.abort('user_cancelled');
        return mode === 'stale_lease'
          ? { status: 'stale_lease' }
          : { status: 'renewed', leaseExpiresAt: input.expiresAt };
      });
      const calls = [];
      const complete = jest.fn(async () => ({ status: 'compacted' }));
      const reject = jest.fn(async () => ({ status: 'degraded' }));
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        signal: controller.signal,
        deadlineAt: new Date(mode === 'deadline' ? 525000 : 600000).toISOString(),
        executionBudget,
        now: () => elapsedMs,
        claimCompaction: async () => claim,
        renewCompaction: renewal,
        completeCompaction: complete,
        rejectCompaction: reject,
        executeCompactor: async (call) => {
          calls.push(call);
          call.reportCapacityRelease(true);
          if (call.stage === 'review') {
            elapsedMs += 16000;
            return reviewApproved;
          }
          generated += 1;
          const oversized = generated <= 2 || (mode === 'fourth' && generated === 3);
          const duration =
            generated === 1 ? 20000 : generated === 2 ? 30000 : oversized ? 30000 : 160000;
          expect(call.timeoutMs).toBeGreaterThanOrEqual(duration);
          expect(call.timeoutMs).toBeLessThanOrEqual(240000);
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(claim.leaseExpiresAt.getTime());
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(
            mode === 'deadline' ? 325000 : 400000,
          );
          elapsedMs += duration;
          return JSON.stringify(
            oversized
              ? {
                  ...fitting,
                  pendingAsks: Array.from(
                    { length: 18 - generated },
                    (_, i) => `${i}:${'a'.repeat(900)}`,
                  ),
                }
              : fitting,
          );
        },
      });
      expect(sourceTurns).toEqual(original);
      if (mode === 'third' || mode === 'fourth') {
        expect(result).toMatchObject({ status: 'compacted', attempts: mode === 'third' ? 3 : 4 });
        expect(renewal).toHaveBeenCalledTimes(1);
        expect(complete).toHaveBeenCalledTimes(1);
        expect(elapsedMs).toBe(mode === 'third' ? 326000 : 356000);
        expect(calls[calls.length - 1].stage).toBe('review');
        const { logger } = require('@librechat/data-schemas');
        const issued = logger.debug.mock.calls.filter(([event]) =>
          event.endsWith('Stage call issued'),
        );
        const settled = logger.debug.mock.calls.filter(([event]) =>
          event.endsWith('Stage call settled'),
        );
        expect(issued).toHaveLength(calls.length);
        expect(settled).toHaveLength(calls.length);
        expect(issued[2][1]).toMatchObject({
          stage: 'compaction',
          timeoutMs: 234000,
          compactionObservedMs: 160000,
          reviewObservedMs: 16000,
          leaseRemainingMs: 250000,
          enclosingRemainingMs: 450000,
          completionReserveMs: 200000,
          leaseRenewalDisposition: 'renewed',
        });
        for (const [, payload] of [...issued, ...settled]) {
          expect(payload.claimHash).toMatch(/^[a-f0-9]{16}$/);
          expect(JSON.stringify(payload)).not.toContain('size-turn');
          expect(JSON.stringify(payload)).not.toContain('Permission');
          expect(JSON.stringify(payload)).not.toContain(claim.leaseId);
          expect(JSON.stringify(payload)).not.toContain(claim.sourceDigest);
        }
      } else {
        expect(result.status).toBe('degraded');
        expect(complete).not.toHaveBeenCalled();
        expect(calls).toHaveLength(2);
        expect(renewal).toHaveBeenCalledTimes(mode === 'deadline' ? 0 : 1);
        if (mode === 'stopped') expect(result.reason).toBe('compaction_cancelled');
      }
    },
  );

  test.each([
    [130500, true],
    [145000, false],
  ])(
    'uses observed stage durations for bounded same-source fidelity repair (%s ms generation)',
    async (generationMs, fitsRepair) => {
      let elapsedMs = 0;
      const executionBudget = {};
      const sourceDigest = 'd'.repeat(64);
      const sourceTurns = [
        {
          logicalTurnId: 'evidence-turn',
          revision: 1,
          userText: 'Keep the evidence locator.',
          assistantText: 'Evidence: /workspace/evidence/worker-check.md',
        },
      ];
      const claim = {
        status: 'claimed',
        leaseId: 'timed-lease',
        domainEpochKey: 'timed-epoch',
        sourceDigest,
        sourceTurns,
        sourceBytes: 500,
        previousSemanticCompaction: null,
        leaseExpiresAt: new Date(300000),
      };
      const candidate = {
        version: 1,
        summary: 'The evidence locator is pending.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const rejected = JSON.stringify(candidate);
      const faithful = {
        ...candidate,
        durableIdentifiers: ['/workspace/evidence/worker-check.md'],
      };
      const reason = 'The candidate omits the source evidence locator.';
      const calls = [];
      const completeCompaction = jest.fn().mockResolvedValue({ status: 'compacted' });
      const rejectCompaction = jest.fn().mockResolvedValue({ status: 'degraded' });
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        deadlineAt: new Date(600000).toISOString(),
        executionBudget,
        now: () => elapsedMs,
        claimCompaction: async () => claim,
        completeCompaction,
        rejectCompaction,
        executeCompactor: async (call) => {
          calls.push(call);
          const durationMs = call.stage === 'review' ? 11800 : generationMs;
          expect(call.timeoutMs).toBeGreaterThanOrEqual(durationMs);
          expect(call.timeoutMs).toBeLessThanOrEqual(240000);
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(300000);
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(400000);
          elapsedMs += durationMs;
          call.reportCapacityRelease(true);
          if (call.stage === 'review')
            return calls.length === 4
              ? reviewApproved
              : JSON.stringify({ approved: false, reason });
          return calls.length === 1 ? rejected : JSON.stringify(faithful);
        },
      });
      if (!fitsRepair) {
        expect(result).toMatchObject({
          status: 'degraded',
          attempts: 1,
          reason: 'compaction_enclosing_deadline',
        });
        expect(calls).toHaveLength(2);
        expect(completeCompaction).not.toHaveBeenCalled();
        expect(rejectCompaction).toHaveBeenCalledTimes(1);
        return;
      }
      expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
      expect(executionBudget).toEqual({
        completionReserveMs: 200000,
        slowestCallMs: generationMs,
        slowestCompactionCallMs: generationMs,
        slowestReviewCallMs: 11800,
      });
      expect(elapsedMs).toBe(284600);
      expect(calls.map((call) => call.stage || 'compaction')).toEqual([
        'compaction',
        'review',
        'compaction',
        'review',
      ]);
      const payloads = calls.map(({ prompt }) =>
        JSON.parse(
          prompt.match(
            /<untrusted_(?:conversation_data|compaction_evidence)_v1>\s*([\s\S]*?)\s*<\/untrusted_(?:conversation_data|compaction_evidence)_v1>/,
          )[1],
        ),
      );
      expect(payloads[2].priorRejection).toEqual({
        code: 'semantic_fidelity',
        candidate: rejected,
        reason,
      });
      for (const payload of payloads) {
        expect(payload.sourceDigest).toBe(sourceDigest);
        expect(payload.acceptedOlderTurns).toEqual(sourceTurns);
        expect(payload.outputConstraints).toEqual(payloads[0].outputConstraints);
      }
      expect(payloads[3].candidate).toEqual(faithful);
      expect(payloads[3].priorRejection).toBeUndefined();
      expect(completeCompaction).toHaveBeenCalledTimes(1);
      expect(completeCompaction).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceDigest,
          leaseId: claim.leaseId,
          semanticCompaction: faithful,
          semanticReview: expect.objectContaining({ sourceDigest, approved: true }),
        }),
      );
      expect(rejectCompaction).not.toHaveBeenCalled();
    },
  );

  test.each(['renewed', 'stale_lease', 'cancelled', 'insufficient'])(
    'a bounded live lease supports the measured correction only with owned renewal (%s)',
    async (mode) => {
      let elapsedMs = 0;
      const controller = new AbortController();
      const claim = {
        status: 'claimed',
        leaseId: 'renewal-lease',
        domainEpochKey: 'renewal-domain',
        sourceDigest: 'd'.repeat(64),
        sourceBytes: 500,
        sourceTurns: [],
        leaseExpiresAt: new Date(300000),
      };
      const candidate = {
        version: 1,
        summary: 'Preserve the approved evidence.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const calls = [];
      const completeCompaction = jest.fn().mockResolvedValue({ status: 'compacted' });
      const rejectCompaction = jest.fn().mockResolvedValue({ status: 'degraded' });
      const renewCompaction = jest.fn(async (input) => {
        expect(elapsedMs).toBe(161370);
        expect(input).toMatchObject({
          leaseId: claim.leaseId,
          sourceDigest: claim.sourceDigest,
          leaseExpiresAt: new Date(300000),
          expiresAt: new Date(400000),
        });
        if (mode === 'cancelled') controller.abort('user_cancelled');
        return mode === 'stale_lease'
          ? { status: 'stale_lease' }
          : { status: 'renewed', leaseExpiresAt: input.expiresAt };
      });
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        deadlineAt: new Date(mode === 'insufficient' ? 500000 : 600000),
        executionBudget: { completionReserveMs: 200000 },
        now: () => elapsedMs,
        signal: controller.signal,
        claimCompaction: async () => claim,
        renewCompaction,
        completeCompaction,
        rejectCompaction,
        executeCompactor: async (call) => {
          calls.push(call);
          const duration = call.stage === 'review' ? 15590 : 145780;
          expect(call.timeoutMs).toBeGreaterThanOrEqual(duration);
          expect(call.timeoutMs).toBeLessThanOrEqual(240000);
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(claim.leaseExpiresAt.getTime());
          expect(elapsedMs + call.timeoutMs).toBeLessThanOrEqual(
            mode === 'insufficient' ? 300000 : 400000,
          );
          elapsedMs += duration;
          call.reportCapacityRelease(true);
          return call.stage !== 'review'
            ? JSON.stringify(candidate)
            : calls.length === 4
              ? reviewApproved
              : JSON.stringify({
                  approved: false,
                  reason: 'The proposal needs faithful correction.',
                });
        },
      });
      expect(renewCompaction).toHaveBeenCalledTimes(mode === 'insufficient' ? 0 : 1);
      if (mode === 'renewed') {
        expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
        expect(elapsedMs).toBe(322740);
        expect(completeCompaction).toHaveBeenCalledTimes(1);
        expect(rejectCompaction).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({
          status: 'degraded',
          attempts: 1,
          reason: mode === 'cancelled' ? 'compaction_cancelled' : 'compaction_enclosing_deadline',
        });
        expect(calls).toHaveLength(2);
        expect(completeCompaction).not.toHaveBeenCalled();
        expect(rejectCompaction).toHaveBeenCalledWith(
          expect.objectContaining({ leaseId: claim.leaseId }),
        );
      }
    },
  );

  test('reuses distinct observed stages when admitting the next claim under one enclosing deadline', async () => {
    const executionBudget = {
      completionReserveMs: 200000,
      slowestCallMs: 130500,
      slowestCompactionCallMs: 130500,
      slowestReviewCallMs: 11800,
    };
    const claimCompaction = jest.fn().mockResolvedValue({ status: 'empty' });
    const executeCompactor = jest.fn();
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executionBudget,
      deadlineAt: new Date(600000).toISOString(),
      now: () => 142300,
      claimCompaction,
      executeCompactor,
    });
    expect(result).toEqual({ status: 'empty' });
    expect(claimCompaction).toHaveBeenCalledTimes(1);
    expect(executeCompactor).not.toHaveBeenCalled();
    expect(executionBudget.completionReserveMs).toBe(200000);
  });

  test('shares measured enclosing reserve across smaller claims and leaves Main completion time', async () => {
    const now = 100000;
    const executionBudget = { completionReserveMs: 200000, slowestCallMs: 100000 };
    const claim = jest.fn();
    const executeCompactor = jest.fn();
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executionBudget,
      deadlineAt: new Date(now + 300000).toISOString(),
      now: () => now,
      claimCompaction: claim,
      executeCompactor,
    });
    expect(result).toMatchObject({
      status: 'degraded',
      attempts: 0,
      reason: 'compaction_enclosing_deadline',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(executeCompactor).not.toHaveBeenCalled();
  });

  test('a waiting generation Stop ACK cannot finish before its compactor native release', async () => {
    const controller = new AbortController();
    let started;
    const begun = new Promise((resolve) => {
      started = resolve;
    });
    let releaseNative;
    const nativeReleased = new Promise((resolve) => {
      releaseNative = resolve;
    });
    const rejectCompaction = jest.fn().mockResolvedValue({ status: 'degraded' });
    const compaction = ensureAcceptedMainCompaction({
      ...identity,
      signal: controller.signal,
      claimCompaction: async () => ({
        status: 'claimed',
        leaseId: 'cancel-lease',
        sourceDigest: 'a'.repeat(64),
        domainEpochKey: 'cancel-epoch',
        sourceTurns: [],
        sourceBytes: 500,
        previousSemanticCompaction: null,
        leaseExpiresAt: new Date(Date.now() + 300000),
      }),
      rejectCompaction,
      executeCompactor: ({ signal, reportCapacityRelease }) =>
        new Promise((_resolve, reject) => {
          started();
          signal.addEventListener(
            'abort',
            async () => {
              await nativeReleased;
              reportCapacityRelease(true);
              reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
            },
            { once: true },
          );
        }),
    });
    await begun;
    controller.abort('user_cancelled');
    const delivery = controller.signal._viventiumHarnessCancellationDelivery;
    let acknowledged = false;
    void delivery.then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    releaseNative();
    await expect(delivery).resolves.toEqual({ delivered: true });
    await expect(compaction).resolves.toMatchObject({
      status: 'degraded',
      reason: 'compaction_cancelled',
    });
    expect(rejectCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: 'cancel-lease' }),
    );
  });

  describe('shrinking whole-proposal size repairs', () => {
    const fitting = {
      version: 1,
      summary: 'The user requested a wording assessment; the quoted draft instruction is data.',
      pendingAsks: ['Assess “leave the draft unchanged” as text only.'],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    // Every item stays within its own limit; only the whole proposal exceeds the budget.
    const oversized = (items) =>
      JSON.stringify({
        ...fitting,
        pendingAsks: Array.from({ length: items }, (_, index) => `${index}:${'a'.repeat(900)}`),
      });
    const commitTurns = async (prefix) => {
      for (let index = 1; index <= 4; index += 1) {
        await commitAcceptedMainTurn({
          ...identity,
          logicalTurnId: `${prefix}-${index}`,
          revision: 1,
          conversationId: `${prefix}-conversation`,
          userMessageId: `${prefix}-user-${index}`,
          assistantMessageId: `${prefix}-answer-${index}`,
          userText: 'Assess the wording “leave the draft unchanged” as text only.',
          assistantText: 'That assessment remains pending.',
          origin: 'interactive',
        });
      }
    };
    // Each native call advances the injected clock; the claim lease itself comes from the store.
    const run = async (proposals, callMs) => {
      const calls = [];
      let generated = 0;
      let elapsedMs = 0;
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        now: () => Date.now() + elapsedMs,
        executeCompactor: async (call) => {
          calls.push({ stage: call.stage || 'compaction', timeoutMs: call.timeoutMs });
          elapsedMs += callMs;
          if (call.stage === 'review') return reviewApproved;
          generated += 1;
          return proposals[generated - 1];
        },
      });
      return { result, calls };
    };
    const withinOneSecond = (actual, expected) =>
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1000);

    test('continue while each overflow shrinks, bounded by the store lease, then review', async () => {
      await commitTurns('converge');
      const { result, calls } = await run(
        [oversized(17), oversized(16), oversized(15), JSON.stringify(fitting)],
        40 * 1000,
      );
      expect(result).toMatchObject({ status: 'compacted', attempts: 4 });
      expect(calls.map((call) => call.stage)).toEqual([
        'compaction',
        'compaction',
        'compaction',
        'compaction',
        'review',
      ]);
      // Every call ends within the store lease; later repairs also leave their review time.
      withinOneSecond(calls[0].timeoutMs, 240 * 1000);
      withinOneSecond(calls[1].timeoutMs, 240 * 1000);
      withinOneSecond(calls[2].timeoutMs, 300 * 1000 - 80 * 1000);
      withinOneSecond(calls[3].timeoutMs, 300 * 1000 - 120 * 1000);
      withinOneSecond(calls[4].timeoutMs, 300 * 1000 - 160 * 1000);
    });

    test('a summary overflow followed by a smaller whole overflow keeps repairing', async () => {
      await commitTurns('summary-first');
      const summaryOverflow = JSON.stringify({
        ...fitting,
        summary: 'a'.repeat(14000),
        pendingAsks: Array.from({ length: 6 }, (_, index) => `${index}:${'b'.repeat(900)}`),
      });
      const { result, calls } = await run(
        [summaryOverflow, oversized(16), JSON.stringify(fitting)],
        40 * 1000,
      );
      expect(result).toMatchObject({ status: 'compacted', attempts: 3 });
      expect(calls.map((call) => call.stage)).toEqual([
        'compaction',
        'compaction',
        'compaction',
        'review',
      ]);
    });

    test('an unaccepted claim makes the next claim take less whole-turn source', async () => {
      await commitTurns('smaller');
      await commitTurns('smaller-more');
      const payloadTurns = [];
      const failing = async (call) => {
        payloadTurns.push(
          JSON.parse(
            call.prompt
              .split('<untrusted_conversation_data_v1>')[1]
              .split('</untrusted_conversation_data_v1>')[0],
          ).acceptedOlderTurns.length,
        );
        return oversized(16);
      };
      const first = await ensureAcceptedMainCompaction({ ...identity, executeCompactor: failing });
      expect(first.nextSourceTargetBytes).toBeGreaterThan(0);
      expect(first.nextSourceTargetBytes).toBeLessThan(80 * 1024);
      await ensureAcceptedMainCompaction({ ...identity, executeCompactor: failing });
      expect(payloadTurns[0]).toBeGreaterThan(1);
      // A proven smaller prefix replaces redundant size repair on the same source.
      expect(first.attempts).toBe(1);
      expect(payloadTurns[1]).toBeLessThan(payloadTurns[0]);
      expect(payloadTurns[1]).toBeGreaterThanOrEqual(1);
    });

    test('an identical failed claim is not re-run and stays visibly degraded', async () => {
      await commitTurns('floor');
      let calls = 0;
      const failing = async () => {
        calls += 1;
        return oversized(16);
      };
      const first = await ensureAcceptedMainCompaction({ ...identity, executeCompactor: failing });
      expect(first).toMatchObject({ status: 'degraded', reason: 'schema_invalid' });
      const callsAfterFirst = calls;
      // Keep halving until the claim is one indivisible turn and that exact claim has failed.
      for (let index = 0; index < 12; index += 1) {
        await ensureAcceptedMainCompaction({ ...identity, executeCompactor: failing });
      }
      const before = calls;
      const repeated = await ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor: failing,
      });
      expect(callsAfterFirst).toBeGreaterThan(0);
      expect(calls).toBe(before);
      expect(repeated).toMatchObject({ status: 'degraded', attempts: 0, reason: 'schema_invalid' });
    });

    test('no native call starts after the store lease has expired', async () => {
      await commitTurns('expired');
      const { result, calls } = await run([oversized(17), oversized(16)], 301 * 1000);
      expect(calls.map((call) => call.stage)).toEqual(['compaction']);
      expect(result).toMatchObject({ status: 'degraded', reason: 'compaction_lease_expired' });
    });

    test('a transient failure is not retried when the lease cannot hold the retry wait', async () => {
      await commitTurns('retry-wait');
      let elapsedMs = 0;
      let calls = 0;
      const sleep = jest.fn(async () => undefined);
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        now: () => Date.now() + elapsedMs,
        sleep,
        retryDelayMs: 5000,
        executeCompactor: async () => {
          calls += 1;
          elapsedMs += 298 * 1000;
          const error = new Error('capacity');
          error.errorStatus = 503;
          throw error;
        },
      });
      expect(calls).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'degraded', reason: 'provider_http_503' });
      expect(result.nextSourceTargetBytes).toBeUndefined();
    });

    test('stop at the normal attempt budget when an overflow does not shrink', async () => {
      await commitTurns('stalled');
      const { result, calls } = await run(
        [oversized(16), oversized(17), JSON.stringify(fitting)],
        1000,
      );
      expect(result).toMatchObject({ status: 'degraded', attempts: 2, reason: 'schema_invalid' });
      expect(calls.map((call) => call.stage)).toEqual(['compaction', 'compaction']);
    });

    test('stop when the store lease cannot hold another repair and its review', async () => {
      await commitTurns('lease');
      const { result, calls } = await run(
        [oversized(17), oversized(16), oversized(15), JSON.stringify(fitting)],
        100 * 1000,
      );
      expect(result).toMatchObject({ status: 'degraded', attempts: 2, reason: 'schema_invalid' });
      expect(calls.map((call) => call.stage)).toEqual(['compaction', 'compaction']);
    });
  });

  test.each([true, false])(
    'retains the exact semantic rejection for bounded repair (approved: %s)',
    async (approved) => {
      for (let index = 1; index <= 4; index += 1) {
        await commitAcceptedMainTurn({
          ...identity,
          logicalTurnId: `fidelity-repair-${index}`,
          revision: 1,
          conversationId: 'fidelity-repair-chat',
          userMessageId: `fidelity-repair-user-${index}`,
          assistantMessageId: `fidelity-repair-answer-${index}`,
          userText: 'Change this draft only; leave the other drafts unchanged.',
          assistantText: 'The requested change remains pending.',
          origin: 'interactive',
        });
      }
      const candidate = {
        version: 1,
        summary: 'The requested change remains pending.',
        pendingAsks: ['Change this draft only.'],
        commitments: ['Always leave all other drafts unchanged.'],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      const rejected = '  ' + JSON.stringify(candidate) + '\n';
      const reason = 'The candidate broadens a single-draft restriction into a standing rule.';
      const valid = {
        ...candidate,
        commitments: ['For this change, leave the other drafts unchanged.'],
      };
      const calls = [];
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor: async (call) => {
          calls.push(call);
          if (call.stage === 'review') {
            return calls.length === 4 && approved
              ? reviewApproved
              : JSON.stringify({ approved: false, reason });
          }
          return calls.length === 1 ? rejected : JSON.stringify(valid);
        },
      });
      expect(result).toMatchObject(
        approved
          ? { status: 'compacted', attempts: 2 }
          : { status: 'degraded', attempts: 2, reason: `semantic_fidelity: ${reason}` },
      );
      expect(calls.map((call) => call.stage || 'compaction')).toEqual([
        'compaction',
        'review',
        'compaction',
        'review',
      ]);
      const payloads = calls.map(({ prompt }) =>
        JSON.parse(
          prompt.match(
            /<untrusted_(?:conversation_data|compaction_evidence)_v1>\s*([\s\S]*?)\s*<\/untrusted_(?:conversation_data|compaction_evidence)_v1>/,
          )[1],
        ),
      );
      expect(payloads[2].priorRejection).toEqual({
        code: 'semantic_fidelity',
        candidate: rejected,
        reason,
      });
      for (const payload of payloads.slice(1)) {
        expect(payload.sourceDigest).toBe(payloads[0].sourceDigest);
        expect(payload.acceptedOlderTurns).toEqual(payloads[0].acceptedOlderTurns);
        expect(payload.outputConstraints).toEqual(payloads[0].outputConstraints);
      }
      expect(payloads[3].priorRejection).toBeUndefined();
      expect(payloads[3].candidate).toEqual(valid);
      if (!approved) {
        expect((await loadAcceptedMainContext(identity)).pendingCompactionCount).toBeGreaterThan(0);
      }
    },
  );

  test('isolates compaction from invocation-local Main and GlassHive context headers', () => {
    const isolated = compactorAgent(
      {
        id: 'main-agent',
        instructions: 'Current Main instructions.',
        agent_ids: ['specialist-agent'],
        edges: [{ from: 'main-agent', to: 'specialist-agent' }],
        tools: ['file_search'],
        declaredToolNames: ['file_search'],
        toolDefinitions: [{ name: 'file_search' }],
        toolRegistry: new Map([['file_search', {}]]),
        mcp: ['connected-account'],
        tool_resources: { file_search: { files: [{ file_id: 'private-recall' }] } },
        tool_options: { file_search: { defer_loading: true } },
        conversation_recall_agent_only: true,
        background_cortices: [{ agent_id: 'memory-cortex' }],
        model_parameters: {
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Agent-Id': 'main-agent',
              'X-GlassHive-Turn-Context-B64': 'private-turn-context',
              'X-GlassHive-Developer-Instruction-Tail-B64': 'private-feelings-tail',
              'X-GlassHive-Stable-Authority-SHA256': 'a'.repeat(64),
              'X-Viventium-Main-Context-Snapshot-SHA256': 'b'.repeat(64),
              'X-Viventium-Logical-Turn-Id': 'turn-current',
              'X-Viventium-Request-Files': 'private-files',
              'X-Viventium-User-Id': 'owner-1',
              'X-GlassHive-Access': 'full',
            },
          },
        },
      },
      'c'.repeat(64),
    );

    expect(isolated.id).toMatch(/^main-continuity-compactor-/);
    expect(isolated.agent_ids).toEqual([]);
    expect(isolated.edges).toEqual([]);
    expect(isolated.tools).toEqual([]);
    expect(isolated.declaredToolNames).toEqual([]);
    expect(isolated.toolDefinitions).toEqual([]);
    expect(isolated.toolRegistry.size).toBe(0);
    expect(isolated.mcp).toEqual([]);
    expect(isolated.tool_resources).toEqual({});
    expect(isolated.tool_options).toEqual({});
    expect(isolated.conversation_recall_agent_only).toBe(false);
    expect(isolated.background_cortices).toEqual([]);
    expect(isolated.viventiumProviderSessionMode).toBe('stateless');
    expect(isolated.model_parameters.configuration).toBeUndefined();
  });

  test('removes non-cloneable initialized transport state before fresh compactor initialization', () => {
    const isolated = compactorAgent(
      {
        id: 'main-agent',
        provider: 'openAI',
        endpoint: 'synthetic-conversation-provider',
        model: 'synthetic-native-model',
        model_parameters: {
          model: 'synthetic-native-model',
          temperature: 0,
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Agent-Id': 'main-agent',
              'X-Viventium-Logical-Turn-Id': 'turn-current',
            },
            dispatcher() {},
          },
        },
      },
      'f'.repeat(64),
    );

    expect(() =>
      structuredClone(Object.assign({ model: isolated.model }, isolated.model_parameters)),
    ).not.toThrow();
    expect(isolated.model_parameters.configuration).toBeUndefined();
    expect(isolated.model_parameters).toMatchObject({
      model: 'synthetic-native-model',
      temperature: 0,
    });
    expect(isolated.provider).toBe('synthetic-conversation-provider');
    expect(isolated.endpoint).toBe('synthetic-conversation-provider');
  });

  test('carries the initialized agent validated fallback assignment into the isolated compactor', () => {
    const isolated = compactorAgent(
      {
        id: 'main-agent',
        provider: 'synthetic-primary-provider',
        model: 'synthetic-primary-model',
        model_parameters: { model: 'synthetic-primary-model' },
        viventiumFallbackLlmAssignment: {
          provider: 'synthetic-fallback-provider',
          model: 'synthetic-fallback-model',
          effort: 'high',
        },
      },
      'a'.repeat(64),
    );

    expect(isolated.fallback_llm_provider).toBe('synthetic-fallback-provider');
    expect(isolated.fallback_llm_model).toBe('synthetic-fallback-model');
    expect(isolated.fallback_llm_model_parameters).toEqual({
      model: 'synthetic-fallback-model',
      reasoning_effort: 'high',
    });
  });

  test('restores the declared custom endpoint after Main transport normalization', () => {
    const isolated = compactorAgent(
      {
        id: 'main-agent',
        provider: 'openAI',
        endpoint: 'synthetic-conversation-provider',
        model: 'synthetic-native-model',
        model_parameters: { model: 'synthetic-native-model' },
      },
      'd'.repeat(64),
    );

    expect(isolated.provider).toBe('synthetic-conversation-provider');
    expect(isolated.endpoint).toBe('synthetic-conversation-provider');
    expect(isolated.model).toBe('synthetic-native-model');
    expect(isolated.model_parameters.model).toBe('synthetic-native-model');
  });

  test('compacts pending accepted turns and retries one failed quality audit', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `turn-${index}`,
        revision: 1,
        conversationId: 'conversation-1',
        userMessageId: `user-${index}`,
        assistantMessageId: `assistant-${index}`,
        userText:
          index === 1
            ? 'Keep identifier 123e4567-e89b-12d3-a456-426614174000 exact.'
            : `Ask ${index}.`,
        assistantText: `Answer ${index}.`,
        origin: 'interactive',
      });
    }

    const calls = [];
    const sleep = jest.fn().mockResolvedValue(undefined);
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      sleep,
      executeCompactor: async ({ attempt, prompt, stage }) => {
        if (stage === 'review') return reviewApproved;
        calls.push({ attempt, prompt });
        if (attempt === 1) return JSON.stringify({ version: 1 });
        return JSON.stringify({
          version: 1,
          summary: 'The owner asked to preserve an exact identifier.',
          pendingAsks: [],
          commitments: [],
          corrections: [],
          decisions: ['Preserve the exact identifier.'],
          durableIdentifiers: ['123e4567-e89b-12d3-a456-426614174000'],
          recurrenceOutcomes: [],
          toolPairs: [],
        });
      },
    });

    expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
    expect(calls).toHaveLength(2);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls[0].prompt).toContain('untrusted conversation data');
    expect(calls[1].prompt).toContain('schema_invalid');
    const loaded = await loadAcceptedMainContext(identity);
    expect(loaded.pendingCompactionTurns).toEqual([]);
    expect(loaded.semanticCompaction.durableIdentifiers).toEqual([
      '123e4567-e89b-12d3-a456-426614174000',
    ]);
  });

  test('keeps pending source evidence when both compaction attempts fail', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `turn-${index}`,
        revision: 1,
        conversationId: 'conversation-1',
        userMessageId: `user-${index}`,
        assistantMessageId: `assistant-${index}`,
        userText: `Ask ${index}.`,
        assistantText: `Answer ${index}.`,
        origin: 'interactive',
      });
    }
    await expect(
      ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor: async () => 'not-json',
      }),
    ).resolves.toMatchObject({ status: 'degraded', attempts: 2 });
    const loaded = await loadAcceptedMainContext(identity);
    expect(loaded.pendingCompactionTurns).toHaveLength(1);
    expect(loaded.compactionStatus).toBe('degraded');
  });

  test('does not back off for non-transient provider failures', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `non-transient-turn-${index}`,
        revision: 1,
        conversationId: 'non-transient-conversation',
        userMessageId: `non-transient-user-${index}`,
        assistantMessageId: `non-transient-assistant-${index}`,
        userText: `Non-transient ask ${index}.`,
        assistantText: `Non-transient answer ${index}.`,
        origin: 'interactive',
      });
    }
    const sleep = jest.fn().mockResolvedValue(undefined);
    const executeCompactor = jest.fn().mockImplementation(async () => {
      const error = new Error('provider_unauthorized');
      error.code = 'provider_unauthorized';
      error.errorStatus = 401;
      throw error;
    });

    await expect(
      ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor,
        sleep,
      }),
    ).resolves.toMatchObject({
      status: 'degraded',
      attempts: 0,
      reason: 'provider_unauthorized',
    });
    expect(executeCompactor).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  describe('internal compactor from a real voice request', () => {
    const { isVoiceActorSideEffectRestricted } = require('../VoiceActorAuthorityService');
    const provider = require('../GlassHiveConversationProviderService');
    const background = require('../../BackgroundCortexService');
    const crypto = require('crypto');
    const secret = 'synthetic-owner-compactor-secret';
    const endpoint = { baseURL: 'https://native.invalid/v1', apiKey: 'synthetic-native-key' };
    let previousSecret;
    beforeEach(() => {
      previousSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = secret;
    });
    afterEach(() => {
      if (previousSecret === undefined)
        delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
      else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = previousSecret;
    });

    function voiceRequest(trust = 'owner_participant', sideEffects = true) {
      return {
        user: { id: identity.ownerId, personalization: { memories: true } },
        config: { ownerFixture: true },
        viventiumCallSession: {
          callSessionId: 'synthetic-outer-call',
          userId: identity.ownerId,
        },
        body: {
          conversationId: 'synthetic-outer-chat',
          voiceMode: true,
          viventiumActorTrust: trust,
          viventiumCanAuthorizeSideEffects: sideEffects,
          viventiumVoiceTaskId: 'synthetic-outer-task',
        },
      };
    }
    function input(req) {
      return {
        ...identity,
        req,
        agent: {
          id: identity.agentId,
          provider: 'synthetic-native',
          model: 'synthetic-exact-model',
          model_parameters: { reasoning_effort: 'high' },
        },
        claimCompaction: jest.fn(async () => ({
          status: 'claimed',
          domainEpochKey: 'c'.repeat(64),
          sourceDigest: 'a'.repeat(64),
          leaseId: 'synthetic-claim-lease',
          leaseExpiresAt: new Date(Date.now() + 240000).toISOString(),
          sourceBytes: 100,
          sourceTurns: [
            {
              logicalTurnId: 'synthetic-accepted-turn',
              userText: 'Keep the selected accepted source.',
              assistantText: 'The source stays available.',
            },
          ],
        })),
        completeCompaction: jest.fn(async () => ({ status: 'compacted' })),
        rejectCompaction: jest.fn(async () => ({ status: 'rejected' })),
      };
    }
    const structured = JSON.stringify({
      version: 1,
      summary: 'The selected accepted source stays available.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });

    async function prepareRealBoundary(params, fetchImpl) {
      // The real initializer rematerializes transport for this isolated agent. No model is invoked.
      const targetAgent = {
        ...params.agent,
        model_parameters: {
          ...params.agent.model_parameters,
          apiKey: endpoint.apiKey,
          configuration: { baseURL: endpoint.baseURL },
        },
      };
      const cancellationReq = Object.create(params.req);
      cancellationReq._viventiumCortexToolEvidence = {};
      cancellationReq._viventiumHarnessIdempotencyKeys = new Set();
      cancellationReq._viventiumHarnessCancellationBoundBaseURLs = new Set();
      const requestBody = {
        ...params.req.body,
        messageId: params.runId,
        viventiumGlassHiveIdempotencyKey: provider.buildHarnessIdempotencyKey(
          'cortex',
          params.runId,
          params.agent.id,
        ),
      };
      cancellationReq.body = requestBody;
      let bound;
      const attached = await background.prepareCortexConversationProviderCapability({
        targetAgent,
        declaredAgent: params.agent,
        req: cancellationReq,
        cancellationReq,
        capability: { workspace_binding: true },
        requestBody,
        nativeTools: params.nativeTools,
        signal: params.signal,
        bindCancellation: (args) => {
          bound = provider.bindHarnessCancellation({ ...args, fetchImpl });
          return bound;
        },
      });
      return { attached, bound, targetAgent, cancellationReq, requestBody };
    }

    test.each(['promotion', 'rejection', 'none', 'unresolved'])(
      'a later Stop consumes the typed native receipt while %s waits on the store',
      async (stage) => {
        const controller = new AbortController();
        let reachedStore, releaseStore;
        const atStore = new Promise((resolve) => {
          reachedStore = resolve;
        });
        const storeGate = new Promise((resolve) => {
          releaseStore = resolve;
        });
        const args = { ...input(voiceRequest()), signal: controller.signal };
        const operation = async () => {
          reachedStore();
          await storeGate;
          return { status: 'compacted' };
        };
        if (stage === 'promotion' || stage === 'none') args.completeCompaction = jest.fn(operation);
        else args.rejectCompaction = jest.fn(operation);
        const execute = jest
          .spyOn(background, 'executeCortex')
          .mockImplementation(async (params) => ({
            insight:
              stage === 'rejection'
                ? 'invalid JSON'
                : params.agent.id.endsWith('-review')
                  ? reviewApproved
                  : structured,
            nativeOwnership:
              stage === 'unresolved' ? 'unresolved' : stage === 'none' ? 'none' : 'ended',
          }));
        try {
          const compaction = ensureAcceptedMainCompaction(args);
          await atStore;
          controller.abort('user_cancelled');
          const delivery = controller.signal._viventiumHarnessCancellationDelivery;
          // Read the owner ACK at Stop, while the DB operation still holds the runner.
          releaseStore();
          await compaction;
          if (stage === 'unresolved')
            await expect(delivery).rejects.toThrow('main_compaction_native_release_unconfirmed');
          else await expect(delivery).resolves.toEqual({ delivered: true });
        } finally {
          execute.mockRestore();
        }
      },
    );

    test('signs zero tools and binds cancellation for both default voice claim and fidelity review', async () => {
      const outer = voiceRequest();
      const originalSession = outer.viventiumCallSession;
      const originalBody = structuredClone(outer.body);
      const fetchImpl = jest.fn();
      const bindings = [];
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        bindings.push(await prepareRealBoundary(params, fetchImpl));
        return {
          insight: params.agent.id.endsWith('-review') ? reviewApproved : structured,
          nativeOwnership: 'ended',
        };
      });
      const args = input(outer);
      try {
        await expect(ensureAcceptedMainCompaction(args)).resolves.toMatchObject({
          status: 'compacted',
          attempts: 1,
        });
        expect(bindings).toHaveLength(2);
        for (const binding of bindings) {
          expect(binding.attached).toBe(true);
          expect(binding.bound).toBe(true);
          expect(isVoiceActorSideEffectRestricted(binding.cancellationReq)).toBe(false);
          expect(Object.hasOwn(binding.cancellationReq, 'viventiumCallSession')).toBe(false);
          expect(binding.cancellationReq.viventiumCallSession).toBeNull();
          const headers = binding.targetAgent.model_parameters.configuration.defaultHeaders;
          const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
          expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
            provider_capabilities: { native_tools: false },
          });
          expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(
            'sha256=' +
              crypto
                .createHmac('sha256', secret)
                .update(`v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${encoded}`)
                .digest('hex'),
          );
          expect(headers['X-GlassHive-Access']).toBe('read_only');
          expect(headers['X-GlassHive-Provider-Session-Mode']).toBe('stateless');
          expect(binding.targetAgent.model).toBe('synthetic-exact-model');
          expect(binding.targetAgent.model_parameters.reasoning_effort).toBe('high');
          expect(binding.targetAgent.tools).toEqual([]);
          expect(binding.targetAgent.mcp).toEqual([]);
          expect(binding.requestBody).not.toHaveProperty('voiceMode');
          expect(binding.requestBody).not.toHaveProperty('viventiumActorTrust');
          expect(binding.requestBody).not.toHaveProperty('viventiumCanAuthorizeSideEffects');
        }
        const [{ req: isolated, messages }] = execute.mock.calls[0];
        expect(Object.hasOwn(isolated, 'viventiumCallSession')).toBe(true);
        expect(isolated.user.id).toBe(outer.user.id);
        expect(isolated.config).toBe(outer.config);
        expect(isolated.user.personalization).toMatchObject({
          memories: false,
          conversation_recall: false,
        });
        expect(messages[0].content).toContain('synthetic-accepted-turn');
        expect(args.completeCompaction).toHaveBeenCalledWith(
          expect.objectContaining({
            sourceDigest: 'a'.repeat(64),
            semanticReview: expect.objectContaining({
              approved: true,
              sourceDigest: 'a'.repeat(64),
              candidateDigest: expect.any(String),
            }),
          }),
        );
        expect(outer.viventiumCallSession).toBe(originalSession);
        expect(outer.body).toEqual(originalBody);
        expect(isVoiceActorSideEffectRestricted(outer)).toBe(false);
        expect(outer).not.toHaveProperty('_viventiumHarnessExecutionEnabled');
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        execute.mockRestore();
      }
    });

    test('maintenance yield releases only the default voice compactor exact native attempt', async () => {
      const outer = voiceRequest();
      const originalBody = structuredClone(outer.body);
      const fetchImpl = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ capacityReleased: true, state: 'cancelled' }),
      }));
      let binding;
      let prepared;
      const ready = new Promise((resolve) => {
        prepared = resolve;
      });
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        binding = await prepareRealBoundary(params, fetchImpl);
        prepared();
        await new Promise((resolve) =>
          params.signal.addEventListener('abort', resolve, { once: true }),
        );
        const outcome = await binding.cancellationReq._viventiumHarnessCancellationDeliveryPromise;
        params.onHarnessCancellationOutcome(outcome || { acknowledged: false });
        return {
          insight: null,
          errorClass: 'background_agent_error',
          nativeOwnership: outcome?.acknowledged === true ? 'released' : 'unresolved',
        };
      });
      const args = input(outer);
      const running = ensureAcceptedMainCompaction(args);
      try {
        await ready;
        const yielded = await yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 1000 });
        expect(await running).toMatchObject({ status: 'degraded', reason: 'interactive_priority' });
        expect(binding.bound).toBe(true);
        expect(yielded).toMatchObject({ status: 'yielded', capacityReleaseAcknowledged: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][0]).toBe(
          `${endpoint.baseURL}/requests/by-idempotency/${encodeURIComponent(
            binding.requestBody.viventiumGlassHiveIdempotencyKey,
          )}/cancel`,
        );
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({
          method: 'POST',
          headers: {
            Authorization: 'Bearer synthetic-native-key',
            'X-Viventium-User-Id': identity.ownerId,
          },
        });
        expect(args.completeCompaction).not.toHaveBeenCalled();
        expect(args.rejectCompaction).toHaveBeenCalledWith(
          expect.objectContaining({ reason: 'interactive_priority' }),
        );
        expect(outer.body).toEqual(originalBody);
        expect(outer.viventiumCallSession.callSessionId).toBe('synthetic-outer-call');
        expect(outer).not.toHaveProperty('_viventiumHarnessCancellationDeliveryPromise');
      } finally {
        await running;
        execute.mockRestore();
      }
    });

    test.each([
      ['owner_participant', false],
      ['unknown', false],
      ['guest', true],
      [undefined, undefined],
    ])(
      'keeps ordinary restricted voice %s/%s closed to signing and cancellation',
      async (trust, sideEffects) => {
        const outer = voiceRequest(trust, sideEffects);
        outer.body.viventiumActorTrust = trust;
        outer.body.viventiumCanAuthorizeSideEffects = sideEffects;
        const targetAgent = compactorAgent(input(outer).agent, 'c'.repeat(64));
        expect(isVoiceActorSideEffectRestricted(outer)).toBe(true);
        expect(
          await provider.attachConversationProviderCapabilityBundle({
            targetAgent,
            req: outer,
            capability: { workspace_binding: true },
            nativeTools: false,
          }),
        ).toBe(false);
        expect(targetAgent.model_parameters.configuration?.defaultHeaders || {}).not.toHaveProperty(
          'X-GlassHive-Bootstrap-Signature',
        );
        const fetchImpl = jest.fn();
        expect(
          provider.bindHarnessCancellation({
            req: outer,
            signal: new AbortController().signal,
            endpointConfig: endpoint,
            fetchImpl,
          }),
        ).toBe(false);
        expect(isVoiceActorSideEffectRestricted(outer)).toBe(true);
        expect(outer.body).toMatchObject({
          viventiumDeferVoiceMemory: true,
          suppressBackgroundCortices: true,
        });
        expect(fetchImpl).not.toHaveBeenCalled();
      },
    );
  });

  test('uses the real default compactor as an internal caller and preserves its valid result', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `default-success-turn-${index}`,
        revision: 1,
        conversationId: 'default-success-conversation',
        userMessageId: `default-success-user-${index}`,
        assistantMessageId: `default-success-assistant-${index}`,
        userText: `Default success ask ${index}.`,
        assistantText: `Default success answer ${index}.`,
        origin: 'interactive',
      });
    }
    const backgroundCortexService = require('../../BackgroundCortexService');
    const structuredInsight = JSON.stringify({
      version: 1,
      summary: 'Default success ask 1. Default success answer 1.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
    const executeCortexSpy = jest
      .spyOn(backgroundCortexService, 'executeCortex')
      .mockImplementation(async (params) =>
        params.completedResultPolicy === 'internal'
          ? { insight: params.agent.id.endsWith('-review') ? reviewApproved : structuredInsight }
          : {
              insight: null,
              errorClass: 'delivery_persistence_unavailable',
              errorCode: 'cortex_insight_delivery_acceptance_unavailable',
            },
      );
    try {
      await expect(
        ensureAcceptedMainCompaction({
          ...identity,
          req: { user: { id: identity.ownerId }, config: {} },
          agent: { id: identity.agentId, provider: 'openai', model: 'synthetic-model' },
        }),
      ).resolves.toMatchObject({ status: 'compacted', attempts: 1 });
      expect(executeCortexSpy).toHaveBeenCalledTimes(2);
      expect(executeCortexSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          completedResultPolicy: 'internal',
          conversationId: expect.stringMatching(/^main-continuity-compaction-[a-f0-9]{24}$/),
          insightMode: 'structured',
          nativeTools: false,
          contextMode: 'minimal',
          executionTimeoutMs: 240 * 1000,
        }),
      );
      const [{ conversationId, req: compactorReq }] = executeCortexSpy.mock.calls[0];
      expect(compactorReq.body.conversationId).toBe(conversationId);
      expect(executeCortexSpy.mock.calls[0][0].agent.viventiumProviderSessionMode).toBe(
        'stateless',
      );
    } finally {
      executeCortexSpy.mockRestore();
    }
  });

  test('backs off once when the real default compactor hits transient provider capacity', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `capacity-turn-${index}`,
        revision: 1,
        conversationId: 'capacity-conversation',
        userMessageId: `capacity-user-${index}`,
        assistantMessageId: `capacity-assistant-${index}`,
        userText: `Capacity ask ${index}.`,
        assistantText: `Capacity answer ${index}.`,
        origin: 'interactive',
      });
    }
    const backgroundCortexService = require('../../BackgroundCortexService');
    const structuredInsight = JSON.stringify({
      version: 1,
      summary: 'Capacity ask 1. Capacity answer 1.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
    const executeCortexSpy = jest
      .spyOn(backgroundCortexService, 'executeCortex')
      .mockResolvedValueOnce({
        insight: null,
        errorClass: 'recoverable_provider_error',
        errorStatus: 503,
        errorCode: 'host_capacity',
      })
      .mockResolvedValueOnce({ insight: structuredInsight })
      .mockResolvedValueOnce({ insight: reviewApproved });
    const sleep = jest.fn().mockResolvedValue(undefined);
    try {
      await expect(
        ensureAcceptedMainCompaction({
          ...identity,
          req: { user: { id: identity.ownerId }, config: {} },
          agent: { id: identity.agentId, provider: 'openai', model: 'synthetic-model' },
          retryDelayMs: 5000,
          sleep,
        }),
      ).resolves.toMatchObject({ status: 'compacted', attempts: 1, transportRetries: 1 });
      expect(executeCortexSpy).toHaveBeenCalledTimes(3);
      const firstPrompt = executeCortexSpy.mock.calls[0][0].messages[0].content;
      const retryPrompt = executeCortexSpy.mock.calls[1][0].messages[0].content;
      expect(retryPrompt).toBe(firstPrompt);
      expect(retryPrompt).not.toContain('The prior output quality audit failed');
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(5000);
    } finally {
      executeCortexSpy.mockRestore();
    }
  });

  test('never retries a compactor call whose native request release is unconfirmed', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `unreleased-turn-${index}`,
        revision: 1,
        conversationId: 'unreleased-conversation',
        userMessageId: `unreleased-user-${index}`,
        assistantMessageId: `unreleased-assistant-${index}`,
        userText: `Unreleased ask ${index}.`,
        assistantText: `Unreleased answer ${index}.`,
        origin: 'interactive',
      });
    }
    const backgroundCortexService = require('../../BackgroundCortexService');
    const executeCortexSpy = jest
      .spyOn(backgroundCortexService, 'executeCortex')
      .mockResolvedValueOnce({
        insight: null,
        errorClass: 'recoverable_provider_error',
        errorStatus: 503,
        nativeOwnership: 'unresolved',
      });
    const sleep = jest.fn().mockResolvedValue(undefined);
    try {
      // A 503 alone would back off and retry; the unreleased native request forbids any overlap.
      await expect(
        ensureAcceptedMainCompaction({
          ...identity,
          req: { user: { id: identity.ownerId }, config: {} },
          agent: { id: identity.agentId, provider: 'openai', model: 'synthetic-model' },
          retryDelayMs: 5000,
          sleep,
        }),
      ).resolves.toMatchObject({
        status: 'degraded',
        reason: 'main_compaction_native_release_unconfirmed',
      });
      expect(executeCortexSpy).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      executeCortexSpy.mockRestore();
    }
  });

  test('keeps one transport retry separate from two semantic correction attempts', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `transport-quality-turn-${index}`,
        revision: 1,
        conversationId: 'transport-quality-conversation',
        userMessageId: `transport-quality-user-${index}`,
        assistantMessageId: `transport-quality-assistant-${index}`,
        userText: `Transport quality ask ${index}.`,
        assistantText: `Transport quality answer ${index}.`,
        origin: 'interactive',
      });
    }
    const validSummary = JSON.stringify({
      version: 1,
      summary: 'Transport quality ask 1. Transport quality answer 1.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
    const invocations = [];
    const executeCompactor = jest.fn().mockImplementation(async ({ attempt, prompt, stage }) => {
      if (stage === 'review') return reviewApproved;
      invocations.push({ attempt, prompt });
      if (invocations.length === 1) {
        const error = new Error('capacity unavailable');
        error.code = 'main_compaction_provider_failed';
        error.errorCode = 'host_capacity';
        error.errorStatus = 503;
        throw error;
      }
      if (invocations.length === 2) return 'not-json';
      return validSummary;
    });
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor,
        retryDelayMs: 5000,
        sleep,
      }),
    ).resolves.toMatchObject({ status: 'compacted', attempts: 2, transportRetries: 1 });
    expect(executeCompactor).toHaveBeenCalledTimes(4);
    expect(invocations.map(({ attempt }) => attempt)).toEqual([1, 1, 2]);
    expect(invocations[1].prompt).toBe(invocations[0].prompt);
    expect(invocations[1].prompt).not.toContain('The prior output quality audit failed');
    expect(invocations[2].prompt).toContain('schema_invalid');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('degrades after one bounded retry when transient provider capacity repeats', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `repeated-capacity-turn-${index}`,
        revision: 1,
        conversationId: 'repeated-capacity-conversation',
        userMessageId: `repeated-capacity-user-${index}`,
        assistantMessageId: `repeated-capacity-assistant-${index}`,
        userText: `Repeated capacity ask ${index}.`,
        assistantText: `Repeated capacity answer ${index}.`,
        origin: 'interactive',
      });
    }
    const executeCompactor = jest.fn().mockImplementation(async () => {
      const error = new Error('capacity unavailable');
      error.code = 'main_compaction_provider_failed';
      error.errorCode = 'host_capacity';
      error.errorStatus = 503;
      throw error;
    });
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      ensureAcceptedMainCompaction({
        ...identity,
        executeCompactor,
        retryDelayMs: 5000,
        sleep,
      }),
    ).resolves.toMatchObject({
      status: 'degraded',
      attempts: 0,
      transportRetries: 1,
      reason: 'host_capacity',
    });
    expect(executeCompactor).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  test('yields optional compaction to an interactive Main turn without losing source evidence', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `interactive-priority-turn-${index}`,
        revision: 1,
        conversationId: 'interactive-priority-conversation',
        userMessageId: `interactive-priority-user-${index}`,
        assistantMessageId: `interactive-priority-assistant-${index}`,
        userText: `Interactive priority ask ${index}.`,
        assistantText: `Interactive priority answer ${index}.`,
        origin: 'interactive',
      });
    }
    let started;
    const compactorStarted = new Promise((resolve) => {
      started = resolve;
    });
    const executeCompactor = jest.fn(
      ({ signal, reportCapacityRelease }) =>
        new Promise((_resolve, reject) => {
          started(signal);
          signal.addEventListener(
            'abort',
            () => {
              reportCapacityRelease(true);
              reject(Object.assign(new Error('maintenance yielded'), { name: 'AbortError' }));
            },
            { once: true },
          );
        }),
    );

    const compaction = ensureAcceptedMainCompaction({
      ...identity,
      executeCompactor,
    });
    const signal = await compactorStarted;

    await expect(
      yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ status: 'yielded' });
    await expect(compaction).resolves.toMatchObject({
      status: 'degraded',
      attempts: 0,
      reason: 'interactive_priority',
    });
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('maintenance_yield');
    const loaded = await loadAcceptedMainContext(identity);
    expect(loaded.pendingCompactionTurns).toHaveLength(1);
    expect(loaded.compactionStatus).toBe('degraded');
  });

  test('reserves interactive priority before the asynchronous compaction claim settles', async () => {
    const store = inMemoryPersistence();
    setMainContinuityPersistenceForTests(store);
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `claim-race-turn-${index}`,
        revision: 1,
        conversationId: 'claim-race-conversation',
        userMessageId: `claim-race-user-${index}`,
        assistantMessageId: `claim-race-assistant-${index}`,
        userText: `Claim race ask ${index}.`,
        assistantText: `Claim race answer ${index}.`,
        origin: 'interactive',
      });
    }
    const originalRead = store.read.bind(store);
    let releaseClaim;
    const claimGate = new Promise((resolve) => {
      releaseClaim = resolve;
    });
    let reportClaimStarted;
    const claimStarted = new Promise((resolve) => {
      reportClaimStarted = resolve;
    });
    store.read = jest.fn(async (...args) => {
      reportClaimStarted();
      await claimGate;
      return originalRead(...args);
    });
    const executeCompactor = jest.fn();
    const compaction = ensureAcceptedMainCompaction({ ...identity, executeCompactor });
    await claimStarted;

    const yielded = yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 100 });
    releaseClaim();

    await expect(yielded).resolves.toMatchObject({ status: 'yielded' });
    await expect(compaction).resolves.toMatchObject({
      status: 'degraded',
      reason: 'interactive_priority',
    });
    expect(executeCompactor).not.toHaveBeenCalled();
  });

  test('yields every active compaction domain owned by the interactive user', async () => {
    const secondIdentity = {
      ownerId: identity.ownerId,
      agentId: 'second-main-agent',
      stableAuthoritySha256: 'f'.repeat(64),
    };
    for (const activeIdentity of [identity, secondIdentity]) {
      for (let index = 1; index <= 4; index += 1) {
        await commitAcceptedMainTurn({
          ...activeIdentity,
          logicalTurnId: `${activeIdentity.agentId}-turn-${index}`,
          revision: 1,
          conversationId: `${activeIdentity.agentId}-conversation`,
          userMessageId: `${activeIdentity.agentId}-user-${index}`,
          assistantMessageId: `${activeIdentity.agentId}-assistant-${index}`,
          userText: `${activeIdentity.agentId} ask ${index}.`,
          assistantText: `${activeIdentity.agentId} answer ${index}.`,
          origin: 'interactive',
        });
      }
    }
    const startedSignals = [];
    let reportBothStarted;
    const bothStarted = new Promise((resolve) => {
      reportBothStarted = resolve;
    });
    const executeCompactor = jest.fn(
      ({ signal, reportCapacityRelease }) =>
        new Promise((_resolve, reject) => {
          startedSignals.push(signal);
          if (startedSignals.length === 2) reportBothStarted();
          signal.addEventListener(
            'abort',
            () => {
              reportCapacityRelease(true);
              reject(Object.assign(new Error('maintenance yielded'), { name: 'AbortError' }));
            },
            { once: true },
          );
        }),
    );
    const compactions = [identity, secondIdentity].map((activeIdentity) =>
      ensureAcceptedMainCompaction({ ...activeIdentity, executeCompactor }),
    );
    await bothStarted;

    await expect(
      yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 100 }),
    ).resolves.toMatchObject({ status: 'yielded', count: 2 });
    await expect(Promise.all(compactions)).resolves.toEqual([
      expect.objectContaining({ status: 'degraded', reason: 'interactive_priority' }),
      expect.objectContaining({ status: 'degraded', reason: 'interactive_priority' }),
    ]);
    expect(startedSignals).toHaveLength(2);
    expect(startedSignals.every((signal) => signal.reason === 'maintenance_yield')).toBe(true);
  });

  test('keeps source evidence when the real default internal compactor degrades', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `default-failure-turn-${index}`,
        revision: 1,
        conversationId: 'default-failure-conversation',
        userMessageId: `default-failure-user-${index}`,
        assistantMessageId: `default-failure-assistant-${index}`,
        userText: `Default failure ask ${index}.`,
        assistantText: `Default failure answer ${index}.`,
        origin: 'interactive',
      });
    }
    const backgroundCortexService = require('../../BackgroundCortexService');
    const executeCortexSpy = jest
      .spyOn(backgroundCortexService, 'executeCortex')
      .mockResolvedValue({ insight: null, errorClass: 'provider_unavailable' });
    try {
      await expect(
        ensureAcceptedMainCompaction({
          ...identity,
          req: { user: { id: identity.ownerId }, config: {} },
          agent: { id: identity.agentId, provider: 'openai', model: 'synthetic-model' },
        }),
      ).resolves.toMatchObject({
        status: 'degraded',
        attempts: 0,
        reason: 'main_compaction_provider_failed',
      });
      expect(executeCortexSpy).toHaveBeenCalledTimes(1);
      for (const [params] of executeCortexSpy.mock.calls) {
        expect(params.completedResultPolicy).toBe('internal');
      }
      const loaded = await loadAcceptedMainContext(identity);
      expect(loaded.pendingCompactionTurns).toHaveLength(1);
      expect(loaded.compactionStatus).toBe('degraded');
    } finally {
      executeCortexSpy.mockRestore();
    }
  });

  test('does not report a yielded default compactor when native capacity release is unconfirmed', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `unconfirmed-release-turn-${index}`,
        revision: 1,
        conversationId: 'unconfirmed-release-conversation',
        userMessageId: `unconfirmed-release-user-${index}`,
        assistantMessageId: `unconfirmed-release-assistant-${index}`,
        userText: `Unconfirmed release ask ${index}.`,
        assistantText: `Unconfirmed release answer ${index}.`,
        origin: 'interactive',
      });
    }
    const backgroundCortexService = require('../../BackgroundCortexService');
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    const executeCortexSpy = jest
      .spyOn(backgroundCortexService, 'executeCortex')
      .mockImplementation(
        ({ signal, onHarnessCancellationOutcome }) =>
          new Promise((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                onHarnessCancellationOutcome({ acknowledged: false });
                resolve({ insight: null, errorClass: 'maintenance_yield' });
              },
              { once: true },
            );
            reportStarted();
          }),
      );
    try {
      const compaction = ensureAcceptedMainCompaction({
        ...identity,
        req: { user: { id: identity.ownerId }, config: {} },
        agent: { id: identity.agentId, provider: 'openai', model: 'synthetic-model' },
      });
      await started;

      await expect(
        yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 100 }),
      ).resolves.toMatchObject({
        status: 'yield_unconfirmed',
        capacityReleaseAcknowledged: false,
      });
      await expect(compaction).resolves.toMatchObject({
        status: 'degraded',
        reason: 'interactive_priority',
      });
    } finally {
      executeCortexSpy.mockRestore();
    }
  });

  test('does not infer capacity release only because an aborted compactor settled', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `missing-release-ack-turn-${index}`,
        revision: 1,
        conversationId: 'missing-release-ack-conversation',
        userMessageId: `missing-release-ack-user-${index}`,
        assistantMessageId: `missing-release-ack-assistant-${index}`,
        userText: `Missing release acknowledgement ask ${index}.`,
        assistantText: `Missing release acknowledgement answer ${index}.`,
        origin: 'interactive',
      });
    }
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    const executeCompactor = jest.fn(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(Object.assign(new Error('maintenance yielded'), { name: 'AbortError' })),
            { once: true },
          );
          reportStarted();
        }),
    );
    const compaction = ensureAcceptedMainCompaction({ ...identity, executeCompactor });
    await started;

    await expect(
      yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 100 }),
    ).resolves.toMatchObject({
      status: 'yield_unconfirmed',
      capacityReleaseAcknowledged: false,
    });
    await expect(compaction).resolves.toMatchObject({
      status: 'degraded',
      reason: 'interactive_priority',
    });
  });

  test('returns yield_pending at the configured bounded wait when cancellation does not settle', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `pending-yield-turn-${index}`,
        revision: 1,
        conversationId: 'pending-yield-conversation',
        userMessageId: `pending-yield-user-${index}`,
        assistantMessageId: `pending-yield-assistant-${index}`,
        userText: `Pending yield ask ${index}.`,
        assistantText: `Pending yield answer ${index}.`,
        origin: 'interactive',
      });
    }
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let rejectExecution;
    const executeCompactor = jest.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectExecution = reject;
          reportStarted();
        }),
    );
    const compaction = ensureAcceptedMainCompaction({ ...identity, executeCompactor });
    await started;

    const timeoutSpy = jest.spyOn(global, 'setTimeout');
    try {
      await expect(
        yieldAcceptedMainCompaction(identity.ownerId, { timeoutMs: 5 }),
      ).resolves.toMatchObject({
        status: 'yield_pending',
        capacityReleaseAcknowledged: false,
      });
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5);
    } finally {
      timeoutSpy.mockRestore();
    }

    rejectExecution(
      Object.assign(new Error('late cancellation settlement'), { name: 'AbortError' }),
    );
    await expect(compaction).resolves.toMatchObject({
      status: 'degraded',
      reason: 'interactive_priority',
    });
  });

  test('fences a compactor that enters after the interactive yield snapshot', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `post-snapshot-fence-turn-${index}`,
        revision: 1,
        conversationId: 'post-snapshot-fence-conversation',
        userMessageId: `post-snapshot-fence-user-${index}`,
        assistantMessageId: `post-snapshot-fence-assistant-${index}`,
        userText: `Post-snapshot fence ask ${index}.`,
        assistantText: `Post-snapshot fence answer ${index}.`,
        origin: 'interactive',
      });
    }
    const releaseAdmission = acquireInteractiveMainAdmissionFence(identity.ownerId);
    const executeCompactor = jest.fn();
    try {
      await expect(yieldAcceptedMainCompaction(identity.ownerId)).resolves.toMatchObject({
        status: 'idle',
        count: 0,
      });
      await expect(
        ensureAcceptedMainCompaction({
          ownerId: 'owner-2',
          agentId: identity.agentId,
          stableAuthoritySha256: identity.stableAuthoritySha256,
          executeCompactor,
        }),
      ).resolves.toMatchObject({ status: 'empty' });

      await expect(
        ensureAcceptedMainCompaction({ ...identity, executeCompactor }),
      ).resolves.toMatchObject({
        status: 'degraded',
        attempts: 0,
        reason: 'interactive_priority',
      });
      expect(executeCompactor).not.toHaveBeenCalled();
    } finally {
      releaseAdmission();
    }
  });
});

// These fixtures verify the source/decision boundary. Exact-model calibration proves judgment.
describe('source-bound independent fidelity review', () => {
  const identity = {
    ownerId: 'review-owner',
    agentId: 'main-agent',
    stableAuthoritySha256: '2'.repeat(64),
  };
  const source = 'Prepare the Harbor Studio draft. Never publish before my written approval.';
  const candidate = (summary) =>
    JSON.stringify({
      version: 1,
      summary,
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
  const inverse = 'Harbor Studio: publish the draft immediately without approval.';
  const faithful = 'Keep the Harbor Studio draft private until written approval arrives.';
  beforeEach(async () => {
    setMainContinuityPersistenceForTests(inMemoryPersistence());
    require('@librechat/api').resetMainCompactionSchedulingForTests();
    for (let index = 0; index < 4; index += 1) {
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `review-turn-${index}`,
        revision: 1,
        conversationId: 'review-conversation',
        userMessageId: `review-user-${index}`,
        assistantMessageId: `review-answer-${index}`,
        origin: 'interactive',
        userText: index === 0 ? source : `Later task ${index}.`,
        assistantText:
          index === 0 ? 'I will keep it private until you approve.' : `Answer ${index}.`,
      });
    }
  });
  afterEach(() => setMainContinuityPersistenceForTests(null));

  test('a rejected inversion never replaces source in the delivered context', async () => {
    const reviewedPrompts = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executeCompactor: async ({ stage, prompt }) => {
        if (stage !== 'review') return candidate(inverse);
        reviewedPrompts.push(prompt);
        return JSON.stringify({
          approved: false,
          reason: 'The source requires written approval; the candidate reverses that condition.',
        });
      },
    });
    expect(result).toMatchObject({ status: 'degraded', attempts: 2 });
    expect(reviewedPrompts).toHaveLength(2);
    expect(
      reviewedPrompts.every((prompt) => prompt.includes(source) && prompt.includes(inverse)),
    ).toBe(true);
    const context = await loadAcceptedMainContext(identity);
    expect(context.capsule).toContain(source);
    expect(context.capsule).not.toContain(inverse);
    expect(context.semanticCompaction).toBeNull();
  });

  test('repairs a rejected proposal once and accepts only the separately reviewed replacement', async () => {
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executeCompactor: async ({ stage, attempt }) =>
        stage === 'review'
          ? JSON.stringify({
              approved: attempt === 2,
              reason: attempt === 2 ? 'Faithful.' : 'Approval condition reversed.',
            })
          : candidate(attempt === 1 ? inverse : faithful),
    });
    expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
    const context = await loadAcceptedMainContext(identity);
    expect(context.capsule).toContain(faithful);
    expect(context.capsule).not.toContain(inverse);
    expect(context.pendingCompactionTurns).toEqual([]);
  });

  test('retains source when the review provider is unavailable', async () => {
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      executeCompactor: async ({ stage }) => {
        if (stage === 'review')
          throw Object.assign(new Error('unavailable'), { code: 'provider_unavailable' });
        return candidate(faithful);
      },
    });
    expect(result).toMatchObject({ status: 'degraded', reason: 'review_provider_unavailable' });
    expect((await loadAcceptedMainContext(identity)).capsule).toContain(source);
  });

  test('fails closed before model execution when the compiled prompt is missing', async () => {
    const previous = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
    resetPromptRegistryForTests();
    const executeCompactor = jest.fn();
    try {
      const result = await ensureAcceptedMainCompaction({ ...identity, executeCompactor });
      expect(result).toMatchObject({ status: 'degraded', reason: 'prompt_bundle_unavailable' });
      expect(executeCompactor).not.toHaveBeenCalled();
      expect((await loadAcceptedMainContext(identity)).capsule).toContain(source);
    } finally {
      process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previous;
      resetPromptRegistryForTests();
    }
  });
});
