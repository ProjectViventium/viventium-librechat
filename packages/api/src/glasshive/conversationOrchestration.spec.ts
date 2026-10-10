import {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_LIST_DESCRIPTION,
  DELEGATION_TOOL_NAME,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  mainDelegationJsonSchema,
  canonicalConversationOrchestrationArguments,
  mainDelegationTurnTruth,
  mainOrchestrationInvocationIdentity,
  recordMainDelegationOutcome,
} from './conversationOrchestration';

describe('GlassHive conversation orchestration contract', () => {
  const ordinaryMission = {
    title: 'Synthetic mission',
    instruction: 'Complete the synthetic objective.',
    resourceClass: 'standard',
  };

  it('requires one exact worker memory class and a boolean long-mission declaration', () => {
    expect(MAIN_DELEGATION_JSON_SCHEMA.required).toEqual(['title', 'instruction', 'resourceClass']);
    expect(
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, ordinaryMission),
    ).toEqual(ordinaryMission);
    expect(() =>
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        title: ordinaryMission.title,
        instruction: ordinaryMission.instruction,
      }),
    ).toThrow('resourceClass is required');
    expect(() =>
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinaryMission,
        resourceClass: 'tiny',
      }),
    ).toThrow('resourceClass must be one of: standard, light');
    expect(() =>
      canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinaryMission,
        longMission: 'true',
      }),
    ).toThrow('longMission must be a boolean');
  });

  it('preserves the current action mask and completed-versus-retry semantics', () => {
    expect(ACTIVE_WORK_LIST_DESCRIPTION).toContain('authoritative actions');
    expect(ACTIVE_WORK_ACTION_DESCRIPTION).toContain("the target work item's current actions");
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
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'Completed work is successful and must never be retried',
    );
    expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
      'Message can continue completed work when its actions list allows it',
    );
  });

  it('does not let terminal history satisfy a new simultaneous execution group', () => {
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

  it('canonicalizes operation identity from trusted turn and occurrence scope', () => {
    const input = {
      userId: 'owner-1',
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      toolName: 'active_work_action',
      args: { workRef: 'work-1', action: 'STOP', ignoredOwner: 'attacker' },
      trustedCallIdentity: 'call-1',
    };
    const first = mainOrchestrationInvocationIdentity(input);
    const replay = mainOrchestrationInvocationIdentity(input);
    const sibling = mainOrchestrationInvocationIdentity({
      ...input,
      trustedCallIdentity: 'call-2',
    });

    expect(first).toMatch(/^ghbi_[a-f0-9]{64}$/);
    expect(replay).toBe(first);
    expect(sibling).not.toBe(first);
    expect(mainOrchestrationInvocationIdentity({ ...input, requestBody: {} })).toBe('');
  });

  it('keeps one trusted provider occurrence stable when reconstructed arguments change', () => {
    const input = {
      userId: 'owner-1',
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      toolName: 'active_work_action',
      args: { workRef: 'work-1', action: 'stop' },
      trustedCallIdentity: 'call-1',
    };

    expect(
      mainOrchestrationInvocationIdentity({
        ...input,
        args: { workRef: 'work-1', action: 'STOP', instruction: 'reconstructed' },
      }),
    ).toBe(mainOrchestrationInvocationIdentity(input));
  });

  it('keeps distinct reconstructed arguments distinct without a trusted occurrence', () => {
    const input = {
      userId: 'owner-1',
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      toolName: 'active_work_action',
      trustedCallIdentity: '',
    };

    expect(
      mainOrchestrationInvocationIdentity({
        ...input,
        args: { workRef: 'work-1', action: 'stop' },
      }),
    ).not.toBe(
      mainOrchestrationInvocationIdentity({
        ...input,
        args: { workRef: 'work-2', action: 'stop' },
      }),
    );
  });

  it('records only bounded public launch truth on the owning request', () => {
    const request = {};
    expect(
      recordMainDelegationOutcome(request, 'call-1', {
        status: 'ok',
        workRef: 'work-1',
        privatePayload: 'not retained',
      }),
    ).toBe(true);
    recordMainDelegationOutcome(request, 'call-2', {
      status: 'blocked',
      retryable: true,
      needs_input: true,
    });

    expect(mainDelegationTurnTruth(request)).toEqual({
      attemptedCount: 2,
      confirmedCount: 1,
      unconfirmedCount: 1,
      retryableCount: 1,
      needsInputCount: 1,
    });
    expect(Object.keys(request)).toEqual([]);
  });
});


describe('trusted delegation source schema', () => {
  test.each([undefined, {}, { viventiumTriggeringSourceSegments: [] },
    { viventiumTriggeringSourceSegments: [{ text: 'One source.' }] }])(
    'preserves the legacy schema when selection is not required', (body) => {
      expect(mainDelegationJsonSchema(body)).toBe(MAIN_DELEGATION_JSON_SCHEMA);
    },
  );
  test('requires a nonempty bounded selection without mutating the shared schema', () => {
    const schema = mainDelegationJsonSchema({ viventiumTriggeringSourceSegments: [{}, {}, {}] });
    expect(schema.required).toContain('sourceOrdinals');
    expect(schema.properties.sourceOrdinals).toMatchObject({ minItems: 1, maxItems: 3,
      items: { type: 'integer', minimum: 1, maximum: 3 } });
    expect(MAIN_DELEGATION_JSON_SCHEMA.required).not.toContain('sourceOrdinals');
    expect(MAIN_DELEGATION_JSON_SCHEMA.properties.sourceOrdinals.maxItems).toBe(32);
  });
});


describe('typed existing-work file selection', () => {
  it('retains the exact selected opaque IDs and their order', () => {
    expect(canonicalConversationOrchestrationArguments('active_work_action', {workRef:'work-1',action:'steer',instruction:'Use the selected files',fileIds:['b','a']})).toEqual({workRef:'work-1',action:'steer',instruction:'Use the selected files',fileIds:['b','a']});
    expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.fileIds.items.type).toBe('string');
  });
  it('rejects duplicate references and unsupported action without renaming the action', () => {
    expect(()=>canonicalConversationOrchestrationArguments('active_work_action',{workRef:'work-1',action:'steer',fileIds:['a','a']})).toThrow();
    expect(()=>canonicalConversationOrchestrationArguments('active_work_action',{workRef:'work-1',action:'pause',fileIds:['a']})).toThrow();
  });
  it('changes the existing occurrence identity when file selection changes', () => {
    const base={userId:'owner-1',requestBody:{conversationId:'conversation-1',messageId:'message-1'},toolName:'active_work_action'};
    expect(mainOrchestrationInvocationIdentity({...base,args:{workRef:'work-1',action:'steer',instruction:'Use files',fileIds:['a']}})).not.toBe(mainOrchestrationInvocationIdentity({...base,args:{workRef:'work-1',action:'steer',instruction:'Use files',fileIds:['b']}}));
  });
});

 it('preserves selected identity/order above64 without adding a file-count policy', () => {
   const fileIds=Array.from({length:65},(_,i)=>'selected-file-'+i);
   expect(canonicalConversationOrchestrationArguments('active_work_action',{workRef:'work-1',action:'queue',instruction:'Use these files',fileIds}).fileIds).toEqual(fileIds);
   expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.fileIds).not.toHaveProperty('maxItems');
 });
