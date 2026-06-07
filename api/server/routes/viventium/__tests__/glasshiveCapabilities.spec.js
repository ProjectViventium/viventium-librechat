const express = require('express');
const request = require('supertest');

const mockBuildCapabilityCatalog = jest.fn();
const mockHandleToolCall = jest.fn();
const mockToolDefinitionsForMcp = jest.fn();
const mockSharedCache = new Map();

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

function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.use('/api/viventium/glasshive/capabilities', require('../glasshiveCapabilities'));
  return app;
}

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

  test('returns MCP tools/list for a valid broker grant', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
    });
    mockBuildCapabilityCatalog.mockResolvedValue({ tools: [] });
    mockToolDefinitionsForMcp.mockReturnValue([
      {
        name: 'capabilities_list',
        description: 'List capabilities',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);

    expect(response.body.result.tools[0].name).toBe('capabilities_list');
    expect(mockBuildCapabilityCatalog).toHaveBeenCalled();
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

  test('accepts an expired grant inside its bounded renewal window', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      ttlSeconds: 60,
      renewableTtlSeconds: 600,
      nowMs: Date.now() - 120_000,
    });
    mockBuildCapabilityCatalog.mockResolvedValue({ tools: [] });
    mockToolDefinitionsForMcp.mockReturnValue([]);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/capabilities/mcp')
      .set('Authorization', `Bearer ${token}`)
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
      .expect(200);

    expect(response.headers['x-glasshive-capability-grant-renewed']).toBe('true');
    expect(response.body.result.tools).toEqual([]);
    expect(mockBuildCapabilityCatalog).toHaveBeenCalledWith(
      expect.objectContaining({
        grant: expect.objectContaining({ renewed: true }),
      }),
    );
  });

  test('accepts MCP initialized notifications without a JSON-RPC response body', async () => {
    const {
      mintBrokerGrant,
    } = require('~/server/services/viventium/GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
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
    });
    mockHandleToolCall.mockResolvedValue({ servers: [{ name: 'google_workspace' }] });

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
