/* === VIVENTIUM START ===
 * Purpose: Coverage for MCP OAuth wait policy and OAuth-pending MCP tool stripping.
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');
const {
  hasLikelyToolIntent,
  getRelevantPendingOAuthServers,
  getMcpOAuthWaitDecision,
  stripOAuthPendingMcpTools,
} = require('~/server/services/viventium/mcpOAuthPolicy');

describe('mcpOAuthPolicy', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY;
    delete process.env.VIVENTIUM_TOOL_INTENT_KEYWORDS;
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

  describe('hasLikelyToolIntent', () => {
    test('returns false for non-tool conversational prompt', () => {
      const req = buildReq('what should be my priority based on your memory');
      expect(hasLikelyToolIntent(req)).toBe(false);
    });

    test('returns true for clear tool-intent keyword', () => {
      const req = buildReq('check my calendar tomorrow');
      expect(hasLikelyToolIntent(req)).toBe(true);
    });

    test('returns true when files are attached', () => {
      const req = buildReq('quick look', {}, { files: [{ file_id: 'f1' }] });
      expect(hasLikelyToolIntent(req)).toBe(true);
    });
  });

  describe('getMcpOAuthWaitDecision', () => {
    test('never waits for Telegram surface', () => {
      const req = buildReq('check my calendar tomorrow', { _viventiumTelegram: true });
      const decision = getMcpOAuthWaitDecision(req, new Set(['google_workspace']));
      expect(decision.surface).toBe('telegram');
      expect(decision.waitForOAuth).toBe(false);
    });

    test('never waits for gateway surface', () => {
      const req = buildReq('check my calendar tomorrow', { _viventiumGateway: true });
      const decision = getMcpOAuthWaitDecision(req, new Set(['google_workspace']));
      expect(decision.surface).toBe('gateway');
      expect(decision.waitForOAuth).toBe(false);
    });

    test('intent mode does not wait for built-in file_search style phrasing without provider-relevant MCP intent', () => {
      const noIntent = getMcpOAuthWaitDecision(
        buildReq('what exact marker was it? use file_search and answer only with the marker'),
        new Set(['google_workspace']),
      );
      expect(noIntent.surface).toBe('web');
      expect(noIntent.mode).toBe('intent');
      expect(noIntent.waitForOAuth).toBe(false);
      expect(noIntent.hasToolIntent).toBe(true);
      expect(noIntent.relevantPendingOAuthServers).toEqual([]);
    });

    test('intent mode waits only for pending servers that match provider-specific intent', () => {
      const withIntent = getMcpOAuthWaitDecision(
        buildReq('check my gmail and google calendar'),
        new Set(['google_workspace', 'ms-365']),
      );
      expect(withIntent.waitForOAuth).toBe(true);
      expect(withIntent.relevantPendingOAuthServers).toEqual(['google_workspace']);
    });

    test('intent mode applies to voice surface too', () => {
      const req = buildReq('how are we tracking this week', { viventiumCallSession: { id: 'cs-1' } });
      const decision = getMcpOAuthWaitDecision(req, new Set(['google_workspace']));
      expect(decision.surface).toBe('voice');
      expect(decision.waitForOAuth).toBe(false);
    });

    test('always mode forces wait on web/voice', () => {
      process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = 'always';
      const webDecision = getMcpOAuthWaitDecision(
        buildReq('hi'),
        new Set(['google_workspace', 'ms-365']),
      );
      expect(webDecision.waitForOAuth).toBe(true);
      expect(webDecision.relevantPendingOAuthServers).toEqual(['google_workspace', 'ms-365']);

      const voiceDecision = getMcpOAuthWaitDecision(
        buildReq('hello', { viventiumCallSession: { id: 'cs-2' } }),
        new Set(['google_workspace']),
      );
      expect(voiceDecision.waitForOAuth).toBe(true);
    });

    test('never mode forces non-blocking behavior on web/voice', () => {
      process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = 'never';
      const webDecision = getMcpOAuthWaitDecision(
        buildReq('check my inbox'),
        new Set(['google_workspace']),
      );
      expect(webDecision.waitForOAuth).toBe(false);
      expect(webDecision.relevantPendingOAuthServers).toEqual([]);

      const voiceDecision = getMcpOAuthWaitDecision(
        buildReq('calendar tomorrow', { viventiumCallSession: { id: 'cs-3' } }),
        new Set(['google_workspace']),
      );
      expect(voiceDecision.waitForOAuth).toBe(false);
    });
  });

  describe('getRelevantPendingOAuthServers', () => {
    test('returns only the matching provider when multiple pending servers exist', () => {
      const req = buildReq('check outlook and teams for updates');
      expect(getRelevantPendingOAuthServers(req, new Set(['google_workspace', 'ms-365']))).toEqual([
        'ms-365',
      ]);
    });

    test('returns empty list for generic recall search phrasing', () => {
      const req = buildReq('use file_search to find the exact recall marker from another chat');
      expect(getRelevantPendingOAuthServers(req, new Set(['google_workspace']))).toEqual([]);
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
