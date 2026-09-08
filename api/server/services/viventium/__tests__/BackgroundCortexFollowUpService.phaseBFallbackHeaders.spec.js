const { Run } = require('@librechat/agents');

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

jest.mock('../nativeResponseService', () => ({
  getService: () => ({ readToolEvidence: jest.fn().mockResolvedValue([]) }),
}));

const { setTrustedInteractionContext } = require('../interactionContext');

const { generateFollowUpText } = require('../BackgroundCortexFollowUpService');

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
  test('passes distinct observed images to Main and returns only its selected image link', async () => {
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
    const processStream = jest.fn().mockResolvedValue(selected);
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const fetchImage = jest
      .spyOn(global, 'fetch')
      .mockImplementation(
        async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }),
      );
    const originalBase = process.env.GLASSHIVE_ARTIFACT_BASE_URL;
    process.env.GLASSHIVE_ARTIFACT_BASE_URL = base;
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
      expect(output).not.toContain(first.observations[0].download_url);
    } finally {
      if (originalBase === undefined) delete process.env.GLASSHIVE_ARTIFACT_BASE_URL;
      else process.env.GLASSHIVE_ARTIFACT_BASE_URL = originalBase;
      fetchImage.mockRestore();
      createRun.mockRestore();
    }
  });
});
