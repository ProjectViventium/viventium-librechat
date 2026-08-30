const {
  DELEGATION_TOOL_NAME,
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_LIST_DESCRIPTION,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  canonicalConversationOrchestrationArguments,
} = require('../GlassHiveConversationOrchestration');

describe('GlassHive conversation orchestration Active Work contract', () => {
  test('requires an explicit canonical worker memory class for every new mission', () => {
    const ordinary = {
      title: 'Synthetic mission',
      instruction: 'Complete the synthetic objective.',
    };

    expect(MAIN_DELEGATION_JSON_SCHEMA.required).toEqual(['title', 'instruction', 'resourceClass']);
    expect(MAIN_DELEGATION_JSON_SCHEMA.properties.resourceClass).toEqual({
      type: 'string',
      enum: ['standard', 'light'],
      description: expect.stringContaining('Required worker memory class'),
    });
    expect(
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinary,
        resourceClass: 'light',
      }),
    ).toEqual({ ...ordinary, resourceClass: 'light' });
    expect(() =>
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, ordinary),
    ).toThrow('resourceClass is required');
    for (const malformed of ['', 'LIGHT', 'tiny', 1, null, {}, []]) {
      expect(() =>
        canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
          ...ordinary,
          resourceClass: malformed,
        }),
      ).toThrow('resourceClass must be one of: standard, light');
    }
  });

  test('accepts only an explicit boolean long-mission declaration', () => {
    const ordinary = {
      title: 'Synthetic mission',
      instruction: 'Complete the synthetic objective.',
      resourceClass: 'standard',
    };

    expect(MAIN_DELEGATION_JSON_SCHEMA.properties.longMission).toEqual({ type: 'boolean' });
    expect(
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinary,
        longMission: true,
      }),
    ).toEqual({ ...ordinary, longMission: true });
    expect(
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinary,
        longMission: false,
      }),
    ).toEqual(ordinary);
    expect(canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, ordinary)).toEqual(
      ordinary,
    );
    for (const malformed of ['true', 1, null, {}, []]) {
      expect(() =>
        canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
          ...ordinary,
          longMission: malformed,
        }),
      ).toThrow('longMission must be a boolean');
    }
  });

  test('makes each work item’s current action mask authoritative in the shared tool contracts', () => {
    expect(ACTIVE_WORK_LIST_DESCRIPTION).toContain('authoritative actions');
    expect(ACTIVE_WORK_ACTION_DESCRIPTION).toContain("the target work item's current actions");
    expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.action.description).toContain(
      "the target work item's current actions",
    );
    expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.action.enum).toEqual([
      'queue',
      'message',
      'steer',
      'pause',
      'resume',
      'stop',
      'retry',
      'dismiss',
    ]);
  });

  test('distinguishes completed-work continuation from retryable failed-work recovery', () => {
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'Completed work is successful and must never be retried',
    );
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'Message can continue completed work when its actions list allows it',
    );
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'Retry is only for failed or otherwise retryable terminal work whose actions list includes retry',
    );
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'when retryable failed work needs both recovery and a new instruction',
    );
    expect(ACTIVE_WORK_ACTION_SEMANTICS).not.toContain(
      'when terminal work needs both recovery and a new instruction',
    );
  });

  test('does not reuse terminal history for a newly requested simultaneous execution group', () => {
    expect(MAIN_DELEGATION_DESCRIPTION).toContain(
      'Terminal history cannot satisfy a new simultaneous execution group unless the user explicitly asks to reuse it',
    );
    expect(MAIN_DELEGATION_DESCRIPTION).toContain(
      "Preserve the current turn's requested mission count",
    );
    expect(MAIN_DELEGATION_DESCRIPTION).toContain(
      'Never present an old artifact as a current delivery',
    );
  });
});
