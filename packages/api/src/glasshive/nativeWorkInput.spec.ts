/* === VIVENTIUM START === Exact native mission identity and owner-choice courier regression. === VIVENTIUM END === */
import crypto from 'node:crypto';
import {
  createNativeMissionVoiceInput,
  createNativeMissionVoiceAcknowledgement,
  nativeWorkInputBinding,
  nativeWorkInputResponseSchema,
  nativeMissionVoiceBinding,
  retainedVoiceInputOperation,
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
