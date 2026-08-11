/* === VIVENTIUM START ===
 * Feature: capability-scoped GlassHive voice task actions
 * Purpose: Prove retry/cancel use only signed exact-run capabilities and never expose tokens.
 * === VIVENTIUM END === */

const {
  confirmVoiceTaskOwnerCancellation,
  completeVoiceTask,
  createVoiceTask,
  failVoiceTask,
  flushVoiceTaskOwnerOperations,
  getVoiceTask,
  getVoiceTaskByStreamId,
  requestVoiceTaskOwnerCancellation,
  resetVoiceTasksForTests,
  retryVoiceTask,
  snapshotEvent,
} = require('../VoiceTaskService');
const {
  registerGlassHiveVoiceTaskActionCapabilities,
} = require('../GlassHiveVoiceTaskActionService');

function capability(overrides = {}) {
  return {
    version: 1,
    capabilityId: 'capability-1',
    operation: 'cancel',
    action: 'cancel',
    endpoint: '/v1/run-actions',
    projectId: 'project-1',
    workerId: 'worker-1',
    runId: 'run-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    capability: 'opaque-action-secret',
    ...overrides,
  };
}

function response(payload, status = 202, headers = {}) {
  const normalizedHeaders = {
    'content-type': 'application/json',
    ...Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), String(value)]),
    ),
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: jest.fn((name) => normalizedHeaders[String(name).toLowerCase()] || null) },
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  };
}

