import Ajv from 'ajv';
import { readActiveWork } from './activeWorkTools';
import {
  ACTIVE_WORK_ACTION_DESCRIPTION,
  ACTIVE_WORK_ACTION_JSON_SCHEMA,
  ACTIVE_WORK_ACTION_SEMANTICS,
  ACTIVE_WORK_LIST_DESCRIPTION,
  ACTIVE_WORK_LIST_JSON_SCHEMA,
  DELEGATION_TOOL_NAME,
  MAIN_DELEGATION_DESCRIPTION,
  MAIN_DELEGATION_JSON_SCHEMA,
  mainDelegationJsonSchema,
  canonicalConversationOrchestrationArguments,
  mainDelegationTurnTruth,
  mainOrchestrationInvocationIdentity,
  recordMainDelegationOutcome,
} from './conversationOrchestration';

test('native Queen canonical action preserves exact clarification keys, including reserved own keys', () => {
  const nativeInput = JSON.parse('{"version":1,"requestId":"question-1","requestFingerprint":"'+ 'a'.repeat(64) +'","action":"accept","content":{"answers":{"__proto__":["Blue"],"constructor":["Other"]}}}');
  const action = {workRef:'work-1', action:'resume', nativeInput};
  expect(canonicalConversationOrchestrationArguments('active_work_action', action)).toEqual(action);
  expect(Object.hasOwn((canonicalConversationOrchestrationArguments('active_work_action', action).nativeInput as typeof nativeInput).content.answers, '__proto__')).toBe(true);
  expect(() => canonicalConversationOrchestrationArguments('active_work_action', {...action, action:'steer'})).toThrow();
  expect(() => canonicalConversationOrchestrationArguments('active_work_action', {...action, instruction:'Also change direction'})).toThrow();
  expect(canonicalConversationOrchestrationArguments('active_work_action', {...action,nativeInput:{...nativeInput,content:{optionId:'native-choice'}}})).toMatchObject({nativeInput:{content:{optionId:'native-choice'}}});
  expect(() => canonicalConversationOrchestrationArguments('active_work_action', {...action,nativeHumanInput:{receivedAt:1}})).toThrow();
});


test('native action schema advertises the exact Resume constraint enforced by its owner', () => {
  const validate = new Ajv().compile(ACTIVE_WORK_ACTION_JSON_SCHEMA);
  const nativeInput = { version: 1, requestId: 'question-1', requestFingerprint: 'a'.repeat(64),
    action: 'accept', content: { answers: { 'Choose a shape?': ['Blue circle'] } } };
  const action = { workRef: 'work-1', action: 'resume', nativeInput };
  expect(validate(action)).toBe(true);
  expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.nativeInput.description).toContain(
    'the current pendingNativeInput context capsule or active_work_list',
  );
  expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain('For ordinary work controls');
  expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
    'use action resume with its exact nativeInput, even when resume is absent from ordinary actions',
  );
  expect(ACTIVE_WORK_ACTION_SEMANTICS).toContain(
    'The native input owner revalidates the current request and explicit owner answer',
  );
  expect(ACTIVE_WORK_ACTION_JSON_SCHEMA).not.toHaveProperty('allOf');
  expect(() => canonicalConversationOrchestrationArguments('active_work_action',
    { ...action, action: 'steer' })).toThrow('nativeInput requires action resume without instruction.');
  expect(validate({ workRef: 'work-1', action: 'steer', instruction: 'Use the revised goal' })).toBe(true);
  try {
    canonicalConversationOrchestrationArguments('active_work_action', {
      ...action, instruction: 'private-marker@example.test',
    });
    throw new Error('Expected argument rejection');
  } catch (error) {
    expect(error).toMatchObject({ code: 'native_input_arguments_conflict',
      message: 'nativeInput requires action resume without instruction.' });
    expect(String(error)).not.toContain('private-marker');
  }
});

