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

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  getUserById: jest.fn(),
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

jest.mock('~/server/services/viventium/GlassHiveCapabilityBootstrapService', () => ({
  buildDirectGlassHiveCapabilityBundle: jest.fn(),
  directCapabilityReadiness: jest.fn(),
  revokeDirectGlassHiveCapabilityGrant: jest.fn(),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityDirectIssuerAuth', () => ({
  verifyDirectIssuerAssertion: jest.fn(),
}));

function appWithRoute({ requestSignal } = {}) {
  const app = express();
  app.use(express.json());
  if (requestSignal) {
    app.use((req, _res, next) => {
      // Keep the sentinel inert: a native aborted signal can make Node abort the test transport
      // before this route gets a chance to prove that it does not forward request lifecycle state.
      // Node 24 exposes `signal` as a getter-only request property, so shadow it explicitly.
      Object.defineProperty(req, 'signal', {
        configurable: true,
        value: requestSignal,
      });
      next();
    });
  }
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

    const response = await request(appWithRoute({ requestSignal: { aborted: true } }))
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);

    expect(response.body.result.tools[0].name).toBe('capabilities_list');
    expect(mockBuildCapabilityCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
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

  test('rejects a revoked scheduled grant even inside its renewal window', async () => {
    const {
      mintBrokerGrant,
      revokeBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      grantId: 'ghcb_sched_revoked_route',
      allowedServers: ['google_workspace'],
      requestContext: { schedule_id: 'schedule-1', run_id: 'scheduled-run-1' },
      requireTurnScope: false,
      ttlSeconds: 60,
      renewableTtlSeconds: 600,
      nowMs: Date.now() - 120_000,
    });
    await revokeBrokerGrant(payload);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 8, method: 'tools/list' })
      .expect(401);

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

    const response = await request(appWithRoute({ requestSignal: { aborted: true } }))
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
    expect(mockHandleToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        appConfig: expect.objectContaining({
          webSearch: expect.objectContaining({ searchProvider: 'searxng' }),
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
