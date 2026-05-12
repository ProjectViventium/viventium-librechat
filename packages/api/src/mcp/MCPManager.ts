import { logger } from '@librechat/data-schemas';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { TokenMethods, IUser } from '@librechat/data-schemas';
import type { GraphTokenResolver } from '~/utils/graph';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPOAuthTokens } from './oauth';
import type { RequestBody } from '~/types';
import type * as t from './types';
import { MCPServersInitializer } from './registry/MCPServersInitializer';
import { MCPServerInspector } from './registry/MCPServerInspector';
import { MCPServersRegistry } from './registry/MCPServersRegistry';
import { UserConnectionManager } from './UserConnectionManager';
import { ConnectionsRepository } from './ConnectionsRepository';
import { MCPConnectionFactory } from './MCPConnectionFactory';
import { preProcessGraphTokens } from '~/utils/graph';
import { formatToolContent } from './parsers';
import { MCPConnection } from './connection';
import { processMCPEnv } from '~/utils/env';

type ServerInstructionConfig = t.ParsedServerConfig & {
  viventiumTrustedServerInstructions?: unknown;
};

function sanitizeMCPManagerErrorForLog(error: unknown): {
  name: string | null;
  code: unknown;
  status: number | null;
  message: string | null;
} {
  const record = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof record.message === 'string'
          ? record.message
          : '';
  return {
    name: error instanceof Error ? error.name : null,
    code: record.code ?? null,
    status: typeof record.status === 'number' && Number.isFinite(record.status) ? record.status : null,
    message: message
      ? message
          .replace(/https?:\/\/[^\s)]+/gi, '<url>')
          .replace(/\/Users\/[^\s)]+/g, '<path>')
          .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer <redacted>')
          .slice(0, 180)
      : null,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function serverInstructionCacheKey(serverName: string, config: t.ParsedServerConfig): string {
  const relevantConfig = {
    type: config.type,
    url: 'url' in config ? config.url : undefined,
    command: 'command' in config ? config.command : undefined,
    args: 'args' in config ? config.args : undefined,
    serverInstructions: config.serverInstructions,
    requiresOAuth: config.requiresOAuth,
    oauthMetadata: Boolean(config.oauthMetadata),
    trusted:
      (config as ServerInstructionConfig).viventiumTrustedServerInstructions === true,
  };
  return `${serverName}:${stableStringify(relevantConfig)}`;
}

function allowsServerInstructionFetch(config: t.ParsedServerConfig): boolean {
  return (config as ServerInstructionConfig).viventiumTrustedServerInstructions === true;
}

const DEFAULT_SERVER_INSTRUCTION_FETCH_TIMEOUT_MS = 1500;
const MAX_SERVER_INSTRUCTION_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_SERVER_INSTRUCTION_FAILURE_TTL_MS = 30_000;
const MAX_SERVER_INSTRUCTION_FAILURE_TTL_MS = 5 * 60_000;

function parseBoundedPositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function serverInstructionFetchTimeoutMs(): number {
  return parseBoundedPositiveInt(
    process.env.VIVENTIUM_MCP_SERVER_INSTRUCTIONS_TIMEOUT_MS,
    DEFAULT_SERVER_INSTRUCTION_FETCH_TIMEOUT_MS,
    MAX_SERVER_INSTRUCTION_FETCH_TIMEOUT_MS,
  );
}

