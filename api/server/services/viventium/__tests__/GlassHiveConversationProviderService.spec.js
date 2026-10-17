const { Constants } = require('librechat-data-provider');
const crypto = require('crypto');
const { setTrustedInteractionContext } = require('../interactionContext');

jest.mock('~/server/services/Config/getEndpointsConfig', () => ({
  getEndpointsConfig: jest.fn(async () => ({
    agents: { capabilities: ['file_search', 'web_search'] },
  })),
}));
const { getEndpointsConfig } = require('~/server/services/Config/getEndpointsConfig');

jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  primeFiles: jest.fn(async ({ tool_resources }) => ({
    files: tool_resources?.file_search?.files || [],
    toolContext: '',
  })),
}));

const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const { primeFiles } = require('~/app/clients/tools/util/fileSearch');
jest.mock('~/models', () => ({
  getMessages: jest.fn(async () => []),
  getFiles: jest.fn(async () => []),
}));
const { getMessages, getFiles } = require('~/models');
const {
  applyHostEvidenceBoundaryInstructions,
  attachDeclaredConversationProviderCapabilityBundle,
  attachConversationProviderCapabilityBundle,
  attachConversationProviderBootstrapBundle,
  installConversationProviderCapabilityRefresher,
  bindConversationProviderDeveloperInstructionTail,
  captureConversationProviderStableAuthority,
  conversationProviderStableAuthorityDigest,
  bindHarnessCancellation,
  CORTEX_ATTEMPT_DEADLINE_REASON,
  probeHarnessFamilyRelease,
  buildHarnessAgentIdempotencyKeys,
  buildHarnessAttemptIdempotencyKey,
  buildHarnessIdempotencyKey,
  clearConversationProviderCapabilityBundle,
  configuredBrokerHostTools,
  configuredConversationOrchestrationWorkerRoute,
  conversationProviderUsesLocalVisibleAccounting,
  conversationProviderUsesInvocationLocalTime,
  declaredMcpServerNames,
  resolveConversationProviderContextProtocol,
  resolveConversationProviderId,
  resolvedConversationOrchestrationToolNames,
  setConversationProviderCapability,
  restrictedConversationProviderBootstrapHeaders,
  resolveConversationProviderUploadedFiles,
} = require('../GlassHiveConversationProviderService');

