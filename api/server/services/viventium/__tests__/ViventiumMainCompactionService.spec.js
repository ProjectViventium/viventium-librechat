'use strict';
jest.mock('../ViventiumMainContinuityService', () => require('./fixtures/mainContinuity')());
jest.mock('../CallSessionService', () => ({
  getActiveCallSessionForMainMaintenance: jest.fn(async () => null),
}));
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
  flushEndedCallMainCompactions,
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
  test('repairs candidate-only tool identities before spending an independent review call', async () => {
    const pair = {
      callId: 'call_opaque_001',
      toolName: 'read_record',
      outcome: 'Record value is 7.',
    };
    const candidate = {
      version: 1,
      summary: 'Record value is 7.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [pair],
    };
    const claim = {
      status: 'claimed',
      leaseId: 'typed-identity-repair',
      domainEpochKey: 'typed-identity-domain',
      sourceDigest: 'b'.repeat(64),
      sourceBytes: 500,
      previousSemanticCompaction: null,
      sourceTurns: [{ toolPairs: [pair] }],
      leaseExpiresAt: new Date(Date.now() + 300000),
    };
    const stages = [],
      prompts = [];
    let generated = 0;
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      claimCompaction: async () => claim,
      completeCompaction: async () => ({ status: 'compacted' }),
      rejectCompaction: async () => ({ status: 'degraded' }),
      executeCompactor: async (call) => {
        stages.push(call.stage || 'compaction');
        prompts.push(call.prompt);
        call.reportCapacityRelease(true);
        if (call.stage === 'review') return reviewApproved;
        generated += 1;
        return JSON.stringify(
          generated === 1
            ? { ...candidate, toolPairs: [{ ...pair, callId: 'call_opaque_00I' }] }
            : candidate,
        );
      },
    });
    expect(result).toMatchObject({ status: 'compacted', attempts: 2 });
    expect(stages).toEqual(['compaction', 'compaction', 'review']);
    expect(prompts[1]).toContain('"constraint":"source_identity"');
    expect(prompts[2]).toContain('"typedToolIdentityComparison":{"version":1,"exactMatches":');
    expect(prompts[2]).toContain('"sourceLocations":["sourceTurns.0.toolPairs.0"]');
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
    'repairs %s without replacing accepted source or echoing an oversized draft',
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
        issue: { constraint },
      });
      if (constraint === 'max_bytes') expect(payloads[1].priorRejection.candidate).toBeUndefined();
      else expect(payloads[1].priorRejection.candidate).toBe(rejected);
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

  test('an indivisible source fits a size correction without duplicating its rejected draft', async () => {
    const valid = {
      version: 1,
      summary: 'Permission and the pending task remain unresolved.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const previousSemanticCompaction = { ...valid, summary: 's'.repeat(80000) };
    const legacyInputs = [
      {
        kind: 'legacy_state',
        id: 'legacy-artifact',
        semanticCompaction: { ...valid, summary: 'l'.repeat(39000) },
        sourceTurns: [
          {
            logicalTurnId: 'whole-turn',
            revision: 1,
            userText: 'Keep permission required.',
            assistantText: 'The task is still pending.',
            toolPairs: [],
          },
        ],
        sourceRange: { artifactId: 'legacy-artifact', start: 0, end: 1, total: 3 },
      },
    ];
    const rejected = JSON.stringify({ ...valid, summary: 'd'.repeat(90000) });
    const outputContract = {
      version: 1,
      consumer: 'accepted_core',
      carrierMaxUtf8Bytes: 131072,
      reservedUtf8Bytes: 57388,
      maxJsonUtf8Bytes: 73684,
      maxSummaryUtf8Bytes: 73684,
      maxItemsPerArray: 32,
      maxStringItemUtf8Bytes: 1024,
      maxToolIdentityCharacters: 256,
    };
    const claim = {
      status: 'claimed',
      leaseId: 'indivisible-size',
      domainEpochKey: 'size-domain',
      sourceDigest: '9'.repeat(64),
      sourceBytes: 121050,
      sourceTurns: [],
      legacyInputs,
      previousSemanticCompaction,
      outputContract,
      canReduceSource: false,
      leaseExpiresAt: new Date(Date.now() + 300000),
    };
    const original = structuredClone(claim);
    const completeCompaction = jest.fn(async () => ({ status: 'compacted' }));
    const rejectCompaction = jest.fn();
    const calls = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      claimCompaction: async () => claim,
      completeCompaction,
      rejectCompaction,
      executeCompactor: async (call) => {
        calls.push(call);
        if (Buffer.byteLength(call.prompt) > 196608)
          throw Object.assign(new Error('Request exceeds native byte budget'), {
            errorStatus: 413,
          });
        return calls.length === 1
          ? rejected
          : call.stage === 'review'
            ? reviewApproved
            : JSON.stringify(valid);
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
    const correction = payloads[1];
    expect(correction.priorRejection).toMatchObject({
      code: 'schema_invalid',
      issue: { constraint: 'max_bytes', limit: 73684 },
    });
    expect(correction.priorRejection.candidate).toBeUndefined();
    const oldCorrection = {
      ...correction,
      priorRejection: { ...correction.priorRejection, candidate: rejected },
    };
    expect(Buffer.byteLength(JSON.stringify(oldCorrection))).toBeGreaterThan(196608);
    for (const payload of payloads) {
      expect(payload.previousSemanticCompaction).toEqual(original.previousSemanticCompaction);
      expect(payload.legacyInputs).toEqual(original.legacyInputs);
      expect(payload.acceptedOlderTurns).toEqual(original.sourceTurns);
      expect(payload.sourceDigest).toBe(original.sourceDigest);
      expect(payload.outputConstraints).toEqual(original.outputContract);
    }
    expect(calls[2].stage).toBe('review');
    expect(payloads[2].candidate).toEqual(valid);
    expect(completeCompaction).toHaveBeenCalledTimes(1);
    expect(completeCompaction.mock.calls[0][0].semanticReview.approved).toBe(true);
    expect(rejectCompaction).not.toHaveBeenCalled();
  });

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
    const executionBudget = {
      completionReserveMs: 200000,
      slowestCallMs: 100000,
      slowestCompactionCallMs: 100000,
      slowestReviewCallMs: 100000,
    };
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

    test('stop when the store lease cannot hold the measured next repair stage', async () => {
      await commitTurns('lease');
      const { result, calls } = await run(
        [oversized(17), oversized(16), oversized(15), JSON.stringify(fitting)],
        110 * 1000,
      );
      expect(result).toMatchObject({
        status: 'degraded',
        attempts: 2,
        reason: 'compaction_lease_expired',
      });
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

    test('a long detached native producer reaches review with a renewed live claim and its own deadline', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1000);
      const args = input(voiceRequest());
      args.req.config.endpoints = {
        agents: {
          providerCapabilities: {
            'synthetic-native': { workspace_binding: true, conversation_session: true },
          },
        },
      };
      args.renewCompaction = jest.fn(async ({ leaseExpiresAt, expiresAt }) => {
        expect(new Date(leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
        return { status: 'renewed', leaseExpiresAt: expiresAt.toISOString() };
      });
      let started;
      const admitted = new Promise((resolve) => {
        started = resolve;
      });
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        expect(typeof params.onNativeAdmission).toBe('function');
        expect(
          await params.onNativeAdmission({
            requestId: params.agent.id,
            responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
          }),
        ).toBe(true);
        if (!params.agent.id.endsWith('-review')) {
          started();
          await new Promise((resolve) => setTimeout(resolve, 660000));
          return { insight: structured, nativeOwnership: 'ended' };
        }
        // Fresh stage admission replenishes the short lease left by the long producer.
        expect(params.executionTimeoutMs).toBe(240000);
        return { insight: reviewApproved, nativeOwnership: 'ended' };
      });
      try {
        const result = ensureAcceptedMainCompaction(args);
        await Promise.race([
          admitted,
          result.then(() => {
            throw new Error('Producer not admitted');
          }),
        ]);
        await jest.advanceTimersByTimeAsync(660000);
        expect(await result).toMatchObject({ status: 'compacted' });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(args.renewCompaction.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        execute.mockRestore();
        jest.useRealTimers();
      }
    });

    test('a finite idle batch admits a fitting native deadline and still reaches reviewed promotion', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(1000);
      const args = input(voiceRequest());
      args.trigger = 'accepted_turn';
      args.foreground = false;
      args.req.viventiumCallSession = null;
      args.req.config.endpoints = {
        agents: {
          providerCapabilities: {
            'synthetic-native': { workspace_binding: true, conversation_session: true },
          },
        },
      };
      args.renewCompaction = jest.fn(async ({ expiresAt }) => ({
        status: 'renewed',
        leaseExpiresAt: expiresAt.toISOString(),
      }));
      let started;
      const admitted = new Promise((resolve) => {
        started = resolve;
      });
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        expect(typeof params.onNativeAdmission).toBe('function');
        const accepted = await params.onNativeAdmission({
          requestId: params.agent.id,
          responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
        });
        if (!params.agent.id.endsWith('-review')) {
          expect(accepted).toBe(true);
          started();
          await new Promise((resolve) => setTimeout(resolve, 660000));
          return { insight: structured, nativeOwnership: 'ended' };
        }
        // Another complete native deadline would exceed the same twenty-minute batch.
        expect(accepted).toBe(false);
        return { insight: reviewApproved, nativeOwnership: 'ended' };
      });
      try {
        const result = ensureAcceptedMainCompaction(args);
        await Promise.race([
          admitted,
          result.then(() => {
            throw new Error('Finite producer not admitted');
          }),
        ]);
        await jest.advanceTimersByTimeAsync(660000);
        expect(await result).toMatchObject({ status: 'compacted' });
        expect(execute).toHaveBeenCalledTimes(2);
        expect(args.renewCompaction.mock.calls.length).toBeGreaterThanOrEqual(4);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        execute.mockRestore();
        jest.useRealTimers();
      }
    });

    test.each([
      { batchMs: 1200000, claims: 2 },
      { batchMs: 800000, claims: 1 },
      { batchMs: 1200000, claims: 3, rearm: true },
      {
        batchMs: 1200000,
        claims: 1,
        completionReserveMs: 240000,
        producerMs: 330000,
        reviewMs: 30000,
      },
    ])(
      'long Native stages retain bounded continuation: %p',
      async ({
        batchMs,
        claims,
        rearm = false,
        completionReserveMs = 0,
        producerMs = 400000,
        reviewMs = 20000,
      }) => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);
        const args = input(voiceRequest());
        args.trigger = 'accepted_turn';
        args.req.viventiumCallSession = null;
        if (!rearm) args.deadlineAt = new Date(Date.now() + batchMs).toISOString();
        args.executionBudget = { completionReserveMs };
        args.req.config.endpoints = {
          agents: {
            providerCapabilities: {
              'synthetic-native': { workspace_binding: true, conversation_session: true },
            },
          },
        };
        args.renewCompaction = jest.fn(async ({ expiresAt }) => ({
          status: 'renewed',
          leaseExpiresAt: expiresAt.toISOString(),
        }));
        let completed = 0;
        args.completeCompaction = jest.fn(async () => ({
          status: 'compacted',
          continuationPending: ++completed < (rearm ? 3 : 2),
        }));
        let started;
        const admitted = new Promise((resolve) => {
          started = resolve;
        });
        const execute = jest
          .spyOn(background, 'executeCortex')
          .mockImplementation(async (params) => {
            expect(params.executionTimeoutMs).toBeLessThanOrEqual(240000);
            const review = params.agent.id.endsWith('-review');
            const accepted = await params.onNativeAdmission({
              requestId: params.agent.id,
              responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
            });
            if (!review) {
              expect(accepted).toBe(true);
              started();
            }
            await new Promise((resolve) => setTimeout(resolve, review ? reviewMs : producerMs));
            return { insight: review ? reviewApproved : structured, nativeOwnership: 'ended' };
          });
        try {
          const result = ensureAcceptedMainCompaction(args);
          await Promise.race([
            admitted,
            result.then(() => {
              throw new Error('First producer not admitted');
            }),
          ]);
          await jest.runAllTimersAsync();
          const final = await result;
          expect(completed).toBe(claims);
          expect(args.claimCompaction).toHaveBeenCalledTimes(claims);
          expect(execute).toHaveBeenCalledTimes(claims * 2);
          expect(args.executionBudget.slowestCompactionCallMs).toBe(producerMs);
          expect(args.executionBudget.slowestReviewCallMs).toBe(reviewMs);
          expect(args.executionBudget.nativeCompactionAdmissionWindowMs).toBe(
            660000 + background.getCortexExecutionGuardGraceMs(),
          );
          expect(final).toMatchObject(
            claims >= 2
              ? { status: 'compacted' }
              : { status: 'compacted', continuationPending: true, reason: 'idle_budget_exhausted' },
          );
          expect(jest.getTimerCount()).toBe(0);
        } finally {
          execute.mockRestore();
          jest.useRealTimers();
        }
      },
    );

    test.each([-1, 0, 1])(
      'native deadline plus grace/reserve respects the finite boundary (%j)',
      async (delta) => {
        jest.useFakeTimers();
        jest.setSystemTime(1000);
        const args = input(voiceRequest());
        args.deadlineAt = new Date(Date.now() + 1200000).toISOString();
        args.executionBudget = { completionReserveMs: 10000 };
        args.req.config.endpoints = {
          agents: {
            providerCapabilities: {
              'synthetic-native': { workspace_binding: true, conversation_session: true },
            },
          },
        };
        args.renewCompaction = jest.fn(async ({ expiresAt }) => ({
          status: 'renewed',
          leaseExpiresAt: expiresAt.toISOString(),
        }));
        const grace = background.getCortexExecutionGuardGraceMs();
        args.renewCompaction.mockImplementation(async ({ expiresAt }) => {
          expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.parse(args.deadlineAt) - 10000);
          return { status: 'renewed', leaseExpiresAt: expiresAt.toISOString() };
        });
        const execute = jest
          .spyOn(background, 'executeCortex')
          .mockImplementation(async (params) => {
            expect(typeof params.onNativeAdmission).toBe('function');
            expect(
              await params.onNativeAdmission({
                requestId: params.agent.id,
                responseDeadlineAt: new Date(
                  Date.parse(args.deadlineAt) - grace - 10000 + delta,
                ).toISOString(),
              }),
            ).toBe(delta <= 0);
            return {
              insight: params.agent.id.endsWith('-review') ? reviewApproved : structured,
              nativeOwnership: 'ended',
            };
          });
        try {
          expect(await ensureAcceptedMainCompaction(args)).toMatchObject({ status: 'compacted' });
          if (delta > 0) {
            expect(args.executionBudget.nativeCompactionAdmissionWindowMs).toBeUndefined();
            expect(args.executionBudget.nativeReviewAdmissionWindowMs).toBeUndefined();
          }
        } finally {
          execute.mockRestore();
          jest.useRealTimers();
        }
      },
    );

    test('foreground admission still cancels an admitted finite native compaction', async () => {
      const args = input(voiceRequest());
      args.deadlineAt = new Date(Date.now() + 1200000).toISOString();
      args.executionBudget = { completionReserveMs: 0 };
      args.req.config.endpoints = {
        agents: {
          providerCapabilities: {
            'synthetic-native': { workspace_binding: true, conversation_session: true },
          },
        },
      };
      args.renewCompaction = jest.fn(async ({ expiresAt }) => ({
        status: 'renewed',
        leaseExpiresAt: expiresAt.toISOString(),
      }));
      let started;
      const admitted = new Promise((resolve) => {
        started = resolve;
      });
      let observedSignal;
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        expect(
          await params.onNativeAdmission({
            requestId: params.agent.id,
            responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
          }),
        ).toBe(true);
        observedSignal = params.signal;
        started();
        await new Promise((resolve) =>
          params.signal.addEventListener('abort', resolve, { once: true }),
        );
        params.reportCapacityRelease(true);
        return { error: 'cancelled', nativeOwnership: 'ended' };
      });
      let release;
      try {
        const result = ensureAcceptedMainCompaction(args);
        await Promise.race([
          admitted,
          result.then(() => {
            throw new Error('Finite producer not admitted');
          }),
        ]);
        release = acquireInteractiveMainAdmissionFence(identity.ownerId);
        await yieldAcceptedMainCompaction(identity.ownerId);
        expect(observedSignal.aborted).toBe(true);
        expect(await result).toMatchObject({ status: 'degraded', reason: 'interactive_priority' });
        expect(args.completeCompaction).not.toHaveBeenCalled();
      } finally {
        release?.();
        execute.mockRestore();
      }
    });

    test('prestage CAS contention keeps the original bounded guard without cancelling valid work', async () => {
      const args = input(voiceRequest());
      args.req.config.endpoints = {
        agents: {
          providerCapabilities: {
            'synthetic-native': { workspace_binding: true, conversation_session: true },
          },
        },
      };
      args.renewCompaction = jest.fn(async () => ({ status: 'busy' }));
      const execute = jest.spyOn(background, 'executeCortex').mockImplementation(async (params) => {
        expect(params.signal.aborted).toBe(false);
        expect(params.executionTimeoutMs).toBeLessThanOrEqual(240000);
        expect(
          await params.onNativeAdmission({
            requestId: params.agent.id,
            responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
          }),
        ).toBe(false);
        expect(params.signal.aborted).toBe(false);
        return {
          insight: params.agent.id.endsWith('-review') ? reviewApproved : structured,
          nativeOwnership: 'ended',
        };
      });
      try {
        expect(await ensureAcceptedMainCompaction(args)).toMatchObject({ status: 'compacted' });
        expect(execute).toHaveBeenCalledTimes(2);
      } finally {
        execute.mockRestore();
      }
    });

    test.each(['foreground', 'non-native', 'no-renewal'])(
      'keeps the legacy native deadline policy for %s',
      async (mode) => {
        const args = input(voiceRequest());
        args.req.config.endpoints = {
          agents: {
            providerCapabilities: {
              'synthetic-native': { workspace_binding: true, conversation_session: true },
            },
          },
        };
        if (mode !== 'no-renewal')
          args.renewCompaction = jest.fn(async () => ({ status: 'stale_lease' }));
        if (mode === 'foreground') args.foreground = true;
        if (mode === 'non-native') args.req.config.endpoints.agents.providerCapabilities = {};
        const execute = jest
          .spyOn(background, 'executeCortex')
          .mockImplementation(async (params) => {
            expect(params.onNativeAdmission).toBeUndefined();
            expect(params.executionTimeoutMs).toBeLessThanOrEqual(240000);
            return {
              insight: params.agent.id.endsWith('-review') ? reviewApproved : structured,
              nativeOwnership: 'ended',
            };
          });
        try {
          expect(await ensureAcceptedMainCompaction(args)).toMatchObject({ status: 'compacted' });
        } finally {
          execute.mockRestore();
        }
      },
    );

    test('uses canonical Main primary and fallback for producer and reviewer after a Voice override', async () => {
      const args = input(voiceRequest());
      const { retainMainCompactionRoute } = require('@librechat/api');
      retainMainCompactionRoute(args.req, {
        ...args.agent,
        provider: 'selected-main',
        model: 'selected-main-model',
        model_parameters: { reasoning_effort: 'high' },
        fallback_llm_provider: 'selected-fallback',
        fallback_llm_model: 'selected-fallback-model',
        fallback_llm_model_parameters: { reasoning_effort: 'high' },
      });
      args.agent = {
        ...args.agent,
        provider: 'selected-voice',
        endpoint: 'selected-voice',
        model: 'selected-voice-model',
        model_parameters: { reasoning_effort: 'low' },
        viventiumFallbackLlmAssignment: {
          provider: 'voice-only-fallback',
          model: 'voice-only-model',
        },
      };
      const execute = jest
        .spyOn(background, 'executeCortex')
        .mockImplementation(async (params) => ({
          insight: params.agent.id.endsWith('-review') ? reviewApproved : structured,
          nativeOwnership: 'ended',
        }));
      try {
        expect(await ensureAcceptedMainCompaction(args)).toMatchObject({ status: 'compacted' });
        expect(execute).toHaveBeenCalledTimes(2);
        for (const [params] of execute.mock.calls) {
          expect(params.agent).toMatchObject({
            provider: 'selected-main',
            endpoint: 'selected-main',
            model: 'selected-main-model',
            model_parameters: { reasoning_effort: 'high' },
            fallback_llm_provider: 'selected-fallback',
            fallback_llm_model: 'selected-fallback-model',
            fallback_llm_model_parameters: { reasoning_effort: 'high' },
          });
          expect(params.agent.viventiumFallbackLlmAssignment).toBeUndefined();
          expect(params.nativeTools).toBe(false);
          expect(params.req.viventiumCallSession).toBeNull();
        }
        expect(args.agent.model).toBe('selected-voice-model');
      } finally {
        execute.mockRestore();
      }
    });

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