function serverInstructionFailureTtlMs(): number {
  return parseBoundedPositiveInt(
    process.env.VIVENTIUM_MCP_SERVER_INSTRUCTIONS_FAILURE_TTL_MS,
    DEFAULT_SERVER_INSTRUCTION_FAILURE_TTL_MS,
    MAX_SERVER_INSTRUCTION_FAILURE_TTL_MS,
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T | null> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch (_error) {
        // Timeout cleanup is best-effort; the original promise still owns final cleanup.
      }
      resolve(null);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Centralized manager for MCP server connections and tool execution.
 * Extends UserConnectionManager to handle both app-level and user-specific connections.
 */
export class MCPManager extends UserConnectionManager {
  private static instance: MCPManager | null;
  private readonly serverInstructionCache = new Map<string, string>();
  private readonly failedServerInstructionCache = new Map<string, number>();
  private readonly pendingServerInstructionFetches = new Map<string, Promise<string | null>>();

  /** Creates and initializes the singleton MCPManager instance */
  public static async createInstance(configs: t.MCPServers): Promise<MCPManager> {
    if (MCPManager.instance) throw new Error('MCPManager has already been initialized.');
    MCPManager.instance = new MCPManager();
    await MCPManager.instance.initialize(configs);
    return MCPManager.instance;
  }

  /** Returns the singleton MCPManager instance */
  public static getInstance(): MCPManager {
    if (!MCPManager.instance) throw new Error('MCPManager has not been initialized.');
    return MCPManager.instance;
  }

  /** Initializes the MCPManager by setting up server registry and app connections */
  public async initialize(configs: t.MCPServers) {
    await MCPServersInitializer.initialize(configs);
    this.appConnections = new ConnectionsRepository(undefined);
  }

  /** Retrieves an app-level or user-specific connection based on provided arguments */
  public async getConnection(
    args: {
      serverName: string;
      user?: IUser;
      forceNew?: boolean;
      flowManager?: FlowStateManager<MCPOAuthTokens | null>;
    } & Omit<t.OAuthConnectionOptions, 'useOAuth' | 'user' | 'flowManager'>,
  ): Promise<MCPConnection> {
    //the get method checks if the config is still valid as app level
    const existingAppConnection = await this.appConnections!.get(args.serverName);
    if (existingAppConnection) {
      return existingAppConnection;
    } else if (args.user?.id) {
      return this.getUserConnection(args as Parameters<typeof this.getUserConnection>[0]);
    } else {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No connection found for server ${args.serverName}`,
      );
    }
  }

  /**
   * Discovers tools from an MCP server, even when OAuth is required.
   * Per MCP spec, tool listing should be possible without authentication.
   * Use this for agent initialization to get tool schemas before OAuth flow.
   */
  public async discoverServerTools(args: t.ToolDiscoveryOptions): Promise<t.ToolDiscoveryResult> {
    const { serverName, user } = args;
    const logPrefix = user?.id ? `[MCP][User: ${user.id}][${serverName}]` : `[MCP][${serverName}]`;

    try {
      const existingAppConnection = await this.appConnections?.get(serverName);
      if (existingAppConnection && (await existingAppConnection.isConnected())) {
        const tools = await existingAppConnection.fetchTools();
        return { tools, oauthRequired: false, oauthUrl: null };
      }
    } catch {
      logger.debug(`${logPrefix} [Discovery] App connection not available, trying discovery mode`);
    }

    const serverConfig = (await MCPServersRegistry.getInstance().getServerConfig(
      serverName,
      user?.id,
    )) as t.MCPOptions | null;

    if (!serverConfig) {
      logger.warn(`${logPrefix} [Discovery] Server config not found`);
      return { tools: null, oauthRequired: false, oauthUrl: null };
    }

    const useOAuth = Boolean(
      serverConfig.requiresOAuth || (serverConfig as t.ParsedServerConfig).oauthMetadata,
    );

    const useSSRFProtection = MCPServersRegistry.getInstance().shouldEnableSSRFProtection();
    const dbSourced = !!(serverConfig as t.ParsedServerConfig).dbId;
    const basic: t.BasicConnectionOptions = {
      dbSourced,
      serverName,
      serverConfig,
      useSSRFProtection,
    };

    if (!useOAuth) {
      const result = await MCPConnectionFactory.discoverTools(basic);
      return {
        tools: result.tools,
        oauthRequired: result.oauthRequired,
        oauthUrl: result.oauthUrl,
      };
    }

    if (!user || !args.flowManager) {
      logger.warn(`${logPrefix} [Discovery] OAuth server requires user and flowManager`);
      return { tools: null, oauthRequired: true, oauthUrl: null };
    }

    const result = await MCPConnectionFactory.discoverTools(basic, {
      user,
      useOAuth: true,
      flowManager: args.flowManager,
      tokenMethods: args.tokenMethods,
      signal: args.signal,
      oauthStart: args.oauthStart,
      customUserVars: args.customUserVars,
      requestBody: args.requestBody,
      connectionTimeout: args.connectionTimeout,
    });

    return { tools: result.tools, oauthRequired: result.oauthRequired, oauthUrl: result.oauthUrl };
  }

  /** Returns all available tool functions from app-level connections */
  public async getAppToolFunctions(): Promise<t.LCAvailableTools> {
    const toolFunctions: t.LCAvailableTools = {};
    const configs = await MCPServersRegistry.getInstance().getAllServerConfigs();
    for (const config of Object.values(configs)) {
      if (config.toolFunctions != null) {
        Object.assign(toolFunctions, config.toolFunctions);
      }
    }
    return toolFunctions;
  }

  /** Returns all available tool functions from all connections available to user */
  public async getServerToolFunctions(
    userId: string,
    serverName: string,
  ): Promise<t.LCAvailableTools | null> {
    try {
      //try get the appConnection (if the config is not in the app level anymore any existing connection will disconnect and get will return null)
      const existingAppConnection = await this.appConnections?.get(serverName);
      if (existingAppConnection) {
        return MCPServerInspector.getToolFunctions(serverName, existingAppConnection);
      }

      const userConnections = this.getUserConnections(userId);
      if (!userConnections || userConnections.size === 0) {
        return null;
      }
      if (!userConnections.has(serverName)) {
        return null;
      }

      return MCPServerInspector.getToolFunctions(serverName, userConnections.get(serverName)!);
    } catch (error) {
      logger.warn(
        `[getServerToolFunctions] Error getting tool functions for server ${serverName}`,
        sanitizeMCPManagerErrorForLog(error),
      );
      return null;
    }
  }

  /**
   * Get instructions for MCP servers
   * @param serverNames Optional array of server names. If not provided or empty, returns all servers.
   * @returns Object mapping server names to their instructions
   */
  private async getInstructionsWithSources(
    serverNames?: string[],
  ): Promise<{ instructions: Record<string, string>; sources: Record<string, string> }> {
    const instructions: Record<string, string> = {};
    const sources: Record<string, string> = {};
    const configs = await MCPServersRegistry.getInstance().getAllServerConfigs();
    const requestedServers =
      serverNames && serverNames.length > 0 ? new Set(serverNames) : undefined;
    const resolvedServers = await Promise.all(
      Object.entries(configs)
        .filter(([serverName]) => !requestedServers || requestedServers.has(serverName))
        .map(([serverName, config]) => this.resolveInstructionsForServer(serverName, config)),
    );
    for (const resolved of resolvedServers) {
      sources[resolved.serverName] = resolved.source;
      if (resolved.instruction) {
        instructions[resolved.serverName] = resolved.instruction;
      }
    }
    if (requestedServers) {
      for (const serverName of requestedServers) {
        if (!sources[serverName]) {
          sources[serverName] = 'missing';
        }
      }
    }
    return { instructions, sources };
  }

  private async resolveInstructionsForServer(
    serverName: string,
    config: t.ParsedServerConfig,
  ): Promise<{ serverName: string; instruction?: string; source: string }> {
    if (typeof config.serverInstructions === 'string') {
      const trimmedInstructions = config.serverInstructions.trim();
      if (trimmedInstructions && trimmedInstructions.toLowerCase() !== 'true') {
        return { serverName, instruction: config.serverInstructions, source: 'config_inline' };
      }
      if (trimmedInstructions.toLowerCase() !== 'true') {
        return { serverName, source: 'missing' };
      }
    } else if (config.serverInstructions !== true) {
      return { serverName, source: 'missing' };
    }

    const serverProvidedInstructions = await this.fetchServerProvidedInstructions(serverName, config);
    if (serverProvidedInstructions) {
      return { serverName, instruction: serverProvidedInstructions, source: 'server_fetched' };
    }
    if (config.serverInstructions === true || String(config.serverInstructions).trim().toLowerCase() === 'true') {
      logger.warn(
        `[MCP][${serverName}] serverInstructions=true was not resolved to server-provided instructions; skipping injection`,
      );
    }
    return { serverName, source: 'missing' };
  }

  private async fetchServerProvidedInstructions(
    serverName: string,
    config: t.ParsedServerConfig,
  ): Promise<string | null> {
    if (!allowsServerInstructionFetch(config)) {
      logger.warn(
        `[MCP][${serverName}] serverInstructions=true is only allowed for trusted first-party server configs; skipping injection`,
      );
      return null;
    }

    const cacheKey = serverInstructionCacheKey(serverName, config);
    const cachedInstructions = this.serverInstructionCache.get(cacheKey);
    if (cachedInstructions) {
      return cachedInstructions;
    }

    const failedUntil = this.failedServerInstructionCache.get(cacheKey);
    if (failedUntil && failedUntil > Date.now()) {
      return null;
    }
    if (failedUntil) {
      this.failedServerInstructionCache.delete(cacheKey);
    }

    const pendingFetch = this.pendingServerInstructionFetches.get(cacheKey);
    if (pendingFetch) {
      return pendingFetch;
    }

    if (config.requiresOAuth || config.oauthMetadata) {
      logger.warn(
        `[MCP][${serverName}] serverInstructions=true requires server metadata, but OAuth/user-specific instructions cannot be fetched from app-level context`,
      );
      return null;
    }

    const fetchPromise = this.fetchServerProvidedInstructionsOnce(
      serverName,
      config,
      serverInstructionFetchTimeoutMs(),
    );
    this.pendingServerInstructionFetches.set(cacheKey, fetchPromise);
    try {
      const result = await fetchPromise;
      if (!result) {
        const failureTtlMs = serverInstructionFailureTtlMs();
        if (failureTtlMs > 0) {
          this.failedServerInstructionCache.set(cacheKey, Date.now() + failureTtlMs);
        }
      }
      return result;
    } finally {
      this.pendingServerInstructionFetches.delete(cacheKey);
    }
  }

  private async fetchServerProvidedInstructionsOnce(
    serverName: string,
    config: t.ParsedServerConfig,
    timeoutMs = serverInstructionFetchTimeoutMs(),
  ): Promise<string | null> {
    let connection: MCPConnection | undefined;
    let timedOut = false;
    try {
      const createConnectionPromise = MCPConnectionFactory.create({
        serverName,
        serverConfig: config,
        dbSourced: !!config.dbId,
        useSSRFProtection: MCPServersRegistry.getInstance().shouldEnableSSRFProtection(),
      }).then(async (createdConnection) => {
        if (timedOut) {
          try {
            await createdConnection.disconnect();
          } catch (disconnectError) {
            logger.debug(
              `[MCP][${serverName}] Failed to disconnect late server-instructions connection`,
              {
                name: disconnectError instanceof Error ? disconnectError.name : null,
              },
            );
          }
          return null;
        }
        return createdConnection;
      });
      const nextConnection = await withTimeout(
        createConnectionPromise,
        timeoutMs,
        () => {
          timedOut = true;
        },
      );
      if (!nextConnection) {
        logger.warn(
          `[MCP][${serverName}] Timed out creating temporary server-instructions connection; skipping injection`,
        );
        return null;
      }
      connection = nextConnection;
      const serverProvidedInstructions = connection.client.getInstructions();
      if (typeof serverProvidedInstructions === 'string' && serverProvidedInstructions.trim()) {
        this.serverInstructionCache.set(
          serverInstructionCacheKey(serverName, config),
          serverProvidedInstructions,
        );
        return serverProvidedInstructions;
      }

      logger.warn(
        `[MCP][${serverName}] serverInstructions=true resolved to empty server-provided instructions; skipping injection`,
      );
      return null;
    } catch (error) {
      logger.warn(
        `[MCP][${serverName}] Failed to fetch server-provided instructions for context injection`,
        sanitizeMCPManagerErrorForLog(error),
      );
      return null;
    } finally {
      if (connection) {
        try {
          await connection.disconnect();
        } catch (disconnectError) {
          logger.debug(
            `[MCP][${serverName}] Failed to disconnect temporary server-instructions connection`,
            {
              name: disconnectError instanceof Error ? disconnectError.name : null,
            },
          );
        }
      }
    }
  }

  /**
   * Format MCP server instructions for injection into context
   * @param serverNames Optional array of server names to include. If not provided, includes all servers.
   * @returns Formatted instructions string ready for context injection
   */
  public async formatInstructionsForContext(serverNames?: string[]): Promise<string> {
    const { text } = await this.formatInstructionsForContextWithMetadata(serverNames);
    return text;
  }

  public async formatInstructionsForContextWithMetadata(
    serverNames?: string[],
  ): Promise<{ text: string; sources: Record<string, string> }> {
    /** Instructions for specified servers or all stored instructions */
    const { instructions: instructionsToInclude, sources } =
      await this.getInstructionsWithSources(serverNames);

    if (Object.keys(instructionsToInclude).length === 0) {
      return { text: '', sources };
    }

    // Format instructions for context injection
    const formattedInstructions = Object.entries(instructionsToInclude)
      .map(([serverName, instructions]) => {
        return `## ${serverName} MCP Server Instructions

${instructions}`;
      })
      .join('\n\n');

    const text = `# MCP Server Instructions

The following MCP servers are available with their specific instructions:

${formattedInstructions}

Please follow these instructions when using tools from the respective MCP servers.`;
    return { text, sources };
  }

  /**
   * Calls a tool on an MCP server, using either a user-specific connection
   * (if userId is provided) or an app-level connection. Updates the last activity timestamp
   * for user-specific connections upon successful call initiation.
   *
   * @param graphTokenResolver - Optional function to resolve Graph API tokens via OBO flow.
   *   When provided and the server config contains `{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}` placeholders,
   *   they will be resolved to actual Graph API tokens before the tool call.
   */
  async callTool({
    user,
    serverName,
    toolName,
    provider,
    toolArguments,
    options,
    tokenMethods,
    requestBody,
    flowManager,
    oauthStart,
    oauthEnd,
    customUserVars,
    graphTokenResolver,
  }: {
    user?: IUser;
    serverName: string;
    toolName: string;
    provider: t.Provider;
    toolArguments?: Record<string, unknown>;
    options?: RequestOptions;
    requestBody?: RequestBody;
    tokenMethods?: TokenMethods;
    customUserVars?: Record<string, string>;
    flowManager: FlowStateManager<MCPOAuthTokens | null>;
    oauthStart?: (authURL: string) => Promise<void>;
    oauthEnd?: () => Promise<void>;
    graphTokenResolver?: GraphTokenResolver;
  }): Promise<t.FormattedToolResponse> {
    /** User-specific connection */
    let connection: MCPConnection | undefined;
    const userId = user?.id;
    const logPrefix = userId ? `[MCP][User: ${userId}][${serverName}]` : `[MCP][${serverName}]`;

    try {
      if (userId && user) this.updateUserLastActivity(userId);

      connection = await this.getConnection({
        serverName,
        user,
        flowManager,
        tokenMethods,
        oauthStart,
        oauthEnd,
        signal: options?.signal,
        customUserVars,
        requestBody,
      });

      if (!(await connection.isConnected())) {
        /** May happen if getUserConnection failed silently or app connection dropped */
        throw new McpError(
          ErrorCode.InternalError, // Use InternalError for connection issues
          `${logPrefix} Connection is not active. Cannot execute tool ${toolName}.`,
        );
      }

      const rawConfig = await MCPServersRegistry.getInstance().getServerConfig(serverName, userId);
      const isDbSourced = !!(rawConfig as t.ParsedServerConfig | null)?.dbId;

      /** Pre-process Graph token placeholders (async) before the synchronous processMCPEnv pass */
      const graphProcessedConfig = isDbSourced
        ? (rawConfig as t.MCPOptions)
        : await preProcessGraphTokens(rawConfig as t.MCPOptions, {
            user,
            graphTokenResolver,
            scopes: process.env.GRAPH_API_SCOPES,
          });
      const currentOptions = processMCPEnv({
        user,
        body: requestBody,
        dbSourced: isDbSourced,
        options: graphProcessedConfig,
        customUserVars,
      });
      if ('headers' in currentOptions) {
        connection.setRequestHeaders(currentOptions.headers || {});
      }

      const result = await connection.client.request(
        {
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: toolArguments,
          },
        },
        CallToolResultSchema,
        {
          timeout: connection.timeout,
          resetTimeoutOnProgress: true,
          ...options,
        },
      );
      if (userId) {
        this.updateUserLastActivity(userId);
      }
      this.checkIdleConnections();
      return formatToolContent(result as t.MCPToolCallResponse, provider);
    } catch (error) {
      // Log with context and re-throw or handle as needed
      logger.error(`${logPrefix}[${toolName}] Tool call failed`, sanitizeMCPManagerErrorForLog(error));
      // Rethrowing allows the caller (createMCPTool) to handle the final user message
      throw error;
    }
  }
}
