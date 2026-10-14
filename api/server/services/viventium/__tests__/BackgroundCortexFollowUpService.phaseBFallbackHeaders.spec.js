const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPromptBundleFixture,
} = require('../../../../../scripts/test-support/promptBundle.cjs');
const previousPromptBundlePath = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
let promptFixtureDirectory;
beforeAll(() => {
  promptFixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-test-prompts-'));
  const bundlePath = path.join(promptFixtureDirectory, 'bundle.json');
  fs.writeFileSync(
    bundlePath,
    JSON.stringify(
      buildPromptBundleFixture(
        path.resolve(__dirname, '../../../../../viventium/source_of_truth/prompts'),
      ),
    ),
  );
  process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundlePath;
});
afterAll(() => {
  if (previousPromptBundlePath === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previousPromptBundlePath;
  fs.rmSync(promptFixtureDirectory, { recursive: true, force: true });
});

const { Run } = require('@librechat/agents');

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return { ...actual, createNativeCapacityFetch: jest.fn(actual.createNativeCapacityFetch) };
});

jest.mock('~/server/services/BackgroundCortexService', () => {
  const actual = jest.requireActual('~/server/services/BackgroundCortexService');
  return {
    ...actual,
    getCustomEndpointConfig: jest.fn(async () => ({
      apiKey: 'synthetic-harness-key',
      baseURL: 'http://127.0.0.1:8766/v1',
      defaultHeaders: { 'X-Synthetic-Endpoint': 'keep-endpoint-header' },
    })),
  };
});

jest.mock('~/models/Agent', () => {
  const actual = jest.requireActual('~/models/Agent');
  return { ...actual, getAgent: jest.fn(async () => null) };
});

jest.mock('../CortexInsightDeliveryService', () => ({
  ...jest.requireActual('../CortexInsightDeliveryService'),
  markCortexInsightDeliveryBatchFailed: jest.fn(async () => []),
  markCortexInsightDeliveryBatchDropped: jest.fn(async () => []),
}));

jest.mock('../nativeResponseService', () => ({
  getService: () => ({
    readToolEvidence: jest.fn().mockResolvedValue([]),
    readToolEvidenceForPresentation: jest.fn().mockResolvedValue([]),
  }),
}));
jest.mock('../VoiceTaskService', () => ({
  ...jest.requireActual('../VoiceTaskService'),
  isVoiceTaskSuppressedDurably: jest.fn(async () => false),
}));

const { setTrustedInteractionContext } = require('../interactionContext');

const { generateFollowUpText } = require('../BackgroundCortexFollowUpService');