describe('active Call compaction scheduling owner', () => {
  const identity = {
    ownerId: 'call-owner',
    agentId: 'call-main',
    stableAuthoritySha256: 'f'.repeat(64),
  };
  const call = () => ({
    userId: identity.ownerId,
    callSessionId: 'active-call',
    status: 'listening',
    expiresAtMs: Date.now() + 60000,
  });
  beforeEach(() => require('@librechat/api').resetMainCompactionSchedulingForTests());
  test('two accepted Voice turns start no model and End enters the existing runner once with the latest input', async () => {
    const claim = jest.fn(async () => ({ status: 'empty' })),
      execute = jest.fn();
    const session = call();
    for (const marker of ['first', 'latest']) {
      expect(
        await ensureAcceptedMainCompaction({
          ...identity,
          trigger: 'accepted_turn',
          req: { viventiumCallSession: session },
          marker,
          claimCompaction: claim,
          executeCompactor: execute,
        }),
      ).toMatchObject({ status: 'deferred', reason: 'active_call' });
    }
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await flushEndedCallMainCompactions({ ...session, status: 'ended' })).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0][0].marker).toBe('latest');
    expect(await flushEndedCallMainCompactions({ ...session, status: 'ended' })).toBe(0);
  });
  test('required foreground recovery during a call executes and removes its deferred duplicate', async () => {
    const session = call(),
      claim = jest.fn(async () => ({ status: 'empty' }));
    const input = { ...identity, req: { viventiumCallSession: session }, claimCompaction: claim };
    await ensureAcceptedMainCompaction({ ...input, trigger: 'accepted_turn' });
    expect(
      await ensureAcceptedMainCompaction({
        ...input,
        trigger: 'context_carrier',
        foreground: true,
      }),
    ).toMatchObject({ status: 'empty' });
    expect(claim).toHaveBeenCalledTimes(1);
    expect(await flushEndedCallMainCompactions({ ...session, status: 'ended' })).toBe(0);
  });
  test('ordinary accepted scheduling and late acceptance after End use the existing runner', async () => {
    const session = call(),
      claim = jest.fn(async () => ({ status: 'empty' }));
    await ensureAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
      claimCompaction: claim,
    });
    await flushEndedCallMainCompactions({ ...session, status: 'ended' });
    await ensureAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
      req: { viventiumCallSession: session },
      claimCompaction: claim,
    });
    expect(claim).toHaveBeenCalledTimes(2);
  });
});

