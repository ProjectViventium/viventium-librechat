/* === VIVENTIUM START ===
 * Feature: Regression tests for persistent MCP idle behavior.
 * Purpose: Keep scheduling-cortex initialized across idle sweeps.
 * === VIVENTIUM END === */
import type { IUser } from '@librechat/data-schemas';
import { UserConnectionManager } from '~/mcp/UserConnectionManager';
import { mcpConfig } from '~/mcp/mcpConfig';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import type { MCPConnection } from '~/mcp/connection';

const mockRegistryInstance = {
  getServerConfig: jest.fn(),
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
});
