/* === VIVENTIUM START ===
 * Purpose: Coverage for MCP OAuth wait policy and OAuth-pending MCP tool stripping.
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');
const {
  hasNonPendingSpecializedTools,
  getRelevantPendingOAuthServers,
  getMcpOAuthWaitDecision,
  stripOAuthPendingMcpTools,
} = require('~/server/services/viventium/mcpOAuthPolicy');

describe('mcpOAuthPolicy', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  const buildReq = (text, flags = {}, extraBody = {}) => ({
    ...flags,
    body: {
      text,
      ...extraBody,
    },
  });

  const buildToolSurface = (toolNames) => ({
    toolDefinitions: toolNames.map((name) => ({ name })),
    toolRegistry: new Map(toolNames.map((name) => [name, { name }])),
  });

  describe('hasNonPendingSpecializedTools', () => {
    test('returns false when only generic built-ins remain outside pending OAuth tools', () => {
      const d = Constants.mcp_delimiter;
      expect(
        hasNonPendingSpecializedTools({
          ...buildToolSurface([`read_inbox${d}google_workspace`, 'file_search', 'web_search']),
          pendingOAuthServers: new Set(['google_workspace']),
        }),
      ).toBe(false);
    });

    test('returns true when another specialized tool remains available', () => {
      const d = Constants.mcp_delimiter;
      expect(
        hasNonPendingSpecializedTools({
          ...buildToolSurface([`read_inbox${d}google_workspace`, `schedule_list${d}scheduling-cortex`]),
          pendingOAuthServers: new Set(['google_workspace']),
        }),
      ).toBe(true);
    });
  });

  describe('getMcpOAuthWaitDecision', () => {
    test('never waits for Telegram surface', () => {
      const req = buildReq('check my calendar tomorrow', { _viventiumTelegram: true });
      const decision = getMcpOAuthWaitDecision(
        req,
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`]),
      );
      expect(decision.surface).toBe('telegram');
      expect(decision.waitForOAuth).toBe(false);
    });

    test('never waits for gateway surface', () => {
      const req = buildReq('check my calendar tomorrow', { _viventiumGateway: true });
      const decision = getMcpOAuthWaitDecision(
        req,
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`]),
      );
      expect(decision.surface).toBe('gateway');
      expect(decision.waitForOAuth).toBe(false);
    });

    test('intent mode does not wait when non-pending specialized tools remain', () => {
      const decision = getMcpOAuthWaitDecision(
        buildReq('what exact marker was it?'),
        new Set(['google_workspace']),
        buildToolSurface([
          `read_inbox${Constants.mcp_delimiter}google_workspace`,
          `schedule_list${Constants.mcp_delimiter}scheduling-cortex`,
        ]),
      );
      expect(decision.surface).toBe('web');
      expect(decision.mode).toBe('intent');
      expect(decision.waitForOAuth).toBe(false);
      expect(decision.hasSpecializedAlternatives).toBe(true);
      expect(decision.relevantPendingOAuthServers).toEqual(['google_workspace']);
    });

    test('intent mode waits when one pending OAuth server owns the specialist tool surface', () => {
      const decision = getMcpOAuthWaitDecision(
        buildReq('check my inbox'),
        new Set(['google_workspace']),
        buildToolSurface([
          `read_inbox${Constants.mcp_delimiter}google_workspace`,
          'file_search',
          'web_search',
        ]),
      );
      expect(decision.waitForOAuth).toBe(true);
      expect(decision.hasSpecializedAlternatives).toBe(false);
      expect(decision.relevantPendingOAuthServers).toEqual(['google_workspace']);
    });

    test('intent mode does not wait when multiple pending OAuth servers are ambiguous', () => {
      const decision = getMcpOAuthWaitDecision(
        buildReq('hello'),
        new Set(['google_workspace', 'ms-365']),
        buildToolSurface([
          `read_inbox${Constants.mcp_delimiter}google_workspace`,
          `read_mail${Constants.mcp_delimiter}ms-365`,
          'web_search',
        ]),
      );
      expect(decision.waitForOAuth).toBe(false);
      expect(decision.relevantPendingOAuthServers).toEqual(['google_workspace', 'ms-365']);
    });

    test('intent mode applies to voice surface too', () => {
      const req = buildReq('how are we tracking this week', { viventiumCallSession: { id: 'cs-1' } });
      const decision = getMcpOAuthWaitDecision(
        req,
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`, 'web_search']),
      );
      expect(decision.surface).toBe('voice');
      expect(decision.waitForOAuth).toBe(true);
    });

    test('always mode forces wait on web/voice', () => {
      process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = 'always';
      const webDecision = getMcpOAuthWaitDecision(
        buildReq('hi'),
        new Set(['google_workspace', 'ms-365']),
        buildToolSurface([
          `read_inbox${Constants.mcp_delimiter}google_workspace`,
          `read_mail${Constants.mcp_delimiter}ms-365`,
        ]),
      );
      expect(webDecision.waitForOAuth).toBe(true);
      expect(webDecision.relevantPendingOAuthServers).toEqual(['google_workspace', 'ms-365']);

      const voiceDecision = getMcpOAuthWaitDecision(
        buildReq('hello', { viventiumCallSession: { id: 'cs-2' } }),
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`]),
      );
      expect(voiceDecision.waitForOAuth).toBe(true);
    });

    test('never mode forces non-blocking behavior on web/voice', () => {
      process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = 'never';
      const webDecision = getMcpOAuthWaitDecision(
        buildReq('check my inbox'),
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`]),
      );
      expect(webDecision.waitForOAuth).toBe(false);
      expect(webDecision.relevantPendingOAuthServers).toEqual([]);

      const voiceDecision = getMcpOAuthWaitDecision(
        buildReq('calendar tomorrow', { viventiumCallSession: { id: 'cs-3' } }),
        new Set(['google_workspace']),
        buildToolSurface([`read_inbox${Constants.mcp_delimiter}google_workspace`]),
      );
      expect(voiceDecision.waitForOAuth).toBe(false);
    });
  });

  describe('getRelevantPendingOAuthServers', () => {
    test('returns only servers that currently own loaded OAuth-pending tools', () => {
      const d = Constants.mcp_delimiter;
      expect(
        getRelevantPendingOAuthServers({
          ...buildToolSurface([`read_mail${d}ms-365`, 'file_search']),
          pendingOAuthServers: new Set(['google_workspace', 'ms-365']),
        }),
      ).toEqual(['ms-365']);
    });

    test('returns empty list when no pending-server tools are loaded', () => {
      expect(
        getRelevantPendingOAuthServers({
          ...buildToolSurface(['file_search']),
          pendingOAuthServers: new Set(['google_workspace']),
        }),
      ).toEqual([]);
    });
  });

  describe('stripOAuthPendingMcpTools', () => {
    test('removes only tools from OAuth-pending MCP servers', () => {
      const d = Constants.mcp_delimiter;
      const toolDefinitions = [
        { name: `read_inbox${d}google_workspace` },
        { name: `schedule_list${d}scheduling-cortex` },
        { name: 'file_search' },
      ];
      const toolRegistry = new Map([
        [`read_inbox${d}google_workspace`, { name: `read_inbox${d}google_workspace` }],
        [`schedule_list${d}scheduling-cortex`, { name: `schedule_list${d}scheduling-cortex` }],
        ['file_search', { name: 'file_search' }],
      ]);

      const result = stripOAuthPendingMcpTools({
        toolDefinitions,
        toolRegistry,
        pendingOAuthServers: new Set(['google_workspace']),
      });

      expect(result.removedToolNames).toEqual([`read_inbox${d}google_workspace`]);
      expect(result.toolDefinitions.map((t) => t.name)).toEqual([
        `schedule_list${d}scheduling-cortex`,
        'file_search',
      ]);
      expect(Array.from(result.toolRegistry.keys())).toEqual([
        `schedule_list${d}scheduling-cortex`,
        'file_search',
      ]);
    });

    test('returns unchanged data when no pending OAuth servers', () => {
      const toolDefinitions = [{ name: 'file_search' }];
      const toolRegistry = new Map([['file_search', { name: 'file_search' }]]);

      const result = stripOAuthPendingMcpTools({
        toolDefinitions,
        toolRegistry,
        pendingOAuthServers: new Set(),
      });

      expect(result.removedToolNames).toEqual([]);
      expect(result.toolDefinitions).toEqual(toolDefinitions);
      expect(Array.from(result.toolRegistry.keys())).toEqual(['file_search']);
    });
  });
});