test('native roster uses a plain provider schema and retains owner-side identity and pagination validation', async () => {
  const validate = new Ajv().compile(ACTIVE_WORK_LIST_JSON_SCHEMA);
  expect(ACTIVE_WORK_LIST_JSON_SCHEMA).not.toHaveProperty('allOf');
  expect(ACTIVE_WORK_LIST_JSON_SCHEMA.properties.scope.description).toContain(
    'Result requires an exact runId or workRef and no cursor or limit',
  );
  const deps = { getActiveWorkPage: jest.fn(), getActiveWorkHistoryPage: jest.fn(),
    getGlassHiveWorkResult: jest.fn() };
  for (const input of [{}, { scope: 'active', limit: 5 }, { scope: 'history', cursor: 'next' },
    { scope: 'result', workRef: 'work-1' }, { scope: 'result', runId: 'run-1' }]) {
    expect(validate(input)).toBe(true);
  }
  for (const input of [{ scope: 'active', workRef: 'work-1' }, { runId: 'run-1' },
    { scope: 'history', runId: 'run-1' }, { scope: 'result' },
    { scope: 'result', workRef: 'work-1', limit: 5 },
    { scope: 'result', runId: 'run-1', cursor: 'next' }]) {
    await expect(readActiveWork('owner-1', input, deps)).rejects.toThrow();
  }
});

describe('GlassHive conversation orchestration contract', () => {
  const ordinaryMission = {
    title: 'Synthetic mission',
    instruction: 'Complete the synthetic objective.',
    resourceClass: 'standard',
  };

  test.each(['direct-openai', 'direct-anthropic', 'direct-xai'])(
    'advertises the registered Direct worker profile %s without allowing arbitrary profiles',
    (profile) => {
      const validate = new Ajv().compile(MAIN_DELEGATION_JSON_SCHEMA);
      const args = { ...ordinaryMission, profile, effort: 'low' };
      expect(validate(args)).toBe(true);
      expect(canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, args)).toEqual(args);
      expect(validate({ ...args, profile: 'unregistered-runtime' })).toBe(false);
    },
  );

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
      'Message can continue terminal work when its actions list allows it',
    );
  });

  it('preserves exact file selection in launch arguments and rejects ambiguous selectors', () => {
    const fileIds = ['11111111-1111-4111-8111-111111111111'];
    expect(canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
      ...ordinaryMission, fileIds,
    })).toEqual({ ...ordinaryMission, fileIds });
    expect(canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
      ...ordinaryMission, fileIds: [],
    }).fileIds).toEqual([]);
    for (const invalid of [[''], [' spaced'], ['duplicate', 'duplicate'], [42],
      ['x'.repeat(257)], Array.from({ length: 65 }, (_, i) => String(i))]) {
      expect(() => canonicalConversationOrchestrationArguments(DELEGATION_TOOL_NAME, {
        ...ordinaryMission, fileIds: invalid,
      })).toThrow('fileIds require exact unique file references');
    }
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
  it.each(['message', 'queue', 'steer', 'pause'])(
    'canonicalizes empty optional fileIds as no added files for %s',
    (action) => {
      const input = { workRef: 'work-1', action, instruction: 'Continue the exact objective' };
      expect(canonicalConversationOrchestrationArguments('active_work_action', {
        ...input, fileIds: [],
      })).toEqual(canonicalConversationOrchestrationArguments('active_work_action', input));
      const identity = {
        userId: 'owner-1',
        requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
        toolName: 'active_work_action',
      };
      expect(mainOrchestrationInvocationIdentity({ ...identity, args: { ...input, fileIds: [] } }))
        .toBe(mainOrchestrationInvocationIdentity({ ...identity, args: input }));
      expect(ACTIVE_WORK_ACTION_JSON_SCHEMA.properties.fileIds.minItems).toBe(0);
    },
  );
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


describe('advertised historical file choices', () => {
  it('requires only the existing field, enumerates exact choices and permits none', () => {
    const schema = mainDelegationJsonSchema({}, [{ file_id: 'native_' + 'a'.repeat(64) },
      { file_id: '11111111-1111-4111-8111-111111111111', filename: 'original.csv' }]);
    expect(schema.required).toContain('fileIds');
    expect(schema.required).not.toContain('sourceOrdinals');
    expect(schema.properties.fileIds).toMatchObject({ minItems: 0, maxItems: 64,
      items: { type: 'string', enum: ['native_' + 'a'.repeat(64),
        '11111111-1111-4111-8111-111111111111'] } });
    expect(MAIN_DELEGATION_JSON_SCHEMA.required).not.toContain('fileIds');
  });
  it('retains simultaneous source selection and file selection independently', () => {
    const schema = mainDelegationJsonSchema({ viventiumTriggeringSourceSegments: [{}, {}] },
      [{ file_id: 'history-file' }]);
    expect(schema.required).toEqual(expect.arrayContaining(['sourceOrdinals', 'fileIds']));
  });
});
