const mockAttach = jest.fn(async (input) => {
  if (input.nativeTools === false)
    return jest.requireActual('../GlassHiveConversationProviderService')
      .attachConversationProviderCapabilityBundle(input);
  return false;
});
jest.mock('../GlassHiveConversationProviderService', () => ({
  ...jest.requireActual('../GlassHiveConversationProviderService'),
  attachConversationProviderCapabilityBundle: (...args) => mockAttach(...args),
}));
jest.mock('~/models/Agent', () => ({ getAgent: jest.fn().mockResolvedValue(null) }));
jest.mock('~/server/services/BackgroundCortexService', () => ({
  getCustomEndpointConfig: jest.fn(async () => ({
    apiKey: 'synthetic-transport-key', baseURL: 'http://127.0.0.1:1/v1',
  })),
  mapProvider: () => 'openAI',
}));

const { resolveFollowUpLLMConfig } = require('../BackgroundCortexFollowUpService');
const priorSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
beforeEach(() => {
  mockAttach.mockClear();
  process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-zero-tool-signing-secret';
});
afterAll(() => {
  if (priorSecret === undefined) delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
  else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = priorSecret;
});

function fixture(tools) {
  const agent = {
    id: 'synthetic-main', provider: 'synthetic-native', model: 'claude-code:claude-opus-5',
    model_parameters: { reasoning_effort: 'low', configuration: { defaultHeaders: {} } },
    tools: ['active_work_action'], toolDefinitions: [{ name: 'active_work_list' }],
    toolRegistry: new Map([['terminal', {}]]), mcp: ['authorized-server'],
    agent_ids: ['consultant'], edges: [{ to: 'consultant' }],
    glasshive_options: { orchestration: { tool_mode: 'coordination' }, access: 'full' },
  };
  Object.defineProperty(agent, 'declaredToolNames', { value: ['worker_delegate_once'], enumerable: false });
  return {
    agent, tools, providerName: 'synthetic-native', effectiveModel: agent.model,
    conversationId: 'conversation', parentMessageId: 'parent', runId: 'followup',
    req: { user: { id: 'owner', role: 'USER' }, body: { conversationId: 'conversation' },
      config: { endpoints: { agents: { providerCapabilities: {
        'synthetic-native': { workspace_binding: true, conversation_session: true },
      } } } } },
    inheritedContext: { prompt: 'Complete current personality, memory and Feelings.',
      messages: [{ role: 'user', content: 'Original input.' }], evidence: [],
      turnContextB64: Buffer.from('Complete current context.').toString('base64'), selectedCarrierBytes: 25 },
  };
}

test('the actual tool-less presentation contract signs a zero-tool clone while retaining Main cognition/settings', async () => {
  const input = fixture([]);
  const original = input.agent;
  const result = await resolveFollowUpLLMConfig(input);
  const attached = mockAttach.mock.calls[0][0];
  expect(attached.nativeTools).toBe(false);
  expect(attached.targetAgent).not.toBe(original);
  expect(attached.declaredAgent).toBe(attached.targetAgent);
  for (const key of ['tools', 'toolDefinitions', 'declaredToolNames', 'mcp', 'agent_ids', 'edges'])
    expect(attached.targetAgent[key]).toEqual([]);
  expect(attached.targetAgent.toolRegistry.size).toBe(0);
  expect(attached.inheritedConversation).toBeDefined();
  const headers = result.configuration.defaultHeaders;
  expect(JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64')))
    .toEqual({ provider_capabilities: { native_tools: false } });
  expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  expect(headers['X-GlassHive-Turn-Context-B64']).toBe(input.inheritedContext.turnContextB64);
  expect(original.tools).toEqual(['active_work_action']);
  expect(original.declaredToolNames).toEqual(['worker_delegate_once']);
  expect(original.toolRegistry.has('terminal')).toBe(true);
  expect(original.glasshive_options.access).toBe('full');
  expect(original.model_parameters.configuration.defaultHeaders).toEqual({});
});

test.each([undefined, ['active_work_action']])(
  'does not narrow a participant without the actual empty tool execution contract: %p',
  async (tools) => {
    const input = fixture(tools);
    await resolveFollowUpLLMConfig(input);
    const attached = mockAttach.mock.calls[0][0];
    expect(attached.nativeTools).toBeUndefined();
    expect(attached.targetAgent.tools).toEqual(['active_work_action']);
    expect(attached.targetAgent.declaredToolNames).toEqual(['worker_delegate_once']);
    expect(attached.targetAgent.mcp).toEqual(['authorized-server']);
  },
);