describe('accepted-turn idle continuation binding', () => {
  const identity = {
    ownerId: 'idle-owner',
    agentId: 'idle-main',
    stableAuthoritySha256: 'c'.repeat(64),
  };
  const candidate = JSON.stringify({
    version: 1,
    summary: 'Keep the exact pending request.',
    pendingAsks: [],
    commitments: [],
    corrections: [],
    decisions: [],
    durableIdentifiers: [],
    recurrenceOutcomes: [],
    toolPairs: [],
  });
  beforeEach(() => require('@librechat/api').resetMainCompactionSchedulingForTests());

  test.each(['accepted_turn', 'conversation_legacy'])(
    '%s background trigger advances successive reviewed claims through the same runner',
    async (trigger) => {
      let completed = 0;
      const claimCompaction = jest.fn(async () => ({
        status: 'claimed',
        leaseId: `idle-${completed}`,
        domainEpochKey: 'idle-domain',
        sourceDigest: String(completed + 1).repeat(64),
        sourceBytes: 100,
        sourceTurns: [],
        leaseExpiresAt: new Date(Date.now() + 300000),
      }));
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        trigger,
        foreground: false,
        claimCompaction,
        executeCompactor: async (call) => (call.stage === 'review' ? reviewApproved : candidate),
        completeCompaction: async () => ({
          status: 'compacted',
          continuationPending: ++completed < 3,
        }),
        rejectCompaction: jest.fn(),
      });
      expect(result).toMatchObject({ status: 'compacted', continuationPending: false });
      expect(claimCompaction).toHaveBeenCalledTimes(3);
    },
  );

  test('a foreground fence between reviewed claims stops idle continuation', async () => {
    let release;
    const claimCompaction = jest.fn(async () => ({
      status: 'claimed',
      leaseId: 'yield-idle',
      domainEpochKey: 'idle-yield-domain',
      sourceDigest: 'd'.repeat(64),
      sourceBytes: 100,
      sourceTurns: [],
      leaseExpiresAt: new Date(Date.now() + 300000),
    }));
    try {
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        trigger: 'accepted_turn',
        claimCompaction,
        executeCompactor: async (call) => (call.stage === 'review' ? reviewApproved : candidate),
        completeCompaction: async () => {
          release = acquireInteractiveMainAdmissionFence(identity.ownerId);
          return { status: 'compacted', continuationPending: true };
        },
        rejectCompaction: jest.fn(),
      });
      expect(result).toMatchObject({ status: 'compacted', continuationPending: true });
      expect(claimCompaction).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
    }
  });
});