describe('GlassHiveConversationProviderService', () => {
  describe('read-only text compactor signed zero-tool capability', () => {
    function args() {
      const targetAgent = {
        provider: 'synthetic-native',
        tools: [],
        model_parameters: {
          configuration: {
            defaultHeaders: {
              'X-GlassHive-Access': 'read_only',
              'X-GlassHive-Provider-Session-Mode': 'stateless',
            },
          },
        },
      };
      return {
        targetAgent,
        declaredAgent: targetAgent,
        req: { user: { id: 'owner-synthetic' }, body: {} },
        capability: { workspace_binding: true },
        nativeTools: false,
      };
    }
    test('private machine state is signed, internal and retained by the real capability refresher', async () => {
      const input = { ...args(), privateStructuredResponse: true };
      expect(installConversationProviderCapabilityRefresher(input)).toBe(true);
      expect(
        await attachConversationProviderCapabilityBundle({ ...input, deferUntilInvocation: true }),
      ).toBe(true);
      const refreshed = await input.targetAgent.viventiumConversationProviderCapabilityRefresh({
        messageId: 'next-attempt',
      });
      const headers = refreshed.defaultHeaders;
      expect(
        JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64')),
      ).toEqual({
        provider_capabilities: {
          native_tools: false,
          response_contract: {
            version: 1,
            visibility: 'private_machine_state',
            format: 'json_object',
          },
        },
      });
      expect(headers).toMatchObject({
        'X-Viventium-Actor-Kind': 'system',
        'X-Viventium-Origin': 'system',
        'X-Viventium-Audio-Eligible': 'false',
        'X-GlassHive-Access': 'read_only',
      });
      expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(
        'sha256=' +
          crypto
            .createHmac('sha256', 'synthetic-bundle-secret')
            .update(
              'v1\n' +
                headers['X-GlassHive-Bootstrap-Timestamp'] +
                '\n' +
                headers['X-GlassHive-Bootstrap-Bundle-B64'],
            )
            .digest('hex'),
      );
    });
    test('private user request fields cannot opt into private machine output', async () => {
      const input = args();
      input.req.body.privateStructuredResponse = true;
      input.req.body.completedResultPolicy = 'internal';
      input.req.body.provider_capabilities = {
        response_contract: { visibility: 'private_machine_state' },
      };
      await attachConversationProviderCapabilityBundle(input);
      const headers = input.targetAgent.model_parameters.configuration.defaultHeaders;
      expect(
        JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64')),
      ).toEqual({ provider_capabilities: { native_tools: false } });
      expect(headers).not.toHaveProperty('X-Viventium-Origin', 'system');
    });
    test.each([undefined, true, 'false'])(
      'private state requires zero-tool owner: %s',
      async (nativeTools) => {
        await expect(
          attachConversationProviderCapabilityBundle({
            ...args(),
            nativeTools,
            privateStructuredResponse: true,
          }),
        ).rejects.toThrow('explicit zero-tool');
      },
    );
    test('signs only native false and retains read-only exact session scope', async () => {
      const input = args();
      expect(await attachConversationProviderCapabilityBundle(input)).toBe(true);
      const headers = input.targetAgent.model_parameters.configuration.defaultHeaders;
      const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
      expect(JSON.parse(Buffer.from(encoded, 'base64').toString())).toEqual({
        provider_capabilities: { native_tools: false },
      });
      expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(
        'sha256=' +
          crypto
            .createHmac('sha256', 'synthetic-bundle-secret')
            .update(`v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${encoded}`)
            .digest('hex'),
      );
      expect(headers['X-GlassHive-Access']).toBe('read_only');
      expect(headers['X-GlassHive-Provider-Session-Mode']).toBe('stateless');
      expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
      expect(getMessages).not.toHaveBeenCalled();
    });
    test('re-signs at the existing invocation refresh boundary', async () => {
      const input = args();
      const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
      try {
        await attachConversationProviderCapabilityBundle(input);
        expect(installConversationProviderCapabilityRefresher(input)).toBe(true);
        const before = input.targetAgent.model_parameters.configuration.defaultHeaders;
        now.mockReturnValue(1700000010000);
        const result = await input.targetAgent.viventiumConversationProviderCapabilityRefresh({
          messageId: 'fresh-attempt',
        });
        expect(result.attached).toBe(true);
        expect(result.defaultHeaders['X-GlassHive-Bootstrap-Timestamp']).toBe('1700000010');
        expect(result.defaultHeaders['X-GlassHive-Bootstrap-Signature']).not.toBe(
          before['X-GlassHive-Bootstrap-Signature'],
        );
      } finally {
        now.mockRestore();
      }
    });
    test.each([
      ['tools', ['synthetic-tool']],
      ['declaredToolNames', ['synthetic-tool']],
      ['toolDefinitions', [{ function: { name: 'synthetic-tool' } }]],
      ['toolRegistry', new Map([['synthetic-tool', {}]])],
      ['mcp', ['synthetic-server']],
      ['agent_ids', ['synthetic-peer']],
      ['edges', [{ from: 'a', to: 'b' }]],
    ])('rejects nonzero %s instead of dropping authority', async (key, value) => {
      const input = args();
      input.declaredAgent = { [key]: value };
      await expect(attachConversationProviderCapabilityBundle(input)).rejects.toThrow(
        'requires a tool-less participant',
      );
      expect(input.targetAgent.model_parameters.configuration.defaultHeaders).not.toHaveProperty(
        'X-GlassHive-Bootstrap-Signature',
      );
    });
    test('unsigned request body cannot opt an ordinary participant into zero-tool mode', async () => {
      const input = args();
      delete input.nativeTools;
      input.req.body.nativeTools = false;
      input.req.body.provider_capabilities = { native_tools: false };
      expect(await attachConversationProviderCapabilityBundle(input)).toBe(false);
      expect(input.targetAgent.model_parameters.configuration.defaultHeaders).not.toHaveProperty(
        'X-GlassHive-Bootstrap-Signature',
      );
    });
    test('nonboolean internal declaration fails closed', async () => {
      await expect(
        attachConversationProviderCapabilityBundle({ ...args(), nativeTools: 'false' }),
      ).rejects.toThrow('must be a boolean');
    });
  });

  const originalBrokerSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    getMessages.mockResolvedValue([]);
    getFiles.mockResolvedValue([]);
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
  });

  test('defers only graph-owned minting and preserves the exact invocation-fresh capability', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
      buildConversationProviderBootstrapBundle.mockResolvedValue({
        glasshive_capability_broker: {
          grant_token: 'synthetic-fresh-grant',
          grant_id: 'synthetic-grant',
        },
        conversation_provider_instructions: 'Use only the freshly authorized capability.',
      });
      const make = () => {
        const targetAgent = {
          id: 'participant',
          instructions: 'Stable instructions.',
          tools: [`lookup${Constants.mcp_delimiter}declared`],
          model_parameters: {
            configuration: {
              defaultHeaders: {
                'X-GlassHive-Agent-Id': 'participant',
                'X-GlassHive-Access': 'read_only',
                'X-GlassHive-Bootstrap-Signature': 'stale',
                'X-Existing': 'keep',
              },
            },
          },
        };
        const req = { user: { id: 'owner' }, body: { conversationId: 'new' } };
        setTrustedInteractionContext(req, {
          actor_kind: 'system',
          origin: 'scheduler',
          surface: 'workbench',
          source_event_id: 'occurrence',
        });
        return { targetAgent, req, capability: { workspace_binding: true } };
      };
      const deferred = make();
      expect(installConversationProviderCapabilityRefresher(deferred)).toBe(true);
      expect(
        await attachConversationProviderCapabilityBundle({
          ...deferred,
          deferUntilInvocation: true,
        }),
      ).toBe(false);
      expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
      expect(getMessages).not.toHaveBeenCalled();
      expect(primeFiles).not.toHaveBeenCalled();
      expect(deferred.targetAgent.model_parameters.configuration.defaultHeaders).toEqual({
        'X-GlassHive-Agent-Id': 'participant',
        'X-GlassHive-Access': 'read_only',
        'X-Existing': 'keep',
        'X-Viventium-Actor-Kind': 'system',
        'X-Viventium-Origin': 'scheduler',
      });
      const finalized = { conversationId: 'final-conversation', messageId: 'final-message' };
      const fresh =
        await deferred.targetAgent.viventiumConversationProviderCapabilityRefresh(finalized);
      const eager = make();
      await attachConversationProviderCapabilityBundle({ ...eager, requestBody: finalized });
      expect(fresh.attached).toBe(true);
      expect(fresh.defaultHeaders).toEqual(
        eager.targetAgent.model_parameters.configuration.defaultHeaders,
      );
      expect(deferred.targetAgent.instructions).toBe(eager.targetAgent.instructions);
      expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledTimes(2);
      expect(buildConversationProviderBootstrapBundle.mock.calls[0][0]).toEqual(
        buildConversationProviderBootstrapBundle.mock.calls[1][0],
      );
      expect(buildConversationProviderBootstrapBundle.mock.calls[0][0].requestBody).toEqual(
        finalized,
      );
    } finally {
      now.mockRestore();
    }
  });

  test('does not defer a direct caller without an installed invocation refresher', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: 'synthetic-authority',
    });
    const targetAgent = {
      tools: [`lookup${Constants.mcp_delimiter}declared`],
      model_parameters: {},
    };
    expect(
      await attachConversationProviderCapabilityBundle({
        targetAgent,
        req: { user: { id: 'owner' }, body: {} },
        capability: { workspace_binding: true },
        deferUntilInvocation: true,
      }),
    ).toBe(true);
    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledTimes(1);
    expect(
      targetAgent.model_parameters.configuration.defaultHeaders['X-GlassHive-Bootstrap-Signature'],
    ).toMatch(/^sha256=/);
  });

  test('deferred graph refresh retains unavailable authority and passive failure-safe timing', async () => {
    const { logger } = require('@librechat/data-schemas');
    const input = {
      targetAgent: {
        id: 'participant',
        instructions: 'Stable rules.',
        tools: [`lookup${Constants.mcp_delimiter}declared`],
        model_parameters: {},
      },
      req: {
        user: { id: 'owner' },
        body: {},
        viventiumVoiceLogLatency: true,
        viventiumVoiceRequestId: 'synthetic-request',
      },
      capability: { workspace_binding: true },
    };
    installConversationProviderCapabilityRefresher(input);
    await attachConversationProviderCapabilityBundle({ ...input, deferUntilInvocation: true });
    buildConversationProviderBootstrapBundle.mockRejectedValue(new Error('synthetic denied'));
    const result = await input.targetAgent.viventiumConversationProviderCapabilityRefresh({
      messageId: 'final',
    });
    expect(result.attached).toBe(false);
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Signature');
    expect(result.instructionAppend).toContain('host capability broker is unavailable');
    expect(logger.debug).toHaveBeenCalledWith(
      '[VoiceLatency][LC][Timing]',
      expect.objectContaining({
        stage: 'capability_refresh_completed',
        source: expect.stringMatching(/^conversation_provider:[a-f0-9]{64}$/),
        request_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        stage_ms_f: expect.any(Number),
      }),
    );
    logger.debug.mockImplementationOnce(() => {
      throw new Error('diagnostic failure');
    });
    await expect(
      input.targetAgent.viventiumConversationProviderCapabilityRefresh({ messageId: 'next' }),
    ).resolves.toMatchObject({ attached: false });
  });

  test('signs selected prior native outputs using current owner File metadata', async () => {
    const fileId = 'native_' + 'a'.repeat(64);
    const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const earlier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const sibling = 'native_' + 'b'.repeat(64);
    getMessages.mockResolvedValue([
      { messageId: parentMessageId, parentMessageId: earlier },
      { messageId: earlier, attachments: [null, { file_id: fileId, filename: 'stale.txt' }] },
      { messageId: 'another-branch', attachments: [{ file_id: sibling }] },
    ]);
    getFiles.mockResolvedValue([
      { file_id: fileId, filename: 'selected.txt', type: 'text/plain', bytes: 19, source: 'local' },
    ]);
    buildConversationProviderBootstrapBundle.mockResolvedValue({});
    const targetAgent = { model_parameters: {} };
    const req = { user: { id: 'owner-a' }, body: { conversationId, parentMessageId, files: [] } };
    expect(
      await attachConversationProviderCapabilityBundle({
        targetAgent,
        req,
        capability: { workspace_binding: true, worker_native_tools: true },
      }),
    ).toBe(true);
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
    const bundle = JSON.parse(Buffer.from(encoded, 'base64').toString());
    expect(bundle.viventium_upload_context.selected_uploads).toEqual([
      {
        file_id: fileId,
        filename: 'selected.txt',
        type: 'text/plain',
        bytes: 19,
        source: 'local',
        media_group_index: 1,
      },
    ]);
    expect(getFiles).toHaveBeenCalledWith(
      { user: 'owner-a', file_id: { $in: [fileId] } },
      null,
      'file_id filename type bytes source context text messageId',
    );
    expect(req.body.files).toEqual([]);
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(
      'sha256=' +
        crypto
          .createHmac('sha256', 'synthetic-bundle-secret')
          .update('v1\n' + headers['X-GlassHive-Bootstrap-Timestamp'] + '\n' + encoded)
          .digest('hex'),
    );
  });

  test('signs the minimal native restriction with the existing bootstrap protocol', () => {
    const headers = restrictedConversationProviderBootstrapHeaders();
    const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
    const issuedAt = headers['X-GlassHive-Bootstrap-Timestamp'];
    expect(JSON.parse(Buffer.from(encoded, 'base64'))).toEqual({
      provider_capabilities: { native_tools: false },
    });
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(
      `sha256=${crypto
        .createHmac('sha256', 'synthetic-bundle-secret')
        .update(`v1\n${issuedAt}\n${encoded}`)
        .digest('hex')}`,
    );
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    expect(restrictedConversationProviderBootstrapHeaders).toThrow('signature secret');
  });

  test('signs safe current attachment identities without requiring a broker tool', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({});
    const targetAgent = { model_parameters: {} };
    const files = [
      {
        file_id: 'audio-current',
        filename: 'request.m4a',
        type: 'audio/mp4',
        source: 'local',
        bytes: 123,
        filepath: '/uploads/other-owner/private.m4a',
        url: 'https://untrusted.invalid/file',
        source_path: '/private/arbitrary',
      },
    ];
    expect(
      await attachConversationProviderCapabilityBundle({
        targetAgent,
        req: { user: { id: 'owner-a' }, body: { files } },
        capability: { workspace_binding: true, worker_native_tools: true },
      }),
    ).toBe(true);
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
    const bundle = JSON.parse(Buffer.from(encoded, 'base64').toString());
    expect(bundle.viventium_upload_context.selected_uploads).toEqual([
      {
        file_id: 'audio-current',
        filename: 'request.m4a',
        type: 'audio/mp4',
        source: 'local',
        bytes: 123,
        media_group_index: 0,
      },
    ]);
    expect(encoded).not.toBe('');
    const expected = crypto
      .createHmac('sha256', 'synthetic-bundle-secret')
      .update(`v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${encoded}`)
      .digest('hex');
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expected}`);
  });

  test('native audio uses the same signed current upload resources while preserving inherited worker capabilities', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: {
        allowed_host_tools: ['file_search', 'transcribe_audio'],
      },
    });
    const current = {
      file_id: '11111111-1111-4111-8111-111111111111',
      filename: 'current.m4a',
      type: 'audio/mp4',
      bytes: 4,
      source: 'local',
      filepath: '/private/untrusted.m4a',
      url: 'https://untrusted.invalid/current.m4a',
    };
    const inherited = {
      file_id: 'recall-owner',
      filename: 'recall.txt',
      context: 'conversation_recall',
    };
    const targetAgent = {
      id: 'main',
      model_parameters: {},
      declaredToolNames: ['file_search'],
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: {
        file_search: { files: [inherited] },
        transcribe_audio: { files: [{ file_id: 'old-upload', filename: 'old.m4a' }] },
      },
    };
    const req = {
      user: { id: 'owner' },
      body: { files: [current], conversationId: 'conversation', messageId: 'message' },
      _viventiumGlassHiveWorkerMemory: 'Authorized preference.',
      _viventiumGlassHiveCapabilityDependency: { version: 1, source: 'turn_tool_activation' },
    };
    expect(
      await attachConversationProviderCapabilityBundle({
        targetAgent,
        req,
        capability: {
          workspace_binding: true,
          worker_native_tools: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search', 'transcribe_audio'],
        },
      }),
    ).toBe(true);
    const call = buildConversationProviderBootstrapBundle.mock.calls[0][0];
    expect(call.allowedHostTools).toEqual(['file_search', 'transcribe_audio']);
    expect(call.hostToolResources.file_search).toEqual({ entity_id: 'main', files: [inherited] });
    expect(call.workerMemory).toBe('Authorized preference.');
    expect(call.capabilityDependency).toEqual(req._viventiumGlassHiveCapabilityDependency);
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    const bundle = JSON.parse(
      Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString(),
    );
    expect(call.hostToolResources.transcribe_audio.files.map((file) => file.file_id)).toEqual(
      bundle.viventium_upload_context.selected_uploads.map((file) => file.file_id),
    );
    expect(call.hostToolResources.transcribe_audio.files).toEqual([
      { file_id: current.file_id, filename: current.filename },
    ]);
    expect(bundle.viventium_upload_context.selected_uploads[0]).toMatchObject({
      type: current.type,
      bytes: 4,
      source: 'local',
      media_group_index: 0,
    });
    expect(JSON.stringify(call.hostToolResources)).not.toContain('/private/');
    expect(JSON.stringify(call.hostToolResources)).not.toContain('untrusted.invalid');
    expect(targetAgent.tool_resources.transcribe_audio.files[0].file_id).toBe('old-upload');
  });

  test.each([false, true])(
    'a follow-up grants selected historical attachments without rewriting current inputs (new upload=%s)',
    async (includeCurrent) => {
      const historical = {
        file_id: '22222222-2222-4222-8222-222222222222',
        filename: 'prior.m4a',
        type: 'audio/mp4',
        bytes: 4,
        source: 'local',
      };
      const current = {
        file_id: '11111111-1111-4111-8111-111111111111',
        filename: 'current.m4a',
        type: 'audio/mp4',
        bytes: 8,
        source: 'local',
      };
      const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      getMessages.mockResolvedValue([
        { messageId: parentMessageId, files: [{ file_id: historical.file_id }] },
      ]);
      getFiles.mockResolvedValue([historical]);
      buildConversationProviderBootstrapBundle.mockResolvedValue({});
      const currentFiles = includeCurrent ? [current] : [];
      const expectedIds = [...currentFiles.map((file) => file.file_id), historical.file_id];
      const req = {
        user: { id: 'owner' },
        body: { conversationId, parentMessageId, files: currentFiles },
      };
      const targetAgent = { model_parameters: {} };
      await attachConversationProviderCapabilityBundle({
        targetAgent,
        req,
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['transcribe_audio'],
        },
      });
      const call = buildConversationProviderBootstrapBundle.mock.calls[0][0];
      expect(call.hostToolResources.transcribe_audio.files.map((file) => file.file_id)).toEqual(
        expectedIds,
      );
      expect(call.requestBody.files).toEqual(currentFiles);
      expect(req.body.files).toEqual(currentFiles);
      expect(getMessages).toHaveBeenCalledWith(
        { user: 'owner', conversationId },
        'messageId parentMessageId files attachments',
      );
      expect(getFiles).toHaveBeenCalledWith(
        { user: 'owner', file_id: { $in: [historical.file_id] } },
        null,
        'file_id filename type bytes source context text messageId',
      );
      const encoded =
        targetAgent.model_parameters.configuration.defaultHeaders[
          'X-GlassHive-Bootstrap-Bundle-B64'
        ];
      const bundle = JSON.parse(Buffer.from(encoded, 'base64').toString());
      expect(bundle.viventium_upload_context.selected_uploads.map((file) => file.file_id)).toEqual(
        call.hostToolResources.transcribe_audio.files.map((file) => file.file_id),
      );
    },
  );

  test.each([
    {
      workspace_binding: false,
      host_tools_transport: 'broker_mcp',
      host_tools: ['transcribe_audio'],
    },
    { workspace_binding: true, host_tools_transport: 'none', host_tools: ['transcribe_audio'] },
    { workspace_binding: true, host_tools_transport: 'broker_mcp', host_tools: [] },
  ])(
    'native audio is not granted when the selected provider disables the capability (%p)',
    async (capability) => {
      buildConversationProviderBootstrapBundle.mockResolvedValue({});
      await attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        capability,
        req: {
          user: { id: 'owner' },
          body: { files: [{ file_id: '11111111-1111-4111-8111-111111111111', filename: 'a.m4a' }] },
        },
      });
      for (const [call] of buildConversationProviderBootstrapBundle.mock.calls) {
        expect(call.allowedHostTools).not.toContain('transcribe_audio');
        expect(call.hostToolResources).not.toHaveProperty('transcribe_audio');
      }
    },
  );

  test.each([{ files: [] }, { files: [{ filename: 'no-owned-id.m4a', type: 'audio/mp4' }] }])(
    'native audio is not granted without usable current upload IDs (%p)',
    async ({ files }) => {
      buildConversationProviderBootstrapBundle.mockResolvedValue({});
      await attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['transcribe_audio'],
        },
        req: { user: { id: 'owner' }, body: { files } },
      });
      for (const [call] of buildConversationProviderBootstrapBundle.mock.calls) {
        expect(call.allowedHostTools).not.toContain('transcribe_audio');
        expect(call.hostToolResources).not.toHaveProperty('transcribe_audio');
      }
    },
  );

  afterAll(() => {
    if (originalBrokerSecret === undefined) {
      delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = originalBrokerSecret;
    }
  });

  test('observes only the attached grant without serializing the server evidence observer', () => {
    const observeGrant = jest.fn();
    const targetAgent = { model_parameters: {} };
    const req = { _viventiumCortexToolEvidence: { observeGrant } };
    const bundle = { glasshive_capability_broker: { grant_id: 'fresh-grant' } };
    expect(attachConversationProviderBootstrapBundle({ targetAgent, bundle, req })).toBe(true);
    expect(observeGrant).toHaveBeenCalledWith('fresh-grant');
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toEqual(bundle);
  });

  test.each(['empty', 'broker-unavailable'])(
    'retains trusted native scope across %s capability projection and refresh',
    async (mode) => {
      const req = { user: { id: 'owner' }, body: { origin: 'interactive' } };
      setTrustedInteractionContext(req, {
        actor_kind: 'system',
        origin: 'scheduler',
        surface: 'workbench',
        source_event_id: 'occurrence',
      });
      const targetAgent = {
        id: 'participant',
        tools: mode === 'empty' ? [] : [`lookup${Constants.mcp_delimiter}declared`],
        model_parameters: {
          configuration: {
            defaultHeaders: {
              'x-viventium-actor-kind': 'external_user',
              'X-VIVENTIUM-ORIGIN': 'interactive',
              'X-Existing': 'keep',
            },
          },
        },
      };
      if (mode === 'broker-unavailable') {
        buildConversationProviderBootstrapBundle.mockRejectedValueOnce(new Error('offline'));
      }
      const args = { targetAgent, req, capability: { workspace_binding: true } };
      expect(await attachConversationProviderCapabilityBundle(args)).toBe(false);
      const expected = {
        'X-Existing': 'keep',
        'X-Viventium-Actor-Kind': 'system',
        'X-Viventium-Origin': 'scheduler',
      };
      expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual(expected);
      expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
      expect(
        (await targetAgent.viventiumConversationProviderCapabilityRefresh()).defaultHeaders,
      ).toEqual(expected);
      if (mode === 'empty') expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    },
  );

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

  test('gives a generic fallback attempt a distinct request identity in the same outer turn', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };

    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main:response-1');
    req._viventiumFallbackLlmAttempt = true;
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
  });

  test('gives each workspace-bound graph agent a stable distinct request identity', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };
    const first = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent'],
    });
    const retry = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent'],
    });

    expect(first).toEqual({
      primaryKey: 'main:response-1',
      byAgentId: {
        'main-agent': 'main:response-1',
        'reality-agent': 'main:reality-agent:response-1',
      },
      allKeys: ['main:response-1', 'main:reality-agent:response-1'],
    });
    expect(retry).toEqual(first);
    expect(first.byAgentId['reality-agent']).not.toBe(first.byAgentId['main-agent']);
  });

  test('preserves completed-transfer receipt families across graph fallback models', () => {
    const req = { _viventiumHarnessExecutionEnabled: true };
    const primary = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent', 'red-agent'],
      preserveGraphTurnFamily: true,
    });

    req._viventiumFallbackLlmAttempt = true;
    const graphFallback = buildHarnessAgentIdempotencyKeys(req, 'response-1', {
      primaryAgentId: 'main-agent',
      agentIds: ['main-agent', 'reality-agent', 'red-agent'],
      preserveGraphTurnFamily: true,
    });

    expect(graphFallback).toEqual(primary);
    expect(graphFallback.byAgentId).toEqual({
      'main-agent': 'main:response-1',
      'reality-agent': 'main:reality-agent:response-1',
      'red-agent': 'main:red-agent:response-1',
    });
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
  });

  test('scopes workspace handoffs even when the primary provider is not workspace-bound', () => {
    const req = { _viventiumHarnessExecutionEnabled: false };

    expect(
      buildHarnessAgentIdempotencyKeys(req, 'response-1', {
        primaryAgentId: 'direct-main',
        agentIds: ['reality-agent', 'research-agent'],
      }),
    ).toEqual({
      primaryKey: '',
      byAgentId: {
        'reality-agent': 'main:reality-agent:response-1',
        'research-agent': 'main:research-agent:response-1',
      },
      allKeys: ['main:reality-agent:response-1', 'main:research-agent:response-1'],
    });
  });

  test('keeps the declared custom endpoint after provider transport normalization', () => {
    expect(
      resolveConversationProviderId({
        endpoint: 'glasshive-harness',
        provider: 'openAI',
      }),
    ).toBe('glasshive-harness');
    expect(resolveConversationProviderId({ provider: 'anthropic' })).toBe('anthropic');
  });

  test('removes native broker bearer headers case-insensitively from presentation lanes', () => {
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'x-glasshive-bootstrap-bundle-b64': 'synthetic-bundle',
            'X-GlassHive-Bootstrap-Timestamp': '123',
            'x-GlassHive-Bootstrap-Signature': 'sha256=synthetic',
            'X-GlassHive-Agent-Id': 'agent-main',
          },
        },
      },
    };

    clearConversationProviderCapabilityBundle(targetAgent);

    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({
      'X-GlassHive-Agent-Id': 'agent-main',
    });
  });

  test('resolves invocation-local provider behavior from structured capabilities', () => {
    const req = {
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                time_context_delivery: 'per_turn_header',
                usage_accounting_scope: 'provider_request',
                context_protocol: 'main_context_v1',
              },
              anthropic: {
                time_context_delivery: 'developer',
                usage_accounting_scope: 'visible_message_local',
                context_protocol: 'legacy',
              },
            },
          },
        },
      },
    };

    expect(conversationProviderUsesInvocationLocalTime(req, 'glasshive-harness')).toBe(true);
    expect(conversationProviderUsesInvocationLocalTime(req, { provider: 'anthropic' })).toBe(false);
    expect(conversationProviderUsesLocalVisibleAccounting(req, { provider: 'anthropic' })).toBe(
      true,
    );
    expect(resolveConversationProviderContextProtocol(req, 'glasshive-harness')).toBe(
      'main_context_v1',
    );
  });

  test('binds stable authority independently from per-turn runtime state', () => {
    const makeAgent = () => ({
      id: 'synthetic-main',
      provider: 'glasshive-harness',
      model: 'codex-cli:synthetic',
      instructions: 'Stable synthetic Main authority.',
      tools: ['file_search'],
      model_parameters: {
        configuration: {
          defaultHeaders: { 'X-GlassHive-Agent-Id': 'synthetic-main' },
        },
      },
    });
    const first = makeAgent();
    const second = makeAgent();

    expect(captureConversationProviderStableAuthority(first)).toBe(true);
    expect(captureConversationProviderStableAuthority(second)).toBe(true);
    first.instructions += '\n\nCurrent Feeling: calm.';
    second.instructions += '\n\nCurrent Feeling: energetic.';

    const firstDigest =
      first.model_parameters.configuration.defaultHeaders['X-GlassHive-Stable-Authority-SHA256'];
    expect(firstDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      second.model_parameters.configuration.defaultHeaders['X-GlassHive-Stable-Authority-SHA256'],
    ).toBe(firstDigest);
    expect(
      conversationProviderStableAuthorityDigest({
        ...makeAgent(),
        toolDefinitions: [{ name: 'file_search', description: 'Runtime schema.' }],
      }),
    ).toBe(conversationProviderStableAuthorityDigest(makeAgent()));
  });

  test('switches harness execution flags from structured provider capabilities', () => {
    const req = {
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                activity_stream: true,
                workspace_binding: true,
                conversation_session: true,
                time_context_delivery: 'per_turn_header',
                usage_accounting_scope: 'visible_message_local',
                context_protocol: 'legacy',
                native_session_authority: 'none',
                replay_protocol: 'legacy_message_count',
              },
              anthropic: {
                activity_stream: false,
                workspace_binding: false,
                conversation_session: false,
              },
            },
          },
        },
      },
    };

    expect(setConversationProviderCapability(req, 'glasshive-harness')).toMatchObject({
      workspace_binding: true,
    });
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: true,
      _viventiumHarnessExecutionEnabled: true,
      viventiumTimeContextDelivery: 'per_turn_header',
      viventiumUsageAccountingScope: 'visible_message_local',
    });

    expect(setConversationProviderCapability(req, 'anthropic')).toMatchObject({
      workspace_binding: false,
    });
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: false,
      _viventiumHarnessExecutionEnabled: false,
      viventiumTimeContextDelivery: 'developer',
    });
  });

  test('never re-enables or signs native capabilities for an unverified voice actor', async () => {
    const req = {
      body: {
        voiceMode: true,
        viventiumActorTrust: 'shared_mic_unverified',
        viventiumCanAuthorizeSideEffects: false,
      },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                activity_stream: true,
                workspace_binding: true,
                conversation_session: true,
              },
            },
          },
        },
      },
      _viventiumHarnessIdempotencyKey: 'synthetic-must-be-cleared',
    };
    const capability = setConversationProviderCapability(req, 'glasshive-harness');
    const targetAgent = {
      id: 'agent-synthetic',
      tools: [`send_email${Constants.mcp_delimiter}synthetic-connected-account`],
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: targetAgent,
        req,
        capability,
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(req).toMatchObject({
      _viventiumHarnessActivityEnabled: false,
      _viventiumHarnessExecutionEnabled: false,
    });
    expect(req._viventiumHarnessIdempotencyKey).toBeUndefined();
    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('derives delegated host-tool policy from structured broker capabilities only', () => {
    expect(
      configuredBrokerHostTools({
        first: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
        disabled: {
          workspace_binding: false,
          host_tools_transport: 'broker_mcp',
          host_tools: ['untrusted_tool'],
        },
      }),
    ).toEqual(['file_search']);
  });

  test('projects Main orchestration separately from inheritable worker host tools', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: {
        allowed_host_tools: ['file_search', 'active_work_list'],
      },
    });
    const targetAgent = {
      id: 'agent-synthetic',
      glasshive_options: {
        orchestration: {
          parallel_available: true,
          worker_profile: 'codex-cli',
          fallback_worker_profile: 'claude-code',
        },
      },
      toolRegistry: new Map([
        ['file_search', { name: 'file_search' }],
        ['active_work_list', { name: 'active_work_list' }],
        ['active_work_action', { name: 'active_work_action' }],
        [
          'worker_delegate_once_mcp_glasshive-workers-projects',
          { name: 'worker_delegate_once_mcp_glasshive-workers-projects' },
        ],
        ['unknown_peer_spawn', { name: 'unknown_peer_spawn' }],
      ]),
      tool_resources: { file_search: { files: [{ file_id: 'file-1' }] } },
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
    const capability = {
      workspace_binding: true,
      host_tools_transport: 'broker_mcp',
      host_tools: ['file_search'],
      conversation_orchestration_tools: [
        'active_work_list',
        'active_work_action',
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'unknown_peer_spawn',
      ],
    };
    const req = {
      user: { id: 'user-synthetic' },
      body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
      _viventiumGlassHiveWorkerMemory: 'Permission-gated user fact.',
      _viventiumGlassHiveCapabilityDependency: { version: 1, source: 'turn_tool_activation' },
    };

    expect(resolvedConversationOrchestrationToolNames(targetAgent, capability)).toEqual([
      'active_work_action',
      'active_work_list',
      'worker_delegate_once_mcp_glasshive-workers-projects',
    ]);
    expect(configuredConversationOrchestrationWorkerRoute(targetAgent)).toEqual({
      workerProfile: 'codex-cli',
      fallbackWorkerProfile: 'claude-code',
    });
    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: targetAgent,
        req,
        capability,
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHostTools: ['file_search'],
        allowedConversationOrchestrationTools: [
          'active_work_action',
          'active_work_list',
          'worker_delegate_once_mcp_glasshive-workers-projects',
        ],
        workerMemory: 'Permission-gated user fact.',
        capabilityDependency: { version: 1, source: 'turn_tool_activation' },
        workerProfile: 'codex-cli',
        fallbackWorkerProfile: 'claude-code',
      }),
    );
    expect(configuredBrokerHostTools({ 'synthetic-harness': capability })).toEqual(['file_search']);
  });

  test('denies broker-native peer orchestration to mission roots', () => {
    const missionRoot = {
      id: 'mission-root',
      toolRegistry: new Map([
        [
          'worker_delegate_once_mcp_glasshive-workers-projects',
          { name: 'worker_delegate_once_mcp_glasshive-workers-projects' },
        ],
        ['active_work_list', { name: 'active_work_list' }],
        ['active_work_action', { name: 'active_work_action' }],
      ]),
    };
    const capability = {
      workspace_binding: true,
      host_tools_transport: 'broker_mcp',
      conversation_orchestration_tools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
    };

    expect(resolvedConversationOrchestrationToolNames(missionRoot, capability)).toEqual([]);
    missionRoot.glasshive_options = { orchestration: { parallel_available: false } };
    expect(resolvedConversationOrchestrationToolNames(missionRoot, capability)).toEqual([]);
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('cancels the exact native request when a newer logical-turn revision supersedes it', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-superseded',
      body: { responseMessageId: 'response-superseded' },
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });

    abortController.abort('superseded');
    await req._viventiumHarnessCancellationDeliveryPromise;

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-superseded/cancel',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each(['maintenance_yield', 'compaction_lease_lost'])(
    'delivers %s to release the exact native compactor request',
    async (reason) => {
      const abortController = new AbortController();
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ capacityReleased: true }),
      });
      const req = {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'cortex:compaction-run:compactor-agent',
        body: {},
        user: { id: 'user-synthetic' },
      };

      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      });
      abortController.abort(reason);
      await req._viventiumHarnessCancellationDeliveryPromise;

      expect(fetchImpl).toHaveBeenCalledWith(
        'http://glasshive.local/v1/requests/by-idempotency/cortex%3Acompaction-run%3Acompactor-agent/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test('delivers an already-requested maintenance yield when direct binding finishes late', async () => {
    const abortController = new AbortController();
    abortController.abort('maintenance_yield');
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ capacityReleased: true }),
    });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'cortex:late-binding:compactor-agent',
      body: {},
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    await req._viventiumHarnessCancellationDeliveryPromise;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  /* === VIVENTIUM START ===
   * Purpose: A cortex attempt's deadline is an owned cancellation of its exact native request,
   * acknowledged only when the native capacity is actually released.
   * === VIVENTIUM END === */
  test.each([
    [true, true],
    [false, false],
  ])(
    'delivers an attempt deadline to the exact native request (released=%s acknowledged=%s)',
    async (capacityReleased, acknowledged) => {
      const abortController = new AbortController();
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ capacityReleased }),
      });
      const req = {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'cortex:deadline-run:cortex-agent',
        body: {},
        user: { id: 'user-synthetic' },
      };

      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError: jest.fn(),
      });
      abortController.abort(CORTEX_ATTEMPT_DEADLINE_REASON);
      const outcome = await req._viventiumHarnessCancellationDeliveryPromise;

      expect(fetchImpl).toHaveBeenCalledWith(
        'http://glasshive.local/v1/requests/by-idempotency/cortex%3Adeadline-run%3Acortex-agent/cancel',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(outcome.acknowledged).toBe(acknowledged);
    },
  );

  /* === VIVENTIUM START ===
   * Purpose: An attempt that ends without its accepted result releases its exact native request
   * with no abort, acknowledged only when GlassHive reports the capacity released.
   * === VIVENTIUM END === */
  test.each([
    [true, true],
    [false, false],
  ])(
    'releases an attempt that ended without an abort (released=%s acknowledged=%s)',
    async (capacityReleased, acknowledged) => {
      jest.useFakeTimers();
      try {
        const abortController = new AbortController();
        const fetchImpl = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({ capacityReleased }),
        });
        const req = {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'cortex:ended-run:cortex-agent',
          body: {},
          user: { id: 'user-synthetic' },
        };
        bindHarnessCancellation({
          req,
          signal: abortController.signal,
          endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
          fetchImpl,
          onDeliveryError: jest.fn(),
        });
        expect(fetchImpl).not.toHaveBeenCalled();

        const delivery = req._viventiumHarnessReleaseAttempt();
        await jest.runAllTimersAsync();
        const outcome = await delivery;

        expect(abortController.signal.aborted).toBe(false);
        expect(fetchImpl).toHaveBeenCalledWith(
          'http://glasshive.local/v1/requests/by-idempotency/cortex%3Aended-run%3Acortex-agent/cancel',
          expect.objectContaining({ method: 'POST' }),
        );
        expect(outcome).toMatchObject({
          acknowledged,
          outcomes: [expect.objectContaining({ acknowledged })],
        });
        expect(outcome.outcomes[0].capacityReleased === true).toBe(capacityReleased);
        expect(req._viventiumHarnessCancellationDeliveryPromise).toBe(delivery);
      } finally {
        jest.useRealTimers();
      }
    },
  );

  test('does not acknowledge maintenance yield without explicit capacity release', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onDeliveryError = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ capacityReleased: false }),
      });
      const req = {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'cortex:unconfirmed:compactor-agent',
        body: {},
        user: { id: 'user-synthetic' },
      };

      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      });
      abortController.abort('maintenance_yield');
      await jest.runAllTimersAsync();

      await expect(req._viventiumHarnessCancellationDeliveryPromise).resolves.toMatchObject({
        acknowledged: false,
        outcomes: [expect.objectContaining({ acknowledged: false, status: 425 })],
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retries an unacknowledged Stop delivery and stops after the first acknowledgement', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const fetchImpl = jest
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
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
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');

      // Stop remains synchronous/nonblocking even while its delivery is awaiting acknowledgement.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[1]).toEqual(fetchImpl.mock.calls[0]);
      expect(onDeliveryError).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('deduplicates participant keys and endpoint bindings before delivering Stop', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKeys: ['main:response-1', 'main:response-1'],
      body: {},
      user: { id: 'user-synthetic' },
    };
    const binding = {
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    };

    expect(bindHarnessCancellation(binding)).toBe(true);
    expect(bindHarnessCancellation(binding)).toBe(true);
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('targets the fallback attempt when Stop arrives before the fallback stream opens', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main-fallback%3Aresponse-1/cancel',
      expect.any(Object),
    );
  });

  test('an intentional Stop cancels every workspace-bound graph attempt', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      _viventiumHarnessIdempotencyKeys: new Set([
        'main:response-1',
        'main:reality-agent:response-1',
      ]),
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-1/cancel',
      'http://glasshive.local/v1/requests/by-idempotency/main%3Areality-agent%3Aresponse-1/cancel',
    ]);
  });

  test('workspace handoff keys can bind cancellation without a workspace primary', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: false,
      _viventiumHarnessIdempotencyKeys: new Set(['main:reality-agent:response-1']),
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);
    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Areality-agent%3Aresponse-1/cancel',
      expect.any(Object),
    );
  });

  test('only the active harness endpoint receives fallback cancellation', async () => {
    const abortController = new AbortController();
    const primaryFetch = jest.fn().mockResolvedValue({ ok: true });
    const fallbackFetch = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      _viventiumHarnessIdempotencyKey: 'main-fallback:response-1',
      body: { responseMessageId: 'response-1' },
      user: { id: 'user-synthetic' },
    };
    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://primary.local/v1', apiKey: 'primary-key' },
      fetchImpl: primaryFetch,
    });
    bindHarnessCancellation({
      req,
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://fallback.local/v1', apiKey: 'fallback-key' },
      fetchImpl: fallbackFetch,
    });

    abortController.abort('user_cancelled');
    await Promise.resolve();

    expect(primaryFetch).not.toHaveBeenCalled();
    expect(fallbackFetch).toHaveBeenCalledTimes(1);
  });

  test.each(['transport_disconnected', 'provider_response_deadline_exceeded', undefined])(
    'does not cancel the native run for a non-user abort reason: %s',
    async (abortReason) => {
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

      abortController.abort(abortReason);
      await Promise.resolve();

      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  test('reports one bounded terminal error when Stop delivery is never acknowledged', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onDeliveryError = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 503 });
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-1',
          body: {},
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HARNESS_CANCELLATION_DELIVERY_FAILED',
          attempts: 3,
          status: 503,
          message:
            'GlassHive cancellation was not acknowledged after 3 attempts (last outcome: HTTP 503)',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not retry a permanent Stop delivery rejection', async () => {
    jest.useFakeTimers();
    try {
      const abortController = new AbortController();
      const onDeliveryError = jest.fn();
      const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-1',
          body: {},
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      });

      abortController.abort('user_cancelled');
      await jest.runAllTimersAsync();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledTimes(1);
      expect(onDeliveryError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'HARNESS_CANCELLATION_DELIVERY_FAILED',
          attempts: 1,
          status: 401,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
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

  test('projects a resolved host tool even when the Agent declares no external MCP server', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['file_search'] },
      conversation_provider_instructions:
        'Host-tool resources are service-backed. Call the authorized host tool first.',
    });
    const recallFile = {
      file_id: 'conversation_recall:all:user-synthetic',
      filename: 'conversation-recall-all.txt',
      context: 'conversation_recall',
      viventiumConversationRecallMode: 'source_only',
      viventiumConversationRecallAttachmentReason: 'stale_corpus',
    };
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { files: [recallFile] } },
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
      allowedServerNames: [],
      allowedHostTools: ['file_search'],
      hostToolResources: {
        file_search: {
          entity_id: 'agent-synthetic',
          files: [recallFile],
        },
      },
    });
    expect(targetAgent.instructions).toBe(
      'Existing authority.\n\nHost-tool resources are service-backed. Call the authorized host tool first.',
    );
  });

  test.each([false, true])(
    'keeps native host evidence through initialization and fallback (fallback=%s)',
    async (fallback) => {
      buildConversationProviderBootstrapBundle.mockResolvedValue({
        glasshive_capability_broker: {},
      });
      const files = [
        { file_id: 'conversation_recall:all:user-synthetic', context: 'conversation_recall' },
      ];
      const initialized = {
        id: 'agent-synthetic',
        tools: [],
        toolDefinitions: [],
        toolRegistry: new Map(),
        declaredToolNames: [
          'file_search',
          'web_search',
          `read_mail${Constants.mcp_delimiter}mail-service`,
        ],
        tool_resources: { file_search: { files } },
        model_parameters: { configuration: { defaultHeaders: {} } },
      };
      const target = fallback
        ? { ...initialized, declaredToolNames: [], tool_resources: {} }
        : initialized;
      await attachConversationProviderCapabilityBundle({
        targetAgent: target,
        declaredAgent: {
          id: 'agent-synthetic',
          tools: fallback ? [] : initialized.declaredToolNames,
        },
        capabilitySourceAgent: initialized,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: {
          workspace_binding: true,
          worker_native_tools: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search', 'web_search'],
        },
      });
      expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedHostTools: ['file_search', 'web_search'],
          hostToolResources: { file_search: { entity_id: 'agent-synthetic', files } },
          allowedServerNames: ['mail-service'],
        }),
      );
      expect(target.tools).toEqual([]);
    },
  );

  test('does not restore disabled native host capabilities from declarations', async () => {
    getEndpointsConfig.mockResolvedValueOnce({ agents: { capabilities: ['web_search'] } });
    buildConversationProviderBootstrapBundle.mockResolvedValue({ glasshive_capability_broker: {} });
    await attachConversationProviderCapabilityBundle({
      targetAgent: {
        id: 'agent-synthetic',
        tools: [],
        tool_resources: { file_search: { files: [{ file_id: 'file-a' }] } },
        model_parameters: { configuration: { defaultHeaders: {} } },
      },
      declaredAgent: { tools: ['file_search', 'web_search'] },
      req: { user: { id: 'user-synthetic' }, body: {} },
      capability: {
        workspace_binding: true,
        worker_native_tools: true,
        host_tools_transport: 'broker_mcp',
        host_tools: ['file_search', 'web_search'],
      },
    });
    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({ allowedHostTools: ['web_search'], hostToolResources: {} }),
    );
  });

  test('publishes the filesystem-substitution policy when a configured host tool has no authorized resources', async () => {
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { files: [] } },
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(targetAgent.instructions).toContain(
      'These configured host capabilities have no authorized resources for this turn: file_search.',
    );
    expect(targetAgent.instructions).toContain(
      'Do not emulate or replace an unavailable host capability by searching application state',
    );
    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('replaces a stale host-evidence policy block when runtime resource state changes', () => {
    const targetAgent = { instructions: 'Existing authority.' };

    applyHostEvidenceBoundaryInstructions(targetAgent, ['file_search']);
    expect(targetAgent.instructions).toContain('<viventium_host_evidence_boundary>');
    expect(targetAgent.instructions).toContain('file_search');

    applyHostEvidenceBoundaryInstructions(targetAgent, []);
    expect(targetAgent.instructions).toBe('Existing authority.');
  });

  test('keeps resource-less host tools authorized instead of classifying them as unavailable', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['workspace_action'] },
    });
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['workspace_action', { name: 'workspace_action' }]]),
      instructions: 'Existing authority.',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['workspace_action'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['workspace_action'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedHostTools: ['workspace_action'],
        hostToolResources: {},
      }),
    );
    expect(targetAgent.instructions).not.toContain('no authorized resources');
  });

  test('projects ACL-primed agent knowledge-base file_ids instead of silently dropping them', async () => {
    const primedFile = { file_id: 'kb-file-1', filename: 'knowledge-base.txt' };
    primeFiles.mockResolvedValueOnce({ files: [primedFile], toolContext: '' });
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_host_tools: ['file_search'] },
    });
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { file_ids: ['kb-file-1'], files: [] } },
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
    const req = {
      user: { id: 'user-synthetic', role: 'USER' },
      body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req,
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(true);

    expect(primeFiles).toHaveBeenCalledWith({
      tool_resources: targetAgent.tool_resources,
      req,
      agentId: 'agent-synthetic',
    });
    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({
        hostToolResources: {
          file_search: { entity_id: 'agent-synthetic', files: [primedFile] },
        },
      }),
    );
  });

  test('degrades a failed host-resource prime to an explicit unavailable capability', async () => {
    primeFiles.mockRejectedValueOnce(new Error('synthetic resource failure'));
    const targetAgent = {
      id: 'agent-synthetic',
      toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
      tool_resources: { file_search: { file_ids: ['kb-file-1'] } },
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      }),
    ).resolves.toBe(false);
    expect(targetAgent.instructions).toContain('no authorized resources');
    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
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

  test('binds the exact dynamic authority tail only to a GlassHive provider request', () => {
    const capsule = [
      '<viventium_feeling_state>',
      'Synthetic private causal state.',
      '</viventium_feeling_state>',
    ].join('\n');
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-Existing': 'kept',
            'X-GlassHive-Agent-Id': 'agent-synthetic',
          },
        },
      },
    };

    expect(bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: capsule })).toBe(
      true,
    );
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      Buffer.from(headers['X-GlassHive-Developer-Instruction-Tail-B64'], 'base64').toString('utf8'),
    ).toBe(capsule);

    expect(bindConversationProviderDeveloperInstructionTail({ targetAgent, tail: '' })).toBe(true);
    expect(
      targetAgent.model_parameters.configuration.defaultHeaders[
        'X-GlassHive-Developer-Instruction-Tail-B64'
      ],
    ).toBeUndefined();

    const ordinaryAgent = { model_parameters: { configuration: { defaultHeaders: {} } } };
    expect(
      bindConversationProviderDeveloperInstructionTail({
        targetAgent: ordinaryAgent,
        tail: capsule,
      }),
    ).toBe(false);
    expect(ordinaryAgent.model_parameters.configuration.defaultHeaders).toEqual({});
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
      allowedHostTools: [],
      hostToolResources: {},
    });
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toEqual({ codex_config_append: '[mcp_servers.synthetic]' });
    const expected = crypto
      .createHmac('sha256', 'synthetic-bundle-secret')
      .update(
        `v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${headers['X-GlassHive-Bootstrap-Bundle-B64']}`,
      )
      .digest('hex');
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expected}`);
  });

  test('regenerates the complete signed bundle and broker grant after 301 and 601 seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:52:15.000Z'));
    try {
      buildConversationProviderBootstrapBundle.mockImplementation(async () => {
        const issuedAt = Math.floor(Date.now() / 1000);
        return {
          glasshive_capability_broker: {
            grant_token: `synthetic-grant-${issuedAt}`,
            grant: { iat: issuedAt, exp: issuedAt + 600 },
          },
          conversation_provider_instructions: 'Use the freshly authorized host capability.',
        };
      });
      const targetAgent = {
        id: 'agent-synthetic',
        toolRegistry: new Map([['file_search', { name: 'file_search' }]]),
        tool_resources: { file_search: { files: [{ file_id: 'synthetic-file' }] } },
        model_parameters: { configuration: { defaultHeaders: { 'X-Existing': 'kept' } } },
      };
      const args = {
        targetAgent,
        declaredAgent: { id: 'agent-synthetic', tools: ['file_search'] },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: {
          workspace_binding: true,
          host_tools_transport: 'broker_mcp',
          host_tools: ['file_search'],
        },
      };

      await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
      const descriptor = Object.getOwnPropertyDescriptor(
        targetAgent,
        'viventiumConversationProviderCapabilityRefresh',
      );
      expect(descriptor).toMatchObject({ enumerable: false, writable: false });
      const initialHeaders = { ...targetAgent.model_parameters.configuration.defaultHeaders };

      jest.setSystemTime(new Date('2026-08-10T18:57:16.000Z'));
      const after301 = await descriptor.value();
      jest.setSystemTime(new Date('2026-08-10T19:02:16.000Z'));
      const after601 = await descriptor.value();

      const decode = (headers) =>
        JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString());
      const refreshedHeaders = [initialHeaders, after301.defaultHeaders, after601.defaultHeaders];
      for (const headers of refreshedHeaders) {
        const expectedSignature = crypto
          .createHmac('sha256', 'synthetic-bundle-secret')
          .update(
            `v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${headers['X-GlassHive-Bootstrap-Bundle-B64']}`,
          )
          .digest('hex');
        expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expectedSignature}`);
      }
      expect([
        initialHeaders['X-GlassHive-Bootstrap-Timestamp'],
        after301.defaultHeaders['X-GlassHive-Bootstrap-Timestamp'],
        after601.defaultHeaders['X-GlassHive-Bootstrap-Timestamp'],
      ]).toEqual(['1786387935', '1786388236', '1786388536']);
      expect([
        decode(initialHeaders).glasshive_capability_broker.grant_token,
        decode(after301.defaultHeaders).glasshive_capability_broker.grant_token,
        decode(after601.defaultHeaders).glasshive_capability_broker.grant_token,
      ]).toEqual([
        'synthetic-grant-1786387935',
        'synthetic-grant-1786388236',
        'synthetic-grant-1786388536',
      ]);
      expect(decode(after601.defaultHeaders).glasshive_capability_broker.grant.exp).toBe(
        1786389136,
      );
      expect(
        new Set(refreshedHeaders.map((headers) => headers['X-GlassHive-Bootstrap-Signature'])).size,
      ).toBe(3);
      expect(after601.defaultHeaders['X-Existing']).toBe('kept');
      expect(primeFiles).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('refreshes a gateway first turn from the finalized run scope instead of the pre-persistence body', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { grant_token: 'synthetic-scoped-grant' },
      conversation_provider_instructions: 'Use the authorized host capability.',
    });
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
    const prePersistenceBody = {
      conversationId: 'new',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
    };
    const finalizedRunBody = {
      conversationId: 'conversation-telegram-synthetic',
      messageId: 'assistant-message-telegram-synthetic',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      viventiumSurface: 'telegram',
    };
    const args = {
      targetAgent,
      declaredAgent: {
        tools: [`health_read${Constants.mcp_delimiter}synthetic-private-health`],
      },
      req: { user: { id: 'user-synthetic', role: 'ADMIN' }, body: prePersistenceBody },
      capability: { workspace_binding: true },
    };

    expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
    await targetAgent.viventiumConversationProviderCapabilityRefresh(finalizedRunBody);

    expect(buildConversationProviderBootstrapBundle.mock.calls[0][0].requestBody).toEqual(
      finalizedRunBody,
    );
  });

  test('projects fallback MCP authority from the owning participant instead of the tool-less route', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { grant_token: 'synthetic-fallback-grant' },
      conversation_provider_instructions: 'Use the authorized participant capability.',
    });
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: {} } },
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: { id: 'synthetic-fallback-route', tools: [] },
        capabilitySourceAgent: {
          id: 'synthetic-owning-participant',
          tools: [`health_read${Constants.mcp_delimiter}viventium-health`],
        },
        req: {
          user: { id: 'user-synthetic' },
          body: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
        },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
      expect.objectContaining({ allowedServerNames: ['viventium-health'] }),
    );
  });

  test('keeps call task controls on the owner provider without granting them to delegated workers', async () => {
    const originalEnabled = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'true';
    try {
      const actualBootstrap = jest.requireActual('../GlassHiveCapabilityBootstrapService');
      const { verifyBrokerGrant, hydrateBrokerGrantResources } = jest.requireActual(
        '../GlassHiveCapabilityBrokerAuth',
      );
      const { DELEGATION_TOOL_NAME } = jest.requireActual('../GlassHiveConversationOrchestration');
      const authority = { userId: 'owner-synthetic', callSessionId: 'call-synthetic' };
      const bundle = await actualBootstrap.buildConversationProviderBootstrapBundle({
        user: { id: authority.userId },
        requestBody: { messageId: 'voice-turn-synthetic' },
        allowedHostTools: ['manage_active_tasks', 'web_search'],
        hostToolResources: {
          manage_active_tasks: { version: 1, authority },
          web_search: { version: 1 },
        },
        allowedConversationOrchestrationTools: [DELEGATION_TOOL_NAME],
      });
      const grant = await hydrateBrokerGrantResources(
        verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
          expectedUserId: authority.userId,
          requireTurnScope: true,
        }),
      );
      expect(grant.allowed_host_tools).toContain('manage_active_tasks');
      expect(grant.host_tool_resources.manage_active_tasks).toEqual({ version: 1, authority });
      const delegated = grant.host_tool_resources[DELEGATION_TOOL_NAME];
      expect(delegated.mission_host_tools).toEqual(['web_search']);
      expect(delegated.mission_host_tool_resources).toEqual({ web_search: { version: 1 } });
    } finally {
      if (originalEnabled === undefined)
        delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
      else process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = originalEnabled;
    }
  });

  test('keeps one exact first-message scope across primary, fallback, and delayed re-entry bundles', async () => {
    const originalEnabled = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
    const originalTtl = process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS;
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'true';
    process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS = '600';
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T18:52:15.000Z'));
    try {
      const actualBootstrap = jest.requireActual('../GlassHiveCapabilityBootstrapService');
      const { verifyBrokerGrant } = jest.requireActual('../GlassHiveCapabilityBrokerAuth');
      buildConversationProviderBootstrapBundle.mockImplementation((args) =>
        actualBootstrap.buildConversationProviderBootstrapBundle(args),
      );
      const requestBody = {
        messageId: 'user-msg-foreground-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      };
      const capability = {
        workspace_binding: true,
        host_tools_transport: 'broker_mcp',
        host_tools: ['synthetic_lookup'],
      };
      const buildArgs = (id) => {
        const targetAgent = {
          id,
          toolRegistry: new Map([['synthetic_lookup', { name: 'synthetic_lookup' }]]),
          model_parameters: { configuration: { defaultHeaders: {} } },
        };
        return {
          targetAgent,
          declaredAgent: { id, tools: ['synthetic_lookup'] },
          req: { user: { id: 'user-synthetic' }, body: requestBody },
          capability,
        };
      };
      const primaryArgs = buildArgs('agent-primary-synthetic');
      const fallbackArgs = buildArgs('agent-fallback-synthetic');

      await expect(attachConversationProviderCapabilityBundle(primaryArgs)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(primaryArgs)).toBe(true);
      await expect(attachConversationProviderCapabilityBundle(fallbackArgs)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(fallbackArgs)).toBe(true);

      const initialPrimary = {
        ...primaryArgs.targetAgent.model_parameters.configuration.defaultHeaders,
      };
      jest.setSystemTime(new Date('2026-08-10T18:57:16.000Z'));
      const fallbackAttempt =
        await fallbackArgs.targetAgent.viventiumConversationProviderCapabilityRefresh();
      jest.setSystemTime(new Date('2026-08-10T19:02:17.000Z'));
      const mainReentry =
        await primaryArgs.targetAgent.viventiumConversationProviderCapabilityRefresh();

      const refreshes = [
        { role: 'primary', headers: initialPrimary },
        { role: 'fallback', headers: fallbackAttempt.defaultHeaders },
        { role: 'reentry', headers: mainReentry.defaultHeaders },
      ];
      const grants = refreshes.map(({ role, headers }) => {
        const encodedBundle = headers['X-GlassHive-Bootstrap-Bundle-B64'];
        const issuedAt = Number(headers['X-GlassHive-Bootstrap-Timestamp']);
        const expectedSignature = crypto
          .createHmac('sha256', 'synthetic-bundle-secret')
          .update(`v1\n${issuedAt}\n${encodedBundle}`)
          .digest('hex');
        expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expectedSignature}`);
        const bundle = JSON.parse(Buffer.from(encodedBundle, 'base64').toString());
        const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
          nowMs: issuedAt * 1000,
          expectedUserId: 'user-synthetic',
          requireTurnScope: true,
        });
        expect(grant).toMatchObject({
          conversation_id: '',
          parent_message_id: '',
          message_id: 'user-msg-foreground-1',
          turn_id: 'user-msg-foreground-1',
        });
        expect(grant.exp - grant.iat).toBe(600);
        return { role, issuedAt, grantId: grant.grant_id };
      });

      expect(grants.map(({ issuedAt }) => issuedAt)).toEqual([1786387935, 1786388236, 1786388537]);
      expect(new Set(grants.map(({ grantId }) => grantId)).size).toBe(3);
      expect(primeFiles).not.toHaveBeenCalled();
      expect(JSON.stringify(primaryArgs.targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
      expect(JSON.stringify(fallbackArgs.targetAgent)).not.toContain(
        'viventiumConversationProviderCapabilityRefresh',
      );
    } finally {
      jest.useRealTimers();
      if (originalEnabled === undefined) {
        delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
      } else {
        process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = originalEnabled;
      }
      if (originalTtl === undefined) {
        delete process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS;
      } else {
        process.env.VIVENTIUM_GLASSHIVE_PROVIDER_BROKER_TTL_SECONDS = originalTtl;
      }
    }
  });

  test('removes stale signed headers and replaces capability authority when refresh becomes unavailable', async () => {
    buildConversationProviderBootstrapBundle
      .mockResolvedValueOnce({
        glasshive_capability_broker: { grant_token: 'synthetic-initial-grant' },
        conversation_provider_instructions: 'Old authorized capability claim.',
      })
      .mockResolvedValueOnce({});
    const targetAgent = {
      model_parameters: { configuration: { defaultHeaders: { 'X-Existing': 'kept' } } },
    };
    const args = {
      targetAgent,
      declaredAgent: {
        tools: [`search${Constants.mcp_delimiter}synthetic-server`],
      },
      req: { user: { id: 'user-synthetic' }, body: {} },
      capability: { workspace_binding: true },
    };

    await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
    expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
    const result = await targetAgent.viventiumConversationProviderCapabilityRefresh();

    expect(result).toMatchObject({
      attached: false,
      previousInstructionAppend: 'Old authorized capability claim.',
    });
    expect(result.instructionAppend).toContain('host capability broker is unavailable');
    expect(result.defaultHeaders).toEqual({ 'X-Existing': 'kept' });
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Bundle-B64');
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Timestamp');
    expect(result.defaultHeaders).not.toHaveProperty('X-GlassHive-Bootstrap-Signature');
  });

  test.each(['policy-null', 'declaration-empty'])(
    'clears prior capability authority when refresh has no projection: %s',
    async (mode) => {
      buildConversationProviderBootstrapBundle.mockResolvedValueOnce({
        glasshive_capability_broker: { grant_token: 'synthetic-initial-grant' },
        conversation_provider_instructions: 'Old authorized capability claim.',
      });
      if (mode === 'policy-null') {
        buildConversationProviderBootstrapBundle.mockResolvedValueOnce(null);
      }
      const declaredAgent = {
        tools: [`search${Constants.mcp_delimiter}synthetic-server`],
      };
      const targetAgent = {
        model_parameters: { configuration: { defaultHeaders: {} } },
      };
      const args = {
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      };

      await expect(attachConversationProviderCapabilityBundle(args)).resolves.toBe(true);
      expect(installConversationProviderCapabilityRefresher(args)).toBe(true);
      if (mode === 'declaration-empty') {
        declaredAgent.tools = [];
      }
      const result = await targetAgent.viventiumConversationProviderCapabilityRefresh();

      expect(result).toMatchObject({
        attached: false,
        previousInstructionAppend: 'Old authorized capability claim.',
        instructionAppend: '',
        defaultHeaders: {},
      });
    },
  );

  test('keeps one Feeling tail and a signed capability bundle on a declared GlassHive fallback', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      glasshive_capability_broker: { allowed_servers: ['google-workspace'] },
      glasshive_capability_intent: { instruction: 'Use available capabilities as needed.' },
      codex_md: 'Synthetic Codex worker guidance.',
      claude_md: 'Synthetic Claude worker guidance.',
      agents_md: 'Synthetic shared worker guidance.',
    });
    const capsule = [
      '<viventium_feeling_state>',
      'Synthetic private causal state.',
      '</viventium_feeling_state>',
    ].join('\n');
    const targetAgent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': 'agent-synthetic',
            'X-GlassHive-Developer-Instruction-Tail-B64': Buffer.from(capsule).toString('base64'),
          },
        },
      },
    };
    const declaredFallbackAgent = {
      endpoint: 'glasshive-harness',
      provider: 'openAI',
      tools: [`search${Constants.mcp_delimiter}google-workspace`],
    };
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumFallbackLlmAttempt: true,
      user: { id: 'user-synthetic' },
      body: { responseMessageId: 'response-1' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': { workspace_binding: true },
              openAI: { workspace_binding: false },
            },
          },
        },
      },
    };

    await expect(
      attachDeclaredConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: declaredFallbackAgent,
        req,
      }),
    ).resolves.toBe(true);

    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(buildHarnessAttemptIdempotencyKey(req, 'response-1')).toBe('main-fallback:response-1');
    expect(
      Buffer.from(headers['X-GlassHive-Developer-Instruction-Tail-B64'], 'base64')
        .toString('utf8')
        .match(/<viventium_feeling_state>/g),
    ).toHaveLength(1);
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toMatchObject({
      glasshive_capability_broker: { allowed_servers: ['google-workspace'] },
      glasshive_capability_intent: { instruction: 'Use available capabilities as needed.' },
      codex_md: 'Synthetic Codex worker guidance.',
      claude_md: 'Synthetic Claude worker guidance.',
      agents_md: 'Synthetic shared worker guidance.',
    });
    expect(headers['X-GlassHive-Bootstrap-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-GlassHive-Bootstrap-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  test('continues honestly instead of sending an unsigned capability bundle', async () => {
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    buildConversationProviderBootstrapBundle.mockResolvedValue({ env: { SYNTHETIC: 'value' } });
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when declared capabilities cannot produce a broker bundle', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({});
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when capability bundle construction throws', async () => {
    buildConversationProviderBootstrapBundle.mockRejectedValueOnce(
      new Error('synthetic broker cache outage'),
    );
    const targetAgent = { instructions: 'Base instructions.', model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}synthetic-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.instructions).toContain('host capability broker is unavailable');
    expect(targetAgent.instructions).not.toContain('synthetic broker cache outage');
    expect(targetAgent.model_parameters).toEqual({});
  });

  test('continues honestly when policy authorizes no capability projection', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue(null);
    const targetAgent = { model_parameters: { configuration: { defaultHeaders: {} } } };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent: {
          tools: [`search${Constants.mcp_delimiter}non-projectable-server`],
        },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).resolves.toBe(false);

    expect(targetAgent.model_parameters.configuration.defaultHeaders).toEqual({});
  });
});

