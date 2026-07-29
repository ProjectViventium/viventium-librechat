const { Constants } = require('librechat-data-provider');

jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));

const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const {
  attachConversationProviderCapabilityBundle,
  bindHarnessCancellation,
  buildHarnessIdempotencyKey,
  declaredMcpServerNames,
} = require('../GlassHiveConversationProviderService');

describe('GlassHiveConversationProviderService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('builds stable role-scoped keys for main, Phase B, and parallel cortices', () => {
    expect(buildHarnessIdempotencyKey('main', 'response-1')).toBe('main:response-1');
    expect(buildHarnessIdempotencyKey('phase_b', 'response-1', 'main-agent')).toBe(
      'phase_b:main-agent:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'research')).toBe(
      'cortex:research:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'red-team')).not.toBe(
      buildHarnessIdempotencyKey('cortex', 'response-1', 'research'),
    );
  });

  test('delivers an intentional Stop to the exact authenticated main request', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      body: { responseMessageId: 'response-wrong' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1/', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);

    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-key',
          'X-Viventium-User-Id': 'user-synthetic',
        },
      }),
    );
  });

  test('does not cancel the native run for a transport disconnect', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        body: { responseMessageId: 'response-1' },
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });

    abortController.abort('transport_disconnected');
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports a non-success cancellation response instead of silently accepting it', async () => {
    const abortController = new AbortController();
    const onDeliveryError = jest.fn();
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'main:response-1',
        body: {},
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      onDeliveryError,
    });

    abortController.abort('user_cancelled');
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GlassHive cancellation returned HTTP 503' }),
    );
  });

  test('projects only declared non-GlassHive MCP servers', () => {
    const delimiter = Constants.mcp_delimiter;
    const names = declaredMcpServerNames(
      {
        tools: [
          `read_mail${delimiter}google-workspace`,
          `read_drive${delimiter}google-workspace`,
          `worker_run${delimiter}glasshive-workers-projects`,
          'file_search',
          { name: 'not-a-persisted-tool-id' },
        ],
      },
      ['glasshive-workers-projects'],
    );

    expect(names).toEqual(['google-workspace']);
  });

  test('does nothing when the selected provider has no workspace binding capability', async () => {
    const targetAgent = { model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: false },
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(targetAgent).toEqual({ model_parameters: {} });
  });

  test('attaches one signed bundle while preserving existing provider headers', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: '[mcp_servers.synthetic]',
    });
    const delimiter = Constants.mcp_delimiter;
    const requestBody = {
      conversationId: 'conversation-synthetic',
      messageId: 'message-synthetic',
    };
    const targetAgent = {
      model_parameters: {
        configuration: { defaultHeaders: { 'X-Existing': 'kept' } },
      },
    };
    const declaredAgent = {
      tools: [
        `search${delimiter}google-workspace`,
        `worker_run${delimiter}glasshive-workers-projects`,
      ],
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: { ignored: true } },
        requestBody,
        capability: {
          workspace_binding: true,
          excluded_mcp_servers: ['glasshive-workers-projects'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody,
      allowedServerNames: ['google-workspace'],
    });
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toEqual({ codex_config_append: '[mcp_servers.synthetic]' });
  });
});