describe('idle continuation after the finite batch cap', () => {
  test.each(['accepted_turn', 'conversation_legacy'])(
    '%s finishes a fifth reviewed claim after idle without another user acceptance',
    async (trigger) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      let completed = 0;
      const identity = {
        ownerId: 'idle-resume-owner',
        agentId: 'main',
        stableAuthoritySha256: 'b'.repeat(64),
      };
      const candidate = JSON.stringify({
        version: 1,
        summary: 'The source remains intact.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      });
      const claimCompaction = jest.fn(async () => ({
        status: 'claimed',
        leaseId: `continuation-${completed}`,
        domainEpochKey: 'idle-resume-domain',
        sourceDigest: String(completed + 1).repeat(64),
        sourceBytes: 100,
        sourceTurns: [],
        leaseExpiresAt: new Date(Date.now() + 300000),
      }));
      try {
        require('@librechat/api').resetMainCompactionSchedulingForTests();
        const first = await ensureAcceptedMainCompaction({
          ...identity,
          trigger,
          foreground: false,
          claimCompaction,
          executeCompactor: async (call) => (call.stage === 'review' ? reviewApproved : candidate),
          completeCompaction: async () => ({
            status: 'compacted',
            continuationPending: ++completed < 5,
          }),
          rejectCompaction: jest.fn(),
        });
        expect(first).toMatchObject({ continuationPending: true, reason: 'idle_budget_exhausted' });
        expect(completed).toBe(4);
        await jest.advanceTimersByTimeAsync(30000);
        for (let i = 0; i < 10 && completed < 5; i++)
          await new Promise((resolve) => setImmediate(resolve));
        expect(completed).toBe(5);
        expect(claimCompaction).toHaveBeenCalledTimes(5);
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        require('@librechat/api').resetMainCompactionSchedulingForTests();
        jest.useRealTimers();
      }
    },
  );
});

describe('fresh call liveness before historical idle claims', () => {
  const lookup = require('../CallSessionService').getActiveCallSessionForMainMaintenance;
  const identity = {
    ownerId: 'call-idle-owner',
    agentId: 'main',
    stableAuthoritySha256: 'a'.repeat(64),
  };
  const candidate = JSON.stringify({
    version: 1,
    summary: 'Retain the reviewed historical source.',
    pendingAsks: [],
    commitments: [],
    corrections: [],
    decisions: [],
    durableIdentifiers: [],
    recurrenceOutcomes: [],
    toolPairs: [],
  });
  beforeEach(() => {
    lookup.mockReset().mockResolvedValue(null);
    require('@librechat/api').resetMainCompactionSchedulingForTests();
  });
  afterEach(() => {
    lookup.mockReset().mockResolvedValue(null);
    require('@librechat/api').resetMainCompactionSchedulingForTests();
  });
  const inputFor = (complete) => ({
    ...identity,
    trigger: 'accepted_turn',
    claimCompaction: jest.fn(async () => ({
      status: 'claimed',
      leaseId: 'call-idle-lease',
      domainEpochKey: 'call-idle-domain',
      sourceDigest: 'e'.repeat(64),
      sourceBytes: 100,
      sourceTurns: [],
      leaseExpiresAt: new Date(Date.now() + 300000),
    })),
    executeCompactor: async (call) => (call.stage === 'review' ? reviewApproved : candidate),
    completeCompaction: complete,
    rejectCompaction: jest.fn(),
  });
  const liveCall = () => ({
    userId: identity.ownerId,
    agentId: identity.agentId,
    callSessionId: 'new-live-call',
    status: 'listening',
    expiresAtMs: Date.now() + 120000,
  });

  test('a call starting between claims defers the next claim until the existing End flush', async () => {
    let completed = 0;
    const call = liveCall();
    lookup.mockResolvedValue(call).mockResolvedValueOnce(null);
    const input = inputFor(async () => ({
      status: 'compacted',
      continuationPending: ++completed < 2,
    }));
    expect(await ensureAcceptedMainCompaction(input)).toMatchObject({
      status: 'deferred',
      reason: 'active_call',
    });
    expect(completed).toBe(1);
    lookup.mockResolvedValue(null);
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' })).toBe(1);
    expect(completed).toBe(2);
    expect(input.claimCompaction).toHaveBeenCalledTimes(2);
  });

  test('a new call after the timer was armed prevents an idle claim until End', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    let completed = 0;
    const input = inputFor(async () => ({
      status: 'compacted',
      continuationPending: ++completed < 5,
    }));
    try {
      await ensureAcceptedMainCompaction(input);
      expect(completed).toBe(4);
      const call = liveCall();
      lookup.mockResolvedValue(call);
      await jest.advanceTimersByTimeAsync(30000);
      expect(completed).toBe(4);
      expect(input.claimCompaction).toHaveBeenCalledTimes(4);
      lookup.mockResolvedValue(null);
      expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' })).toBe(1);
      expect(completed).toBe(5);
      expect(input.claimCompaction).toHaveBeenCalledTimes(5);
    } finally {
      require('@librechat/api').resetMainCompactionSchedulingForTests();
      jest.useRealTimers();
    }
  });

  test('unavailable call liveness starts no maintenance provider claim', async () => {
    lookup.mockRejectedValue(new Error('synthetic persistence unavailable'));
    const input = inputFor(jest.fn());
    expect(await ensureAcceptedMainCompaction(input)).toMatchObject({
      status: 'deferred',
      reason: 'call_liveness_unavailable',
    });
    expect(input.claimCompaction).not.toHaveBeenCalled();
  });
});