describe('superseded Main family release probe', () => {
  const released = (capacityReleased) =>
    jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ state: 'cancelled', capacityReleased, responseTimeoutS: 660 }),
    }));

  test('stops each exact owner-scoped family and requires every release acknowledgement', async () => {
    const fetchImpl = released(true);

    await expect(
      probeHarnessFamilyRelease({
        baseURL: 'http://glasshive.test/v1/',
        apiKey: 'provider-key',
        ownerId: 'owner-1',
        messageId: 'response-a',
        fetchImpl,
      }),
    ).resolves.toEqual({ released: true, reachable: true, responseTimeoutS: 660 });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://glasshive.test/v1/requests/by-idempotency/main%3Aresponse-a/cancel',
      'http://glasshive.test/v1/requests/by-idempotency/main-fallback%3Aresponse-a/cancel',
      'http://glasshive.test/v1/requests/by-idempotency/response-a/cancel',
    ]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer provider-key', 'X-Viventium-User-Id': 'owner-1' },
    });
  });

  test.each([false, true])(
    'checks a tool-less response-id family before reporting release (released=%s)',
    async (capacityReleased) => {
      const fetchImpl = jest.fn(async (url, request) => {
        expect(request.headers['X-Viventium-User-Id']).toBe('owner-1');
        const bareResponse = url.endsWith('/response-a/cancel');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            state: 'cancelled',
            capacityReleased: bareResponse ? capacityReleased : true,
            responseTimeoutS: 660,
          }),
        };
      });
      await expect(
        probeHarnessFamilyRelease({
          baseURL: 'http://glasshive.test/v1',
          apiKey: 'provider-key',
          ownerId: 'owner-1',
          messageId: 'response-a',
          fetchImpl,
        }),
      ).resolves.toEqual({ released: capacityReleased, reachable: true, responseTimeoutS: 660 });
      expect(fetchImpl.mock.calls.map(([url]) => url)).toContain(
        'http://glasshive.test/v1/requests/by-idempotency/response-a/cancel',
      );
    },
  );

  test('never reports release while execution is retained, unreachable or unscoped', async () => {
    const pending = released(false);
    const probe = (overrides) =>
      probeHarnessFamilyRelease({
        baseURL: 'http://glasshive.test/v1',
        apiKey: 'provider-key',
        ownerId: 'owner-1',
        messageId: 'response-a',
        fetchImpl: pending,
        ...overrides,
      });

    await expect(probe()).resolves.toEqual({
      released: false,
      reachable: true,
      responseTimeoutS: 660,
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await expect(
      probe({
        fetchImpl: jest.fn(async () => {
          throw new Error('offline');
        }),
      }),
    ).resolves.toEqual({ released: false, reachable: false, responseTimeoutS: null });
    await expect(
      probe({ fetchImpl: jest.fn(async () => ({ ok: false, status: 503 })) }),
    ).resolves.toEqual({ released: false, reachable: false, responseTimeoutS: null });
    await expect(probe({ ownerId: '' })).resolves.toMatchObject({ released: false });
    await expect(probe({ messageId: '' })).resolves.toMatchObject({ released: false });
  });
});

