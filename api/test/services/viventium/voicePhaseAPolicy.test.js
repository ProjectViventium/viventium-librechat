/* eslint-disable max-lines */

const {
  resolveVoicePhaseAAsyncPolicy,
  hasToolHoldCandidateConfigured,
} = require('~/server/services/viventium/voicePhaseAPolicy');

const ORIGINAL_ENV = { ...process.env };

describe('voicePhaseAPolicy', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC;
    delete process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD;
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_AGENT_IDS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test('disables async outside voice mode', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    const policy = resolveVoicePhaseAAsyncPolicy({
      voiceMode: false,
      agent: { background_cortices: [{ agent_id: 'online_tool_use' }] },
    });
    expect(policy).toEqual(
      expect.objectContaining({
        enabled: false,
        forcedOff: false,
        reason: 'not_voice_mode',
      }),
    );
  });

  test('disables async when not requested by env', () => {
    const policy = resolveVoicePhaseAAsyncPolicy({
      voiceMode: true,
      agent: { background_cortices: [{ agent_id: 'online_tool_use' }] },
    });
    expect(policy).toEqual(
      expect.objectContaining({
        enabled: false,
        requested: false,
        reason: 'async_not_requested',
      }),
    );
  });

  test('forces sync when async requested and tool-hold candidate is configured', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = '1';
    const policy = resolveVoicePhaseAAsyncPolicy({
      voiceMode: true,
      agent: {
        background_cortices: [
          {
            agent_id: 'agent_viventium_online_tool_use_95aeb3',
            activation: { intent_scope: 'productivity_ms365' },
          },
        ],
      },
    });
    expect(policy).toEqual(
      expect.objectContaining({
        enabled: false,
        requested: true,
        forcedOff: true,
        reason: 'tool_hold_candidate_configured',
      }),
    );
  });

  test('allows async override when tool-hold candidate configured', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    process.env.VIVENTIUM_VOICE_PHASE_A_ASYNC_ALLOW_TOOL_HOLD = 'true';
    const policy = resolveVoicePhaseAAsyncPolicy({
      voiceMode: true,
      agent: {
        background_cortices: [
          {
            agent_id: 'online_tool_use',
            activation: { intent_scope: 'productivity_ms365' },
          },
        ],
      },
    });
    expect(policy).toEqual(
      expect.objectContaining({
        enabled: true,
        requested: true,
        forcedOff: false,
        reason: 'tool_hold_override',
      }),
    );
  });

  test('enables async when requested and no tool-hold candidate is configured', () => {
    process.env.VIVENTIUM_VOICE_BACKGROUND_AGENT_DETECTION_ASYNC = 'true';
    const policy = resolveVoicePhaseAAsyncPolicy({
      voiceMode: true,
      agent: { background_cortices: [{ agent_id: 'memory_cortex' }] },
    });
    expect(policy).toEqual(
      expect.objectContaining({
        enabled: true,
        requested: true,
        forcedOff: false,
        reason: 'enabled',
      }),
    );
  });

  test('hasToolHoldCandidateConfigured ignores bare ids without config-defined scope', () => {
    const agent = {
      background_cortices: [{ agent_id: 'something_foo_tool_v2' }, { agent_id: 'memory_cortex' }],
    };
    expect(hasToolHoldCandidateConfigured(agent)).toBe(false);
  });

  test('hasToolHoldCandidateConfigured uses activation intent scope without hardcoded names', () => {
    const agent = {
      background_cortices: [
        {
          agent_id: 'agent-random-productivity-shape',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
      ],
    };
    expect(hasToolHoldCandidateConfigured(agent)).toBe(true);
  });

  test('hasToolHoldCandidateConfigured stays off for bare names without scope or env override', () => {
    const agent = {
      background_cortices: [
        {
          agent_id: 'online_tool_use',
          name: 'Google',
        },
      ],
    };
    expect(hasToolHoldCandidateConfigured(agent)).toBe(false);
  });
});