describe('legacy conversation maintenance uses the existing idle and call owners', () => {
  beforeEach(() => require('@librechat/api').resetMainCompactionSchedulingForTests());
  test('the idle binding waits for the foreground fence without invoking a provider', async () => {
    jest.useFakeTimers();
    const run = jest.fn(async () => {});
    const release = acquireInteractiveMainAdmissionFence('legacy-idle-owner');
    try {
      const { scheduleMainContinuityMaintenance } = require('../ViventiumMainCompactionService');
      expect(
        scheduleMainContinuityMaintenance({
          ownerId: 'legacy-idle-owner',
          agentId: 'main',
          stableAuthoritySha256: 'legacy-conversation',
          schedule: run,
        }),
      ).toBe(true);
      await jest.advanceTimersByTimeAsync(60000);
      expect(run).not.toHaveBeenCalled();
      release();
      await jest.advanceTimersByTimeAsync(30000);
      expect(run).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      release();
      require('@librechat/api').resetMainCompactionSchedulingForTests();
      jest.useRealTimers();
    }
  });
  test('background legacy claims wait for a fresh live call and resume once after End', async () => {
    const call = {
      userId: 'legacy-call-owner',
      callSessionId: 'legacy-call',
      status: 'listening',
      expiresAtMs: Date.now() + 60000,
    };
    const calls = require('../CallSessionService').getActiveCallSessionForMainMaintenance;
    calls.mockResolvedValueOnce(call).mockResolvedValueOnce(null);
    const claim = jest.fn(async () => ({ status: 'empty' }));
    const input = {
      ownerId: call.userId,
      agentId: 'main',
      stableAuthoritySha256: 'legacy-conversation',
      trigger: 'conversation_legacy',
      foreground: false,
      claimCompaction: claim,
      executeCompactor: jest.fn(),
    };
    expect(await ensureAcceptedMainCompaction(input)).toMatchObject({
      status: 'deferred',
      reason: 'active_call',
    });
    expect(claim).not.toHaveBeenCalled();
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' })).toBe(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(input.executeCompactor).not.toHaveBeenCalled();
  });
});