describe('native Voice input binding', () => {
  const tasks = require('../VoiceTaskService');
  const authorityService = require('../VoiceWorkAuthorityService');
  beforeEach(() => tasks.resetVoiceTasksForTests());

  function cancellationBinding() {
    const task = tasks.createVoiceTask({
      userId: 'owner-native',
      callSessionId: 'call-native',
      streamId: 'stream-native',
      owner: { kind: 'remote_generation', id: 'stream-native' },
    });
    const controller = new AbortController();
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'voice:exact',
      _viventiumNativeVoiceInputPolling: Promise.resolve(),
      user: { id: 'owner-native' },
      body: {
        voiceMode: true,
        viventiumVoiceTaskId: task.taskId,
        viventiumActorTrust: 'owner_participant',
        viventiumCanAuthorizeSideEffects: true,
      },
      viventiumVoiceWorkAuthority: { callSessionId: 'call-native' },
    };
    const bind = (fetchImpl) =>
      bindHarnessCancellation({
        req,
        signal: controller.signal,
        endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      });
    return { task, controller, req, bind };
  }

  function stopObservations(logger) {
    return logger.debug.mock.calls
      .filter(([label]) => label === '[GlassHiveProvider] Voice Stop confirmation')
      .map(([, data]) => data);
  }

  test('foreground native question retains exact current request and owner acknowledgement', async () => {
    const api = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    req._viventiumNativeVoiceInputPolling = null;
    const key = 'Which colour?\nKeep exact spacing ';
    const request = {
      kind: 'question',
      requestId: 'question-native',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-native',
      attemptId: 'attempt-native',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      prompt: 'Which colour?',
      requestedSchema: {
        type: 'object',
        required: ['answers'],
        additionalProperties: false,
        properties: {
          answers: {
            type: 'object',
            additionalProperties: false,
            minProperties: 1,
            maxProperties: 16,
            properties: {
              [key]: {
                type: 'array',
                uniqueItems: true,
                minItems: 1,
                maxItems: 1,
                items: { type: 'string', enum: ['Blue', 'Other'] },
              },
            },
          },
          annotations: {
            type: 'object',
            additionalProperties: false,
            properties: {
              [key]: {
                type: 'object',
                additionalProperties: false,
                required: ['notes'],
                properties: { notes: { type: 'string', minLength: 1, maxLength: 8000 } },
              },
            },
          },
        },
      },
    };
    const submit = jest.fn(async () => ({ accepted: true, phase: 'running' }));
    const poll = jest.fn(async ({ onInput }) => onInput(request, 'voice:exact'));
    const input = jest
      .spyOn(api, 'createNativeVoiceInputClient')
      .mockReturnValue({ poll, submit, isCurrent: jest.fn(async () => true) });
    const check = jest.spyOn(authorityService, 'assertVoiceWorkAuthority').mockResolvedValue({});
    try {
      bind(jest.fn());
      await req._viventiumNativeVoiceInputPolling;
      expect(tasks.snapshotEvent(task.taskId).needsInput).toMatchObject({
        inputType: 'native_question',
        prompt: request.prompt,
        nativeInputRequest: {
          version: 1,
          kind: 'question',
          requestId: request.requestId,
          requestFingerprint: request.requestFingerprint,
          runId: request.runId,
          attemptId: request.attemptId,
          expiresAt: request.expiresAt,
        },
        questionForm: { questions: [{ key, multiSelect: false }] },
      });
      const answer = JSON.stringify({ answers: { [key]: ['Blue'] } });
      await tasks.submitVoiceTaskInput(task.taskId, answer, { userId: 'owner-native' });
      expect(submit).toHaveBeenCalledWith('voice:exact', request, answer);
      expect(check).toHaveBeenCalled();
      controller.abort('test_complete');
    } finally {
      input.mockRestore();
      check.mockRestore();
    }
  });

  function stopDecisions(logger) {
    const prefix = '[GlassHiveProvider] Voice Stop decision ';
    return logger.info.mock.calls
      .filter(([message]) => typeof message === 'string' && message.startsWith(prefix))
      .map(([message]) => JSON.parse(message.slice(prefix.length)));
  }

  function stopScopeSha256(task) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify([task.taskId, task.streamId, task.callSessionId]))
      .digest('hex');
  }

  test.each([
    ['local_stop', false, true, { acknowledged: true, outcomes: [{ capacityReleased: true }] }],
    ['fresh_delivery', true, false, { acknowledged: true, outcomes: [{ capacityReleased: true }] }],
    [
      'delivery_acknowledged',
      true,
      true,
      { acknowledged: false, outcomes: [{ capacityReleased: false }] },
    ],
    ['outcomes_present', true, true, { acknowledged: true, outcomes: null }],
    ['family_nonempty', true, true, { acknowledged: true, outcomes: [] }],
    [
      'families_released',
      true,
      true,
      { acknowledged: true, outcomes: [{ capacityReleased: true }, { capacityReleased: false }] },
    ],
  ])(
    'Voice Stop diagnostics identify %s without confirming an unreleased owner',
    async (failedCheck, success, freshDelivery, delivery) => {
      const { logger } = require('@librechat/data-schemas');
      const { GenerationJobManager } = require('@librechat/api');
      const { task, req, bind } = cancellationBinding();
      logger.debug.mockClear();
      logger.info.mockClear();
      req._viventiumHarnessCancellationDeliveryPromise = Promise.resolve(delivery);
      const fetchImpl = jest.fn();
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        if (freshDelivery)
          req._viventiumHarnessCancellationDeliveryPromise = Promise.resolve(delivery);
        return { success };
      });
      try {
        bind(fetchImpl);
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
        expect(tasks.isVoiceTaskSuppressed(task.taskId)).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(stopObservations(logger)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              stage: 'confirmation_checks',
              failedCheck,
              confirmed: false,
            }),
          ]),
        );
        expect(stopDecisions(logger)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scopeSha256: stopScopeSha256(task),
              stage: 'confirmation_checks',
              failedCheck,
              confirmed: false,
            }),
          ]),
        );
      } finally {
        abort.mockRestore();
      }
    },
  );

  test.each([
    [1, 'owner_before_abort'],
    [2, 'owner_after_abort'],
    [3, 'confirmation_checks'],
  ])(
    'Voice Stop diagnostics retain an exact owner guard at read %s',
    async (invalidRead, stage) => {
      const { logger } = require('@librechat/data-schemas');
      const { GenerationJobManager } = require('@librechat/api');
      const { task, req, bind } = cancellationBinding();
      logger.debug.mockClear();
      logger.info.mockClear();
      const get = tasks.getVoiceTask;
      let reads = 0;
      const owner = jest.spyOn(tasks, 'getVoiceTask').mockImplementation((id) => {
        const current = get(id);
        reads += 1;
        return reads === invalidRead
          ? { ...current, owner: { ...current.owner, id: 'foreign-stream' } }
          : current;
      });
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        req._viventiumHarnessCancellationDeliveryPromise = Promise.resolve({
          acknowledged: true,
          outcomes: [{ capacityReleased: true }],
        });
        return { success: true };
      });
      try {
        bind(jest.fn());
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(get(task.taskId).state).toBe('cancelled_unenforceable');
        expect(stopObservations(logger)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage, failedCheck: 'owner_current' }),
          ]),
        );
        expect(stopDecisions(logger)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scopeSha256: stopScopeSha256(task),
              stage: 'owner_guard',
              ownerIdMatches: false,
              failedCheck: 'owner_current',
            }),
          ]),
        );
        expect(abort).toHaveBeenCalledTimes(invalidRead === 1 ? 0 : 1);
      } finally {
        owner.mockRestore();
        abort.mockRestore();
      }
    },
  );

  test.each(['abort_job', 'delivery'])(
    'Voice Stop diagnostics identify an exception at %s without copying its content',
    async (stage) => {
      const { logger } = require('@librechat/data-schemas');
      const { GenerationJobManager } = require('@librechat/api');
      const { task, req, bind } = cancellationBinding();
      logger.debug.mockClear();
      logger.info.mockClear();
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        if (stage === 'abort_job') throw new Error('synthetic-private-error-argument');
        req._viventiumHarnessCancellationDeliveryPromise = Promise.reject(
          new Error('synthetic-private-error-argument'),
        );
        return { success: true };
      });
      try {
        bind(jest.fn());
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
        const entries = stopObservations(logger);
        expect(entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ stage, failedCheck: 'exception' })]),
        );
        expect(JSON.stringify(entries)).not.toContain('synthetic-private-error-argument');
        expect(stopDecisions(logger)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scopeSha256: stopScopeSha256(task),
              stage,
              failedCheck: 'exception',
            }),
          ]),
        );
        expect(JSON.stringify(stopDecisions(logger))).not.toContain(
          'synthetic-private-error-argument',
        );
      } finally {
        abort.mockRestore();
      }
    },
  );

  test('normal-console Stop decisions exclude transport credentials, keys, prompt and opaque abort reason', async () => {
    const { logger } = require('@librechat/data-schemas');
    const { GenerationJobManager } = require('@librechat/api');
    const { task, req, controller, bind } = cancellationBinding();
    logger.info.mockClear();
    req.body.text = 'PRIVATE-PROMPT-SENTINEL';
    req._viventiumHarnessIdempotencyKey = 'PRIVATE-REQUEST-KEY-SENTINEL';
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort(new Error('PRIVATE-ABORT-SENTINEL'));
      return { success: true };
    });
    try {
      bind(jest.fn());
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      const decisions = stopDecisions(logger);
      expect(decisions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scopeSha256: stopScopeSha256(task),
            signalAborted: true,
            signalAbortReason: 'other',
            stage: 'confirmation_checks',
            failedCheck: 'fresh_delivery',
          }),
        ]),
      );
      const encoded = JSON.stringify(decisions);
      for (const privateValue of [
        'PRIVATE-PROMPT-SENTINEL',
        'PRIVATE-REQUEST-KEY-SENTINEL',
        'PRIVATE-ABORT-SENTINEL',
        'synthetic-key',
        'native.local',
        task.taskId,
        task.streamId,
        task.callSessionId,
        'owner-native',
      ])
        expect(encoded).not.toContain(privateValue);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
    } finally {
      abort.mockRestore();
    }
  });

  test('Voice Stop diagnostics preserve all graph families and wait for capacity release', async () => {
    const { logger } = require('@librechat/data-schemas');
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    logger.debug.mockClear();
    req._viventiumHarnessIdempotencyKeys = new Set(['voice:main', 'voice:peer']);
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => {
        await released;
        return { capacityReleased: true };
      },
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(fetchImpl);
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await new Promise(setImmediate);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelling');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      release();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
      const entries = stopObservations(logger);
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'delivery_started',
            familyCount: 2,
            capacityRequired: true,
          }),
          expect.objectContaining({
            stage: 'confirmation_checks',
            familyCount: 2,
            releasedFamilyCount: 2,
            confirmed: true,
            failedCheck: null,
          }),
        ]),
      );
      expect(JSON.stringify(entries)).not.toMatch(
        /owner-native|call-native|stream-native|voice:main|voice:peer|synthetic-key|native\.local/,
      );
    } finally {
      release();
      abort.mockRestore();
    }
  });

  test('Voice Stop diagnostics cannot interrupt confirmation when the observer throws', async () => {
    const { logger } = require('@librechat/data-schemas');
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, bind } = cancellationBinding();
    const observe = jest.spyOn(logger, 'debug').mockImplementation(() => {
      throw new Error('observer failed');
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(jest.fn(async () => ({ ok: true, json: async () => ({ capacityReleased: true }) })));
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      observe.mockRestore();
      abort.mockRestore();
    }
  });

  function cortexCancellationRequest(req) {
    const child = Object.create(req);
    child.body = { ...req.body };
    child._viventiumCortexToolEvidence = require('@librechat/api').createCortexToolEvidence();
    child._viventiumHarnessIdempotencyKey = 'voice:child';
    child._viventiumHarnessIdempotencyKeys = new Set();
    child._viventiumHarnessCancellationBoundBaseURLs = new Set();
    child._viventiumHarnessCancellationActiveBaseURL = '';
    child._viventiumHarnessCancellationDeliveryPromise = null;
    return child;
  }

  test('foreground Voice Stop retains Main after a completed cortex binds last', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    req._viventiumHarnessIdempotencyKeys = new Set(['voice:main', 'voice:peer-a', 'voice:peer-b']);
    let release;
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const mainFetch = jest.fn(async () => ({
      ok: true,
      json: async () => {
        await released;
        return { capacityReleased: true };
      },
    }));
    const child = cortexCancellationRequest(req);
    const childController = new AbortController();
    const childFetch = jest.fn();
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(mainFetch);
      bindHarnessCancellation({
        req: child,
        signal: childController.signal,
        endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
        fetchImpl: childFetch,
      });
      // A completed cortex has removed its owner-abort listener; only Main remains active.
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await new Promise(setImmediate);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelling');
      expect(childController.signal.aborted).toBe(false);
      expect(childFetch).not.toHaveBeenCalled();
      expect(mainFetch).toHaveBeenCalledTimes(3);
      release();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
      expect(req._viventiumHarnessCancellationDeliveryPromise).not.toBe(
        child._viventiumHarnessCancellationDeliveryPromise,
      );
    } finally {
      release();
      abort.mockRestore();
    }
  });

  test('foreground Voice Stop retains active cortex cancellation and exact family release', async () => {
    const { logger } = require('@librechat/data-schemas');
    logger.debug.mockClear();
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    req._viventiumHarnessIdempotencyKeys = new Set(['voice:main', 'voice:peer']);
    let releaseMain;
    const mainReleased = new Promise((resolve) => {
      releaseMain = resolve;
    });
    const mainFetch = jest.fn(async () => ({
      ok: true,
      json: async () => {
        await mainReleased;
        return { capacityReleased: true };
      },
    }));
    const child = cortexCancellationRequest(req);
    const childController = new AbortController();
    const parentAbort = () => childController.abort(controller.signal.reason);
    controller.signal.addEventListener('abort', parentAbort, { once: true });
    const childFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(mainFetch);
      expect(
        bindHarnessCancellation({
          req: child,
          signal: childController.signal,
          endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
          fetchImpl: childFetch,
        }),
      ).toBe(true);
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await new Promise(setImmediate);
      expect(childController.signal.reason).toBe('user_cancelled');
      expect(childFetch).toHaveBeenCalledTimes(1);
      expect(childFetch.mock.calls[0][0]).toBe(
        'http://native.local/v1/requests/by-idempotency/voice%3Achild/cancel',
      );
      await expect(child._viventiumHarnessCancellationDeliveryPromise).resolves.toEqual({
        acknowledged: true,
        outcomes: [{ acknowledged: true, capacityReleased: true, responseTimeoutS: null }],
      });
      expect(stopObservations(logger)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: 'delivery_started',
            cortexAttempt: true,
            workAuthorityOwn: false,
            familyCount: 1,
            capacityRequired: true,
          }),
          expect.objectContaining({
            stage: 'abort_started',
            cortexAttempt: false,
            workAuthorityOwn: true,
          }),
        ]),
      );
      expect(mainFetch).toHaveBeenCalledTimes(2);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelling');
      releaseMain();
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      releaseMain();
      controller.signal.removeEventListener('abort', parentAbort);
      abort.mockRestore();
    }
  });

  test('foreground Voice Stop accepts Main when the cortex transport bound first', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    const child = cortexCancellationRequest(req);
    const childFetch = jest.fn();
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bindHarnessCancellation({
        req: child,
        signal: new AbortController().signal,
        endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
        fetchImpl: childFetch,
      });
      bind(jest.fn(async () => ({ ok: true, json: async () => ({ capacityReleased: true }) })));
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
      expect(childFetch).not.toHaveBeenCalled();
    } finally {
      abort.mockRestore();
    }
  });

  test('foreground Voice Stop never promotes a cortex into the Main task owner or input adapter', async () => {
    const api = require('@librechat/api');
    const { task, req } = cancellationBinding();
    const child = cortexCancellationRequest(req);
    child._viventiumNativeVoiceInputPolling = null;
    const childController = new AbortController();
    const childFetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const abort = jest.spyOn(api.GenerationJobManager, 'abortJob').mockImplementation(async () => {
      childController.abort('user_cancelled');
      return { success: true };
    });
    const poll = jest.fn(async () => undefined);
    const input = jest.spyOn(api, 'createNativeVoiceInputClient').mockReturnValue({ poll });
    try {
      expect(
        bindHarnessCancellation({
          req: child,
          signal: childController.signal,
          endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
          fetchImpl: childFetch,
        }),
      ).toBe(true);
      const cancellation = await tasks.requestVoiceTaskOwnerCancellation(task.taskId, {
        userId: 'owner-native',
      });
      await tasks.flushVoiceTaskOwnerOperations();
      await new Promise(setImmediate);
      expect(cancellation.ownerSupported).toBe(false);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
      expect(abort).not.toHaveBeenCalled();
      expect(childFetch).not.toHaveBeenCalled();
      expect(input).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
    } finally {
      input.mockRestore();
      abort.mockRestore();
    }
  });

  test('native Voice Stop confirms only the exact released native owner', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, bind } = cancellationBinding();
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(fetchImpl);
      const result = await tasks.requestVoiceTaskOwnerCancellation(task.taskId, {
        userId: 'owner-native',
      });
      expect(result.ownerSupported).toBe(true);
      await tasks.flushVoiceTaskOwnerOperations();
      expect(abort).toHaveBeenCalledWith('stream-native', 'user_cancelled', 'owner-native');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://native.local/v1/requests/by-idempotency/voice%3Aexact/cancel',
        expect.objectContaining({
          headers: {
            Authorization: 'Bearer synthetic-key',
            'X-Viventium-User-Id': 'owner-native',
          },
        }),
      );
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      abort.mockRestore();
    }
  });

  test.each(['no native delivery', 'native rejects Stop'])(
    'native Voice Stop remains unconfirmed after %s',
    async (failure) => {
      const { GenerationJobManager } = require('@librechat/api');
      const { task, controller, bind } = cancellationBinding();
      const fetchImpl = jest.fn(async () => ({ ok: false, status: 401 }));
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
        if (failure !== 'no native delivery') controller.abort('user_cancelled');
        return { success: true };
      });
      try {
        bind(fetchImpl);
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
        expect(tasks.isVoiceTaskSuppressed(task.taskId)).toBe(true);
      } finally {
        abort.mockRestore();
      }
    },
  );

  test.each(['committed', 'pending'])(
    'native Voice Stop preserves an already committed answer (%s)',
    async (nativeResponse) => {
      const { GenerationJobManager } = require('@librechat/api');
      const { task, bind } = cancellationBinding();
      const fetchImpl = jest.fn();
      const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockResolvedValue({
        success: false,
        nativeResponse,
      });
      try {
        bind(fetchImpl);
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        expect(tasks.getVoiceTask(task.taskId).state).toBe('completed');
        expect(tasks.isVoiceTaskSuppressed(task.taskId)).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        abort.mockRestore();
      }
    },
  );

  test('native Voice Stop cannot reuse a prior attempt acknowledgement', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, req, bind } = cancellationBinding();
    req._viventiumHarnessCancellationDeliveryPromise = Promise.resolve({
      acknowledged: true,
      outcomes: [{ capacityReleased: true }],
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockResolvedValue({ success: true });
    try {
      bind(jest.fn());
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
    } finally {
      abort.mockRestore();
    }
  });

  test.each(['call', 'owner id', 'owner kind'])(
    'native Voice Stop cannot gain a changed %s',
    async (changed) => {
      const { GenerationJobManager } = require('@librechat/api');
      const { task, req, bind } = cancellationBinding();
      if (changed === 'call') req.viventiumVoiceWorkAuthority.callSessionId = 'other-call';
      const fetchImpl = jest.fn();
      const abort = jest.spyOn(GenerationJobManager, 'abortJob');
      try {
        bind(fetchImpl);
        if (changed !== 'call')
          tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
            kind: changed === 'owner kind' ? 'other_owner' : 'remote_generation',
            ownerId: changed === 'owner id' ? 'other-stream' : 'stream-native',
          });
        await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
        await tasks.flushVoiceTaskOwnerOperations();
        await new Promise(setImmediate);
        expect(abort).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
      } finally {
        abort.mockRestore();
      }
    },
  );

  test('native Voice Stop retains the stopped owner while the native request returns', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, bind } = cancellationBinding();
    const fetchImpl = jest.fn(async () => {
      expect(
        tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
          kind: 'remote_generation',
          ownerId: 'replacement-stream',
        }),
      ).toBeNull();
      return { ok: true, json: async () => ({ capacityReleased: true }) };
    });
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(fetchImpl);
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(tasks.getVoiceTask(task.taskId)).toMatchObject({
        state: 'cancelled_confirmed',
        owner: { kind: 'remote_generation', id: 'stream-native' },
      });
    } finally {
      abort.mockRestore();
    }
  });

  test('native Voice Stop cannot use an empty acknowledgement as release proof', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, req, bind } = cancellationBinding();
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      req._viventiumHarnessCancellationDeliveryPromise = Promise.resolve({
        acknowledged: true,
        outcomes: [],
      });
      return { success: true };
    });
    try {
      bind(jest.fn());
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
    } finally {
      abort.mockRestore();
    }
  });

  test('native Voice initialization keeps Stop when the same job becomes remote', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, bind } = cancellationBinding();
    tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'generation_job',
      ownerId: 'stream-native',
    });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bind(fetchImpl);
      tasks.setVoiceTaskOwnerCapabilities(task.taskId, {
        kind: 'remote_generation',
        ownerId: 'stream-native',
      });
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      expect(abort).toHaveBeenCalledWith('stream-native', 'user_cancelled', 'owner-native');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      abort.mockRestore();
    }
  });

  test.each(['generation_job', 'remote_generation'])(
    'relays offered responses through %s to the exact owner request',
    async (ownerKind) => {
      const task = tasks.createVoiceTask({
        userId: 'owner-native',
        callSessionId: 'call-native',
        streamId: 'stream-native',
        owner: { kind: ownerKind, id: 'stream-native' },
      });
      const request = {
        requestId: 'request-native',
        requestFingerprint: 'a'.repeat(64),
        runId: 'run-native',
        attemptId: 'attempt-native',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        prompt: 'Write the requested scratch file',
        operationTitle: 'Create synthetic.txt in the working folder.',
        choices: [
          { value: 'allow-once', label: 'Allow once' },
          { value: 'deny', label: 'Deny' },
        ],
      };
      const authority = { callSessionId: 'call-native' };
      const check = jest.spyOn(authorityService, 'assertVoiceWorkAuthority').mockResolvedValue({});
      const fetchImpl = jest.fn(async (_url, options) => ({
        ok: true,
        json: async () =>
          options.method === 'POST'
            ? { version: 1, accepted: true, requestId: request.requestId }
            : { version: 1, state: 'running', pending: [request] },
      }));
      const controller = new AbortController();
      const req = {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'voice:exact',
        user: { id: 'owner-native' },
        body: {
          voiceMode: true,
          viventiumVoiceTaskId: task.taskId,
          viventiumActorTrust: 'owner_participant',
          viventiumCanAuthorizeSideEffects: true,
        },
        viventiumVoiceWorkAuthority: authority,
      };
      bindHarnessCancellation({
        req,
        signal: controller.signal,
        endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      });
      await new Promise(setImmediate);
      expect(tasks.snapshotEvent(task.taskId)).toMatchObject({
        state: 'needs_input',
        needsInput: {
          choices: request.choices,
          prompt: request.prompt,
          operationTitle: request.operationTitle,
        },
      });
      const result = await tasks.submitVoiceTaskInput(task.taskId, 'allow-once', {
        userId: 'owner-native',
      });
      expect(result).toMatchObject({ ok: true, task: { state: 'running' } });
      expect(check).toHaveBeenCalledWith(authority, 'owner-native');
      const posted = fetchImpl.mock.calls.find(([, options]) => options.method === 'POST');
      expect(posted[0]).toBe(
        'http://native.local/v1/requests/by-idempotency/voice%3Aexact/native-input',
      );
      expect(JSON.parse(posted[1].body)).toMatchObject({
        requestId: request.requestId,
        runId: request.runId,
        attemptId: request.attemptId,
        input: 'allow-once',
      });
      controller.abort('completed');
      await req._viventiumNativeVoiceInputPolling;
      check.mockRestore();
    },
  );

  test('an expired native input preserves Stop for its current owner', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { task, controller, req, bind } = cancellationBinding();
    delete req._viventiumNativeVoiceInputPolling;
    const now = Date.now();
    const request = {
      requestId: 'request-native',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-native',
      attemptId: 'attempt-native',
      expiresAt: new Date(now + 60000).toISOString(),
      prompt: 'Approve synthetic action.',
      choices: [
        { value: 'allow-once', label: 'Allow once' },
        { value: 'deny', label: 'Deny' },
      ],
    };
    const fetchImpl = jest.fn(async (_url, options) => ({
      ok: true,
      json: async () =>
        options.method === 'POST'
          ? { capacityReleased: true }
          : { version: 1, state: 'running', pending: [request] },
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    let clock;
    try {
      bind(fetchImpl);
      await new Promise(setImmediate);
      expect(tasks.snapshotEvent(task.taskId).needsInput).toBeTruthy();
      clock = jest.spyOn(Date, 'now').mockReturnValue(now + 61000);
      await tasks.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'owner-native' });
      await tasks.flushVoiceTaskOwnerOperations();
      await new Promise(setImmediate);
      expect(abort).toHaveBeenCalledWith('stream-native', 'user_cancelled', 'owner-native');
      expect(tasks.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      clock?.mockRestore();
      abort.mockRestore();
      controller.abort('completed');
      await req._viventiumNativeVoiceInputPolling;
    }
  });

  test('does not poll a task from another owner', () => {
    const task = tasks.createVoiceTask({
      userId: 'other-owner',
      callSessionId: 'call-native',
      streamId: 'stream-native',
      owner: { kind: 'generation_job', id: 'stream-native' },
    });
    const fetchImpl = jest.fn();
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      user: { id: 'owner-native' },
      body: {
        voiceMode: true,
        viventiumVoiceTaskId: task.taskId,
        viventiumActorTrust: 'owner_participant',
        viventiumCanAuthorizeSideEffects: true,
      },
      viventiumVoiceWorkAuthority: { callSessionId: 'call-native' },
    };
    bindHarnessCancellation({
      req,
      signal: new AbortController().signal,
      endpointConfig: { baseURL: 'http://native.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(req._viventiumNativeVoiceInputPolling).toBeUndefined();
  });
});

describe('signed text file body parity', () => {
  const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const earlier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const alpha = {
    file_id: '11111111-1111-4111-8111-111111111111',
    filename: '01-first.txt',
    type: 'text/plain',
    source: 'text',
    context: 'message_attachment',
    text: 'First synthetic note.\n',
    bytes: 22,
    media_group_index: 0,
  };
  const bravo = {
    file_id: '22222222-2222-4222-8222-222222222222',
    filename: '02-second.txt',
    type: 'text/plain',
    source: 'text',
    context: 'message_attachment',
    text: 'Second synthetic note.\n',
    bytes: 23,
    media_group_index: 1,
  };
  const sibling = {
    ...alpha,
    file_id: '33333333-3333-4333-8333-333333333333',
    text: 'Unselected sibling body.',
  };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
    buildConversationProviderBootstrapBundle.mockResolvedValue({});
    getMessages.mockResolvedValue([
      {
        messageId: parent,
        parentMessageId: earlier,
        files: [{ file_id: alpha.file_id }, { file_id: bravo.file_id }],
      },
      { messageId: earlier },
      { messageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', files: [{ file_id: sibling.file_id }] },
    ]);
    getFiles.mockImplementation(async (filter, sort, select) => {
      if (filter.user !== 'owner') return [];
      return [alpha, bravo, sibling]
        .filter((f) => filter.file_id.$in.includes(f.file_id))
        .map((f) =>
          Object.fromEntries(
            select
              .split(' ')
              .filter((k) => k in f)
              .map((k) => [k, f[k]]),
          ),
        );
    });
  });
  async function signed(files, surface = 'web', owner = 'owner', parentMessageId = parent) {
    const targetAgent = { model_parameters: {} };
    const req = {
      user: { id: owner },
      body: { conversationId, parentMessageId, files, viventiumSurface: surface },
    };
    const immutable = JSON.stringify(req.body);
    await attachConversationProviderCapabilityBundle({
      targetAgent,
      req,
      capability: { workspace_binding: true, worker_native_tools: true },
    });
    expect(JSON.stringify(req.body)).toBe(immutable);
    const headers = targetAgent.model_parameters.configuration?.defaultHeaders || {};
    if (!headers['X-GlassHive-Bootstrap-Bundle-B64']) return [];
    const bundle = JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64'));
    const expected =
      'sha256=' +
      crypto
        .createHmac('sha256', 'synthetic-bundle-secret')
        .update(
          'v1\n' +
            headers['X-GlassHive-Bootstrap-Timestamp'] +
            '\n' +
            headers['X-GlassHive-Bootstrap-Bundle-B64'],
        )
        .digest('hex');
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(expected);
    return bundle.viventium_upload_context?.selected_uploads || [];
  }
  test.each(['web', 'voice', 'telegram'])(
    'preserves current ordered text despite persisted current ancestry (%s)',
    async (surface) => {
      const out = await signed([alpha, bravo], surface);
      expect(out.map((f) => [f.file_id, f.text, f.media_group_index])).toEqual(
        [alpha, bravo].map((f) => [f.file_id, f.text, f.media_group_index]),
      );
    },
  );
  test('early sizing and signed invocation share current precedence and selected ancestry without mutation', async () => {
    const current = {
      ...alpha,
      filename: 'current.txt',
      text: 'Current exact words.\n',
      filepath: '/private/untrusted',
      source_path: '/private/untrusted',
      url: 'https://untrusted.invalid',
    };
    const req = {
      user: { id: 'owner' },
      body: { conversationId, parentMessageId: parent, files: [current] },
    };
    const before = JSON.stringify(req.body);
    const early = await resolveConversationProviderUploadedFiles(req);
    expect(early).toEqual(await signed([current]));
    expect(early.map((file) => [file.file_id, file.text])).toEqual([
      [alpha.file_id, current.text],
      [bravo.file_id, bravo.text],
    ]);
    expect(early.some((file) => file.file_id === sibling.file_id)).toBe(false);
    expect(JSON.stringify(early)).not.toContain('/private/');
    expect(JSON.stringify(early)).not.toContain('untrusted.invalid');
    expect(JSON.stringify(req.body)).toBe(before);
    getMessages.mockClear();
    expect(
      await resolveConversationProviderUploadedFiles(req, req.body, { includeHistory: false }),
    ).toEqual([early[0]]);
    expect(getMessages).not.toHaveBeenCalled();
  });

  test('failed selected history lookup cannot become a positive empty upload projection', async () => {
    getFiles.mockRejectedValue(new Error('Synthetic file owner unavailable'));
    await expect(
      resolveConversationProviderUploadedFiles({
        user: { id: 'owner' },
        body: { conversationId, parentMessageId: parent, files: [] },
      }),
    ).rejects.toThrow('Synthetic file owner unavailable');
  });

  test('keeps owner-selected text available on a later no-reupload turn', async () => {
    const out = await signed([]);
    expect(out.map((f) => f.text)).toEqual([alpha.text, bravo.text]);
    expect(getFiles.mock.calls[0][0]).toEqual({
      user: 'owner',
      file_id: { $in: [alpha.file_id, bravo.file_id] },
    });
    expect(out.some((f) => f.file_id === sibling.file_id)).toBe(false);
  });
  test('denies wrong owner history without requesting unselected bodies', async () => {
    expect(await signed([], 'web', 'different-owner')).toEqual([]);
    expect(getFiles.mock.calls[0][0].user).toBe('different-owner');
  });
  test('missing selected parent grants no historical body', async () => {
    expect(await signed([], 'web', 'owner', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toEqual([]);
    expect(getFiles).not.toHaveBeenCalled();
  });
  test('deleted owner files stay unavailable', async () => {
    getFiles.mockResolvedValue([]);
    expect(await signed([])).toEqual([]);
  });
});
