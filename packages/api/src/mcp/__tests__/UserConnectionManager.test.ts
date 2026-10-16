/* === VIVENTIUM START ===
 * Feature: Regression tests for persistent MCP idle behavior.
 * Purpose: Keep scheduling-cortex initialized across idle sweeps.
 * === VIVENTIUM END === */
import type { IUser } from '@librechat/data-schemas';
import { UserConnectionManager } from '~/mcp/UserConnectionManager';
import { mcpConfig } from '~/mcp/mcpConfig';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPServerInspector } from '~/mcp/registry/MCPServerInspector';
import type { MCPConnection } from '~/mcp/connection';

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
  shouldEnableSSRFProtection: jest.fn().mockReturnValue(false),
};

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('~/mcp/registry/MCPServersRegistry', () => ({
  MCPServersRegistry: {
    getInstance: () => mockRegistryInstance,
  },
}));

jest.mock('~/mcp/MCPConnectionFactory', () => ({
  MCPConnectionFactory: {
    create: jest.fn(),
  },
}));

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

class TestUserConnectionManager extends UserConnectionManager {
  public setUserConnection(userId: string, serverName: string, connection: MCPConnection): void {
    if (!this.userConnections.has(userId)) {
      this.userConnections.set(userId, new Map());
    }
    this.userConnections.get(userId)?.set(serverName, connection);
  }

  public getUserConnectionByServer(userId: string, serverName: string): MCPConnection | undefined {
    return this.userConnections.get(userId)?.get(serverName);
  }

  public setUserLastActivity(userId: string, timestamp: number): void {
    this.userLastActivity.set(userId, timestamp);
  }

  public getUserLastActivity(userId: string): number | undefined {
    return this.userLastActivity.get(userId);
  }

  public runIdleCheck(currentUserId?: string): void {
    this.checkIdleConnections(currentUserId);
  }
}

function createMockConnection(overrides?: Partial<MCPConnection>): MCPConnection {
  return {
    disconnect: jest.fn().mockResolvedValue(undefined),
    isConnected: jest.fn().mockResolvedValue(true),
    isStale: jest.fn().mockReturnValue(false),
    ...overrides,
  } as unknown as MCPConnection;
}

describe('UserConnectionManager idle behavior', () => {
  const userId = 'test-user-id';

  beforeEach(() => {
    jest.clearAllMocks();
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
    });
  });

  it('disconnects only non-persistent MCP servers during idle sweeps', async () => {
    const manager = new TestUserConnectionManager();
    manager.appConnections = {
      has: jest.fn().mockResolvedValue(false),
    } as never;

    const schedulingConnection = createMockConnection();
    const ms365Connection = createMockConnection();

    manager.setUserConnection(userId, 'scheduling-cortex', schedulingConnection);
    manager.setUserConnection(userId, 'ms-365', ms365Connection);
    manager.setUserLastActivity(userId, Date.now() - mcpConfig.USER_CONNECTION_IDLE_TIMEOUT - 1000);

    manager.runIdleCheck();
    await flushAsync();

    expect(ms365Connection.disconnect).toHaveBeenCalledTimes(1);
    expect(schedulingConnection.disconnect).not.toHaveBeenCalled();
    expect(manager.getUserConnectionByServer(userId, 'scheduling-cortex')).toBe(
      schedulingConnection,
    );
    expect(manager.getUserConnectionByServer(userId, 'ms-365')).toBeUndefined();
    expect(manager.getUserLastActivity(userId)).toBeUndefined();
  });

  it('reuses scheduling-cortex connection after idle window without forcing reconnection', async () => {
    const manager = new TestUserConnectionManager();
    manager.appConnections = {
      has: jest.fn().mockResolvedValue(false),
    } as never;

    const schedulingConnection = createMockConnection();
    manager.setUserConnection(userId, 'scheduling-cortex', schedulingConnection);
    manager.setUserLastActivity(userId, Date.now() - mcpConfig.USER_CONNECTION_IDLE_TIMEOUT - 1000);

    const result = await manager.getUserConnection({
      serverName: 'scheduling-cortex',
      user: { id: userId } as IUser,
      flowManager: {} as never,
    } as never);

    expect(result).toBe(schedulingConnection);
    expect(schedulingConnection.disconnect).not.toHaveBeenCalled();
    expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
  });

  it('replaces a cached interactive connection before non-interactive reuse', async () => {
    const manager = new TestUserConnectionManager();
    manager.appConnections = {
      has: jest.fn().mockResolvedValue(false),
    } as never;
    const interactiveConnection = createMockConnection();
    const nonInteractiveConnection = createMockConnection();
    manager.setUserConnection(userId, 'ms-365', interactiveConnection);
    (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(nonInteractiveConnection);

    const result = await manager.getUserConnection({
      serverName: 'ms-365',
      user: { id: userId } as IUser,
      flowManager: {} as never,
      allowOAuthInitiation: false,
    } as never);

    expect(result).toBe(nonInteractiveConnection);
    expect(interactiveConnection.disconnect).toHaveBeenCalledTimes(1);
    expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ allowOAuthInitiation: false }),
    );
  });
});