describe('owned occupied-session recovery producer', () => {
  test.each([
    [409, 'conversation_session_authority_conflict', 'native_session_occupied'],
    [409, 'other_conflict', 'generation_failed_without_fallback'],
    [503, 'host_capacity_unavailable', 'generation_failed_without_fallback'],
  ])(
    'only exact generation failure %s/%s becomes durable row occupancy',
    (status, code, expected) => {
      const { resolveCortexInsightDropReason } = require('../BackgroundCortexFollowUpService');
      expect(
        resolveCortexInsightDropReason({
          decision: { generationFailed: true },
          generationFailure: { status, code },
        }),
      ).toBe(expected);
    },
  );
  test('actual empty-text producer settles exact occupancy on every admitted row even if parent metadata write fails', async () => {
    const { persistPreparedCortexFollowUpMessage } = require('../BackgroundCortexFollowUpService');
    const delivery = require('../CortexInsightDeliveryService');
    const db = require('~/models');
    const message = jest
      .spyOn(db, 'getMessage')
      .mockRejectedValue(new Error('Synthetic parent metadata write failure'));
    const claims = ['delivery-a', 'delivery-b'].map((deliveryId) => ({
      deliveryId,
      claimToken: 'claim-a',
      claimGeneration: 1,
      attemptNumber: 1,
    }));
    try {
      expect(
        await persistPreparedCortexFollowUpMessage(
          {
            req: { user: { id: 'owner-a' }, body: {} },
            parentMessageId: 'parent-a',
            deliveryBatch: { claimed: claims },
          },
          {
            text: '',
            decision: { generationFailed: true },
            followUpDecisionRecord: {
              generationFailed: true,
              generationFailure: { status: 409, code: 'conversation_session_authority_conflict' },
            },
          },
        ),
      ).toBeNull();
      expect(delivery.markCortexInsightDeliveryBatchFailed).toHaveBeenCalledWith({
        ownerId: 'owner-a',
        claims,
        reason: 'native_session_occupied',
      });
      expect(delivery.markCortexInsightDeliveryBatchDropped).not.toHaveBeenCalled();
    } finally {
      message.mockRestore();
    }
  });
  test('shared existing publication wake retries persistence without changing its event identity', async () => {
    const { publishCortexVoiceFollowUp } = require('../BackgroundCortexFollowUpService');
    const event = jest.fn().mockReturnValueOnce({ sequence: 4 }).mockReturnValue(null);
    const flush = jest
      .fn()
      .mockRejectedValueOnce(new Error('Synthetic failed flush'))
      .mockResolvedValue();
    const dependencies = {
      hydrateVoiceTask: jest.fn(async () => ({
        taskId: 'task-a',
        callSessionId: 'call-a',
        userId: 'owner-a',
        conversationId: 'conversation-a',
      })),
      getVoiceTaskOwnerBinding: jest.fn(() => ({
        taskId: 'task-a',
        callSessionId: 'call-a',
        userId: 'owner-a',
        conversationId: 'conversation-a',
      })),
      observeGenerationEvent: event,
      flushVoiceTaskPersistence: flush,
    };
    const input = {
      ownerId: 'owner-a',
      callSessionId: 'call-a',
      voiceTaskId: 'task-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      messageId: 'child-a',
      dependencies,
    };
    await expect(publishCortexVoiceFollowUp(input)).rejects.toThrow('Synthetic failed flush');
    await expect(publishCortexVoiceFollowUp(input)).resolves.toBe(true);
    expect(event.mock.calls[0]).toEqual(event.mock.calls[1]);
    expect(flush).toHaveBeenCalledTimes(2);
  });
  test('shared wake rejects foreign retained task and never publishes parent as its own child', async () => {
    const { publishCortexVoiceFollowUp } = require('../BackgroundCortexFollowUpService');
    const dependencies = {
      hydrateVoiceTask: jest.fn(async () => ({
        taskId: 'task-a',
        callSessionId: 'foreign',
        userId: 'owner-a',
        conversationId: 'conversation-a',
      })),
      getVoiceTaskOwnerBinding: jest.fn(() => ({
        taskId: 'task-a',
        callSessionId: 'foreign',
        userId: 'owner-a',
        conversationId: 'conversation-a',
      })),
      observeGenerationEvent: jest.fn(),
      flushVoiceTaskPersistence: jest.fn(),
    };
    const input = {
      ownerId: 'owner-a',
      callSessionId: 'call-a',
      voiceTaskId: 'task-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      messageId: 'child-a',
      dependencies,
    };
    expect(await publishCortexVoiceFollowUp(input)).toBe(false);
    expect(await publishCortexVoiceFollowUp({ ...input, messageId: 'parent-a' })).toBe(false);
    expect(dependencies.observeGenerationEvent).not.toHaveBeenCalled();
  });

  const {
    bindOccupiedCortexRecovery,
    prepareCortexFollowUpMessage,
    persistPreparedCortexFollowUpMessage,
  } = require('../BackgroundCortexFollowUpService');
  const db = require('~/models');
  const cause = { status: 409, code: 'conversation_session_authority_conflict' };
  const agent = {
    id: 'synthetic-main',
    provider: 'glasshive-harness',
    model: 'grok-build:grok-4.7-build-fast',
    model_parameters: { model: 'grok-build:grok-4.7-build-fast', reasoning_effort: 'high' },
  };
  const request = () => ({
    user: { id: 'synthetic-owner' },
    body: {
      conversationId: 'synthetic-conversation',
      messageId: 'synthetic-parent',
      viventiumSurface: 'voice',
      voiceMode: true,
    },
    config: {
      endpoints: {
        agents: {
          providerCapabilities: {
            'glasshive-harness': {
              workspace_binding: true,
              conversation_session: true,
              activity_stream: true,
              responses_api: false,
            },
          },
        },
      },
    },
  });
  const input = (req) => ({
    req,
    agent,
    conversationId: 'synthetic-conversation',
    parentMessageId: 'synthetic-parent',
    recentResponse: 'The primary reply is complete.',
    insightsData: { insights: [{ cortexId: 'synthetic-cortex', insight: 'A useful result.' }] },
  });
  test('recovery signer is server-only, native zero-tool, and retains the same parent/agent idempotency', async () => {
    const previous = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-recovery-signing-key';
    const run = jest
      .spyOn(Run, 'create')
      .mockResolvedValue({ processStream: jest.fn(async () => 'Useful result.') });
    try {
      const req = request();
      bindOccupiedCortexRecovery(req, async () => ({ state: 'live' }));
      await generateFollowUpText(input(req));
      const headers = run.mock.calls[0][0].graphConfig.llmConfig.configuration.defaultHeaders;
      expect(
        JSON.parse(
          Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString('utf8'),
        ),
      ).toEqual({ provider_capabilities: { native_tools: false } });
      expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
      expect(headers['X-GlassHive-Idempotency-Key']).toBe(
        'phase_b:synthetic-main:synthetic-parent',
      );
      expect(headers['X-Viventium-Stream-Id']).toBe('phase_b:synthetic-main:synthetic-parent');
      expect(run.mock.calls[0][0].graphConfig.llmConfig.modelKwargs.reasoning_effort).toBe('high');
      expect(req.body.viventiumActorTrust).toBeUndefined();
      expect(req.body.viventiumCanAuthorizeSideEffects).toBeUndefined();
    } finally {
      run.mockRestore();
      if (previous === undefined) delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
      else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = previous;
    }
  });
  test.each([
    [409, 'conversation_session_authority_conflict', cause],
    [409, 'other_conflict', undefined],
    [503, 'host_capacity_unavailable', undefined],
  ])(
    'only exact pre-admission failure %s/%s is retained for recovery',
    async (status, code, expected) => {
      const messages = jest.spyOn(db, 'getMessages').mockResolvedValue([]);
      const message = jest.spyOn(db, 'getMessage').mockResolvedValue(null);
      const run = jest.spyOn(Run, 'create').mockResolvedValue({
        processStream: jest.fn(async () => {
          throw Object.assign(new Error('Synthetic provider refusal'), { status, code });
        }),
      });
      try {
        const req = request();
        req.config.endpoints.agents.providerCapabilities['glasshive-harness'].workspace_binding =
          false;
        const result = await prepareCortexFollowUpMessage(input(req));
        expect(result.followUpDecisionRecord.generationFailure).toEqual(expected);
        expect(result.followUpDecisionRecord.generationFailed).toBe(true);
      } finally {
        messages.mockRestore();
        message.mockRestore();
        run.mockRestore();
      }
    },
  );
  test('Stop arriving after preparation suppresses before any persistence', async () => {
    const req = request();
    bindOccupiedCortexRecovery(req, async () => ({ state: 'suppressed' }));
    const save = jest.spyOn(db, 'saveMessage').mockResolvedValue({ messageId: 'not-saved' });
    try {
      expect(
        await persistPreparedCortexFollowUpMessage(input(req), {
          suppressed: false,
          text: 'Late result.',
        }),
      ).toBeNull();
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });
  test('Stop before preparation starts no author', async () => {
    const req = request();
    bindOccupiedCortexRecovery(req, async () => ({ state: 'suppressed' }));
    const run = jest.spyOn(Run, 'create');
    try {
      expect(await prepareCortexFollowUpMessage(input(req))).toEqual({
        suppressed: true,
        dropReason: 'voice_task_suppressed',
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
  test('lease gap before preparation starts no author and preserves pending authority', async () => {
    const req = request();
    bindOccupiedCortexRecovery(req, async () => ({ state: 'waiting' }));
    const run = jest.spyOn(Run, 'create');
    try {
      await expect(prepareCortexFollowUpMessage(input(req))).rejects.toMatchObject({
        code: 'cortex_voice_recovery_authority_pending',
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
    }
  });
  test.each(['linked_text', 'waiting'])(
    '%s during authoring keeps text without restoring microphone permission',
    async (state) => {
      const messages = jest.spyOn(db, 'getMessages').mockResolvedValue([]);
      const message = jest.spyOn(db, 'getMessage').mockResolvedValue(null);
      const run = jest
        .spyOn(Run, 'create')
        .mockResolvedValue({ processStream: jest.fn(async () => 'A useful completed result.') });
      const req = request();
      const scope = {
        callSessionId: 'synthetic-call',
        taskId: 'synthetic-task',
        streamId: 'synthetic-stream',
      };
      const recheck = jest
        .fn()
        .mockResolvedValueOnce({
          ...scope,
          state: 'live',
          session: {
            callSessionId: scope.callSessionId,
            userId: req.user.id,
          },
        })
        .mockResolvedValue({ ...scope, state });
      bindOccupiedCortexRecovery(req, recheck);
      req.config.endpoints.agents.providerCapabilities['glasshive-harness'].workspace_binding =
        false;
      try {
        const result = await prepareCortexFollowUpMessage(input(req));
        expect(result.text).toBe('A useful completed result.');
        expect(result.followUpDecisionRecord.recoveryCause).toEqual(cause);
        expect(req.body.voiceMode).toBe(false);
        expect(req.body.viventiumInputMode).toBe('text');
        expect(req.viventiumCallSession).toBeUndefined();
        expect(req.body.viventiumCanAuthorizeSideEffects).toBeUndefined();
        expect(recheck).toHaveBeenCalledTimes(2);
      } finally {
        messages.mockRestore();
        message.mockRestore();
        run.mockRestore();
      }
    },
  );
  test('caller body flags cannot invoke the owned recovery recheck', async () => {
    const req = request();
    req.body.occupiedCortexRecovery = true;
    req.body._viventiumCortexOccupiedSessionRecovery = true;
    const run = jest
      .spyOn(Run, 'create')
      .mockResolvedValue({ processStream: jest.fn(async () => 'Ordinary result.') });
    try {
      await generateFollowUpText(input(req));
      expect(
        run.mock.calls[0][0].graphConfig.llmConfig.configuration.defaultHeaders[
          'X-GlassHive-Bootstrap-Bundle-B64'
        ],
      ).toBeUndefined();
    } finally {
      run.mockRestore();
    }
  });
});

/* === VIVENTIUM START === Only durable Phase B opts into typed native occupancy waiting. === */
describe('Phase B occupied-session adapter wiring', () => {
  test.each([
    ['durable', true, true, true],
    ['no conversation session', false, true, false],
    ['no activity stream', true, false, false],
  ])(
    '%s keeps its declared admission contract',
    async (_label, conversationSession, activityStream, expected) => {
      const api = require('@librechat/api');
      api.createNativeCapacityFetch.mockClear();
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({
        processStream: jest.fn().mockResolvedValue('A useful follow-up.'),
      });
      try {
        await generateFollowUpText({
          req: {
            user: { id: 'synthetic-owner' },
            body: { conversationId: 'synthetic-conversation', messageId: 'synthetic-message' },
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    'glasshive-harness': {
                      workspace_binding: true,
                      conversation_session: conversationSession,
                      activity_stream: activityStream,
                      responses_api: false,
                      default_access: 'workspace',
                    },
                  },
                },
              },
            },
          },
          agent: {
            id: 'synthetic-main',
            provider: 'glasshive-harness',
            model: 'grok-build:grok-4.7-build-fast',
            model_parameters: { model: 'grok-build:grok-4.7-build-fast', reasoning_effort: 'high' },
          },
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-message',
          runId: 'synthetic-phase-b',
          recentResponse: 'The work is in progress.',
          insightsData: { insights: [{ cortexName: 'Synthetic', insight: 'A verified result.' }] },
        });
        expect(api.createNativeCapacityFetch).toHaveBeenCalledTimes(expected ? 1 : 0);
        if (expected)
          expect(api.createNativeCapacityFetch).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ waitForOccupiedSession: true, role: 'cortex' }),
          );
      } finally {
        createRun.mockRestore();
      }
    },
  );
});
/* === VIVENTIUM END === */

describe('Phase B follow-up serial fallback arming', () => {
  test.each([
    { actor_kind: 'external_user', origin: 'interactive', surface: 'web' },
    { actor_kind: 'system', origin: 'scheduler', surface: 'workbench' },
    { actor_kind: 'worker', origin: 'callback', surface: 'workbench' },
  ])(
    'carries trusted $origin scope and the same fallback declaration as the root turn',
    async (context) => {
      const processStream = jest.fn().mockResolvedValue('Worker C finished: the card is ready.');
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      try {
        const req = {
          id: 'synthetic-phase-b-fallback',
          body: { conversationId: 'conv-1', messageId: 'msg-1' },
          user: { id: 'user-1' },
          config: {
            endpoints: {
              agents: {
                providerCapabilities: {
                  'glasshive-harness': {
                    workspace_binding: true,
                    default_access: 'workspace',
                    phase_b_followup: true,
                    conversation_session: true,
                    responses_api: false,
                  },
                },
              },
            },
          },
        };
        setTrustedInteractionContext(req, {
          ...context,
          conversation_id: 'conv-1',
          source_event_id: 'root-event',
        });
        await generateFollowUpText({
          req,
          agent: {
            id: 'agent-main',
            provider: 'glasshive-harness',
            endpoint: 'glasshive-harness',
            model: 'codex-cli:gpt-5.6-sol',
            model_parameters: { model: 'codex-cli:gpt-5.6-sol', reasoning_effort: 'medium' },
            glasshive_options: {
              workspace: { mode: 'life' },
              access: 'full',
              fallback_model: 'claude-code:opus',
              fallback_reasoning_effort: 'high',
            },
          },
          insightsData: {
            insights: [{ cortexName: 'Worker', insight: 'The reading list card is complete.' }],
          },
          recentResponse: 'Three fresh Workers are now running concurrently.',
          runId: 'synthetic-run',
          conversationId: 'conv-1',
          parentMessageId: 'msg-1',
        });
        expect(createRun).toHaveBeenCalledTimes(1);
        const headers =
          createRun.mock.calls[0][0].graphConfig.llmConfig.configuration.defaultHeaders;
        expect(headers['X-Viventium-Actor-Kind']).toBe(context.actor_kind);
        expect(headers['X-Viventium-Origin']).toBe(context.origin);
        expect(headers['X-Synthetic-Endpoint']).toBe('keep-endpoint-header');
        expect(headers['X-GlassHive-Fallback-Model']).toBe('claude-code:opus');
        expect(headers['X-GlassHive-Fallback-Reasoning-Effort']).toBe('high');
        expect(headers['X-GlassHive-Access']).toBe('full');
        expect(headers['X-GlassHive-Agent-Id']).toContain('agent-main');
      } finally {
        createRun.mockRestore();
      }
    },
  );
});

describe('verified mission image input', () => {
  test.each(['artifact_ref', 'download_url', 'open_url'])(
    'passes observed images to Main and delivers only its selected %s',
    async (selectionField) => {
      const bytes = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      );
      const sha256 = require('crypto').createHash('sha256').update(bytes).digest('hex');
      const base = 'https://artifacts.example.test';
      const makeMedia = (runId, suffix) => ({
        observations: [
          {
            kind: 'image',
            source: 'native_tool_result',
            artifact_ref: `artifact_sha256:${sha256}`,
            run_id: runId,
            tool_call_id: 'native-call',
            content_index: 0,
            mime_type: 'image/png',
            bytes: bytes.length,
            sha256,
            download_url: `${base}/v1/link-refs/ghr_1234567890abcdef${suffix}`,
            open_url: `${base}/v1/link-refs/ghr_fedcba0987654321${suffix}`,
          },
        ],
        omitted_count: 0,
      });
      const first = makeMedia('run-a', 'a');
      const second = makeMedia('run-b', 'b');
      const selected = `![Readable result](${second.observations[0].download_url})`;
      const processStream = jest
        .fn()
        .mockResolvedValue(`![Readable result](${second.observations[0][selectionField]})`);
      const onNativeMediaSelection = jest.fn();
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      const fetchImage = jest
        .spyOn(global, 'fetch')
        .mockImplementation(
          async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
        );
      const originalEnv = { ...process.env };
      process.env.GLASSHIVE_ARTIFACT_BASE_URL = base;
      process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:8766/v1';
      process.env.WPR_API_TOKEN = 'synthetic-token';
      process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-secret';
      process.env.VIVENTIUM_TENANT_ID = 'synthetic-tenant';
      try {
        const req = {
          body: { conversationId: 'conv-1', messageId: 'msg-1' },
          user: { id: 'user-1' },
          config: {
            endpoints: {
              agents: {
                providerCapabilities: {
                  'glasshive-harness': {
                    workspace_binding: true,
                    default_access: 'workspace',
                    phase_b_followup: true,
                    conversation_session: true,
                    responses_api: false,
                  },
                },
              },
            },
          },
        };
        setTrustedInteractionContext(req, {
          actor_kind: 'worker',
          origin: 'callback',
          surface: 'web',
          conversation_id: 'conv-1',
          source_event_id: 'root-event',
        });
        const output = await generateFollowUpText({
          req,
          agent: {
            id: 'agent-main',
            provider: 'glasshive-harness',
            endpoint: 'glasshive-harness',
            model: 'codex-cli:gpt-5.6-sol',
            model_parameters: { model: 'codex-cli:gpt-5.6-sol', reasoning_effort: 'medium' },
            glasshive_options: { workspace: { mode: 'life' }, access: 'full' },
          },
          insightsData: {
            insights: [first, second].map((nativeMedia) => ({
              cortexName: 'Mission evidence',
              insight: 'The requested local application observation is complete.',
              nativeMedia,
              authority: {
                kind: 'durable_terminal_callback',
                runId: nativeMedia.observations[0].run_id,
              },
            })),
          },
          recentResponse: 'The work is running.',
          runId: 'image-followup',
          onNativeMediaSelection,
          conversationId: 'conv-1',
          parentMessageId: 'msg-1',
        });
        const messages = processStream.mock.calls[0][0].messages;
        expect(messages[0].content.filter((part) => part.type === 'image_url')).toHaveLength(2);
        expect(
          messages[0].content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n'),
        ).toContain(first.observations[0].download_url);
        expect(fetchImage).toHaveBeenCalledTimes(2);
        expect(createRun.mock.calls[0][0].graphConfig.tools).toEqual([]);
        expect(output).toBe(selected);
        expect(onNativeMediaSelection).toHaveBeenCalledWith({
          run_id: 'run-b',
          tool_call_id: 'native-call',
          content_index: 0,
          artifact_ref: second.observations[0].artifact_ref,
          label: 'Readable result',
        });
        expect(output).not.toContain(first.observations[0].download_url);
      } finally {
        process.env = originalEnv;
        fetchImage.mockRestore();
        createRun.mockRestore();
      }
    },
  );
});

