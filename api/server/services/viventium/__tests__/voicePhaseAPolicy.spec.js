/* === VIVENTIUM START ===
 * Feature: Voice Phase A async policy resolution
 * Purpose: Verify voice async policy keeps config-defined tool-hold scopes visible and
 * does not invent ownership from agent names or tool labels.
 * Added: 2026-03-24
 * === VIVENTIUM END === */

const {
  getConfiguredToolHoldScopeKeys,
  hasToolHoldCandidateConfigured,
  resolveVoicePhaseAAsyncPolicy,
  resolveVoicePhaseAAsyncPolicyWithHydratedTools,
} = require('../voicePhaseAPolicy');

describe('voicePhaseAPolicy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test('returns config-defined tool hold scope keys and allows override when requested', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = '1';
    process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD = '1';

    const agent = {
      background_cortices: [
        {
          agent_id: 'agent-ms365',
          activation: { intent_scope: 'productivity_ms365' },
        },
        {
          agent_id: 'agent-google',
          name: 'Google Workspace',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
      ],
    };

    expect(getConfiguredToolHoldScopeKeys(agent)).toEqual([
      'productivity_ms365',
      'productivity_google_workspace',
    ]);
    expect(hasToolHoldCandidateConfigured(agent)).toBe(true);

    expect(resolveVoicePhaseAAsyncPolicy({ voiceMode: true, agent })).toMatchObject({
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'tool_hold_override',
      toolHoldScopeKeys: ['productivity_ms365', 'productivity_google_workspace'],
    });
  });

  test('does not invent hold ownership from bare names or ids', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = '1';

    const agent = {
      background_cortices: [
        {
          agent_id: 'online_tool_use',
          name: 'Google',
        },
      ],
    };

    expect(getConfiguredToolHoldScopeKeys(agent)).toEqual([]);
    expect(hasToolHoldCandidateConfigured(agent)).toBe(false);
    expect(resolveVoicePhaseAAsyncPolicy({ voiceMode: true, agent })).toMatchObject({
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'enabled',
      toolHoldScopeKeys: [],
    });
  });

  test('keeps voice Phase A async when direct-action scope is owned by current tools', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD = 'false';

    const agent = {
      tools: [{ name: 'google_calendar_create_event' }],
      background_cortices: [
        {
          agent_id: 'agent-google',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
      ],
    };
    const directActionSurfaces = [
      {
        scope_key: 'productivity_google_workspace',
        tool_names: ['google_calendar_create_event'],
      },
    ];

    expect(
      resolveVoicePhaseAAsyncPolicy({
        voiceMode: true,
        agent,
        directActionSurfaces,
        agentTools: agent.tools,
      }),
    ).toMatchObject({
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'direct_action_owned',
      toolHoldScopeKeys: ['productivity_google_workspace'],
      unownedToolHoldScopeKeys: [],
    });
  });

  test('forces sync Phase A only for unowned direct-action hold scopes', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD = 'false';

    const agent = {
      tools: [],
      background_cortices: [
        {
          agent_id: 'agent-ms365',
          activation: { intent_scope: 'productivity_ms365' },
        },
      ],
    };

    expect(resolveVoicePhaseAAsyncPolicy({ voiceMode: true, agent })).toMatchObject({
      enabled: false,
      requested: true,
      forcedOff: true,
      reason: 'unowned_tool_hold_candidate_configured',
      toolHoldScopeKeys: ['productivity_ms365'],
      unownedToolHoldScopeKeys: ['productivity_ms365'],
    });
  });

  test('rechecks forced-off policy with hydrated canonical tools before forcing sync', async () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD = 'false';

    const agent = {
      tools: [],
      background_cortices: [
        {
          agent_id: 'agent-google',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
      ],
    };
    const directActionSurfaces = [
      {
        scope_key: 'productivity_google_workspace',
        tool_names: ['google_calendar_create_event'],
      },
    ];

    await expect(
      resolveVoicePhaseAAsyncPolicyWithHydratedTools({
        voiceMode: true,
        agent,
        directActionSurfaces,
        agentTools: agent.tools,
        hydrateAgentTools: async () => ({
          ...agent,
          tools: [{ name: 'google_calendar_create_event' }],
        }),
      }),
    ).resolves.toMatchObject({
      enabled: true,
      requested: true,
      forcedOff: false,
      reason: 'direct_action_owned',
      hydratedToolPolicy: true,
      initialReason: 'unowned_tool_hold_candidate_configured',
    });
  });

  test('returns empty scope keys when voice async is off or not in voice mode', () => {
    const agent = {
      background_cortices: [
        {
          activation: { intent_scope: 'productivity_ms365' },
        },
      ],
    };

    expect(resolveVoicePhaseAAsyncPolicy({ voiceMode: false, agent })).toMatchObject({
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'not_voice_mode',
      toolHoldScopeKeys: [],
    });

    expect(resolveVoicePhaseAAsyncPolicy({ voiceMode: true, agent })).toMatchObject({
      enabled: false,
      requested: false,
      forcedOff: false,
      reason: 'async_not_requested',
      toolHoldScopeKeys: [],
    });
  });
});
