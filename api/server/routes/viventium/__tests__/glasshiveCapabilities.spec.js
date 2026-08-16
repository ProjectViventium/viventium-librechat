const express = require('express');
const { EventEmitter } = require('events');
const http = require('http');
const request = require('supertest');
const { requestLifetimeSignal } = require('../GlassHiveRequestLifetimeSignal');

const mockBuildCapabilityCatalog = jest.fn();
const mockHandleToolCall = jest.fn();
const mockToolDefinitionsForMcp = jest.fn();
const mockGetAppConfig = jest.fn();
const mockSharedCache = new Map();
const mockVerifyAndConsumeAdmission = jest.fn();
const mockAdmitCapabilityAuthorization = jest.fn();
const mockAssertActiveCapabilityAuthorizationGrant = jest.fn();
const mockRevokeCapabilityAuthorizationGrant = jest.fn();

class MockCapabilityAuthorizationError extends Error {
  constructor(code, message, { status = 409, needsInput = true } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.needsInput = needsInput;
  }
}

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  CacheKeys: { FLOWS: 'flows' },
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: jest.fn(async (key) => mockSharedCache.get(key)),
    set: jest.fn(async (key, value) => {
      mockSharedCache.set(key, value);
      return true;
    }),
  })),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerService', () => ({
  buildCapabilityCatalog: (...args) => mockBuildCapabilityCatalog(...args),
  handleToolCall: (...args) => mockHandleToolCall(...args),
  toolDefinitionsForMcp: (...args) => mockToolDefinitionsForMcp(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityAuthorizationService', () => ({
  assertActiveCapabilityAuthorizationGrant: (...args) =>
    mockAssertActiveCapabilityAuthorizationGrant(...args),
  CapabilityAuthorizationError: MockCapabilityAuthorizationError,
  admitCapabilityAuthorization: (...args) => mockAdmitCapabilityAuthorization(...args),
  revokeCapabilityAuthorizationGrant: (...args) =>
    mockRevokeCapabilityAuthorizationGrant(...args),
  verifyAndConsumeAdmission: (...args) => mockVerifyAndConsumeAdmission(...args),
}));

function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.use('/api/viventium/glasshive/capabilities', require('../glasshiveCapabilities'));
  return app;
}

function lifecyclePair() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.writableEnded = false;
  return { req, res };
}

describe('requestLifetimeSignal', () => {
  test.each(['aborted', 'close'])(
    'aborts and removes listeners after premature %s',
    (eventName) => {
      const { req, res } = lifecyclePair();
      const signal = requestLifetimeSignal(req, res);

      (eventName === 'aborted' ? req : res).emit(eventName);

      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe('broker_client_disconnected');
      expect(req.listenerCount('aborted')).toBe(0);
      expect(res.listenerCount('close')).toBe(0);
      expect(res.listenerCount('finish')).toBe(0);
    },
  );

  test('removes listeners without aborting after a normal response finish', () => {
    const { req, res } = lifecyclePair();
    const signal = requestLifetimeSignal(req, res);
    res.writableEnded = true;

    res.emit('finish');
    res.emit('close');

    expect(signal.aborted).toBe(false);
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
    expect(res.listenerCount('finish')).toBe(0);
  });
});

