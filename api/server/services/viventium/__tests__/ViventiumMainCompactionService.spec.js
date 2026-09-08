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

  beforeEach(() => setMainContinuityPersistenceForTests(inMemoryPersistence()));
  afterEach(() => setMainContinuityPersistenceForTests(null));

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
      expect(call.prompt).toContain(
        `"outputConstraints":${JSON.stringify(mainCompactionOutputConstraints)}`,
      );
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
              summary: 'é'.repeat(mainCompactionOutputConstraints.maxJsonUtf8Bytes / 2),
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
      for (const payload of payloads.slice(1)) {
        expect(payload.sourceDigest).toBe(payloads[0].sourceDigest);
        expect(payload.acceptedOlderTurns).toEqual(payloads[0].acceptedOlderTurns);
        expect(payload.outputConstraints).toEqual(mainCompactionOutputConstraints);
      }
      expect(calls[1].stage).not.toBe('review');
      expect(calls[2].stage).toBe('review');
      expect(payloads[2].priorRejection).toBeUndefined();
      expect(payloads[2].candidate).toEqual(valid);
    },
  );

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