describe('GlassHiveVoiceTaskActionService', () => {
  const originalBaseUrl = process.env.GLASSHIVE_PROVIDER_BASE_URL;

  beforeEach(() => {
    resetVoiceTasksForTests();
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://glasshive.example.test:8766/v1';
  });

  afterAll(() => {
    if (originalBaseUrl == null) {
      delete process.env.GLASSHIVE_PROVIDER_BASE_URL;
    } else {
      process.env.GLASSHIVE_PROVIDER_BASE_URL = originalBaseUrl;
    }
  });

  test.each(['accepted', 'pending'])(
    'uses an exact-run %s cancel capability once and waits for signed terminal callback',
    async (ownerStatus) => {
      const task = createVoiceTask({
        callSessionId: 'call-1',
        userId: 'user-1',
        conversationId: 'conversation-1',
        streamId: 'glasshive:run-1',
        owner: { kind: 'glasshive_run', id: 'run-1' },
      });
      const fetchImpl = jest.fn().mockResolvedValue(
        response({
          version: 1,
          status: ownerStatus,
          action: 'cancel',
          projectId: 'project-1',
          workerId: 'worker-1',
          sourceRunId: 'run-1',
          newRun: null,
          confirmationPending: true,
          idempotentReplay: false,
        }),
      );
      const registration = registerGlassHiveVoiceTaskActionCapabilities({
        body: {
          event: 'run.started',
          worker_id: 'worker-1',
          run_id: 'run-1',
          actionCapabilities: [capability()],
        },
        task,
        fetchImpl,
      });

      expect(registration).toEqual({ cancel: true, retry: false });
      const first = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });
      expect(first).toMatchObject({ ownerAccepted: false, ownerPending: true });
      await flushVoiceTaskOwnerOperations();
      const replay = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });

      expect(replay.ownerAccepted).toBe(true);
      expect(getVoiceTask(task.taskId).state).toBe('cancelling');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, options] = fetchImpl.mock.calls[0];
      expect(url).toBe('http://glasshive.example.test:8766/v1/run-actions');
      expect(options.headers['X-Viventium-Action-Capability']).toBe('opaque-action-secret');
      expect(options.headers.Authorization).toBeUndefined();
      expect(options.redirect).toBe('error');
      const requestBody = JSON.parse(options.body);
      expect(requestBody).toMatchObject({
        version: 1,
        capabilityId: 'capability-1',
        action: 'cancel',
        projectId: 'project-1',
        workerId: 'worker-1',
        runId: 'run-1',
      });
      expect(JSON.stringify(requestBody)).not.toContain('opaque-action-secret');
      expect(JSON.stringify(snapshotEvent(task.taskId))).not.toContain('opaque-action-secret');

      await confirmVoiceTaskOwnerCancellation(
        task.taskId,
        'Signed callback confirmed interruption.',
      );
      expect(getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    },
  );

  test('advertises retry only for a signed retryable failure and rebinds the new run', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-2',
      userId: 'user-1',
      conversationId: 'conversation-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const fetchImpl = jest.fn().mockResolvedValue(
      response({
        version: 1,
        status: 'queued',
        action: 'retry',
        projectId: 'project-1',
        workerId: 'worker-1',
        sourceRunId: 'run-1',
        newRun: { projectId: 'project-1', workerId: 'worker-1', runId: 'run-2' },
        idempotentReplay: false,
      }),
    );
    registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.failed',
        failure_retryable: true,
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability({ operation: 'workspace_continue', action: 'retry' })],
      },
      task,
      fetchImpl,
    });
    failVoiceTask(task.taskId, { code: 'worker_failed', message: 'Worker stopped.' });

    expect(snapshotEvent(task.taskId).retryable).toBe(true);
    const retried = await retryVoiceTask(task.taskId, { userId: 'user-1' });
    expect(retried).toMatchObject({
      ok: true,
      task: { state: 'running', parentTaskId: task.taskId },
      previousTask: { taskId: task.taskId, state: 'failed' },
    });
    const child = getVoiceTaskByStreamId('glasshive:run-2');
    expect(child.taskId).not.toBe(task.taskId);
    expect(child.owner).toEqual({ kind: 'glasshive_run', id: 'run-2' });
    expect(getVoiceTask(task.taskId).state).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects a retry response that rebinds the child run to a different worker', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-worker-mismatch',
      userId: 'user-1',
      conversationId: 'conversation-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.failed',
        failure_retryable: true,
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability({ operation: 'workspace_continue', action: 'retry' })],
      },
      task,
      fetchImpl: jest.fn().mockResolvedValue(
        response({
          version: 1,
          status: 'queued',
          action: 'retry',
          projectId: 'project-1',
          workerId: 'worker-1',
          sourceRunId: 'run-1',
          newRun: { projectId: 'project-1', workerId: 'worker-other', runId: 'run-2' },
          idempotentReplay: false,
        }),
      ),
    });
    failVoiceTask(task.taskId, { code: 'worker_failed', message: 'Worker stopped.' });

    const result = await retryVoiceTask(task.taskId, { userId: 'user-1' });

    expect(result).toMatchObject({ ok: false, code: 'owner_retry_failed' });
    expect(getVoiceTaskByStreamId('glasshive:run-2')).toBeNull();
    expect(getVoiceTask(task.taskId).state).toBe('failed');
  });

  test.each([
    ['wrong endpoint', capability({ endpoint: 'https://attacker.example/run-actions' })],
    ['wrong run', capability({ runId: 'run-other' })],
    ['wrong worker', capability({ workerId: 'worker-other' })],
    ['expired', capability({ expiresAt: new Date(Date.now() - 1000).toISOString() })],
    ['wrong event', capability({ operation: 'workspace_continue', action: 'retry' })],
  ])('rejects a %s action capability without advertising owner control', (_label, action) => {
    const task = createVoiceTask({
      callSessionId: 'call-invalid',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const registration = registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.started',
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [action],
      },
      task,
      fetchImpl: jest.fn(),
    });

    expect(registration).toEqual({ cancel: false, retry: false });
  });

  test('rejects retry when the callback does not structurally declare retryability', () => {
    const task = createVoiceTask({
      callSessionId: 'call-not-retryable',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const registration = registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.failed',
        failure_retryable: false,
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability({ operation: 'workspace_continue', action: 'retry' })],
      },
      task,
      fetchImpl: jest.fn(),
    });

    failVoiceTask(task.taskId, { code: 'worker_failed', message: 'Worker stopped.' });
    expect(registration).toEqual({ cancel: false, retry: false });
    expect(snapshotEvent(task.taskId).retryable).toBe(false);
  });

  test('fails closed when no configured GlassHive operator origin exists', () => {
    delete process.env.GLASSHIVE_PROVIDER_BASE_URL;
    const task = createVoiceTask({
      callSessionId: 'call-no-origin',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });

    expect(
      registerGlassHiveVoiceTaskActionCapabilities({
        body: {
          event: 'run.started',
          worker_id: 'worker-1',
          run_id: 'run-1',
          actionCapabilities: [capability()],
        },
        task,
        fetchImpl: jest.fn(),
      }),
    ).toEqual({ cancel: false, retry: false });
  });

  test.each([
    ['oversized body', { 'content-length': '20000' }],
    ['non-JSON body', { 'content-type': 'text/html' }],
  ])('rejects a %s before parsing an action response', async (_label, headers) => {
    const task = createVoiceTask({
      callSessionId: 'call-bounded-response',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const ownerResponse = response(
      {
        version: 1,
        status: 'accepted',
        action: 'cancel',
        projectId: 'project-1',
        workerId: 'worker-1',
        sourceRunId: 'run-1',
        newRun: null,
        confirmationPending: true,
      },
      202,
      headers,
    );
    registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.started',
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability()],
      },
      task,
      fetchImpl: jest.fn().mockResolvedValue(ownerResponse),
    });

    const result = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });

    expect(result).toMatchObject({ ownerSupported: true, ownerAccepted: false });
    expect(ownerResponse.text).not.toHaveBeenCalled();
  });

  test('rejects an oversized action response when content-length is absent', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-oversized-stream',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const ownerResponse = response({});
    ownerResponse.text.mockResolvedValue(`{"padding":"${'x'.repeat(17_000)}"}`);
    registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.started',
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability()],
      },
      task,
      fetchImpl: jest.fn().mockResolvedValue(ownerResponse),
    });

    const result = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });

    expect(result).toMatchObject({ ownerSupported: true, ownerAccepted: false });
    expect(ownerResponse.text).toHaveBeenCalledTimes(1);
  });

  test('maps an exact scoped already-completed cancel race without suppressing its delayed result', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-already-completed',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    registerGlassHiveVoiceTaskActionCapabilities({
      body: {
        event: 'run.started',
        worker_id: 'worker-1',
        run_id: 'run-1',
        actionCapabilities: [capability()],
      },
      task,
      fetchImpl: jest.fn().mockResolvedValue(
        response(
          {
            version: 1,
            status: 'already_completed',
            action: 'cancel',
            projectId: 'project-1',
            workerId: 'worker-1',
            sourceRunId: 'run-1',
            state: 'completed',
          },
          409,
        ),
      ),
    });

    const cancellation = await requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-1',
    });

    expect(cancellation).toMatchObject({
      ownerSupported: true,
      ownerAccepted: false,
      ownerPending: true,
      task: { state: 'cancelling' },
      event: { state: 'cancelling', phase: 'cancelling' },
    });
    await flushVoiceTaskOwnerOperations();
    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'completed' });
    expect(completeVoiceTask(task.taskId, { resultMessageId: 'delayed-result' })).toMatchObject({
      state: 'completed',
      resultMessageId: 'delayed-result',
    });
  });
});
