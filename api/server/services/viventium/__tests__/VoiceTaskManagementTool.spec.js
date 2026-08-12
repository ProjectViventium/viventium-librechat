/* === VIVENTIUM START === manage_active_tasks policy/tool tests. === VIVENTIUM END === */

const mockAbortJob = jest.fn();
jest.mock('@librechat/api', () => ({
  GenerationJobManager: { abortJob: (...args) => mockAbortJob(...args) },
}));

const {
  createVoiceTask,
  failVoiceTask,
  flushVoiceTaskOwnerOperations,
  getVoiceTask,
  observeGenerationEvent,
  registerVoiceTaskOwnerAdapter,
  resetVoiceTasksForTests,
} = require('../VoiceTaskService');
const { createManageActiveTasksTool, operationSchema } = require('../VoiceTaskManagementTool');

function ownerRequest(overrides = {}) {
  return {
    user: { id: 'user-1' },
    viventiumCallSession: { callSessionId: 'call-1', mode: 'call' },
    body: {
      mode: 'call',
      viventiumActorTrust: 'owner_participant',
      viventiumCanAuthorizeSideEffects: true,
    },
    ...overrides,
  };
}

describe('manage_active_tasks', () => {
  beforeEach(() => {
    resetVoiceTasksForTests();
    mockAbortJob.mockReset().mockResolvedValue({ success: true });
  });

  test('registers only for structurally owner-authorized Call/Wing turns', () => {
    expect(createManageActiveTasksTool(ownerRequest())).not.toBeNull();
    expect(
      createManageActiveTasksTool(
        ownerRequest({
          body: {
            mode: 'listen_only',
            viventiumActorTrust: 'owner_participant',
            viventiumCanAuthorizeSideEffects: true,
          },
        }),
      ),
    ).toBeNull();
    expect(
      createManageActiveTasksTool(
        ownerRequest({
          body: {
            mode: 'call',
            viventiumActorTrust: 'shared_mic_unverified',
            viventiumCanAuthorizeSideEffects: false,
          },
        }),
      ),
    ).toBeNull();
    expect(operationSchema.safeParse({ operation: 'cancel', arbitrary: true }).success).toBe(false);
  });

  test('cancellation installs the barrier and truthfully confirms owner abort', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'stream-1',
      owner: { kind: 'generation_job', id: 'stream-1' },
    });
    const tool = createManageActiveTasksTool(ownerRequest());

    const result = JSON.parse(await tool.invoke({ operation: 'cancel', taskId: task.taskId }));

    expect(result).toMatchObject({
      ok: true,
      task: { taskId: task.taskId, state: 'cancelled_confirmed' },
    });
    expect(mockAbortJob).toHaveBeenCalledWith('stream-1');
    expect(getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
  });

  test('acknowledges owner cancellation immediately and applies an already-completed race later', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'glasshive:completed-before-cancel',
      owner: { kind: 'glasshive_run', id: 'completed-before-cancel' },
    });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel: jest.fn().mockResolvedValue({ alreadyCompleted: true }),
      cancellationConfirmable: true,
    });
    const tool = createManageActiveTasksTool(ownerRequest());

    const result = JSON.parse(await tool.invoke({ operation: 'cancel', taskId: task.taskId }));

    expect(result).toMatchObject({
      ok: true,
      task: { taskId: task.taskId, state: 'cancelling' },
    });
    await flushVoiceTaskOwnerOperations();
    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'completed' });
    expect(mockAbortJob).not.toHaveBeenCalled();
  });

  test('delivers input and retry through installed task owner adapters', async () => {
    const inputTask = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'input-stream',
      owner: { kind: 'generation_job', id: 'input-stream' },
    });
    const provideInput = jest.fn().mockResolvedValue({ accepted: true });
    registerVoiceTaskOwnerAdapter(inputTask.taskId, {
      kind: 'generation_job',
      provideInput,
    });
    observeGenerationEvent(inputTask.taskId, {
      event: 'needs_input',
      data: { id: 'tool-input-needed', prompt: 'Which scope?', inputType: 'text' },
    });
    const tool = createManageActiveTasksTool(ownerRequest());

    const inputResult = JSON.parse(
      await tool.invoke({ operation: 'input', taskId: inputTask.taskId, input: 'Example scope' }),
    );

    expect(inputResult).toMatchObject({
      ok: true,
      task: { taskId: inputTask.taskId, state: 'running' },
      event: { state: 'running' },
    });
    expect(provideInput).toHaveBeenCalledTimes(1);

    const retryTask = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'retry-stream',
      owner: { kind: 'generation_job', id: 'retry-stream' },
    });
    const retry = jest.fn().mockResolvedValue({ accepted: true, streamId: 'retry-stream-2' });
    registerVoiceTaskOwnerAdapter(retryTask.taskId, { kind: 'generation_job', retry });
    failVoiceTask(retryTask.taskId, { code: 'provider_failure', message: 'Unavailable' });

    const retryResult = JSON.parse(
      await tool.invoke({ operation: 'retry', taskId: retryTask.taskId }),
    );

    expect(retryResult).toMatchObject({
      ok: true,
      task: {
        taskId: expect.any(String),
        parentTaskId: retryTask.taskId,
        state: 'running',
        streamId: 'retry-stream-2',
      },
      previousTask: { taskId: retryTask.taskId, state: 'failed' },
      events: [{ state: 'queued' }, { state: 'running' }],
    });
    expect(retryResult.task.taskId).not.toBe(retryTask.taskId);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('keeps unsupported owners and unverified callers unable to input or retry', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'unsupported-stream',
    });
    const tool = createManageActiveTasksTool(ownerRequest());

    const inputResult = JSON.parse(
      await tool.invoke({ operation: 'input', taskId: task.taskId, input: 'Do not deliver' }),
    );
    const retryResult = JSON.parse(await tool.invoke({ operation: 'retry', taskId: task.taskId }));

    expect(inputResult).toMatchObject({ ok: false, code: 'input_unsupported' });
    expect(retryResult).toMatchObject({ ok: false, code: 'retry_unsupported' });
    expect(
      createManageActiveTasksTool(
        ownerRequest({
          body: {
            mode: 'wing',
            viventiumActorTrust: 'shared_mic_unverified',
            viventiumCanAuthorizeSideEffects: false,
          },
        }),
      ),
    ).toBeNull();
  });
});