describe('idle size recovery uses the actual next claim', () => {
  const identity = {
    ownerId: 'size-idle-owner',
    agentId: 'size-main',
    stableAuthoritySha256: '8'.repeat(64),
  };
  const fitting = {
    version: 1,
    summary: 'Keep the original permission and pending work.',
    pendingAsks: [],
    commitments: [],
    corrections: [],
    decisions: [],
    durableIdentifiers: [],
    recurrenceOutcomes: [],
    toolPairs: [],
  };
  beforeEach(() => {
    setMainContinuityPersistenceForTests(inMemoryPersistence());
    require('@librechat/api').resetMainCompactionSchedulingForTests();
  });
  afterEach(() => setMainContinuityPersistenceForTests(null));

  test('real history owner claims less whole source, reviews it, then promotes without dropping the rest', async () => {
    for (let index = 0; index < 8; index++)
      await commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `size-turn-${index}`,
        revision: 1,
        conversationId: 'size-conversation',
        userMessageId: `size-user-${index}`,
        assistantMessageId: `size-answer-${index}`,
        origin: 'interactive',
        userText: `Keep permission required ${index}. ` + 'u'.repeat(1000),
        assistantText: `Pending ${index}. ` + 'a'.repeat(500),
      });
    const before = await loadAcceptedMainContext(identity);
    const calls = [];
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
      executeCompactor: async (call) => {
        calls.push(call);
        if (call.stage === 'review') return reviewApproved;
        return JSON.stringify({
          ...fitting,
          summary: calls.length === 1 ? 'x'.repeat(16 * 1024) : fitting.summary,
        });
      },
    });
    expect(result).toMatchObject({ status: 'compacted', attempts: 1 });
    expect(calls).toHaveLength(3);
    expect(calls[2].stage).toBe('review');
    const payload = (call) =>
      JSON.parse(
        call.prompt.match(
          /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
        )[1],
      );
    const first = payload(calls[0]),
      second = payload(calls[1]);
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    expect(second.acceptedOlderTurns.length).toBeLessThan(first.acceptedOlderTurns.length);
    const after = await loadAcceptedMainContext(identity);
    expect(after.semanticCompaction.summary).toBe(fitting.summary);
    expect(after.turns.map((t) => t.logicalTurnId)).toEqual(
      before.turns.map((t) => t.logicalTurnId),
    );
    expect(after.pendingCompactionTurns.length).toBeGreaterThan(0);
    expect(after.pendingCompactionTurns.length).toBeLessThan(before.pendingCompactionTurns.length);
  });

  test.each(['producer', 'review'])(
    'a %s packet rejected as too large uses the same smaller whole-source owner',
    async (stage) => {
      for (let index = 0; index < 8; index++)
        await commitAcceptedMainTurn({
          ...identity,
          logicalTurnId: `packet-turn-${index}`,
          revision: 1,
          conversationId: 'packet-conversation',
          userMessageId: `packet-user-${index}`,
          assistantMessageId: `packet-answer-${index}`,
          origin: 'interactive',
          userText: `Keep required permission ${index}. ` + 'u'.repeat(1000),
          assistantText: `Pending ${index}. ` + 'a'.repeat(500),
        });
      const before = await loadAcceptedMainContext(identity);
      const calls = [];
      let rejected = false;
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        trigger: 'accepted_turn',
        executeCompactor: async (call) => {
          calls.push(call);
          if (!rejected && (stage === 'review') === (call.stage === 'review')) {
            rejected = true;
            throw Object.assign(new Error('Packet too large'), {
              status: 413,
              code: 'invalid_request',
            });
          }
          return call.stage === 'review' ? reviewApproved : JSON.stringify(fitting);
        },
      });
      expect(result.reason).toBeUndefined();
      expect(result).toMatchObject({ status: 'compacted' });
      const producers = calls.filter((call) => call.stage !== 'review');
      expect(producers).toHaveLength(2);
      const payload = (call) =>
        JSON.parse(
          call.prompt.match(
            /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
          )[1],
        );
      expect(payload(producers[1]).acceptedOlderTurns.length).toBeLessThan(
        payload(producers[0]).acceptedOlderTurns.length,
      );
      expect(payload(producers[1]).sourceDigest).not.toBe(payload(producers[0]).sourceDigest);
      expect(calls.at(-1).stage).toBe('review');
      const after = await loadAcceptedMainContext(identity);
      expect(after.semanticCompaction.summary).toBe(fitting.summary);
      expect(after.turns).toEqual(before.turns);
      expect(after.pendingCompactionTurns.length).toBeGreaterThan(0);
    },
  );

  test.each([
    ['same digest', { sourceDigest: 'a'.repeat(64) }],
    ['same bytes', { sourceBytes: 8000 }],
    ['larger bytes', { sourceBytes: 9000 }],
    ['foreign domain', { domainEpochKey: 'foreign-domain' }],
    ['missing bytes', { sourceBytes: undefined }],
  ])('releases a %s next claim before any provider or review', async (_name, change) => {
    let claimCount = 0;
    const claim = {
      status: 'claimed',
      leaseId: 'size-lease',
      domainEpochKey: 'size-domain',
      sourceDigest: 'a'.repeat(64),
      sourceBytes: 8000,
      previousSemanticCompaction: null,
      sourceTurns: [],
      canReduceSource: true,
      leaseExpiresAt: new Date(Date.now() + 300000),
    };
    const reject = jest.fn(async () => ({ status: 'rejected' }));
    const complete = jest.fn();
    const execute = jest.fn(async () => JSON.stringify({ ...fitting, summary: 'x'.repeat(7000) }));
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
      claimCompaction: async () =>
        ++claimCount === 1
          ? claim
          : {
              ...claim,
              leaseId: 'size-second',
              sourceDigest: 'b'.repeat(64),
              sourceBytes: 3000,
              ...change,
            },
      rejectCompaction: reject,
      completeCompaction: complete,
      executeCompactor: execute,
    });
    expect(result).toMatchObject({
      status: 'degraded',
      reason: 'source_reduction_unavailable',
      attempts: 0,
    });
    expect(claimCount).toBe(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(reject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        leaseId: 'size-second',
        reason: change.domainEpochKey ? 'source_reduction_unavailable' : 'schema_invalid',
      }),
    );
  });

  test.each(['provider', 'review', 'cancel'])(
    'a %s failure after source reduction stops without further claims',
    async (failure) => {
      let claims = 0,
        producers = 0;
      const controller = new AbortController();
      const complete = jest.fn();
      const execute = jest.fn(async (call) => {
        if (call.stage === 'review')
          throw Object.assign(new Error('unavailable'), { code: 'provider_unavailable' });
        if (++producers === 1) {
          if (failure === 'cancel') controller.abort('owner_stop');
          return JSON.stringify({ ...fitting, summary: 'x'.repeat(7000) });
        }
        if (failure === 'provider') throw Object.assign(new Error('rejected'), { status: 400 });
        return JSON.stringify(fitting);
      });
      const result = await ensureAcceptedMainCompaction({
        ...identity,
        trigger: 'accepted_turn',
        signal: controller.signal,
        claimCompaction: async () => ({
          status: 'claimed',
          leaseId: `failure-lease-${++claims}`,
          domainEpochKey: 'failure-domain',
          sourceDigest: String(claims).repeat(64),
          sourceBytes: claims === 1 ? 8000 : 3000,
          sourceTurns: [],
          canReduceSource: true,
          leaseExpiresAt: new Date(Date.now() + 300000),
        }),
        rejectCompaction: jest.fn(),
        completeCompaction: complete,
        executeCompactor: execute,
      });
      expect(result.status).toBe('degraded');
      expect(claims).toBe(failure === 'cancel' ? 1 : 2);
      expect(execute).toHaveBeenCalledTimes(
        failure === 'cancel' ? 1 : failure === 'provider' ? 2 : 3,
      );
      expect(complete).not.toHaveBeenCalled();
    },
  );

  test('an indivisible source keeps bounded same-source repair and does not start another claim', async () => {
    const claim = jest.fn(async () => ({
      status: 'claimed',
      leaseId: 'single-lease',
      domainEpochKey: 'single-domain',
      sourceDigest: 'a'.repeat(64),
      sourceBytes: 8000,
      sourceTurns: [],
      canReduceSource: false,
      leaseExpiresAt: new Date(Date.now() + 300000),
    }));
    const execute = jest.fn(async () => JSON.stringify({ ...fitting, summary: 'x'.repeat(7000) }));
    const result = await ensureAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
      claimCompaction: claim,
      executeCompactor: execute,
      rejectCompaction: jest.fn(),
    });
    expect(result).toMatchObject({ status: 'degraded', reason: 'schema_invalid', attempts: 2 });
    expect(result.canReduceSource).toBeUndefined();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('durable fidelity continuation through the existing idle owner', () => {
  test.each([
    'promote',
    'source',
    'contract',
    'exhausted',
    'release',
    'store',
    'explicit-deadline',
  ])('keeps the same repair bound and authority (%s)', async (mode) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(1000000);
    const scheduling = require('@librechat/api');
    scheduling.resetMainCompactionSchedulingForTests();
    const candidate = JSON.stringify({
      version: 1,
      summary: 'Pending evidence needs review.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    });
    let pending = null,
      claims = 0;
    const calls = [];
    const completeCompaction = jest.fn(async () => {
      pending = null;
      return { status: 'compacted' };
    });
    const rejectCompaction = jest.fn(async (input) => {
      pending = input.pendingCompactionRepair || null;
      return {
        status: 'rejected',
        ...(pending && mode !== 'store' ? { repairPending: true } : {}),
      };
    });
    const args = {
      ownerId: 'fidelity-idle-owner',
      agentId: 'main',
      stableAuthoritySha256: 'f'.repeat(64),
      trigger: 'accepted_turn',
      agent: {
        provider: 'native',
        model_parameters: { model: 'synthetic', reasoning_effort: 'high' },
      },
      req: {
        config: {
          endpoints: {
            agents: {
              providerCapabilities: {
                native: {
                  workspace_binding: true,
                  conversation_session: true,
                },
              },
            },
          },
        },
      },
      executionBudget: { completionReserveMs: 0 },
      ...(mode === 'explicit-deadline'
        ? { deadlineAt: new Date(Date.now() + 1200000).toISOString() }
        : {}),
      claimCompaction: async () => {
        claims++;
        return {
          status: 'claimed',
          leaseId: `repair-lease-${claims}`,
          domainEpochKey: 'repair-domain',
          sourceDigest: claims > 1 && mode === 'source' ? 'e'.repeat(64) : 'd'.repeat(64),
          sourceBytes: 1000,
          sourceTurns: [],
          leaseExpiresAt: new Date(Date.now() + 300000),
          ...(pending
            ? {
                pendingCompactionRepair: {
                  ...pending,
                  ...(mode === 'contract' ? { contractKey: 'different-contract' } : {}),
                },
              }
            : {}),
        };
      },
      renewCompaction: async ({ expiresAt }) => ({ status: 'renewed', leaseExpiresAt: expiresAt }),
      completeCompaction,
      rejectCompaction,
      executeCompactor: async (call) => {
        calls.push(call);
        expect(
          await call.onNativeAdmission({
            requestId: `native-${calls.length}`,
            responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
          }),
        ).toBe(true);
        await new Promise((resolve) =>
          setTimeout(resolve, call.stage === 'review' ? 38000 : 451000),
        );
        call.reportCapacityRelease(mode !== 'release');
        return call.stage === 'review'
          ? calls.length === 2 || mode === 'exhausted'
            ? JSON.stringify({
                approved: false,
                reason: 'Retain the exact pending evidence reference.',
              })
            : reviewApproved
          : candidate;
      },
    };
    try {
      const running = ensureAcceptedMainCompaction(args);
      await jest.advanceTimersByTimeAsync(489000);
      const result = await running;
      const resumes = !['release', 'store', 'explicit-deadline'].includes(mode);
      expect(result).toMatchObject({
        status: 'degraded',
        reason: 'compaction_enclosing_deadline',
        attempts: 1,
      });
      expect(calls).toHaveLength(2);
      expect(completeCompaction).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(resumes ? 1 : 0);
      if (!resumes) return;
      expect(pending).toMatchObject({
        semanticAttempts: 1,
        transportRetries: 0,
        correction: {
          code: 'semantic_fidelity',
          candidate,
          reason: 'Retain the exact pending evidence reference.',
        },
      });
      await jest.advanceTimersByTimeAsync(30000 + 489000);
      for (let i = 0; i < 12 && calls.length < 4; i++)
        await new Promise((resolve) => setImmediate(resolve));
      expect(calls).toHaveLength(4);
      const payload = JSON.parse(
        calls[2].prompt.match(
          /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
        )[1],
      );
      const same = !['source', 'contract'].includes(mode);
      expect(calls[2].attempt).toBe(same ? 2 : 1);
      if (same)
        expect(payload.priorRejection).toEqual({
          code: 'semantic_fidelity',
          candidate,
          reason: 'Retain the exact pending evidence reference.',
        });
      else expect(payload.priorRejection).toBeUndefined();
      if (mode === 'exhausted') {
        expect(completeCompaction).not.toHaveBeenCalled();
        expect(rejectCompaction).toHaveBeenLastCalledWith(
          expect.objectContaining({
            reason: 'semantic_fidelity: Retain the exact pending evidence reference.',
          }),
        );
      } else expect(completeCompaction).toHaveBeenCalledTimes(1);
      expect(pending).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      scheduling.resetMainCompactionSchedulingForTests();
      jest.useRealTimers();
    }
  });
});

describe('resumed fidelity checkpoint during foreground cancellation', () => {
  test.each([true, false])(
    'keeps the earlier completed review only after native release=%s',
    async (released) => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      const persistence = inMemoryPersistence();
      setMainContinuityPersistenceForTests(persistence);
      const scheduling = require('@librechat/api');
      scheduling.resetMainCompactionSchedulingForTests();
      const continuity = require('../ViventiumMainContinuityService');
      const identity = {
        ownerId: 'repair-yield-owner',
        agentId: 'main',
        stableAuthoritySha256: 'b'.repeat(64),
      };
      const agent = {
        provider: 'synthetic',
        model_parameters: { model: 'same-model', reasoning_effort: 'high' },
      };
      const candidate = JSON.stringify({
        version: 1,
        summary: 'Keep the draft private until approval.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      });
      try {
        for (let i = 0; i < 4; i++)
          await commitAcceptedMainTurn({
            ...identity,
            logicalTurnId: `yield-source-${i}`,
            revision: 1,
            conversationId: 'yield-conversation',
            userMessageId: `u-${i}`,
            assistantMessageId: `a-${i}`,
            userText: 'Keep the draft private until approval.',
            assistantText: 'Approval remains pending.',
            origin: 'interactive',
          });
        const first = await continuity.claimAcceptedMainCompaction(identity);
        const contractKey = JSON.stringify({
          constraints: first.outputContract,
          provider: 'synthetic',
          model: 'same-model',
          effort: 'high',
        });
        await continuity.rejectAcceptedMainCompaction({
          ...identity,
          leaseId: first.leaseId,
          reason: 'compaction_enclosing_deadline',
          capacityReleaseAcknowledged: true,
          pendingCompactionRepair: {
            version: 1,
            sourceDigest: first.sourceDigest,
            contractKey,
            semanticAttempts: 1,
            transportRetries: 0,
            correction: {
              code: 'semantic_fidelity',
              candidate,
              reason: 'Keep the original approval boundary.',
            },
          },
        });
        const checkpoint = (await persistence.read(first.domainEpochKey)).pendingCompactionRepair;
        let start;
        const started = new Promise((resolve) => {
          start = resolve;
        });
        const input = { ...identity, agent, trigger: 'accepted_turn' };
        const running = ensureAcceptedMainCompaction({
          ...input,
          executeCompactor: (call) => {
            expect(call.attempt).toBe(2);
            start();
            return new Promise((resolve, reject) =>
              call.signal.addEventListener(
                'abort',
                () => {
                  call.reportCapacityRelease(released);
                  reject(new Error('Cancelled by the foreground owner.'));
                },
                { once: true },
              ),
            );
          },
        });
        await started;
        expect(await yieldAcceptedMainCompaction(identity.ownerId)).toMatchObject({
          status: released ? 'yielded' : 'yield_unconfirmed',
          capacityReleaseAcknowledged: released,
        });
        expect(await running).toMatchObject({
          status: 'degraded',
          reason: 'interactive_priority',
          attempts: 1,
        });
        expect((await running).repairPending).toBeUndefined();
        expect(jest.getTimerCount()).toBe(0);
        expect((await persistence.read(first.domainEpochKey)).pendingCompactionRepair).toEqual(
          released ? checkpoint : null,
        );
        if (!released) return;
        const calls = [];
        const next = await ensureAcceptedMainCompaction({
          ...input,
          executeCompactor: async (call) => {
            calls.push(call);
            call.reportCapacityRelease(true);
            return call.stage === 'review' ? reviewApproved : candidate;
          },
        });
        expect(next).toMatchObject({ status: 'compacted', attempts: 2 });
        expect(calls).toHaveLength(2);
        const payload = JSON.parse(
          calls[0].prompt.match(
            /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
          )[1],
        );
        expect(payload.priorRejection).toEqual(checkpoint.correction);
        expect(payload.sourceDigest).toBe(first.sourceDigest);
        expect((await persistence.read(first.domainEpochKey)).pendingCompactionRepair).toBeNull();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        scheduling.resetMainCompactionSchedulingForTests();
        setMainContinuityPersistenceForTests(null);
        jest.useRealTimers();
      }
    },
  );
});

describe('durable shrinking size continuation through the existing idle owner', () => {
  test('retains two completed size corrections across a bounded batch before review and promotion', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    jest.setSystemTime(1000000);
    const scheduling = require('@librechat/api');
    scheduling.resetMainCompactionSchedulingForTests();
    const valid = {
      version: 1,
      summary: 'The task and its permission constraint remain pending.',
      pendingAsks: [],
      commitments: [],
      corrections: [],
      decisions: [],
      durableIdentifiers: [],
      recurrenceOutcomes: [],
      toolPairs: [],
    };
    const outputContract = {
      version: 1,
      consumer: 'accepted_core',
      carrierMaxUtf8Bytes: 131072,
      reservedUtf8Bytes: 55221,
      maxJsonUtf8Bytes: 75851,
      maxSummaryUtf8Bytes: 75851,
      maxItemsPerArray: 32,
      maxStringItemUtf8Bytes: 1024,
      maxToolIdentityCharacters: 256,
    };
    const source = {
      previousSemanticCompaction: {
        ...valid,
        summary: 'Retain the accepted permission constraint.',
      },
      sourceTurns: [],
      legacyInputs: [
        {
          kind: 'legacy_state',
          id: 'size-legacy-artifact',
          sourceTurns: [
            {
              logicalTurnId: 'size-whole-turn',
              revision: 1,
              userText: 'Keep the task pending until permission is given.',
              assistantText: 'Permission is still required.',
              toolPairs: [],
            },
          ],
          sourceRange: { artifactId: 'size-legacy-artifact', start: 5, end: 6, total: 42 },
        },
      ],
    };
    let pending = null;
    let claims = 0;
    const calls = [];
    const completeCompaction = jest.fn(async () => {
      pending = null;
      return { status: 'compacted' };
    });
    const rejectCompaction = jest.fn(async (input) => {
      pending = input.pendingCompactionRepair
        ? { ...input.pendingCompactionRepair, outputContract }
        : null;
      return { status: 'rejected', ...(pending ? { repairPending: true } : {}) };
    });
    const args = {
      ownerId: 'size-idle-owner',
      agentId: 'main',
      stableAuthoritySha256: 'a'.repeat(64),
      trigger: 'accepted_turn',
      executionBudget: { completionReserveMs: 0 },
      agent: {
        provider: 'native',
        model_parameters: { model: 'synthetic', reasoning_effort: 'high' },
      },
      req: {
        config: {
          endpoints: {
            agents: {
              providerCapabilities: {
                native: { workspace_binding: true, conversation_session: true },
              },
            },
          },
        },
      },
      claimCompaction: async () => ({
        status: 'claimed',
        leaseId: `size-idle-lease-${++claims}`,
        domainEpochKey: 'size-idle-domain',
        sourceDigest: 'd'.repeat(64),
        sourceBytes: 120000,
        canReduceSource: false,
        ...structuredClone(source),
        outputContract:
          claims > 1
            ? {
                ...outputContract,
                reservedUtf8Bytes: 55567,
                maxJsonUtf8Bytes: 75505,
                maxSummaryUtf8Bytes: 75505,
              }
            : outputContract,
        leaseExpiresAt: new Date(Date.now() + 300000),
        ...(pending ? { pendingCompactionRepair: structuredClone(pending) } : {}),
      }),
      renewCompaction: async ({ expiresAt }) => ({ status: 'renewed', leaseExpiresAt: expiresAt }),
      completeCompaction,
      rejectCompaction,
      executeCompactor: async (call) => {
        calls.push(call);
        expect(
          await call.onNativeAdmission({
            requestId: `size-native-${calls.length}`,
            responseDeadlineAt: new Date(Date.now() + 660000).toISOString(),
          }),
        ).toBe(true);
        const duration = calls.length <= 2 ? 451000 : call.stage === 'review' ? 10000 : 45000;
        await new Promise((resolve) => setTimeout(resolve, duration));
        call.reportCapacityRelease(true);
        if (call.stage === 'review') return reviewApproved;
        return JSON.stringify(
          calls.length <= 2
            ? { ...valid, summary: 's'.repeat(calls.length === 1 ? 96000 : 93000) }
            : valid,
        );
      },
    };
    try {
      const running = ensureAcceptedMainCompaction(args);
      await jest.advanceTimersByTimeAsync(902000);
      expect(await running).toMatchObject({
        status: 'degraded',
        reason: 'compaction_enclosing_deadline',
        attempts: 2,
        repairPending: true,
      });
      expect(calls).toHaveLength(2);
      expect(completeCompaction).not.toHaveBeenCalled();
      expect(pending).toMatchObject({
        semanticAttempts: 2,
        transportRetries: 0,
        correction: { code: 'schema_invalid', issue: { constraint: 'max_bytes', limit: 75851 } },
      });
      expect(pending.correction.candidate).toBeUndefined();
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(30000 + 55000);
      for (let index = 0; index < 12 && calls.length < 4; index++)
        await new Promise((resolve) => setImmediate(resolve));
      expect(calls.map((call) => call.stage || 'compaction')).toEqual([
        'compaction',
        'compaction',
        'compaction',
        'review',
      ]);
      expect(calls[2].attempt).toBe(3);
      const payload = JSON.parse(
        calls[2].prompt.match(
          /<untrusted_conversation_data_v1>\s*([\s\S]*?)\s*<\/untrusted_conversation_data_v1>/,
        )[1],
      );
      expect(payload.priorRejection).toMatchObject({
        code: 'schema_invalid',
        issue: { constraint: 'max_bytes', limit: 75505 },
      });
      expect(payload.outputConstraints.maxJsonUtf8Bytes).toBe(75505);
      expect(payload.priorRejection.candidate).toBeUndefined();
      expect(payload.previousSemanticCompaction).toEqual(source.previousSemanticCompaction);
      expect(payload.legacyInputs).toEqual(source.legacyInputs);
      expect(completeCompaction).toHaveBeenCalledTimes(1);
      expect(pending).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      scheduling.resetMainCompactionSchedulingForTests();
      jest.useRealTimers();
    }
  });
});

describe('terminal size failure consumer', () => {
  test.each(['nonconverging', 'exhausted'])(
    'does not rerun the same source under a smaller allocation after %s size repair',
    async (mode) => {
      const scheduling = require('@librechat/api');
      scheduling.resetMainCompactionSchedulingForTests();
      const valid = {
        version: 1,
        summary: 'Permission remains required.',
        pendingAsks: [],
        commitments: [],
        corrections: [],
        decisions: [],
        durableIdentifiers: [],
        recurrenceOutcomes: [],
        toolPairs: [],
      };
      let reserved = 55221;
      const execute = jest.fn(async () =>
        JSON.stringify({
          ...valid,
          summary: 's'.repeat(
            mode === 'nonconverging' ? 96000 : 98000 - execute.mock.calls.length * 1000,
          ),
        }),
      );
      const complete = jest.fn();
      const args = {
        ownerId: `size-terminal-${mode}`,
        agentId: 'main',
        stableAuthoritySha256: 'f'.repeat(64),
        agent: {
          provider: 'native',
          model_parameters: { model: 'synthetic', reasoning_effort: 'high' },
        },
        claimCompaction: async () => ({
          status: 'claimed',
          leaseId: 'terminal-size-lease',
          domainEpochKey: `terminal-size-${mode}`,
          sourceDigest: 'd'.repeat(64),
          sourceBytes: 120000,
          sourceTurns: [],
          canReduceSource: false,
          leaseExpiresAt: new Date(Date.now() + 300000),
          outputContract: {
            version: 1,
            consumer: 'accepted_core',
            carrierMaxUtf8Bytes: 131072,
            reservedUtf8Bytes: reserved,
            maxJsonUtf8Bytes: 131072 - reserved,
            maxSummaryUtf8Bytes: 131072 - reserved,
            maxItemsPerArray: 32,
            maxStringItemUtf8Bytes: 1024,
            maxToolIdentityCharacters: 256,
          },
        }),
        executeCompactor: execute,
        completeCompaction: complete,
        rejectCompaction: jest.fn(async () => ({ status: 'rejected' })),
      };
      try {
        expect(await ensureAcceptedMainCompaction(args)).toMatchObject({
          status: 'degraded',
          reason: 'schema_invalid',
          attempts: mode === 'nonconverging' ? 2 : 4,
        });
        const calls = execute.mock.calls.length;
        reserved += 100;
        expect(await ensureAcceptedMainCompaction(args)).toMatchObject({
          status: 'degraded',
          reason: 'schema_invalid',
          attempts: 0,
        });
        expect(execute).toHaveBeenCalledTimes(calls);
        expect(complete).not.toHaveBeenCalled();
      } finally {
        scheduling.resetMainCompactionSchedulingForTests();
      }
    },
  );
});
