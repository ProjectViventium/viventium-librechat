/* === VIVENTIUM START ===
 * Tests: Tool Cortex Brewing Hold
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const {
  collectConfiguredHoldScopeKeys,
  pickHoldText,
  shouldDeferMainResponse,
} = require('../brewingHold');

describe('brewingHold', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore env deterministically (avoid cross-test contamination).
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  test('shouldDeferMainResponse defaults to true for config-driven productivity scope', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ agentId: 'agent_viventium_online_tool_use_95aeb3', activationScope: 'productivity_ms365' }],
      }),
    ).toBe(true);
  });

  test('shouldDeferMainResponse defaults to true for Google productivity scope', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ cortexName: 'Google', activationScope: 'productivity_google_workspace' }],
      }),
    ).toBe(true);
  });

  test('collectConfiguredHoldScopeKeys preserves config-defined scope keys only', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      collectConfiguredHoldScopeKeys([
        {
          agent_id: 'agent-a',
          activation: { intent_scope: 'productivity_ms365' },
        },
        {
          agent_id: 'agent-b',
          name: 'Google',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
        {
          agent_id: 'agent-c',
          name: 'Google duplicate',
          activation: { intent_scope: 'productivity_google_workspace' },
        },
        {
          agent_id: 'agent-d',
          name: 'Bare name only',
        },
      ]),
    ).toEqual(['productivity_ms365', 'productivity_google_workspace']);
  });

  test('shouldDeferMainResponse does not infer default hold ownership from bare names or ids', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ agentId: 'online_tool_use', cortexName: 'Google' }],
      }),
    ).toBe(false);
  });

  test('shouldDeferMainResponse suppresses stale productivity holds for non-tool turns', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ cortexName: 'Google', activationScope: 'productivity_google_workspace' }],
        latestUserText: 'Please reply with exactly DIRECT_OK and nothing else.',
      }),
    ).toBe(false);
  });

  test('shouldDeferMainResponse still allows explicit live-data requests', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED;

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ cortexName: 'Google', activationScope: 'productivity_google_workspace' }],
        latestUserText: 'Check my Gmail inbox and summarize anything urgent.',
      }),
    ).toBe(true);
  });

  test('shouldDeferMainResponse can be disabled via env', () => {
    process.env.VIVENTIUM_TOOL_CORTEX_HOLD_ENABLED = '0';

    expect(
      shouldDeferMainResponse({
        activatedCortices: [{ agentId: 'online_tool_use', activationScope: 'productivity_ms365' }],
      }),
    ).toBe(false);
  });

  test('pickHoldText returns deterministic text for a given message id', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT;
    process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON = JSON.stringify([
      'A',
      'B',
      'C',
    ]);

    const first = pickHoldText({ responseMessageId: 'msg_123' });
    const second = pickHoldText({ responseMessageId: 'msg_123' });
    expect(first).toBe(second);
    expect(['A', 'B', 'C']).toContain(first);
  });

  test('pickHoldText supports fixed override', () => {
    process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT = 'Custom hold';
    expect(pickHoldText({ responseMessageId: 'whatever' })).toBe('Custom hold');
  });

  test('pickHoldText falls back to main-agent holding examples (prompt-owned)', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT;
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON;

    const agentInstructions = `
      # Live Data (Email / Calendar / Files)
      Holding examples (rotate, don't repeat):
      - "One sec."
      - "Hang on."
      - "Checking now."
      - "Give me a moment."
    `;

    const text = pickHoldText({
      responseMessageId: 'msg_123',
      agentInstructions,
    });
    expect(['One sec.', 'Hang on.', 'Checking now.', 'Give me a moment.']).toContain(text);
  });

  /* === VIVENTIUM NOTE ===
   * Feature: Silent hold for scheduler-triggered runs.
   * When scheduleId is present, pickHoldText returns {NTA} so the existing
   * NTA suppression pipeline silences the hold message.
   * === VIVENTIUM NOTE === */
  test('pickHoldText returns {NTA} when scheduleId is present', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT;
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON;

    const text = pickHoldText({
      responseMessageId: 'msg_123',
      scheduleId: 'sched-abc-123',
    });
    expect(text).toBe('{NTA}');
  });

  test('pickHoldText returns {NTA} for scheduler runs even when env/instructions are configured', () => {
    process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON = JSON.stringify([
      'One sec.',
      'Checking now.',
    ]);

    const text = pickHoldText({
      responseMessageId: 'msg_456',
      agentInstructions: 'Holding examples:\n- "Hang on."',
      scheduleId: 'sched-xyz-789',
    });
    expect(text).toBe('{NTA}');
  });

  test('pickHoldText returns normal hold text when scheduleId is absent', () => {
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXT;
    delete process.env.VIVENTIUM_TOOL_CORTEX_HOLD_TEXTS_JSON;

    const text = pickHoldText({
      responseMessageId: 'msg_123',
    });
    // Without env or instructions, falls back to default
    expect(text).toBe('Checking now.');
  });
});