describe('Phase B follow-up carrier', () => {
  test.each([
    [true, 'X-GlassHive-Turn-Context-B64'],
    [false, 'X-GlassHive-Turn-Context-B64'],
    [true, 'x-glasshive-turn-context-b64'],
    [false, 'x-glasshive-turn-context-b64'],
  ])(
    'isolates follow-up authority and Feeling state (enabled=%s, header=%s)',
    async (enabled, turnContextHeader) => {
      const capsule = '<viventium_feeling_state>follow-up-state-c</viventium_feeling_state>';
      const mainCapsule = '<viventium_feeling_state>main-only-state-m</viventium_feeling_state>';
      const processStream = jest.fn().mockResolvedValue('The reading list card is ready.');
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      const mainTurnBinding = {
        'X-Viventium-Main-Context-Protocol': 'main_context_v1',
        'X-Viventium-Main-Context-Owner': 'core',
        'X-Viventium-Main-Context-Snapshot-SHA256': 'a'.repeat(64),
        'X-Viventium-Main-Context-Epoch': 'b'.repeat(64),
        'X-Viventium-Continuity-Domain-Id': 'c'.repeat(64),
        'X-Viventium-Continuity-Agent-Id': 'agent-main',
        'X-Viventium-Logical-Turn-Id': 'turn-1',
        'X-Viventium-Logical-Turn-Revision': '1',
        'X-Viventium-Visible-Message-Chain-B64': Buffer.from(
          JSON.stringify([{ id: 'user-1' }, { id: 'assistant-1' }, { id: 'user-2' }]),
        ).toString('base64'),
        'X-GlassHive-Developer-Instruction-Tail-B64': Buffer.from(mainCapsule).toString('base64'),
        'X-GlassHive-Stable-Authority-SHA256': 'd'.repeat(64),
        [turnContextHeader]: Buffer.from('Synthetic Main-only continuity. '.repeat(1200)).toString(
          'base64',
        ),
      };
      try {
        const req = {
          id: 'synthetic-phase-b-carrier',
          _viventiumFeelingSnapshot: {
            enabled,
            agentScope: 'conscious_agent',
            snapshotHash: 'synthetic-followup-feeling-hash',
            capsule,
          },
          body: { conversationId: 'conv-1', messageId: 'msg-1' },
          user: { id: 'user-1' },
          config: {
            endpoints: {
              agents: {
                providerCapabilities: {
                  'glasshive-harness': {
                    workspace_binding: true,
                    default_access: 'workspace',
                    phase_b_followup: true,
                    conversation_session: true,
                    responses_api: false,
                  },
                },
              },
            },
          },
        };
        setTrustedInteractionContext(req, {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: 'conv-1',
          source_event_id: 'root-event',
        });
        await generateFollowUpText({
          req,
          agent: {
            id: 'agent-main',
            provider: 'glasshive-harness',
            endpoint: 'glasshive-harness',
            model: 'codex-cli:gpt-6.1-sol',
            model_parameters: {
              model: 'codex-cli:gpt-6.1-sol',
              reasoning_effort: 'high',
              configuration: { defaultHeaders: mainTurnBinding },
            },
            glasshive_options: {
              workspace: { mode: 'life' },
              access: 'full',
              fallback_model: 'claude-code:claude-opus-5-5',
              fallback_reasoning_effort: 'high',
            },
          },
          insightsData: {
            insights: [{ cortexName: 'Worker', insight: 'The reading list card is complete.' }],
          },
          recentResponse: 'The Worker is preparing the card.',
          runId: 'synthetic-run',
          conversationId: 'conv-1',
          parentMessageId: 'msg-1',
        });
        expect(createRun).toHaveBeenCalledTimes(1);
        const headers =
          createRun.mock.calls[0][0].graphConfig.llmConfig.configuration.defaultHeaders;
        const sent = Object.keys(headers).map((name) => name.toLowerCase());
        for (const name of Object.keys(mainTurnBinding)) {
          if (name === 'X-GlassHive-Developer-Instruction-Tail-B64') continue;
          expect(sent).not.toContain(name.toLowerCase());
        }
        const ownTail = Buffer.from(
          headers['X-GlassHive-Developer-Instruction-Tail-B64'],
          'base64',
        ).toString('utf8');
        const { getViventiumUserFactGuard } = require('../feelingPromptTail');
        expect(ownTail).toBe(
          [getViventiumUserFactGuard(), enabled ? capsule : ''].filter(Boolean).join('\n\n'),
        );
        const instructions = createRun.mock.calls[0][0].graphConfig.instructions;
        expect(instructions.split(capsule).length - 1).toBe(enabled ? 1 : 0);
        expect(instructions.split('<viventium_feeling_state>').length - 1).toBe(enabled ? 1 : 0);
        expect(JSON.stringify(createRun.mock.calls[0][0])).not.toContain(mainCapsule);
        expect(JSON.stringify(createRun.mock.calls[0][0])).not.toContain(
          Buffer.from(mainCapsule).toString('base64'),
        );
        expect(ownTail).not.toContain(mainCapsule);
        expect(createRun.mock.calls[0][0].graphConfig.instructions.endsWith(ownTail)).toBe(true);
        expect(headers['X-GlassHive-Agent-Id']).toBe('agent-main:phase_b:followup');
        expect(headers['X-Viventium-Origin']).toBe('interactive');
        expect(headers['X-Synthetic-Endpoint']).toBe('keep-endpoint-header');
        expect(headers['X-GlassHive-Agent-Id']).toContain('agent-main');
        expect(headers['X-GlassHive-Fallback-Model']).toBe('claude-code:claude-opus-5-5');
        expect(headers['X-GlassHive-Fallback-Reasoning-Effort']).toBe('high');
        expect(createRun.mock.calls[0][0].graphConfig.llmConfig.modelKwargs.model).toBe(
          'codex-cli:gpt-6.1-sol',
        );
        expect(createRun.mock.calls[0][0].graphConfig.llmConfig.modelKwargs.reasoning_effort).toBe(
          'high',
        );
      } finally {
        createRun.mockRestore();
      }
    },
  );
});