describe('/api/viventium/glasshive/capabilities/mcp', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockSharedCache.clear();
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET: 'route-test-secret',
    };
    mockGetAppConfig.mockResolvedValue({
      webSearch: { searchProvider: 'searxng', searxngInstanceUrl: 'http://127.0.0.1:18082' },
    });
    mockVerifyAndConsumeAdmission.mockResolvedValue(undefined);
    mockAssertActiveCapabilityAuthorizationGrant.mockResolvedValue(undefined);
    mockRevokeCapabilityAuthorizationGrant.mockResolvedValue(undefined);
    mockAdmitCapabilityAuthorization.mockResolvedValue({
      status: 'authorized',
      authorizationRef: 'gha_authorization_1',
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: 'a'.repeat(64),
      grantToken: 'secret-worker-bearer',
      grant: { grantId: 'grant-1', expiresAt: 1_800_086_400 },
    });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('rejects missing broker grant', async () => {
    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);

    expect(response.body.error.message).toBe('Unauthorized GlassHive capability broker request');
  });

  test('rejects a cryptographically valid bearer after its exact generation is inactive', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: {
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        worker_id: 'worker_000001',
        run_id: 'run_000000001',
        authorization_ref: 'gha_authorization_1',
        container_generation_id: 'a'.repeat(64),
      },
    });
    mockAssertActiveCapabilityAuthorizationGrant.mockRejectedValueOnce(
      new MockCapabilityAuthorizationError(
        'capability_grant_inactive',
        'The mission capability grant is no longer active.',
        { status: 401, needsInput: false },
      ),
    );

    await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);

    expect(mockAssertActiveCapabilityAuthorizationGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        grant_id: payload.grant_id,
        authorization_ref: 'gha_authorization_1',
        container_generation_id: 'a'.repeat(64),
      }),
    );
    expect(mockBuildCapabilityCatalog).not.toHaveBeenCalled();
  });

  test('admits an exact mission only after verifying the GlassHive server signature', async () => {
    const body = {
      authorizationRef: 'gha_authorization_1',
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: 'a'.repeat(64),
    };
    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/admit')
      .set('X-Viventium-GlassHive-Admission', 'v1:1800000000:nonce-0001:signature')
      .send(body)
      .expect(200);

    expect(mockVerifyAndConsumeAdmission).toHaveBeenCalledWith({
      body,
      header: 'v1:1800000000:nonce-0001:signature',
    });
    expect(mockAdmitCapabilityAuthorization).toHaveBeenCalledWith(body);
    expect(response.body).toMatchObject({
      status: 'authorized',
      grantToken: 'secret-worker-bearer',
    });
    expect(response.headers['cache-control']).toContain('no-store');
  });

  test('returns structured needs-input truth when the authorization horizon expired', async () => {
    mockAdmitCapabilityAuthorization.mockRejectedValueOnce(
      new MockCapabilityAuthorizationError(
        'capability_authorization_horizon_expired',
        'Explicit authorization is required.',
      ),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/admit')
      .set('X-Viventium-GlassHive-Admission', 'v1:1800000000:nonce-0001:signature')
      .send({
        authorizationRef: 'gha_authorization_1',
        originRef: 'ghi_origin_0001',
        workRef: 'work_00000001',
        workerId: 'worker_000001',
        runId: 'run_000000001',
        containerGenerationId: 'a'.repeat(64),
      })
      .expect(409);

    expect(response.body).toEqual({
      error: {
        code: 'capability_authorization_horizon_expired',
        message: 'Explicit authorization is required.',
        needsInput: true,
      },
    });
  });

  test('revokes only an exact signed mission container generation', async () => {
    const body = {
      authorizationRef: 'gha_authorization_1',
      originRef: 'ghi_origin_0001',
      workRef: 'work_00000001',
      workerId: 'worker_000001',
      runId: 'run_000000001',
      containerGenerationId: 'a'.repeat(64),
      grantId: 'grant-synthetic-1',
    };
    await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/revoke')
      .set('X-Viventium-GlassHive-Admission', 'v1:1800000000:nonce-0002:signature')
      .send(body)
      .expect(204);

    expect(mockVerifyAndConsumeAdmission).toHaveBeenCalledWith({
      body,
      header: 'v1:1800000000:nonce-0002:signature',
    });
    expect(mockRevokeCapabilityAuthorizationGrant).toHaveBeenCalledWith(body);
  });

  test('preserves read-only ToolAnnotations over the signed loopback MCP transport', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    mockBuildCapabilityCatalog.mockResolvedValue({ tools: [] });
    mockToolDefinitionsForMcp.mockReturnValue([
      {
        name: 'capabilities_list',
        description: 'List capabilities',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ]);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);

    expect(response.body.result.tools[0]).toEqual(
      expect.objectContaining({
        name: 'capabilities_list',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }),
    );
    expect(mockGetAppConfig).toHaveBeenCalledWith({ role: 'USER' });
    expect(mockBuildCapabilityCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        appConfig: expect.objectContaining({
          webSearch: expect.objectContaining({ searchProvider: 'searxng' }),
        }),
      }),
    );
  });

  test('rate limits repeated broker requests for the same grant', async () => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_PER_WINDOW = '1';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_WINDOW_MS = '60000';
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    mockBuildCapabilityCatalog.mockResolvedValue({ tools: [] });
    mockToolDefinitionsForMcp.mockReturnValue([]);

    await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
      .expect(200);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 6, method: 'tools/list' })
      .expect(429);

    expect(response.body.error.message).toBe('GlassHive capability broker rate limit exceeded');
    expect(response.headers['retry-after']).toBeDefined();
  });

  test('rejects an expired grant instead of silently extending bearer lifetime', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      ttlSeconds: 60,
      nowMs: Date.now() - 120_000,
    });
    mockBuildCapabilityCatalog.mockResolvedValue({ tools: [] });
    mockToolDefinitionsForMcp.mockReturnValue([]);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
      .expect(401);

    expect(response.headers['x-glasshive-capability-grant-renewed']).toBeUndefined();
    expect(response.body.error.message).toBe('Unauthorized GlassHive capability broker request');
    expect(mockBuildCapabilityCatalog).not.toHaveBeenCalled();
  });

  test('accepts MCP initialized notifications without a JSON-RPC response body', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      .expect(202);

    expect(response.text).toBe('');
  });

  test('returns structured content for tools/call', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    mockHandleToolCall.mockImplementation(({ signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return Promise.resolve({ servers: [{ name: 'google_workspace' }] });
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'capabilities_list', arguments: {} },
      })
      .expect(200);

    expect(response.body.result.structuredContent.servers[0].name).toBe('google_workspace');
    expect(mockHandleToolCall).toHaveBeenCalledWith(expect.objectContaining({ invocationId: '' }));
  });

  test('forwards native prepare/commit without trusting RPC or progress-token identity', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      authorityKind: 'conversation_orchestrator',
      allowedHostTools: ['active_work_action'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    mockHandleToolCall
      .mockResolvedValueOnce({
        status: 'prepared',
        reason: 'orchestration_operation_confirmation_required',
        tool: 'active_work_action',
        _viventium_operation_token: 'signed-operation-token',
      })
      .mockResolvedValueOnce({ status: 'ok', tool: 'active_work_action' });

    const invoke = (id, progressToken, args) =>
      request(appWithRoute())
        .post('/api/viventium/glasshive/capabilities/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'active_work_action',
            arguments: args,
            _meta: { progressToken },
          },
        });
    const prepared = await invoke(99, 'provider-tool-call-first', {
      workRef: ' gh-work-1 ',
      action: 'MESSAGE',
      instruction: ' Keep the evidence. ',
      operationId: 'attacker-id-first',
      ignored: 'first',
    }).expect(200);
    const committed = await invoke(1, 'provider-tool-call-after-reconnect', {
      workRef: 'gh-work-1',
      action: 'message',
      instruction: 'Keep the evidence.',
      _viventium_operation_token: 'signed-operation-token',
    }).expect(200);

    expect(prepared.body.result.structuredContent).toMatchObject({
      status: 'prepared',
      _viventium_operation_token: 'signed-operation-token',
    });
    expect(prepared.headers['cache-control']).toContain('no-store');
    expect(committed.body.result.structuredContent).toEqual({
      status: 'ok',
      tool: 'active_work_action',
    });
    expect(mockHandleToolCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        invocationId: '',
        args: expect.objectContaining({ operationId: 'attacker-id-first' }),
      }),
    );
    expect(mockHandleToolCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invocationId: '',
        args: expect.objectContaining({
          _viventium_operation_token: 'signed-operation-token',
        }),
      }),
    );
  });

  test('preserves native delegation source ordinals across the prepare/commit route', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      authorityKind: 'conversation_orchestrator',
      allowedHostTools: ['worker_delegate_once_mcp_glasshive-workers-projects'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    mockHandleToolCall
      .mockResolvedValueOnce({
        status: 'prepared',
        tool: 'worker_delegate_once_mcp_glasshive-workers-projects',
        _viventium_operation_token: 'signed-delegation-token',
      })
      .mockResolvedValueOnce({
        status: 'ok',
        tool: 'worker_delegate_once_mcp_glasshive-workers-projects',
        workRef: 'gh-work-1',
      });
    const invoke = (args) =>
      request(appWithRoute())
        .post('/api/viventium/glasshive/capabilities/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id: Math.random(),
          method: 'tools/call',
          params: {
            name: 'worker_delegate_once_mcp_glasshive-workers-projects',
            arguments: args,
          },
        });

    const args = {
      title: ' Mission A ',
      instruction: ' Do the work. ',
      executionMode: 'host',
      ownerId: 'attacker-a',
      operationId: 'attacker-a',
      sourceOrdinals: [1],
    };
    await invoke(args).expect(200);
    const committed = await invoke({
      ...args,
      _viventium_operation_token: 'signed-delegation-token',
    }).expect(200);

    expect(committed.body.result.structuredContent.workRef).toBe('gh-work-1');
    expect(mockHandleToolCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        invocationId: '',
        args: expect.objectContaining({
          sourceOrdinals: [1],
          _viventium_operation_token: 'signed-delegation-token',
        }),
      }),
    );
  });

  test('aborts in-flight provider work when the broker client disconnects', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    let captureSignal;
    let captureAbort;
    const signalSeen = new Promise((resolve) => {
      captureSignal = resolve;
    });
    const providerAborted = new Promise((resolve) => {
      captureAbort = resolve;
    });
    mockHandleToolCall.mockImplementation(({ signal }) => {
      captureSignal(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            captureAbort(signal);
            reject(new Error('provider work cancelled'));
          },
          { once: true },
        );
      });
    });

    const server = appWithRoute().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'schedule_create', arguments: {} },
    });
    const clientRequest = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: '/api/viventium/glasshive/capabilities/mcp',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    });
    clientRequest.on('error', () => {});
    clientRequest.end(payload);

    try {
      const signal = await signalSeen;
      expect(signal.aborted).toBe(false);
      clientRequest.destroy();
      const abortedSignal = await providerAborted;
      expect(abortedSignal.aborted).toBe(true);
      expect(abortedSignal.reason).toBe('broker_client_disconnected');
    } finally {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('omits structuredContent for array tool results so strict MCP clients accept them', async () => {
    // MS365 list_mail_messages returns an array. structuredContent must be a JSON
    // object per MCP, so emitting an array makes strict clients (claude-code workers)
    // reject the result with "expected record, received array". The array must still
    // reach the worker via the text content block.
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    const arrayResult = [{ subject: 'Hello' }, { subject: 'World' }];
    mockHandleToolCall.mockResolvedValue(arrayResult);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'list_mail_messages', arguments: {} },
      })
      .expect(200);

    expect(response.body.result).not.toHaveProperty('structuredContent');
    expect(JSON.parse(response.body.result.content[0].text)).toEqual(arrayResult);
  });
});