/* === VIVENTIUM START ===
 * Feature: Respect typed MCP authentication requirements on user connections.
 * Purpose: Avoid no-op token flows without changing real or unknown OAuth behavior.
 */
describe('UserConnectionManager OAuth requirement', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['unknown authentication', {}, true],
    ['unknown stdio', { type: 'stdio', url: undefined, command: 'node' }, true],
    [
      'stdio OAuth declared',
      { type: 'stdio', url: undefined, command: 'node', requiresOAuth: true },
      true,
    ],
    [
      'stdio OAuth metadata',
      { type: 'stdio', url: undefined, command: 'node', requiresOAuth: false, oauthMetadata: {} },
      true,
    ],
    ['explicit OAuth', { requiresOAuth: true }, true],
    ['remote false remains uncertain', { requiresOAuth: false }, true],
    [
      'stdio no OAuth',
      { requiresOAuth: false, type: 'stdio', url: undefined, command: 'node' },
      false,
    ],
    [
      'remote admin key retains authentication path',
      { requiresOAuth: false, apiKey: { source: 'admin' } },
      true,
    ],
    ['OAuth metadata overrides false', { requiresOAuth: false, oauthMetadata: {} }, true],
    ['OAuth metadata with unknown requirement', { oauthMetadata: {} }, true],
  ])('%s preserves the required factory authentication path', async (_label, auth, expected) => {
    const manager = new TestUserConnectionManager();
    manager.appConnections = { has: jest.fn().mockResolvedValue(false) } as never;
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      ...auth,
    });
    const connection = createMockConnection();
    (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(connection);
    const signal = new AbortController().signal;
    const tokenMethods = { findToken: jest.fn(), updateToken: jest.fn() };
    const flowManager = {};

    expect(
      await manager.getUserConnection({
        serverName: 'example-server',
        user: { id: 'test-user-id' } as IUser,
        tokenMethods,
        flowManager,
        signal,
        allowOAuthInitiation: false,
        suppressOAuthFlow: true,
      } as never),
    ).toBe(connection);
    expect(MCPConnectionFactory.create).toHaveBeenCalledTimes(1);
    expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ serverConfig: expect.objectContaining(auth) }),
      expect.objectContaining({
        useOAuth: expected,
        allowOAuthInitiation: false,
        suppressOAuthFlow: true,
      }),
    );
    const options = (MCPConnectionFactory.create as jest.Mock).mock.calls[0][1];
    if (expected) {
      expect(options).toMatchObject({ tokenMethods, flowManager, signal });
    } else {
      for (const key of [
        'tokenMethods',
        'flowManager',
        'signal',
        'oauthStart',
        'oauthEnd',
        'returnOnOAuth',
      ]) {
        expect(options).not.toHaveProperty(key);
      }
    }
  });

  it.each([
    [
      'deferred remote',
      { type: 'streamable-http', url: 'https://example.com/mcp', startup: false },
      true,
    ],
    ['deferred stdio', { type: 'stdio', command: 'node', startup: false }, false],
  ])(
    'preserves Inspector-produced %s authentication semantics',
    async (_label, config, expected) => {
      const parsed = await MCPServerInspector.inspect(
        'example-server',
        config as never,
        undefined,
        ['example.com'],
      );
      expect(parsed.requiresOAuth).toBe(false);
      expect(MCPConnectionFactory.create).not.toHaveBeenCalled();
      mockRegistryInstance.getServerConfig.mockResolvedValue(parsed);
      const manager = new TestUserConnectionManager();
      manager.appConnections = { has: jest.fn().mockResolvedValue(false) } as never;
      (MCPConnectionFactory.create as jest.Mock).mockResolvedValue(createMockConnection());
      await manager.getUserConnection({
        serverName: 'example-server',
        user: { id: 'test-user-id' } as IUser,
        flowManager: {} as never,
      } as never);
      expect(MCPConnectionFactory.create).toHaveBeenCalledWith(
        expect.objectContaining({ serverConfig: parsed }),
        expect.objectContaining({ useOAuth: expected }),
      );
    },
  );

  it('propagates authentication failure without caching a failed connection', async () => {
    const manager = new TestUserConnectionManager();
    manager.appConnections = { has: jest.fn().mockResolvedValue(false) } as never;
    mockRegistryInstance.getServerConfig.mockResolvedValue({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      requiresOAuth: true,
    });
    const failure = new Error('Authentication unavailable');
    (MCPConnectionFactory.create as jest.Mock).mockRejectedValue(failure);
    await expect(
      manager.getUserConnection({
        serverName: 'example-server',
        user: { id: 'test-user-id' } as IUser,
        flowManager: {} as never,
      } as never),
    ).rejects.toBe(failure);
    expect(manager.getUserConnectionByServer('test-user-id', 'example-server')).toBeUndefined();
  });
});
/* === VIVENTIUM END === */
