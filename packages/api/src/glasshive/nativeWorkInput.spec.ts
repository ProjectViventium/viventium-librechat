/* === VIVENTIUM START === Exact native mission identity and owner-choice courier regression. === VIVENTIUM END === */
import crypto from 'node:crypto';
import {
  createNativeMissionVoiceInput,
  createNativeMissionVoiceAcknowledgement,
  nativeWorkInputBinding,
  nativeWorkInputMessagePresentation,
  nativeWorkInputMessagePresentationMatches,
  nativeWorkInputResponseSchema,
  nativeMissionVoiceBinding,
  retainedVoiceInputOperation,
  nativeWorkInputPresentation,
  nativeWorkInputQuestionMatches,
  nativeWorkInputQuestionText,
  nativeQuestionForm,
  nativeQuestionFormFromSchema,
  nativeQuestionContent,
} from './nativeWorkInput';

const pending = {
  version: 1 as const,
  requestId: 'permission-1',
  requestFingerprint: 'a'.repeat(64),
  runId: 'run-1',
  attemptId: 'attempt-1',
  sessionId: 'session-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  kind: 'permission',
  state: 'pending',
  mode: 'form',
  runtimeName: 'Native runtime',
  message: 'Permit this operation?',
  requestedSchema: {
    type: 'object',
    required: ['optionId'],
    properties: {
      optionId: {
        type: 'string',
        enum: ['allow_once', 'reject_once'],
        enumNames: ['Allow once', 'Reject once'],
      },
    },
  },
};
const task = {
  taskId: 'task-1',
  userId: 'owner-1',
  callSessionId: 'call-1',
  owner: { kind: 'glasshive_run', id: 'run-1' },
};
const authority = {
  callSessionId: 'call-1',
  binding: {
    version: 1 as const,
    callSessionId: 'call-1',
    userId: 'owner-1',
    kind: 'audio' as const,
    fingerprint: 'b'.repeat(64),
    turnIds: ['turn-1'],
  },
};
function setup(
  result: object = { status: 'accepted', confirmationPending: false },
  input: object = pending,
  binding: object = pending,
) {
  const executeWorkAction = jest.fn(async () => result);
  return {
    executeWorkAction,
    courier: createNativeMissionVoiceInput({
      pendingInput: input,
      pendingBinding: binding,
      workRef: 'work-1',
      task,
      executeWorkAction,
    }),
  };
}
it('retains only bounded exact identity, not prompt, raw arguments or options', () => {
  expect(nativeWorkInputBinding({ ...pending, secret: 'private-tool-argument' }, 'run-1')).toEqual({
    version: 1,
    requestId: pending.requestId,
    requestFingerprint: pending.requestFingerprint,
    runId: pending.runId,
    attemptId: pending.attemptId,
    sessionId: pending.sessionId,
    expiresAt: pending.expiresAt,
  });
});
it.each([
  { runId: 'other-run' },
  { attemptId: '' },
  { sessionId: '' },
  { requestFingerprint: 'invalid' },
  { expiresAt: 'not-an-iso-date' },
  { version: 2 },
])('rejects invalid callback identity %#', (change) => {
  expect(nativeWorkInputBinding({ ...pending, ...change }, 'run-1')).toBeNull();
});
it.each([
  'requestId',
  'requestFingerprint',
  'runId',
  'attemptId',
  'sessionId',
  'expiresAt',
] as const)('requires the refreshed question to match bound %s', (key) => {
  let value = 'replacement';
  if (key === 'expiresAt') value = '2099-02-01T00:00:00.000Z';
  if (key === 'requestFingerprint') value = 'c'.repeat(64);
  expect(setup({}, pending, { ...pending, [key]: value }).courier).toBeNull();
});
it.each([
  { state: 'resolved' },
  { kind: 'elicitation' },
  { mode: 'url' },
  { expiresAt: '2000-01-01T00:00:00.000Z' },
  {
    requestedSchema: {
      ...pending.requestedSchema,
      properties: {
        optionId: { type: 'string', enum: ['same', 'same'], enumNames: ['One', 'Two'] },
      },
    },
  },
])('does not install stale or unsupported mission input %#', (change) => {
  expect(setup({}, { ...pending, ...change }).courier).toBeNull();
});
it('forwards the offered reject choice and exact current owner authority through the existing action', async () => {
  const { courier, executeWorkAction } = setup();
  expect(courier?.choices).toEqual([
    { value: 'allow_once', label: 'Allow once' },
    { value: 'reject_once', label: 'Reject once' },
  ]);
  await expect(
    courier?.provideInput({
      input: 'reject_once',
      operationId: 'op-1',
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).resolves.toEqual({ accepted: true, phase: 'running' });
  expect(executeWorkAction).toHaveBeenCalledWith({
    ownerId: 'owner-1',
    workRef: 'work-1',
    action: 'resume',
    operationId: 'op-1',
    sourceSurface: 'voice',
    ownerInputControl: true,
    nativeInput: {
      version: 1,
      requestId: pending.requestId,
      requestFingerprint: pending.requestFingerprint,
      action: 'accept',
      content: { optionId: 'reject_once' },
    },
    voiceAuthorityContext: authority,
  });
});
it('keeps pending ACK pending and uses the identical operation/body for acknowledgement retry', async () => {
  const { courier, executeWorkAction } = setup({ status: 'pending', confirmationPending: true });
  const choice = {
    input: 'allow_once',
    operationId: 'op-1',
    owner: task.owner,
    voiceAuthorityContext: authority,
  };
  await expect(courier?.provideInput(choice)).resolves.toEqual({
    accepted: false,
    confirmationPending: true,
  });
  executeWorkAction.mockResolvedValueOnce({
    status: 'already_accepted',
    confirmationPending: false,
  });
  await expect(courier?.provideInput(choice)).resolves.toEqual({
    accepted: true,
    phase: 'running',
  });
  expect(executeWorkAction.mock.calls[1]).toEqual(executeWorkAction.mock.calls[0]);
});
it.each([
  { input: 'invented-option' },
  { owner: { kind: 'glasshive_run', id: 'other-run' } },
  { voiceAuthorityContext: undefined },
  { voiceAuthorityContext: { ...authority, callSessionId: 'other-call' } },
  {
    voiceAuthorityContext: {
      ...authority,
      binding: { ...authority.binding, userId: 'foreign-owner' },
    },
  },
])('rejects unowned or unoffered input before dispatch %#', async (change) => {
  const { courier, executeWorkAction } = setup();
  await expect(
    courier?.provideInput({
      input: 'allow_once',
      operationId: 'op-1',
      owner: task.owner,
      voiceAuthorityContext: authority,
      ...change,
    }),
  ).rejects.toThrow('native_input_owner_control_required');
  expect(executeWorkAction).not.toHaveBeenCalled();
});
it.each([
  { status: 'pending', confirmationPending: false },
  { status: 'queued' },
  { status: 'accepted', confirmationPending: true },
])('does not infer native ACK from HTTP acceptance %#', async (result) => {
  const { courier } = setup(result);
  await expect(
    courier?.provideInput({
      input: 'allow_once',
      operationId: 'op-1',
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).rejects.toThrow('native_input_not_acknowledged');
});
it('rejects caller-injected response authority and keeps typed primitive values', () => {
  const response = {
    version: 1,
    requestId: 'input-1',
    requestFingerprint: 'a'.repeat(64),
    action: 'accept',
    content: { consent: false, count: 0, optionId: 'reject_once' },
  };
  expect(nativeWorkInputResponseSchema.safeParse(response).success).toBe(true);
  expect(
    nativeWorkInputResponseSchema.safeParse({ ...response, ownerInputControl: true }).success,
  ).toBe(false);
  expect(
    nativeWorkInputResponseSchema.safeParse({ ...response, content: { count: Infinity } }).success,
  ).toBe(false);
});

it('retains only scalar retry identity and exact task owner binding', () => {
  const binding = {
    ...pending,
    taskId: task.taskId,
    workRef: 'work-1',
    userId: task.userId,
    callSessionId: task.callSessionId,
    choice: 'private',
  };
  expect(nativeMissionVoiceBinding(binding, task)).toEqual({
    ...nativeWorkInputBinding(pending, 'run-1'),
    taskId: task.taskId,
    workRef: 'work-1',
    userId: task.userId,
    callSessionId: task.callSessionId,
  });
  expect(nativeMissionVoiceBinding(binding, { ...task, owner: undefined })).toBeNull();
  expect(nativeMissionVoiceBinding(binding, { ...task, userId: 'foreign' })).toBeNull();
  expect(nativeMissionVoiceBinding(binding, { ...task, callSessionId: 'foreign' })).toBeNull();
  expect(
    nativeMissionVoiceBinding(binding, {
      ...task,
      owner: { kind: 'glasshive_run', id: 'foreign' },
    }),
  ).toBeNull();
  const operation = {
    hash: 'c'.repeat(64),
    operationId: '11111111-1111-4111-8111-111111111111',
    input: 'private',
    promise: {},
  };
  expect(retainedVoiceInputOperation(operation)).toEqual({
    hash: operation.hash,
    operationId: operation.operationId,
  });
  expect(retainedVoiceInputOperation({ ...operation, operationId: 'bad' })).toBeNull();
});

it('reconciles only an exact retained acknowledgement after expiry with no new permission form', async () => {
  const executeWorkAction = jest
    .fn()
    .mockResolvedValue({ status: 'already_accepted', confirmationPending: false });
  const binding = {
    ...pending,
    expiresAt: '2000-01-01T00:00:00Z',
    taskId: task.taskId,
    userId: task.userId,
    callSessionId: task.callSessionId,
    workRef: 'work-1',
  };
  const operation = {
    hash: crypto.createHash('sha256').update('allow_once').digest('hex'),
    operationId: '11111111-1111-4111-8111-111111111111',
  };
  const courier = createNativeMissionVoiceAcknowledgement({
    binding,
    operation,
    task,
    executeWorkAction,
  });
  expect(courier).not.toBeNull();
  await expect(
    courier?.provideInput({
      input: 'reject_once',
      operationId: operation.operationId,
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).rejects.toThrow('native_input_confirmation_conflict');
  await expect(
    courier?.provideInput({
      input: 'allow_once',
      operationId: 'different-op',
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).rejects.toThrow('native_input_confirmation_conflict');
  expect(executeWorkAction).not.toHaveBeenCalled();
  await expect(
    courier?.provideInput({
      input: 'allow_once',
      operationId: operation.operationId,
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).resolves.toEqual({ accepted: true, phase: 'running' });
  expect(executeWorkAction.mock.calls[0][0]).toMatchObject({
    operationId: operation.operationId,
    nativeInput: {
      requestId: binding.requestId,
      requestFingerprint: binding.requestFingerprint,
      content: { optionId: 'allow_once' },
    },
  });
  expect(
    createNativeMissionVoiceAcknowledgement({ binding, operation: null, task, executeWorkAction }),
  ).toBeNull();
  expect(
    createNativeMissionVoiceAcknowledgement({
      binding: { ...binding, runId: 'foreign' },
      operation,
      task,
      executeWorkAction,
    }),
  ).toBeNull();
});

const questionDelivery = {
  event: 'run.needs_input',
  surface: 'voice',
  deliveryId: 'delivery-1',
  callbackId: 'callback_sha256:' + 'b'.repeat(64),
  callbackMessageId: 'message-1',
  userId: 'owner-1',
  conversationId: 'conversation-1',
  voiceCallSessionId: 'call-1',
  voiceRequestId: 'turn-1',
  originRef: 'origin-1',
  workRef: 'work-1',
  workerId: 'worker-1',
  runId: 'run-1',
  text: pending.message,
  nativeInputBinding: pending,
};
it('binds question presentation to complete owner, call, message and native request identity', () => {
  const current = nativeWorkInputPresentation(questionDelivery);
  expect(current?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  for (const key of [
    'userId',
    'conversationId',
    'voiceCallSessionId',
    'voiceRequestId',
    'callbackMessageId',
    'originRef',
    'workRef',
    'workerId',
    'deliveryId',
    'text',
  ]) {
    expect(nativeWorkInputPresentation({ ...questionDelivery, [key]: 'other' })?.digest).not.toBe(
      current?.digest,
    );
  }
  expect(nativeWorkInputPresentation({ ...questionDelivery, runId: 'other' })).toBeNull();
  expect(nativeWorkInputPresentation({ ...questionDelivery, event: 'run.blocked' })).toBeNull();
});
it('rejects expired admission but preserves issued identity for outcome recording', () => {
  const expired = {
    ...questionDelivery,
    nativeInputBinding: { ...pending, expiresAt: '2000-01-01T00:00:00.000Z' },
  };
  expect(nativeWorkInputPresentation(expired)).toBeNull();
  expect(nativeWorkInputPresentation(expired, { allowExpired: true })).not.toBeNull();
});
it('requires actual current question, not status, with public-safe canonical text', () => {
  expect(nativeWorkInputQuestionMatches(pending, pending, pending.message)).toBe(true);
  expect(nativeWorkInputQuestionMatches(pending, pending, 'Waiting for your response')).toBe(false);
  expect(
    nativeWorkInputQuestionMatches({ ...pending, state: 'resolved' }, pending, pending.message),
  ).toBe(false);
  expect(
    nativeWorkInputQuestionMatches(pending, { ...pending, requestId: 'replaced' }, pending.message),
  ).toBe(false);
  expect(
    nativeWorkInputQuestionMatches(
      { ...pending, message: 'Read /home/synthetic/private.txt?' },
      pending,
      'Read [local path]?',
    ),
  ).toBe(true);
});

const questionKey = 'Which  size?';
const clarification = {
  ...pending,
  requestId: 'question-1',
  kind: 'question',
  message: questionKey,
  requestedSchema: {
    type: 'object',
    required: ['answers'],
    additionalProperties: false,
    properties: {
      answers: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        maxProperties: 16,
        properties: {
          [questionKey]: {
            type: 'array',
            uniqueItems: true,
            minItems: 1,
            maxItems: 1,
            items: { type: 'string', enum: ['Small', 'Large', 'Other'] },
          },
        },
      },
      annotations: {
        type: 'object',
        additionalProperties: false,
        properties: {
          [questionKey]: {
            type: 'object',
            additionalProperties: false,
            required: ['notes'],
            properties: { notes: { type: 'string', minLength: 1, maxLength: 8000 } },
          },
        },
      },
    },
  },
};
it('projects native clarification without rewriting its exact wire question or choices', () => {
  const form = nativeQuestionForm(clarification)!;
  expect(form.questions[0].key).toBe(questionKey);
  expect(nativeQuestionFormFromSchema(clarification.requestedSchema)).toEqual(form);
  expect(nativeWorkInputQuestionMatches(clarification, clarification, 'Which size?')).toBe(true);
  expect(nativeQuestionContent({ answers: { [questionKey]: ['Other'] } }, form)).toEqual({
    answers: { [questionKey]: ['Other'] },
  });
  expect(nativeQuestionContent({ answers: { [questionKey]: ['Large'] } }, form)).toEqual({
    answers: { [questionKey]: ['Large'] },
  });
  expect(
    nativeQuestionContent(
      {
        answers: { [questionKey]: ['Other'] },
        annotations: { [questionKey]: { notes: 'Custom  exact answer' } },
      },
      form,
    )?.annotations?.[questionKey].notes,
  ).toBe('Custom  exact answer');
});
it.each([
  { answers: { 'Which size?': ['Large'] } },
  { answers: { [questionKey]: ['Invented'] } },
  { answers: { [questionKey]: ['Small', 'Large'] } },
  { answers: { [questionKey]: ['Small', 'Small'] } },
  { answers: {} },
  {
    answers: { [questionKey]: ['Small'] },
    annotations: { [questionKey]: { notes: 'Unsolicited' } },
  },
  { answers: { [questionKey]: ['Other'] }, annotations: { foreign: { notes: 'Other answer' } } },
])('rejects invalid native clarification content %p', (content) =>
  expect(nativeQuestionContent(content, nativeQuestionForm(clarification)!)).toBeNull(),
);
it('delivers actual clarification arrays through owner input and retained native ACK', async () => {
  const executeWorkAction = jest.fn().mockResolvedValue({ status: 'accepted' });
  const adapter = createNativeMissionVoiceInput({
    pendingInput: clarification,
    pendingBinding: clarification,
    workRef: 'work-1',
    task,
    executeWorkAction,
  })!;
  const content = {
    answers: { [questionKey]: ['Other'] },
    annotations: { [questionKey]: { notes: 'Custom  exact answer' } },
  };
  const input = JSON.stringify(content);
  await adapter.provideInput({
    input,
    operationId: crypto.randomUUID(),
    owner: task.owner,
    voiceAuthorityContext: authority,
  });
  expect(executeWorkAction.mock.calls[0][0].nativeInput.content).toEqual(content);
  const op = {
    hash: crypto.createHash('sha256').update(input).digest('hex'),
    operationId: crypto.randomUUID(),
  };
  const retry = createNativeMissionVoiceAcknowledgement({
    binding: adapter.binding,
    operation: op,
    task,
    executeWorkAction,
  })!;
  await retry.provideInput({
    input,
    operationId: op.operationId,
    owner: task.owner,
    voiceAuthorityContext: authority,
  });
  expect(executeWorkAction.mock.calls[1][0].nativeInput.content).toEqual(content);
  await expect(
    retry.provideInput({
      input: input + ' ',
      operationId: op.operationId,
      owner: task.owner,
      voiceAuthorityContext: authority,
    }),
  ).rejects.toThrow('native_input_confirmation_conflict');
});
it('bounds whole native content bytes, not only individual fields', () => {
  const questions = Array.from({ length: 16 }, (_, i) => 'Q' + i);
  const large = {
    answers: Object.fromEntries(questions.map((q) => [q, ['Other']])),
    annotations: Object.fromEntries(questions.map((q) => [q, { notes: 'x'.repeat(8000) }])),
  };
  expect(
    nativeWorkInputResponseSchema.safeParse({
      version: 1,
      requestId: 'q',
      requestFingerprint: 'a'.repeat(64),
      action: 'accept',
      content: large,
    }).success,
  ).toBe(false);
});

it.each(['__proto__', 'constructor'])(
  'preserves valid native reserved question key %s through form and exact content',
  (key) => {
    const schema = JSON.parse(
      JSON.stringify(clarification.requestedSchema).replaceAll(questionKey, key),
    );
    const request = { ...clarification, message: key, requestedSchema: schema };
    const form = nativeQuestionForm(request)!;
    expect(form.questions[0].key).toBe(key);
    const content = JSON.parse(
      JSON.stringify({
        answers: { [key]: ['Other'] },
        annotations: { [key]: { notes: 'Exact answer' } },
      }),
    );
    expect(nativeQuestionContent(content, form)).toEqual(content);
    const response = nativeWorkInputResponseSchema.parse({
      version: 1,
      requestId: 'q',
      requestFingerprint: 'a'.repeat(64),
      action: 'accept',
      content,
    });
    expect(JSON.parse(JSON.stringify(response)).content).toEqual(content);
  },
);

it('rejects unknown reserved annotation keys without an inherited-property exception', () => {
  expect(
    nativeQuestionContent(
      {
        answers: { [questionKey]: ['Small'] },
        annotations: { constructor: { notes: 'Wrong question' } },
      },
      nativeQuestionForm(clarification)!,
    ),
  ).toBeNull();
});

it('retains the exact bounded native permission operation as display-only detail', () => {
  const input = {
    ...pending,
    requestedSchema: {
      ...pending.requestedSchema,
      properties: {
        optionId: {
          ...pending.requestedSchema.properties.optionId,
          description: 'Create synthetic.txt in the working folder.',
        },
      },
    },
  };
  const { courier, executeWorkAction } = setup(undefined, input);
  expect(courier).toMatchObject({
    prompt: pending.message,
    operationTitle: input.requestedSchema.properties.optionId.description,
  });
  expect(executeWorkAction).not.toHaveBeenCalled();
  expect(
    setup(undefined, {
      ...input,
      requestedSchema: {
        ...input.requestedSchema,
        properties: {
          optionId: { ...input.requestedSchema.properties.optionId, description: 'x'.repeat(8001) },
        },
      },
    }).courier,
  ).toBeNull();
});

describe('native callback chat presentation', () => {
  it.each([pending, clarification])('uses only canonical current native text', (request) => {
    expect(nativeWorkInputMessagePresentation(request, request.runId)).toMatchObject({
      text: nativeWorkInputQuestionText(request, request),
      presentation: {
        version: 1,
        kind: request.kind,
        binding: nativeWorkInputBinding(request, request.runId),
      },
    });
  });
  it.each([
    { ...pending, state: 'answered' },
    { ...pending, expiresAt: '2020-01-01T00:00:00Z' },
    { ...pending, requestFingerprint: 'invalid' },
    { ...pending, kind: 'status' },
  ])('rejects invalid, settled or expired native offers', (request) => {
    expect(nativeWorkInputMessagePresentation(request, 'run-1')).toBeNull();
  });
  it('separates changed requests and preserves exact historical binding after expiry', () => {
    const a = nativeWorkInputMessagePresentation(pending, 'run-1')!.presentation;
    const historical = { ...a, binding: { ...a.binding, expiresAt: '2020-01-01T00:00:00Z' } };
    expect(
      nativeWorkInputMessagePresentationMatches(historical, JSON.parse(JSON.stringify(historical))),
    ).toBe(true);
    for (const key of [
      'requestId',
      'requestFingerprint',
      'attemptId',
      'sessionId',
      'runId',
      'expiresAt',
    ]) {
      const changed = key === 'expiresAt' ? '2098-01-01T00:00:00Z' : 'different';
      expect(
        nativeWorkInputMessagePresentationMatches(a, {
          ...a,
          binding: {
            ...a.binding,
            [key]: key === 'requestFingerprint' ? 'b'.repeat(64) : changed,
          },
        }),
      ).toBe(false);
    }
    expect(nativeWorkInputMessagePresentationMatches(a, null)).toBe(false);
  });
});