/* === VIVENTIUM START === Phase B waits for the exact persisted native parent. === */
describe('Phase B native parent readiness', () => {
  function input(authority) {
    const req = {
      user: { id: 'owner-readiness' },
      body: { conversationId: 'conversation-readiness', messageId: 'parent-readiness' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                workspace_binding: true,
                default_access: 'workspace',
                phase_b_followup: true,
                responses_api: false,
              },
            },
          },
        },
      },
    };
    setTrustedInteractionContext(
      req,
      {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: 'conversation-readiness',
        source_event_id: 'event-readiness',
      },
      undefined,
      { commit_authority: authority },
    );
    return {
      req,
      agent: {
        id: 'main-readiness',
        provider: 'glasshive-harness',
        model: 'codex-cli:gpt-6.1-sol',
        model_parameters: {
          model: 'codex-cli:gpt-6.1-sol',
          reasoning_effort: 'high',
        },
      },
      runId: 'parent-readiness',
      conversationId: 'conversation-readiness',
      parentMessageId: 'parent-readiness',
      recentResponse: 'The Main answer is complete.',
      insightsData: {
        insights: [{ cortexId: 'cortex-readiness', insight: 'A useful calculation.' }],
      },
    };
  }

  test.each(['server', 'external_adapter'])(
    '%s publication readiness precedes the first Phase B provider invocation',
    async (authority) => {
      let release;
      let enter;
      const ready = new Promise((resolve) => {
        release = resolve;
      });
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const unavailable = Object.assign(new Error('Exact parent is still publishing'), {
        code: 'native_graph_tool_evidence_parent_unfinished',
      });
      const oneShot = jest.fn(async () => {
        enter();
        throw unavailable;
      });
      const publication = jest.fn(async () => {
        enter();
        await ready;
        return [];
      });
      const service = jest
        .spyOn(require('../nativeResponseService'), 'getService')
        .mockReturnValue({
          readToolEvidence: oneShot,
          readToolEvidenceForPresentation: publication,
        });
      const processStream = jest.fn().mockResolvedValue('{NTA}');
      const run = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      let generation;
      try {
        generation = generateFollowUpText(input(authority));
        generation.catch(() => {});
        await entered;
        expect(publication).toHaveBeenCalledWith(
          'owner-readiness',
          'conversation-readiness',
          'parent-readiness',
          expect.any(Number),
        );
        expect(oneShot).not.toHaveBeenCalled();
        expect(processStream).not.toHaveBeenCalled();
        release();
        await expect(generation).resolves.toBe('{NTA}');
        expect(processStream).toHaveBeenCalledTimes(1);
      } finally {
        release();
        await generation?.catch(() => {});
        run.mockRestore();
        service.mockRestore();
      }
    },
  );

  test.each([
    ['server', 'native_graph_tool_evidence_source_changed'],
    ['external_adapter', 'native_graph_tool_evidence_source_changed'],
    ['server', 'native_graph_tool_evidence_parent_unfinished'],
    ['external_adapter', 'native_graph_tool_evidence_parent_unfinished'],
  ])('%s preserves the existing readiness rejection %s', async (authority, code) => {
    const error = Object.assign(new Error('Exact publication authority rejected'), { code });
    const oneShot = jest.fn().mockResolvedValue([]);
    const publication = jest.fn().mockRejectedValue(error);
    const service = jest
      .spyOn(require('../nativeResponseService'), 'getService')
      .mockReturnValue({ readToolEvidence: oneShot, readToolEvidenceForPresentation: publication });
    const processStream = jest.fn().mockResolvedValue('Must not author');
    const run = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    try {
      await expect(generateFollowUpText(input(authority))).rejects.toMatchObject({ code });
      expect(oneShot).not.toHaveBeenCalled();
      expect(processStream).not.toHaveBeenCalled();
    } finally {
      run.mockRestore();
      service.mockRestore();
    }
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Canonical Worker synthesis inherits the saved call brain. === */
describe('Worker completion Voice brain consumption', () => {
  test.each([true, false])(
    'keeps configured model, High effort and fallback with Voice assignment %s',
    async (configured) => {
      const processStream = jest.fn().mockResolvedValue('The verified worker result.');
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      const agent = {
        id: 'agent-main',
        provider: 'glasshive-harness',
        model: 'synthetic-main-model',
        model_parameters: { model: 'synthetic-main-model', reasoning_effort: 'high' },
        voice_llm_provider: configured ? 'glasshive-harness' : '',
        voice_llm_model: configured ? 'synthetic-voice-model' : '',
        voice_llm_model_parameters: { reasoning_effort: 'high' },
        glasshive_options: {
          workspace: { mode: 'life' },
          access: 'full',
          fallback_model: 'synthetic-fallback',
          fallback_reasoning_effort: 'high',
        },
      };
      const before = JSON.stringify(agent);
      try {
        await generateFollowUpText({
          req: {
            user: { id: 'user-1' },
            body: {
              viventiumSurface: 'voice',
              voiceMode: true,
              viventiumInputMode: 'voice_call',
              viventiumCallSessionId: 'live-call',
              viventiumStreamId: 'unrelated-foreground-stream',
            },
            _resumableStreamId: 'unrelated-foreground-stream',
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    'glasshive-harness': {
                      workspace_binding: true,
                      default_access: 'full',
                      phase_b_followup: true,
                      responses_api: false,
                      voice_pipeline_llm: true,
                    },
                  },
                },
              },
            },
          },
          agent,
          runId: 'mission-synthesis',
          conversationId: 'conv-1',
          parentMessageId: 'msg-1',
          recentResponse: 'The worker is running.',
          insightsData: {
            insights: [
              {
                cortexName: 'Worker',
                insight: 'Verified result.',
                authority: {
                  kind: 'durable_terminal_callback',
                  runId: 'worker-run',
                  event: 'run.completed',
                  workState: 'completed',
                },
              },
            ],
          },
        });
        expect(createRun).toHaveBeenCalledTimes(1);
        const config = createRun.mock.calls[0][0].graphConfig.llmConfig;
        expect(config.model).toBe('viventium-chat-completions');
        expect(config.modelKwargs.model).toBe(configured ? agent.voice_llm_model : agent.model);
        expect(config.modelKwargs.reasoning_effort).toBe('high');
        expect(config.configuration.defaultHeaders['X-GlassHive-Fallback-Model']).toBe(
          'synthetic-fallback',
        );
        expect(config.configuration.defaultHeaders['X-GlassHive-Fallback-Reasoning-Effort']).toBe(
          'high',
        );
        expect(config.configuration.defaultHeaders['X-GlassHive-Access']).toBe('full');
        expect(config.configuration.defaultHeaders['X-Viventium-Stream-Id']).toBe(
          'phase_b:agent-main:mission-synthesis',
        );
        expect(JSON.stringify(agent)).toBe(before);
      } finally {
        createRun.mockRestore();
      }
    },
  );
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Direct Phase B signed-body transport parity. === */
describe('Phase B signed bootstrap body dispatch', () => {
  test.each(['native', 'non-native', 'absent', 'conflicting'])(
    '%s carrier follows the existing Native transport boundary',
    async (mode) => {
      const api = require('@librechat/api');
      const endpoint = require('~/server/services/BackgroundCortexService');
      const encoded = Buffer.from(
        JSON.stringify({
          version: 1,
          selected_uploads: [
            { file_id: 'alpha', text: 'A'.repeat(200 * 1024) },
            { file_id: 'bravo', text: 'B'.repeat(200 * 1024) },
          ],
        }),
      ).toString('base64');
      const headers = {
        'X-Synthetic-Endpoint': 'retain',
        ...(mode === 'absent' ? {} : { 'X-GlassHive-Bootstrap-Bundle-B64': encoded }),
        'X-GlassHive-Bootstrap-Timestamp': '123',
        'X-GlassHive-Bootstrap-Signature': 'synthetic-signature',
      };
      endpoint.getCustomEndpointConfig.mockResolvedValueOnce({
        apiKey: 'synthetic-key',
        baseURL: 'https://native.example.test/v1',
        defaultHeaders: headers,
      });
      const sent = [];
      const admitted = [];
      const context = {
        userId: 'owner',
        conversationId: 'conversation',
        responseMessageId: 'answer',
        streamId: 'stream',
        jobCreatedAt: 1,
        logicalTurnId: 'scope.turn',
        revision: 1,
        providerId: 'native',
        agentId: 'main',
        source: { id: 'source', messageId: 'question', digest: 'digest' },
      };
      const sink = async (_input, init) => {
        sent.push(init);
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      };
      const bound = api.createNativeResponseFetch(
        sink,
        async () => context,
        async (identity) => {
          admitted.push(identity);
          return false;
        },
        () => {},
      );
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(bound);
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({
        processStream: jest.fn().mockResolvedValue('The verified result is ready.'),
      });
      try {
        await generateFollowUpText({
          req: {
            user: { id: 'user-1' },
            body: {},
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    'glasshive-harness': {
                      workspace_binding: mode !== 'non-native',
                      phase_b_followup: true,
                      responses_api: false,
                      default_access: 'workspace',
                    },
                  },
                },
              },
            },
          },
          agent: {
            id: 'main',
            provider: 'glasshive-harness',
            model: 'synthetic-model',
            model_parameters: { model: 'synthetic-model', reasoning_effort: 'high' },
          },
          runId: 'signed-bootstrap',
          insightsData: { insights: [{ insight: 'Verified result.' }] },
        });
        const configuration = createRun.mock.calls[0][0].graphConfig.llmConfig.configuration;
        const body = JSON.stringify({
          model: 'synthetic-model',
          messages: [{ role: 'user', content: 'Review.' }],
          metadata: {
            retain: 'original',
            ...(mode === 'conflicting' ? { bootstrap_bundle_b64: 'other' } : {}),
          },
        });
        const init = {
          method: 'POST',
          headers: {
            ...configuration.defaultHeaders,
            'content-length': String(Buffer.byteLength(body)),
          },
          body,
        };
        const dispatch = configuration.fetch || globalThis.fetch;
        if (mode === 'conflicting') {
          await expect(
            dispatch('https://native.example.test/v1/chat/completions', init),
          ).rejects.toThrow('Native bootstrap must use one carrier');
          expect(sent).toHaveLength(0);
          expect(admitted).toHaveLength(0);
          return;
        }
        await dispatch('https://native.example.test/v1/chat/completions', init);
        await dispatch('https://native.example.test/v1/chat/completions', init);
        expect(sent).toHaveLength(2);
        const wireHeaders = new Headers(sent[0].headers);
        const payload = JSON.parse(sent[0].body);
        if (mode === 'native') {
          expect(wireHeaders.has('X-GlassHive-Bootstrap-Bundle-B64')).toBe(false);
          expect(wireHeaders.has('content-length')).toBe(false);
          expect(payload.metadata.retain).toBe('original');
          expect(payload.metadata.bootstrap_bundle_b64 === encoded).toBe(true);
        } else {
          if (mode === 'non-native') expect(configuration.fetch).toBeUndefined();
          expect(payload.metadata.retain).toBe('original');
          expect(payload.metadata.bootstrap_bundle_b64).toBeUndefined();
          expect(wireHeaders.get('X-GlassHive-Bootstrap-Bundle-B64')).toBe(
            mode === 'absent' ? null : encoded,
          );
        }
        expect(wireHeaders.get('X-GlassHive-Bootstrap-Signature')).toBe('synthetic-signature');
        expect(wireHeaders.get('X-GlassHive-Bootstrap-Timestamp')).toBe('123');
        expect(payload.messages).toEqual([{ role: 'user', content: 'Review.' }]);
        expect(admitted[0].bodySha256).toBe(
          require('crypto').createHash('sha256').update(sent[0].body).digest('hex'),
        );
        expect(admitted[1].invocationId).toBe(admitted[0].invocationId);
        expect(sent[1].body).toBe(sent[0].body);
      } finally {
        fetchSpy.mockRestore();
        createRun.mockRestore();
      }
    },
  );
});
/* === VIVENTIUM END === */
/* === VIVENTIUM START === Dispatch identity ordering cannot be reversed. === */
test('bootstrap relocation after Native admission changes the bound body digest', async () => {
  const api = require('@librechat/api');
  const context = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: 1,
    logicalTurnId: 'scope.turn',
    revision: 1,
    providerId: 'native',
    agentId: 'main',
    source: { id: 'source', messageId: 'question', digest: 'digest' },
  };
  let sent;
  let admitted;
  const wrongOrder = api.createNativeResponseFetch(
    api.createNativeBootstrapFetch(async (_input, init) => {
      sent = init;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }),
    async () => context,
    async (identity) => {
      admitted = identity;
      return false;
    },
    () => {},
  );
  await wrongOrder('https://native.example.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'X-GlassHive-Bootstrap-Bundle-B64': 'opaque-signed-fixture' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Review.' }] }),
  });
  expect(admitted.bodySha256).not.toBe(
    require('crypto').createHash('sha256').update(sent.body).digest('hex'),
  );
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Phase B uses the declared Native output contract. === */
describe('Phase B declared audio output contract', () => {
  const modelDisposition = (audio) => ({
    version: 1,
    audio,
    required: true,
    valid: true,
    source: 'model',
  });
  async function runFollowUp({
    trustedCall = true,
    capability = true,
    output,
    text = 'The file is ready.',
    requestOverrides = {},
  } = {}) {
    let runOptions;
    const createRun = jest.spyOn(Run, 'create').mockImplementation(async (options) => {
      runOptions = options;
      return {
        processStream: jest.fn(async () => {
          await options.customHandlers?.on_chat_model_end?.handle('on_chat_model_end', { output });
          return text;
        }),
      };
    });
    const onDeliveryDisposition = jest.fn();
    const onNativeSilentDecision = jest.fn();
    const req = {
      user: { id: 'synthetic-owner' },
      body: { voiceMode: true, viventiumSurface: 'voice', viventiumCallSessionId: 'caller-label' },
      ...(trustedCall ? { viventiumCallSession: { callSessionId: 'owned-active-call' } } : {}),
      ...requestOverrides,
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                workspace_binding: true,
                conversation_session: true,
                responses_api: false,
                ...(capability
                  ? {
                      messaging_delivery_disposition: true,
                      messaging_delivery_disposition_version: 1,
                    }
                  : {}),
              },
            },
          },
        },
      },
    };
    try {
      const result = await generateFollowUpText({
        req,
        agent: {
          id: 'synthetic-main',
          provider: 'glasshive-harness',
          model: 'grok-build:grok-4.7-build-fast',
          model_parameters: { model: 'grok-build:grok-4.7-build-fast', reasoning_effort: 'high' },
        },
        insightsData: { insights: [{ cortexName: 'Synthetic', insight: 'A verified file.' }] },
        recentResponse: 'The worker is preparing it.',
        runId: 'synthetic-phase-b',
        conversationId: 'synthetic-conversation',
        parentMessageId: 'synthetic-parent',
        onDeliveryDisposition,
        onNativeSilentDecision,
      });
      return { result, runOptions, onDeliveryDisposition, onNativeSilentDecision };
    } finally {
      createRun.mockRestore();
    }
  }
  test.each([
    ['strict native silence', '', '', 'skip', true, false, true],
    ['missing controls', '', '', null, true, false, false],
    ['eligible empty output', '', '', 'eligible', true, false, false],
    ['no declared native controls', '', '', 'skip', false, false, false],
    ['native transfer', '', '', 'skip', true, true, false],
    ['lost authored text', '', 'A useful answer.', 'skip', true, false, false],
    ['useful authored answer', 'A useful answer.', 'A useful answer.', 'skip', true, false, false],
  ])(
    'keeps explicit completed native silence distinct from %s',
    async (_label, text, content, audio, capability, transfer, expected) => {
      const output = {
        additional_kwargs: {
          __raw_response: {
            choices: [
              {
                message: {
                  role: 'assistant',
                  content,
                  ...(transfer ? { tool_calls: [{ id: 'transfer', type: 'function' }] } : {}),
                  ...(audio
                    ? {
                        provider_specific_fields: {
                          viventium: { delivery_disposition: modelDisposition(audio) },
                        },
                      }
                    : {}),
                },
              },
            ],
          },
        },
      };
      const result = await runFollowUp({ text, output, capability });
      expect(result.onNativeSilentDecision).toHaveBeenCalledWith(expected);
      expect(result.result).toBe(text);
    },
  );
  test.each(['eligible', 'skip'])(
    'retains Native %s metadata with authored content',
    async (audio) => {
      const disposition = modelDisposition(audio);
      const result = await runFollowUp({
        output: {
          additional_kwargs: {
            provider_specific_fields: { viventium: { delivery_disposition: disposition } },
          },
        },
      });
      expect(result.result).toBe('The file is ready.');
      expect(
        result.runOptions.graphConfig.llmConfig.configuration.defaultHeaders[
          'X-Viventium-Audio-Eligible'
        ],
      ).toBe('true');
      expect(result.runOptions.graphConfig.llmConfig.__includeRawResponse).toBe(true);
      expect(result.onDeliveryDisposition).toHaveBeenCalledWith(disposition);
    },
  );
  test.each([
    ['missing', {}, 'required_missing'],
    [
      'malformed',
      {
        provider_specific_fields: {
          viventium: {
            delivery_disposition: {
              ...modelDisposition('eligible'),
              extra: true,
            },
          },
        },
      },
      'required_malformed',
    ],
  ])(
    'fails closed for required %s metadata without discarding text',
    async (_label, output, source) => {
      const result = await runFollowUp({ output });
      expect(result.result).toBe('The file is ready.');
      expect(result.onDeliveryDisposition).toHaveBeenCalledWith({
        version: 1,
        audio: 'skip',
        required: true,
        valid: false,
        source,
      });
    },
  );
  test('a caller Call label cannot declare an eligible output contract', async () => {
    const literal =
      '{"type":"assistant_response","tool_name":null,"voice":"eligible","content":"A literal JSON example."}';
    const result = await runFollowUp({ trustedCall: false, text: literal });
    expect(
      result.runOptions.graphConfig.llmConfig.configuration.defaultHeaders[
        'X-Viventium-Audio-Eligible'
      ],
    ).toBe('false');
    expect(result.result).toBe(literal);
    expect(result.onDeliveryDisposition).toHaveBeenCalledWith(null);
  });
  test('a provider without the declared capability retains literal JSON and legacy behavior', async () => {
    const literal = '{"voice":"skip","content":"Literal data"}';
    const result = await runFollowUp({ capability: false, text: literal });
    expect(
      result.runOptions.graphConfig.llmConfig.configuration.defaultHeaders[
        'X-Viventium-Audio-Eligible'
      ],
    ).toBeUndefined();
    expect(result.result).toBe(literal);
    expect(result.onDeliveryDisposition).toHaveBeenCalledWith(null);
  });
  test.each([false, true])(
    'Telegram audio eligibility requires authenticated adapter=%s',
    async (authenticated) => {
      const result = await runFollowUp({
        trustedCall: false,
        requestOverrides: {
          _viventiumTelegram: authenticated,
          body: { viventiumSurface: 'telegram', telegramAudioRequested: true },
        },
      });
      expect(
        result.runOptions.graphConfig.llmConfig.configuration.defaultHeaders[
          'X-Viventium-Audio-Eligible'
        ],
      ).toBe(String(authenticated));
      expect(result.onDeliveryDisposition).toHaveBeenCalledWith(
        authenticated
          ? { version: 1, audio: 'skip', required: true, valid: false, source: 'required_missing' }
          : null,
      );
    },
  );
  test('retains no-response silence with a valid model disposition', async () => {
    const disposition = modelDisposition('skip');
    const result = await runFollowUp({
      text: '{NTA}',
      output: {
        provider_specific_fields: { viventium: { delivery_disposition: disposition } },
      },
    });
    expect(result.result).toBe('{NTA}');
    expect(result.onDeliveryDisposition).toHaveBeenCalledWith(disposition);
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Typed terminal publication failures cannot reconnect. === */
describe('Phase B typed terminal result failure', () => {
  test.each([
    ['native_output_files_identity_unavailable', 409, true],
    ['native_output_files_identity_unavailable', 502, true],
    ['ECONNRESET', null, false],
    ['server_error', 502, false],
  ])('%s/%s retains its terminal or transport meaning', async (code, status, terminal) => {
    const failure = Object.assign(new Error('Synthetic result failure'), {
      code,
      ...(status == null ? {} : { status }),
    });
    const processStream = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('A verified result.');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    try {
      const operation = generateFollowUpText({
        req: {
          user: { id: 'synthetic-owner' },
          body: {},
          config: {
            endpoints: {
              agents: {
                providerCapabilities: {
                  'glasshive-harness': {
                    workspace_binding: true,
                    conversation_session: true,
                    activity_stream: true,
                    responses_api: false,
                  },
                },
              },
            },
          },
        },
        agent: {
          id: 'synthetic-main',
          provider: 'glasshive-harness',
          model: 'codex-cli:gpt-6.1-sol',
          model_parameters: { model: 'codex-cli:gpt-6.1-sol' },
        },
        runId: 'synthetic-terminal-followup',
        conversationId: 'synthetic-conversation',
        parentMessageId: 'synthetic-parent',
        recentResponse: 'Working.',
        insightsData: { insights: [{ cortexName: 'Worker', insight: 'The result is ready.' }] },
      });
      if (terminal) await expect(operation).rejects.toBe(failure);
      else await expect(operation).resolves.toBe('A verified result.');
      expect(processStream).toHaveBeenCalledTimes(terminal ? 1 : 2);
    } finally {
      createRun.mockRestore();
    }
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Installed caller respects exact result conflicts. === */
describe('installed Phase B model caller result status', () => {
  test.each([
    [409, 1],
    [502, 2],
  ])('status %s makes exactly %s attempts', async (status, attempts) => {
    const { AsyncCaller } = require('@langchain/core/utils/async_caller');
    const caller = new AsyncCaller({ maxRetries: 1 });
    const failure = Object.assign(new Error('Synthetic native publication response'), {
      status,
      code: status === 409 ? 'native_output_files_identity_unavailable' : 'server_error',
    });
    const invoke = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('Recovered transport.');
    const operation = caller.call(invoke);
    if (status === 409) await expect(operation).rejects.toBe(failure);
    else await expect(operation).resolves.toBe('Recovered transport.');
    expect(invoke).toHaveBeenCalledTimes(attempts);
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Phase B selected files survive pre-merge streams without requiring audio. === */
describe('Phase B native file carrier transport', () => {
  test.each(['stream', 'terminal', 'replaced', 'foreign'])(
    '%s keeps only the actual emitting source before SDK concatenation',
    async (mode) => {
      const onNativeOutputFiles = jest.fn();
      let expectedSource;
      const createRun = jest.spyOn(Run, 'create').mockImplementation(async (options) => ({
        processStream: async () => {
          const headers = options.graphConfig.llmConfig.configuration.defaultHeaders;
          expectedSource = {
            owner_id: headers['X-Viventium-User-Id'],
            conversation_id: headers['X-Viventium-Conversation-Id'],
            message_id: headers['X-Viventium-Message-Id'],
            stream_id: headers['X-Viventium-Stream-Id'],
            agent_id: headers['X-GlassHive-Agent-Id'],
          };
          const envelope = {
            version: 1,
            ...expectedSource,
            logical_turn_id: '',
            logical_turn_revision: 1,
            request_id: 'native-request',
            run_id: 'native-run',
            attempt_id: 'native-attempt',
            invocation_id: '',
            files: [
              {
                filename: 'shape.svg',
                mime_type: 'image/svg+xml',
                bytes: 138,
                sha256: 'a'.repeat(64),
                download_url:
                  'https://artifacts.example.test/v1/link-refs/ghr_main1234567890abcdef',
              },
            ],
          };
          if (mode === 'foreign') envelope.owner_id = 'foreign';
          const chunk = {
            additional_kwargs: {
              __raw_response: {
                id: 'native-request',
                object: mode === 'terminal' ? 'chat.completion' : 'chat.completion.chunk',
                glasshive: { output_files: envelope },
              },
            },
          };
          const handlers = options.customHandlers;
          expect(handlers.on_chat_model_stream).toBeDefined();
          expect(options.graphConfig.llmConfig.__includeRawResponse).toBe(true);
          handlers.on_chat_model_start.handle('on_chat_model_start', {});
          if (mode !== 'terminal')
            handlers.on_chat_model_stream.handle('on_chat_model_stream', { chunk });
          if (mode === 'replaced') handlers.on_chat_model_start.handle('on_chat_model_start', {});
          handlers.on_chat_model_end.handle('on_chat_model_end', {
            output:
              mode === 'terminal'
                ? chunk
                : {
                    additional_kwargs: {
                      __raw_response: {
                        id: 'native-requestnative-request',
                        object: 'chat.completion.chunk',
                        glasshive: { output_files: envelope },
                      },
                    },
                  },
          });
          return 'Here is your file.';
        },
      }));
      try {
        await generateFollowUpText({
          req: {
            id: 'synthetic-files',
            user: { id: 'owner' },
            body: {
              conversationId: 'conversation',
              messageId: 'accepted-parent',
              viventiumSurface: 'web',
            },
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    'glasshive-harness': {
                      workspace_binding: true,
                      conversation_session: true,
                      responses_api: false,
                    },
                  },
                },
              },
            },
          },
          agent: {
            id: 'main',
            provider: 'glasshive-harness',
            model: 'grok-build:grok-4.7-build-fast',
            model_parameters: { model: 'grok-build:grok-4.7-build-fast', reasoning_effort: 'high' },
          },
          insightsData: {
            insights: [{ cortexName: 'Worker', insight: 'The verified shape is ready.' }],
          },
          recentResponse: 'Preparing your file.',
          runId: 'stable-synthesis',
          conversationId: 'conversation',
          parentMessageId: 'accepted-parent',
          onNativeOutputFiles,
        });
        expect(onNativeOutputFiles).toHaveBeenCalledTimes(1);
        const capture = onNativeOutputFiles.mock.calls[0][0];
        if (mode === 'replaced' || mode === 'foreign') expect(capture).toEqual({ error: true });
        else {
          expect(capture.envelope).toMatchObject(expectedSource);
          expect(capture.identity).toMatchObject({
            userId: 'owner',
            conversationId: 'conversation',
            responseMessageId: 'accepted-parent',
            requestId: 'native-request',
            runId: 'native-run',
            attemptId: 'native-attempt',
          });
          expect(capture.presentationAgentId).toBe('main');
          expect(JSON.stringify(capture)).not.toContain('synthetic-harness-key');
        }
      } finally {
        createRun.mockRestore();
      }
    },
  );
});
