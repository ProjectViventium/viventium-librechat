/* === VIVENTIUM START ===
 * Feature: Optional agent-graph resilience regression coverage.
 * Purpose: Prove failed optional agents are removed without corrupting healthy handoff edges.
 * === VIVENTIUM END === */

const { filterOrphanedEdges } = require('@librechat/api');
const {
  appendOmittedCapabilityReadiness,
  evaluateOptionalAgentCapabilityReadiness,
  markOptionalAgentInitializationFailed,
  synchronizeFallbackGraphResilience,
} = require('../agentGraphResilience');

describe('optional agent graph resilience', () => {
  test('removes a handoff edge when its optional target fails initialization', () => {
    const failedAgentIds = new Set();
    const edges = [
      { from: 'main', to: 'connected-accounts' },
      { from: 'main', to: 'healthy-worker' },
    ];

    markOptionalAgentInitializationFailed(failedAgentIds, 'connected-accounts');

    expect(filterOrphanedEdges(edges, failedAgentIds)).toEqual([
      { from: 'main', to: 'healthy-worker' },
    ]);
  });

  test('rejects invalid failure bookkeeping instead of silently keeping a broken graph', () => {
    expect(() => markOptionalAgentInitializationFailed(null, 'connected-accounts')).toThrow(
      'skippedAgentIds must be a Set',
    );
    expect(() => markOptionalAgentInitializationFailed(new Set(), '')).toThrow(
      'agentId is required',
    );
  });

  test('omits a capability-owning handoff when every declared MCP is unavailable', () => {
    const result = evaluateOptionalAgentCapabilityReadiness(
      {
        id: 'connected-accounts',
        tools: ['search_mail_mcp_google_workspace', 'list_mail_mcp_ms-365', 'file_search'],
      },
      {
        mcpCapabilityReadiness: {
          google_workspace: { status: 'missing_auth' },
          'ms-365': {
            status: 'unreadable_credential',
            recovery: {
              action: 'connect_mcp_account',
              surface: 'agent_builder',
              server: 'ms-365',
              instructions:
                'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
            },
          },
        },
      },
    );

    expect(result.keep).toBe(false);
    expect(result.readyServers).toEqual([]);
    expect(result.unavailableServers).toEqual([
      { server: 'google_workspace', status: 'missing_auth' },
      {
        server: 'ms-365',
        status: 'unreadable_credential',
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
        }),
      },
    ]);
  });

  test('keeps a handoff when one declared MCP is ready or readiness is unknown', () => {
    const declared = {
      id: 'connected-accounts',
      tools: ['search_mail_mcp_google_workspace', 'list_mail_mcp_ms-365'],
    };
    expect(
      evaluateOptionalAgentCapabilityReadiness(declared, {
        mcpCapabilityReadiness: {
          google_workspace: { status: 'ready' },
          'ms-365': { status: 'missing_auth' },
        },
      }).keep,
    ).toBe(true);
    expect(evaluateOptionalAgentCapabilityReadiness(declared, {}).keep).toBe(true);
  });

  test.each(['credential_inspection_failed', 'reinitialization_error'])(
    'keeps a handoff when %s is only unknown readiness telemetry',
    (status) => {
      const result = evaluateOptionalAgentCapabilityReadiness(
        {
          id: 'connected-accounts',
          tools: ['search_mail_mcp_google_workspace'],
        },
        {
          mcpCapabilityReadiness: {
            google_workspace: { status },
          },
        },
      );

      expect(result).toEqual({
        keep: true,
        declaredServers: ['google_workspace'],
        readyServers: [],
        unavailableServers: [],
        unknownServers: ['google_workspace'],
      });
    },
  );

  test('gives Main compact structured readiness without naming or prompting a specific fallback', () => {
    const primary = { instructions: 'Base instructions.' };
    appendOmittedCapabilityReadiness(primary, [
      {
        unavailableServers: [
          { server: 'google_workspace', status: 'missing_auth' },
          {
            server: 'ms-365',
            status: 'unreadable_credential',
            recovery: {
              action: 'connect_mcp_account',
              surface: 'agent_builder',
              server: 'ms-365',
              instructions:
                'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
            },
          },
        ],
      },
    ]);
    expect(primary.instructions).toContain('OPTIONAL CAPABILITY READINESS');
    expect(primary.instructions).toContain('google_workspace=missing_auth');
    expect(primary.instructions).toContain('ms-365=unreadable_credential');
    expect(primary.instructions).toContain('each independently satisfiable part');
    expect(primary.instructions).toContain('one unavailable capability does not make another');
    expect(primary.instructions).toContain('depends on current external state');
    expect(primary.instructions).toContain('call an appropriate available tool in this turn');
    expect(primary.instructions).toContain('do not tell the user to call a tool');
    expect(primary.instructions).toContain(
      'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
    );
    expect(primary.instructions).toContain('do not invent or substitute another settings path');
    expect(primary.instructions).toContain('Do not expose raw tool or server identifiers');
    expect(primary.instructions).not.toContain('schedule_list');
    expect(primary.instructions).not.toContain('Connected Accounts');
    expect(primary.instructions).not.toContain('browser fallback');
  });

  test('copies the resolved graph and omitted-capability facts to a lazy model fallback', () => {
    const primary = {
      edges: [{ from: 'main', to: 'healthy-worker' }],
    };
    const fallback = {
      instructions: 'Fallback instructions.',
      edges: [
        { from: 'main', to: 'connected-accounts' },
        { from: 'main', to: 'healthy-worker' },
      ],
    };

    expect(
      synchronizeFallbackGraphResilience(fallback, primary, [
        {
          unavailableServers: [
            { server: 'google_workspace', status: 'missing_auth' },
            {
              server: 'ms-365',
              status: 'unreadable_credential',
              recovery: {
                action: 'connect_mcp_account',
                surface: 'agent_builder',
                server: 'ms-365',
                instructions:
                  'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
              },
            },
          ],
        },
      ]),
    ).toBe(true);

    expect(fallback.edges).toEqual([{ from: 'main', to: 'healthy-worker' }]);
    expect(fallback.edges).not.toBe(primary.edges);
    expect(fallback.instructions).toContain('OPTIONAL CAPABILITY READINESS');
    expect(fallback.instructions).toContain('google_workspace=missing_auth');
    expect(fallback.instructions).toContain('ms-365=unreadable_credential');
    expect(fallback.instructions).toContain('Open Agent Builder');
  });

  test('keeps the resolved handoff on fallback when partial readiness kept it on Main', () => {
    const primary = {
      edges: [{ from: 'main', to: 'connected-accounts' }],
    };
    const fallback = {
      instructions: 'Fallback instructions.',
      edges: [],
    };

    synchronizeFallbackGraphResilience(fallback, primary, []);

    expect(fallback.edges).toEqual([{ from: 'main', to: 'connected-accounts' }]);
    expect(fallback.instructions).toBe('Fallback instructions.');
  });
});
