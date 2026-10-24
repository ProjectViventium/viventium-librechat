/* === VIVENTIUM START === VoiceTaskEventV1 state-machine tests. === VIVENTIUM END === */

const mockRecordVoiceOrchestrationTraceBestEffort = jest.fn();

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

const {
  bindVoiceTaskStream,
  cancelVoiceTask,
  canConfirmVoiceTaskCancellation,
  completeVoiceTask,
  refreshVoiceTaskCommittedPresentation,
  confirmVoiceTaskOwnerCancellation,
  createVoiceTask,
  registerVoiceTaskDeliveryPresentation,
  recordVoiceTaskDeliveryPresentation,
  recordVoiceTaskPresentation,
  failVoiceTask,
  flushVoiceTaskOwnerOperations,
  getVoiceTask,
  getVoiceTaskByStreamId,
  getVoiceTaskTraceBinding,
  getVoiceTaskOwnerBinding,
  getVoiceTaskOwnerCapabilityInventory,
  getVoiceTaskRegistryStats,
  isVoiceTaskSuppressed,
  listVoiceTasks,
  observeGenerationEvent,
  registerVoiceTaskOwnerAdapter,
  requestVoiceTaskOwnerCancellation,
  resetVoiceTasksForTests,
  retryVoiceTask,
  settleVoiceTaskCancellation,
  snapshotEvent,
  setVoiceTaskOwnerCapabilities,
  submitVoiceTaskInput,
  subscribeVoiceTask,
  subscribeVoiceTasksForCall,
} = require('../VoiceTaskService');

describe('VoiceTaskService', () => {
  test('completed parent retries one exact child wake without duplicating the durable event or changing its result', () => {
    const task = createVoiceTask({
      callSessionId: 'call-wake',
      userId: 'owner-wake',
      conversationId: 'conversation-wake',
      streamId: 'stream-wake',
      owner: { kind: 'generation_job', id: 'stream-wake' },
    });
    completeVoiceTask(task.taskId, { resultMessageId: 'parent-wake' });
    const events = [];
    const unsubscribe = subscribeVoiceTasksForCall('call-wake', (event) => events.push(event));
    const wake = {
      event: 'on_cortex_followup',
      data: {
        messageId: 'child-wake',
        parentMessageId: 'parent-wake',
        conversationId: 'conversation-wake',
      },
    };
    expect(observeGenerationEvent(task.taskId, wake)).toMatchObject({
      state: 'completed',
      resultMessageId: 'parent-wake',
      source: { id: 'child-wake' },
      phase: 'follow_up',
    });
    const count = events.length;
    expect(observeGenerationEvent(task.taskId, wake)).toBeNull();
    expect(
      observeGenerationEvent(task.taskId, {
        ...wake,
        data: { ...wake.data, messageId: 'foreign-child', parentMessageId: 'foreign-parent' },
      }),
    ).toBeNull();
    expect(events).toHaveLength(count);
    expect(snapshotEvent(task.taskId).resultMessageId).toBe('parent-wake');
    unsubscribe();
  });

  test.each(['Synthetic recall', 'Synthetic verification'])(
    'keeps generation ownership visible while reporting %s cortex activity',
    (cortexName) => {
      const task = createVoiceTask({
        callSessionId: 'call-label',
        userId: 'user-label',
        streamId: 'stream-label',
        owner: { kind: 'remote_generation', id: 'stream-label' },
      });
      observeGenerationEvent(task.taskId, {
        event: 'on_run_step',
        data: { id: 'writing-label', type: 'message_creation' },
      });
      const event = observeGenerationEvent(task.taskId, {
        event: 'on_cortex_update',
        data: { id: 'cortex-label', cortex_name: cortexName, status: 'complete' },
      });
      expect(event).toMatchObject({
        taskId: task.taskId,
        streamId: 'stream-label',
        state: 'running',
        phase: 'cortex',
        label: 'Writing reply',
        detail: `${cortexName}: complete`,
        cancellable: true,
        owner: { kind: 'remote_generation', id: 'stream-label' },
      });
      expect(snapshotEvent(task.taskId)).toMatchObject({
        label: 'Writing reply',
        detail: `${cortexName}: complete`,
        phase: 'cortex',
        owner: { kind: 'remote_generation', id: 'stream-label' },
      });
      const cancellation = cancelVoiceTask(task.taskId, { userId: 'user-label' });
      expect(cancellation.event).toMatchObject({
        taskId: task.taskId,
        streamId: 'stream-label',
        state: 'cancelling',
        owner: { kind: 'remote_generation', id: 'stream-label' },
      });
      expect(
        observeGenerationEvent(task.taskId, {
          event: 'on_cortex_update',
          data: { id: 'late-cortex', cortex_name: 'Late cortex', status: 'complete' },
        }),
      ).toBeNull();
    },
  );

  test('keeps the initial generation label when cortex progress arrives before a writing step', () => {
    const task = createVoiceTask({
      callSessionId: 'call-label',
      userId: 'user-label',
      streamId: 'stream-label',
    });
    const event = observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: {
        id: 'first-cortex',
        cortex_name: 'N'.repeat(400),
        status: 'S'.repeat(400),
        rawInsight: 'private insight',
      },
    });
    expect(event.label).toBe('Starting');
    expect(event.detail).toBe(`${'N'.repeat(160)}: ${'S'.repeat(80)}`);
    expect(JSON.stringify(event)).not.toContain('private insight');
    expect(
      observeGenerationEvent(task.taskId, {
        event: 'on_cortex_update',
        data: { id: 'first-cortex', cortex_name: 'duplicate', status: 'S'.repeat(400) },
      }),
    ).toBeNull();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordVoiceOrchestrationTraceBestEffort.mockResolvedValue({ sequence: 1 });
    resetVoiceTasksForTests();
  });

  test('native input does not retain the previous cortex status as approval detail', () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-input',
      streamId: 'stream-input',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', provideInput: jest.fn() });
    observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { name: 'Synthetic cortex', status: 'error' },
    });
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: {
        prompt: 'Approve synthetic write?',
        inputType: 'choice',
        choices: [{ value: 'allow', label: 'Allow once' }],
      },
    });
    const snapshot = snapshotEvent(task.taskId);
    expect(snapshot.phase).toBe('needs_input');
    expect(snapshot.detail).toBeUndefined();
  });

  test('native clarification input preserves exact JSON bytes and current form during ACK retry', async () => {
    const key = 'Which  size?';
    const questionForm = {
      questions: [
        {
          key,
          label: 'Which size?',
          multiSelect: false,
          options: [{ value: 'Other', label: 'Other' }],
        },
      ],
    };
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'mission-run',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const provideInput = jest
      .fn()
      .mockResolvedValueOnce({ accepted: false, confirmationPending: true })
      .mockResolvedValueOnce({ accepted: true });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: {
        version: 1,
        requestId: 'question-1',
        requestFingerprint: 'a'.repeat(64),
        runId: 'run-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        expiresAt: '2099-01-01T00:00:00Z',
        workRef: 'work-1',
        taskId: task.taskId,
        userId: 'user-1',
        callSessionId: 'call-input',
        inputKind: 'question',
        questionForm,
      },
    });
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Choose size.', inputType: 'native_question', questionForm },
    });
    const input = JSON.stringify({
      answers: { [key]: ['Other'] },
      annotations: { [key]: { notes: 'Custom  exact ' + 'x'.repeat(1100) } },
    });
    const first = await submitVoiceTaskInput(task.taskId, input, { userId: 'user-1' });
    expect(first.confirmationPending).toBe(true);
    expect(provideInput.mock.calls[0][0].input).toBe(input);
    expect(snapshotEvent(task.taskId).needsInput.questionForm).toEqual(questionForm);
    expect((await submitVoiceTaskInput(task.taskId, input + ' ', { userId: 'user-1' })).code).toBe(
      'input_confirmation_pending',
    );
    const second = await submitVoiceTaskInput(task.taskId, input, { userId: 'user-1' });
    expect(second.ok).toBe(true);
    expect(provideInput.mock.calls[1][0].input).toBe(input);
    expect(provideInput.mock.calls[1][0].operationId).toBe(
      provideInput.mock.calls[0][0].operationId,
    );
  });

  test('native pending ACK retains one operation and permits only its exact choice retry', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'mission-run',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const provideInput = jest
      .fn()
      .mockResolvedValueOnce({ accepted: false, confirmationPending: true })
      .mockResolvedValueOnce({ accepted: true });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: {
        version: 1,
        requestId: 'permission-1',
        requestFingerprint: 'a'.repeat(64),
        runId: 'run-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        expiresAt: '2099-01-01T00:00:00Z',
        workRef: 'work-1',
        taskId: task.taskId,
        userId: 'user-1',
        callSessionId: 'call-input',
      },
    });
    const request = {
      event: 'needs_input',
      data: {
        prompt: 'Choose',
        inputType: 'choice',
        choices: [
          { value: 'allow_once', label: 'Allow once' },
          { value: 'reject_once', label: 'Reject once' },
        ],
      },
    };
    observeGenerationEvent(task.taskId, request);
    const authority = { callSessionId: 'call-input', binding: { userId: 'user-1' } };
    const first = await submitVoiceTaskInput(task.taskId, 'allow_once', {
      userId: 'user-1',
      voiceAuthorityContext: authority,
    });
    expect(first).toMatchObject({
      ok: true,
      confirmationPending: true,
      task: { state: 'needs_input' },
    });
    expect(snapshotEvent(task.taskId)).not.toHaveProperty('error');
    observeGenerationEvent(task.taskId, request);
    expect(
      await submitVoiceTaskInput(task.taskId, 'reject_once', { userId: 'user-1' }),
    ).toMatchObject({ ok: false, code: 'input_confirmation_pending' });
    expect(provideInput).toHaveBeenCalledTimes(1);
    const second = await submitVoiceTaskInput(task.taskId, 'allow_once', {
      userId: 'user-1',
      voiceAuthorityContext: authority,
    });
    expect(second).toMatchObject({ ok: true, task: { state: 'running' } });
    expect(provideInput.mock.calls[1][0]).toMatchObject(provideInput.mock.calls[0][0]);
  });

  test('an exact replacement permission resets the retained choice even when its wording is unchanged', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'mission-run',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const binding = {
      version: 1,
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      expiresAt: '2099-01-01T00:00:00Z',
      workRef: 'work-1',
      taskId: task.taskId,
      userId: 'user-1',
      callSessionId: 'call-input',
    };
    const provideInput = jest
      .fn()
      .mockResolvedValue({ accepted: false, confirmationPending: true });
    const request = {
      event: 'needs_input',
      data: {
        prompt: 'Choose',
        inputType: 'choice',
        choices: [
          { value: 'allow_once', label: 'Allow once' },
          { value: 'reject_once', label: 'Reject once' },
        ],
      },
    };
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: binding,
    });
    observeGenerationEvent(task.taskId, request);
    await submitVoiceTaskInput(task.taskId, 'allow_once', { userId: 'user-1' });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: {
        ...binding,
        requestId: 'permission-2',
        requestFingerprint: 'b'.repeat(64),
      },
    });
    observeGenerationEvent(task.taskId, request);
    expect(
      await submitVoiceTaskInput(task.taskId, 'reject_once', { userId: 'user-1' }),
    ).toMatchObject({ ok: true, confirmationPending: true });
    expect(provideInput.mock.calls[1][0].operationId).not.toBe(
      provideInput.mock.calls[0][0].operationId,
    );
  });

  test('a late acknowledgement of the previous question cannot clear a replacement permission', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'mission-run',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const binding = {
      version: 1,
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      expiresAt: '2099-01-01T00:00:00Z',
      workRef: 'work-1',
      taskId: task.taskId,
      userId: 'user-1',
      callSessionId: 'call-input',
    };
    let acknowledge;
    const provideInput = jest.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const request = {
      event: 'needs_input',
      data: {
        prompt: 'Choose',
        inputType: 'choice',
        choices: [{ value: 'allow_once', label: 'Allow once' }],
      },
    };
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: binding,
    });
    observeGenerationEvent(task.taskId, request);
    const pending = submitVoiceTaskInput(task.taskId, 'allow_once', { userId: 'user-1' });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      provideInput,
      nativeMissionInputBinding: {
        ...binding,
        requestId: 'permission-2',
        requestFingerprint: 'b'.repeat(64),
      },
    });
    observeGenerationEvent(task.taskId, request);
    acknowledge({ accepted: true });
    expect(await pending).toMatchObject({
      ok: false,
      code: 'input_invalid_state',
      task: { state: 'needs_input' },
    });
    expect(snapshotEvent(task.taskId)).toMatchObject({
      state: 'needs_input',
      needsInput: { prompt: 'Choose' },
    });
  });

  test('input registration and expiry preserve the existing exact-run Stop adapter', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'mission-run',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const cancel = jest.fn().mockResolvedValue({ accepted: true });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel,
      cancellationConfirmable: true,
    });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      preserveExisting: true,
      provideInput: jest.fn(),
      inputExpiresAtMs: Date.now() - 1,
    });
    expect(
      getVoiceTaskOwnerCapabilityInventory({ userId: 'user-1', callSessionId: 'call-input' })
        .owners,
    ).toEqual([{ kind: 'glasshive_run', acceptsInput: false }]);
    await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });
    await flushVoiceTaskOwnerOperations();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test('retains canonical trace identity after completion and rejects a same-stream turn change', () => {
    const scope = {
      callSessionId: 'call-trace',
      userId: 'user-trace',
      conversationId: 'convo-trace',
    };
    const task = createVoiceTask({ ...scope, streamId: 'stream-trace' });
    bindVoiceTaskStream(task.taskId, 'stream-trace', { ...scope, logicalTurnId: 'logical-trace' });
    completeVoiceTask(task.taskId, { resultMessageId: 'result-trace' });
    expect(getVoiceTaskTraceBinding(task.taskId)).toEqual({
      taskId: task.taskId,
      callSessionId: scope.callSessionId,
      userId: scope.userId,
      streamId: 'stream-trace',
      logicalTurnId: 'logical-trace',
    });
    expect(
      bindVoiceTaskStream(task.taskId, 'stream-trace', {
        ...scope,
        logicalTurnId: 'other-turn',
      }),
    ).toBeNull();
    expect(
      bindVoiceTaskStream(task.taskId, 'stream-trace', {
        ...scope,
        userId: 'other-owner',
        logicalTurnId: 'logical-trace',
      }),
    ).toBeNull();
    expect(getVoiceTaskTraceBinding(task.taskId).logicalTurnId).toBe('logical-trace');
  });

  test.each(['generation_job', 'glasshive_run', 'glasshive_delivery'])(
    'saved-result owner identity for %s does not invent generation authority',
    (kind) => {
      const scope = {
        callSessionId: 'call-files',
        userId: 'owner-files',
        conversationId: 'chat-files',
      };
      const task = createVoiceTask({
        ...scope,
        streamId: `stream-${kind}`,
        owner: { kind, id: `owner-${kind}` },
      });
      completeVoiceTask(task.taskId, { resultMessageId: 'saved-reply' });
      const binding = getVoiceTaskOwnerBinding(task.taskId);
      expect(binding).toEqual({ taskId: task.taskId, ...scope });
      expect(Object.isFrozen(binding)).toBe(true);
      expect(getVoiceTaskTraceBinding(task.taskId)).toBeNull();
      expect(getVoiceTask(task.taskId)).not.toHaveProperty('userId');
      expect(binding).not.toHaveProperty('streamId');
      expect(binding).not.toHaveProperty('logicalTurnId');
    },
  );

  test('a missing task or owner cannot supply a saved-result identity', () => {
    expect(getVoiceTaskOwnerBinding('missing')).toBeNull();
    const task = createVoiceTask({ callSessionId: 'call-files', conversationId: 'chat-files' });
    expect(getVoiceTaskOwnerBinding(task.taskId)).toBeNull();
  });

  test.each([
    'native_input_declined',
    'native_input_expired',
    'native_input_cancelled',
    'native_turn_cancelled',
  ])('never retries native terminal stop %s or stores raw error text', (code) => {
    const task = createVoiceTask({
      callSessionId: 'call-stop',
      userId: 'user-stop',
      streamId: 'stream-stop',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', retry: jest.fn() });
    const failed = failVoiceTask(task.taskId, { code, message: 'PRIVATE-PROVIDER-ERROR' });
    expect(failed).toMatchObject({ state: 'failed', retryable: false, error: { code } });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE-PROVIDER-ERROR');
  });

  test.each([
    'provider_progress_stalled',
    'native_input_declined',
    'native_input_expired',
    'native_input_cancelled',
    'native_turn_cancelled',
  ])('keeps public non-retryable %s blocked when its owner adapter is rebound', (code) => {
    const task = createVoiceTask({
      callSessionId: 'call-disposition',
      userId: 'user-disposition',
      streamId: 'stream-disposition',
    });
    failVoiceTask(task.taskId, { code, message: 'PRIVATE-PROVIDER-ERROR' });
    const rebound = registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      retry: jest.fn(),
    });
    expect(rebound).toMatchObject({ state: 'failed', retryable: false });
    expect(snapshotEvent(task.taskId)).toMatchObject({ error: { code } });
    expect(JSON.stringify(rebound)).not.toContain('PRIVATE-PROVIDER-ERROR');
  });

  test.each([
    'provider_progress_stalled',
    'native_input_declined',
    'native_input_expired',
    'native_input_cancelled',
    'native_turn_cancelled',
  ])('rejects direct terminal Retry for public non-retryable %s', async (code) => {
    const task = createVoiceTask({
      callSessionId: 'call-disposition',
      userId: 'user-disposition',
      streamId: 'stream-disposition',
    });
    const retry = jest.fn().mockResolvedValue({ accepted: true, streamId: 'forbidden-new-stream' });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', retry });
    failVoiceTask(task.taskId, { code, message: 'PRIVATE-PROVIDER-ERROR' });
    await expect(
      retryVoiceTask(task.taskId, { userId: 'user-disposition' }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'retry_unsupported',
      task: { retryable: false },
    });
    expect(retry).not.toHaveBeenCalled();
    expect(snapshotEvent(task.taskId)).toMatchObject({ error: { code } });
    expect(
      listVoiceTasks({ callSessionId: 'call-disposition', userId: 'user-disposition' }),
    ).toHaveLength(1);
  });

  test('binds the ready receipt conversation once without changing current task state', () => {
    const scope = { callSessionId: 'call-bind', userId: 'user-bind' };
    const task = createVoiceTask({ ...scope, conversationId: 'new', streamId: 'stream-bind' });
    completeVoiceTask(task.taskId, { resultMessageId: 'result-before-ready' });
    const prior = snapshotEvent(task.taskId);
    const binding = { ...scope, conversationId: 'conversation-bind' };
    bindVoiceTaskStream(task.taskId, 'stream-bind', binding);
    const bound = snapshotEvent(task.taskId);
    expect(bound).toMatchObject({
      conversationId: 'conversation-bind',
      state: 'completed',
      resultMessageId: 'result-before-ready',
      sequence: prior.sequence + 1,
    });
    bindVoiceTaskStream(task.taskId, 'stream-bind', binding);
    expect(snapshotEvent(task.taskId).sequence).toBe(bound.sequence);
  });

  test.each([
    { userId: 'other-user' },
    { callSessionId: 'other-call' },
    { conversationId: 'other-conversation' },
  ])('rejects a ready receipt identity change before mutating stream: %j', (mismatch) => {
    const scope = {
      callSessionId: 'call-bind',
      userId: 'user-bind',
      conversationId: 'conversation-bind',
    };
    const task = createVoiceTask({ ...scope, streamId: 'stream-bind' });
    const prior = getVoiceTask(task.taskId);
    expect(bindVoiceTaskStream(task.taskId, 'other-stream', { ...scope, ...mismatch })).toBeNull();
    expect(getVoiceTask(task.taskId)).toEqual(prior);
  });

  test.each([
    { type: 'message_creation' },
    { stepDetails: { type: 'message_creation', message_creation: { message_id: 'message-1' } } },
  ])('presents the declared reply creation step without an internal code: %j', (step) => {
    const task = createVoiceTask({
      callSessionId: 'call-writing',
      userId: 'user-writing',
      streamId: 'stream-writing',
      owner: { kind: 'generation_job', id: 'stream-writing' },
    });
    const before = getVoiceTask(task.taskId);
    const event = observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'writing-step', ...step },
    });
    expect(event).toMatchObject({
      type: 'progress',
      phase: 'agent',
      label: 'Writing reply',
      detail: 'Step started',
      state: before.state,
      sequence: before.sequence + 1,
      taskId: task.taskId,
      callSessionId: before.callSessionId,
    });
    expect(getVoiceTask(task.taskId).owner).toEqual(before.owner);
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  test.each([
    {
      data: { type: 'message_creation', name: 'Drafting your reply' },
      expected: 'Drafting your reply',
      phase: 'agent',
    },
    {
      data: { type: 'message_creation', name: 'tool_calls' },
      expected: 'tool_calls',
      phase: 'agent',
    },
    {
      data: {
        type: 'message_creation',
        stepDetails: { tool_calls: [{ function: { name: 'declared_tool' } }] },
      },
      expected: 'declared_tool',
      phase: 'tool',
    },
    {
      data: {
        type: 'tool_calls',
        stepDetails: { tool_calls: [{ function: { name: 'message_creation' } }] },
      },
      expected: 'message_creation',
      phase: 'tool',
    },
    {
      data: { type: 'other_step', name: 'message_creation' },
      expected: 'message_creation',
      phase: 'agent',
    },
    { data: { type: 'other_step' }, expected: 'other_step', phase: 'agent' },
  ])(
    'retains actual tools, human names and unknown step types: $expected',
    ({ data, expected, phase }) => {
      const task = createVoiceTask({
        callSessionId: 'call-writing',
        userId: 'user-writing',
        streamId: 'stream-writing',
      });
      expect(
        observeGenerationEvent(task.taskId, {
          event: 'on_run_step',
          data: { id: 'writing-step', ...data },
        }),
      ).toMatchObject({ label: expected, phase });
    },
  );

  test('message creation completion is progress without a tool receipt', () => {
    const task = createVoiceTask({
      callSessionId: 'call-writing',
      userId: 'user-writing',
      streamId: 'stream-writing',
    });
    const before = getVoiceTask(task.taskId);
    const event = observeGenerationEvent(task.taskId, {
      event: 'on_run_step_completed',
      data: { id: 'writing-complete', type: 'message_creation' },
    });
    expect(event).toMatchObject({
      phase: 'agent',
      label: 'Writing reply',
      state: before.state,
      owner: before.owner,
      sequence: before.sequence + 1,
    });
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  test('retains progress and duplicate/terminal suppression for reply creation steps', () => {
    const task = createVoiceTask({
      callSessionId: 'call-writing',
      userId: 'user-writing',
      streamId: 'stream-writing',
    });
    const step = {
      event: 'on_run_step',
      data: { id: 'writing-step', type: 'message_creation', current: 1, total: 2, unit: 'parts' },
    };
    const first = observeGenerationEvent(task.taskId, step);
    expect(first).toMatchObject({
      phase: 'agent',
      label: 'Writing reply',
      progress: { current: 1, total: 2, unit: 'parts' },
    });
    expect(observeGenerationEvent(task.taskId, step)).toBeNull();
    completeVoiceTask(task.taskId, { resultMessageId: 'reply-writing' });
    expect(
      observeGenerationEvent(task.taskId, { ...step, data: { ...step.data, id: 'late-step' } }),
    ).toBeNull();
  });

  test('creates a versioned task with monotonic events and a reconnect snapshot', () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      turnId: 'turn-1',
      streamId: 'stream-1',
      owner: { kind: 'generation_job', id: 'stream-1' },
    });
    const events = [];
    const unsubscribe = subscribeVoiceTask(task.taskId, (event) => events.push(event));

    observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'step-1', type: 'tool_call', name: 'web_search' },
    });
    completeVoiceTask(task.taskId, { resultMessageId: 'assistant-1' });
    unsubscribe();

    expect(events[0]).toMatchObject({
      version: 1,
      type: 'snapshot',
      state: 'running',
      taskId: task.taskId,
    });
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(events[1]).toMatchObject({ type: 'progress', phase: 'tool', state: 'running' });
    expect(events[2]).toMatchObject({
      type: 'result',
      state: 'completed',
      resultMessageId: 'assistant-1',
    });
  });

  test('keeps completed replies and follow-up binding when file delivery fails', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-delivery',
      userId: 'user-delivery',
      streamId: 'stream-delivery',
    });
    const retry = jest.fn();
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      retry,
      provideInput: jest.fn(),
    });
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { id: 'input-delivery', prompt: 'Choose', inputType: 'choice' },
    });
    const event = completeVoiceTask(task.taskId, {
      resultMessageId: 'reply-delivery',
      deliveryError: { code: 'native_output_file_unavailable', message: 'private path' },
    });
    expect(event).toMatchObject({
      state: 'completed',
      type: 'result',
      resultMessageId: 'reply-delivery',
      retryable: false,
      error: { code: 'native_output_file_unavailable', message: 'The file could not be attached.' },
    });
    expect(snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'reply-delivery',
      error: event.error,
    });
    await expect(retryVoiceTask(task.taskId, { userId: 'user-delivery' })).resolves.toMatchObject({
      ok: false,
    });
    expect(retry).not.toHaveBeenCalled();
  });

  test('records tools while cortex tracing stays with the detached owner', () => {
    const task = createVoiceTask({
      callSessionId: 'call-trace-1',
      userId: 'user-trace-1',
      conversationId: 'conv-trace-1',
      turnId: 'turn-trace-1',
      streamId: 'stream-trace-1',
      owner: { kind: 'generation_job', id: 'stream-trace-1' },
    });

    observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'tool-step-1', status: 'in_progress' },
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_run_step_completed',
      data: { id: 'non-tool-step', result: { id: 'non-tool-result', type: 'message' } },
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_run_step_completed',
      data: {
        result: {
          id: 'tool-step-1',
          type: 'tool_call',
          tool_call: { id: 'tool-call-1', name: 'web_search' },
        },
      },
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { id: 'cortex-1', status: 'running', cortex_name: 'private-name' },
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_cortex_followup',
      data: { id: 'cortex-1-followup', status: 'completed', text: 'private insight text' },
    });

    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(1);
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenNthCalledWith(1, {
      ownerId: 'user-trace-1',
      callSessionId: 'call-trace-1',
      turnId: 'turn-trace-1',
      eventRef: 'tool-step-1',
      stage: 'tool.completed',
      facts: {
        taskRef: task.taskId,
        streamRef: 'stream-trace-1',
        effectCount: 1,
      },
    });
    expect(JSON.stringify(mockRecordVoiceOrchestrationTraceBestEffort.mock.calls)).not.toContain(
      'private insight text',
    );
    expect(JSON.stringify(mockRecordVoiceOrchestrationTraceBestEffort.mock.calls)).not.toContain(
      'private-name',
    );
  });

  test('cancellation installs an idempotent suppression barrier before confirmation', () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'stream-1',
      owner: { kind: 'generation_job', id: 'stream-1' },
    });

    const first = cancelVoiceTask(task.taskId, { userId: 'user-1' });
    const second = cancelVoiceTask(task.taskId, { userId: 'user-1' });

    expect(first.task.state).toBe('cancelling');
    expect(isVoiceTaskSuppressed(task.taskId)).toBe(true);
    expect(second.event.eventId).toBe(first.event.eventId);
    expect(completeVoiceTask(task.taskId)).toBeNull();
  });

  test('requests real owner cancellation once and waits for authoritative callback confirmation', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-owner-cancel',
      userId: 'user-1',
      streamId: 'glasshive:run-1',
      owner: { kind: 'glasshive_run', id: 'run-1' },
    });
    const cancel = jest.fn().mockResolvedValue({ accepted: true, phase: 'cancelling' });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel,
      cancellationConfirmable: true,
    });

    const first = requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });
    expect(isVoiceTaskSuppressed(task.taskId)).toBe(true);
    const firstResult = await first;
    expect(getVoiceTask(task.taskId).state).toBe('cancelling');
    await flushVoiceTaskOwnerOperations();
    const replayResult = await requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-1',
    });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({
      ownerSupported: true,
      ownerAccepted: false,
      ownerPending: true,
    });
    expect(replayResult).toMatchObject({ ownerSupported: true, ownerAccepted: true });
    expect(getVoiceTask(task.taskId).state).toBe('cancelling');
    await confirmVoiceTaskOwnerCancellation(task.taskId, 'Signed worker callback confirmed stop.');
    expect(getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
  });

  test('returns the exact cancelling acknowledgement for duplicate requests', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-idempotent-cancel',
      userId: 'user-1',
      streamId: 'glasshive:run-idempotent',
      owner: { kind: 'glasshive_run', id: 'run-idempotent' },
    });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel: () => new Promise(() => {}),
      cancellationConfirmable: true,
    });
    const first = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });
    const second = await requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' });

    expect(second.event.eventId).toBe(first.event.eventId);
    expect(second.event.sequence).toBe(first.event.sequence);
    expect(second.operationId).toBe(first.operationId);
    expect(snapshotEvent(task.taskId).sequence).toBe(first.event.sequence);
  });

  test('allows only late signed cancellation proof to correct an unenforceable tombstone', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-late-proof',
      userId: 'user-1',
      streamId: 'glasshive:run-late-proof',
    });
    cancelVoiceTask(task.taskId, { userId: 'user-1' });
    await settleVoiceTaskCancellation(task.taskId, { confirmed: false });
    const before = snapshotEvent(task.taskId);
    const correction = await confirmVoiceTaskOwnerCancellation(
      task.taskId,
      'Signed run interrupted.',
    );

    expect(correction).toMatchObject({
      state: 'cancelled_confirmed',
      sequence: before.sequence + 1,
    });
  });

  test('times out a hung durable barrier before emitting cancelling', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-hung-barrier',
      userId: 'user-1',
      streamId: 'stream-hung-barrier',
    });
    const events = [];
    const unsubscribe = subscribeVoiceTask(task.taskId, (event) => events.push(event));
    const { setVoiceTaskSuppressionPersistenceForTests } = require('../VoiceTaskService');
    setVoiceTaskSuppressionPersistenceForTests({ persist: () => new Promise(() => {}) });
    await expect(
      requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-1' }),
    ).rejects.toMatchObject({ status: 503 });
    unsubscribe();
    expect(events.some((event) => event.state === 'cancelling')).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: 'recovering' });
  });

  test('expires owner action capabilities without advertising stale retry or cancellation', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-09T10:00:00.000Z'));
      const task = createVoiceTask({
        callSessionId: 'call-expired-capability',
        userId: 'user-1',
        streamId: 'glasshive:run-expired',
        owner: { kind: 'glasshive_run', id: 'run-expired' },
      });
      registerVoiceTaskOwnerAdapter(task.taskId, {
        kind: 'glasshive_run',
        retry: jest.fn(),
        cancel: jest.fn(),
        cancellationConfirmable: true,
        expiresAtMs: Date.now() + 1000,
      });
      jest.setSystemTime(new Date('2026-08-09T10:00:02.000Z'));

      failVoiceTask(task.taskId, { code: 'remote_failed', message: 'Stopped.' });
      expect(snapshotEvent(task.taskId)).toMatchObject({ retryable: false });
      expect(canConfirmVoiceTaskCancellation(task.taskId)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retains an unenforceable cancellation barrier through a two-hour late result', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-09T10:00:00.000Z'));
      const task = createVoiceTask({
        callSessionId: 'call-soak',
        userId: 'user-1',
        streamId: 'remote-soak-stream',
        owner: { kind: 'remote_generation', id: 'remote-soak-stream' },
      });
      cancelVoiceTask(task.taskId, { userId: 'user-1' });
      await settleVoiceTaskCancellation(task.taskId, { confirmed: false });

      jest.setSystemTime(new Date('2026-08-09T12:01:00.000Z'));

      expect(isVoiceTaskSuppressed(task.taskId)).toBe(true);
      expect(completeVoiceTask(task.taskId, { resultMessageId: 'late-result' })).toBeNull();
      expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'cancelled_unenforceable' });
    } finally {
      jest.useRealTimers();
    }
  });

  test('lists only tasks owned by the authenticated user', () => {
    createVoiceTask({ callSessionId: 'call-1', userId: 'user-1', streamId: 'stream-1' });
    createVoiceTask({ callSessionId: 'call-2', userId: 'user-2', streamId: 'stream-2' });

    expect(listVoiceTasks({ userId: 'user-1' })).toHaveLength(1);
    expect(getVoiceTask('missing')).toBeNull();
  });

  test('maps structured source, cortex, and needs-input events without forwarding unsafe payloads', () => {
    const task = createVoiceTask({
      callSessionId: 'call-1',
      userId: 'user-1',
      streamId: 'stream-1',
    });
    const sourceEvent = observeGenerationEvent(task.taskId, {
      event: 'on_source',
      data: {
        id: 'source-1',
        title: 'A'.repeat(500),
        url: 'javascript:alert(1)',
        provider: 'search',
        rawHtml: '<script>bad()</script>',
        token: 'secret',
      },
    });
    const cortexEvent = observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { id: 'cortex-1', status: 'brewing', cortex_name: 'Reality Check' },
    });
    const inputEvent = observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: {
        id: 'input-1',
        prompt: 'B'.repeat(1000),
        inputType: 'html',
        schema: { arbitrary: true },
      },
    });

    expect(sourceEvent.source).toEqual({
      id: 'source-1',
      title: 'A'.repeat(200),
      provider: 'search',
    });
    expect(JSON.stringify(sourceEvent)).not.toContain('script');
    expect(JSON.stringify(sourceEvent)).not.toContain('secret');
    expect(cortexEvent).toMatchObject({ type: 'progress', phase: 'cortex' });
    expect(inputEvent).toMatchObject({
      type: 'error',
      state: 'failed',
      error: { code: 'task_input_unsupported' },
    });
  });

  test('deduplicates repeated structured owner events while preserving event order', () => {
    const task = createVoiceTask({ callSessionId: 'call-1', userId: 'user-1', streamId: 's' });
    const first = observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { id: 'cortex-1', status: 'brewing', cortex_name: 'Support' },
    });
    const duplicate = observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { id: 'cortex-1', status: 'brewing', cortex_name: 'Support' },
    });
    const completed = observeGenerationEvent(task.taskId, {
      event: 'on_cortex_update',
      data: { id: 'cortex-1', status: 'complete', cortex_name: 'Support' },
    });

    expect(duplicate).toBeNull();
    expect(completed.sequence).toBe(first.sequence + 1);
  });

  test('emits progress only for authoritative bounded current and total values', () => {
    const task = createVoiceTask({ callSessionId: 'call-1', userId: 'user-1', streamId: 's' });
    const valid = observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'p-1', name: 'Indexing', current: 2, total: 5, unit: 'files' },
    });
    const ambiguous = observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'p-2', name: 'Searching', progress: 80 },
    });
    const invalid = observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: { id: 'p-3', name: 'Searching', current: 8, total: 5 },
    });

    expect(valid.progress).toEqual({ current: 2, total: 5, unit: 'files' });
    expect(ambiguous.progress).toBeUndefined();
    expect(invalid.progress).toBeUndefined();
  });

  test.each(['tool_call', ' TOOL_CALL '])(
    'marks tool completion structurally without requiring detail-text inference: %s',
    (type) => {
      const task = createVoiceTask({ callSessionId: 'call-tool', userId: 'user-1', streamId: 's' });
      const completed = observeGenerationEvent(task.taskId, {
        event: 'on_run_step_completed',
        data: {
          result: {
            id: 'step-complete',
            type,
            tool_call: { id: 'tool-call-complete', name: 'web_search' },
          },
        },
      });
      expect(completed).toMatchObject({
        type: 'progress',
        state: 'running',
        phase: 'tool_completed',
        label: 'web_search',
      });
    },
  );

  test('bounds long-running event and dedupe registries for soak safety', () => {
    const task = createVoiceTask({ callSessionId: 'call-soak', userId: 'user-1', streamId: 's' });
    for (let index = 0; index < 250; index += 1) {
      observeGenerationEvent(task.taskId, {
        event: 'on_run_step',
        data: { id: `step-${index}`, name: 'Work' },
      });
    }

    expect(getVoiceTaskRegistryStats()).toMatchObject({
      tasks: 1,
      events: 100,
      observedEventKeys: 100,
    });
  });

  test('maps actual tool-step and web-search attachment callback shapes', () => {
    const task = createVoiceTask({ callSessionId: 'call-real', userId: 'user-1', streamId: 's' });
    const events = [];
    const unsubscribe = subscribeVoiceTask(task.taskId, (event) => events.push(event));
    const tool = observeGenerationEvent(task.taskId, {
      event: 'on_run_step',
      data: {
        id: 'step-real',
        stepDetails: { tool_calls: [{ function: { name: 'web_search' } }] },
      },
    });
    const source = observeGenerationEvent(task.taskId, {
      event: 'attachment',
      data: {
        type: 'web_search',
        web_search: {
          organic: [
            { title: 'Primary result', link: 'https://example.com/result', secret: 'nope' },
            { title: 'Unsafe', link: 'javascript:alert(1)' },
          ],
          news: [{ title: 'News', link: 'https://news.example.com/story' }],
        },
      },
    });
    unsubscribe();

    expect(tool).toMatchObject({ phase: 'tool', label: 'web_search' });
    expect(source.source).toEqual({
      title: 'Primary result',
      provider: 'web_search',
      url: 'https://example.com/result',
    });
    expect(events.filter((event) => event.type === 'source')).toHaveLength(2);
    expect(JSON.stringify(events)).not.toContain('secret');
    expect(JSON.stringify(events)).not.toContain('javascript');
  });

  test('reconnect snapshot preserves bounded sources and current public state', () => {
    const task = createVoiceTask({
      callSessionId: 'call-snapshot',
      userId: 'user-1',
      streamId: 's',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      provideInput: jest.fn().mockResolvedValue({ accepted: true }),
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_source',
      data: { id: 'source-1', title: 'One', url: 'https://one.example.test' },
    });
    observeGenerationEvent(task.taskId, {
      event: 'on_source',
      data: { id: 'source-2', title: 'Two', url: 'https://two.example.test' },
    });
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { id: 'input-1', prompt: 'Choose a scope', inputType: 'choice' },
    });

    expect(snapshotEvent(task.taskId)).toMatchObject({
      version: 1,
      type: 'snapshot',
      state: 'needs_input',
      needsInput: { prompt: 'Choose a scope', inputType: 'choice' },
      sources: [
        { id: 'source-1', title: 'One', url: 'https://one.example.test/' },
        { id: 'source-2', title: 'Two', url: 'https://two.example.test/' },
      ],
    });
  });

  test('delivers required input through the installed owner adapter exactly once', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-input',
      userId: 'user-1',
      streamId: 'input-stream',
      owner: { kind: 'generation_job', id: 'input-stream' },
    });
    let releaseInput;
    const provideInput = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseInput = resolve;
        }),
    );
    expect(
      registerVoiceTaskOwnerAdapter(task.taskId, {
        kind: 'generation_job',
        provideInput,
      }),
    ).toMatchObject({ taskId: task.taskId });
    const needsInput = observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { id: 'input-needed-1', prompt: 'Which account?', inputType: 'text' },
    });

    const first = submitVoiceTaskInput(task.taskId, '  Example account  ', { userId: 'user-1' });
    const duplicate = submitVoiceTaskInput(task.taskId, 'Example account', { userId: 'user-1' });
    releaseInput({ accepted: true, phase: 'resuming', label: 'Continuing' });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

    expect(provideInput).toHaveBeenCalledTimes(1);
    expect(provideInput).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.taskId,
        input: 'Example account',
        operationId: expect.any(String),
      }),
    );
    expect(firstResult).toMatchObject({
      ok: true,
      event: { state: 'running', phase: 'resuming', sequence: needsInput.sequence + 1 },
      task: { state: 'running' },
    });
    expect(duplicateResult.event.eventId).toBe(firstResult.event.eventId);
    expect(snapshotEvent(task.taskId)).not.toHaveProperty('needsInput');
  });

  test('retries a failed task as a new child without resurrecting the terminal parent', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-retry',
      userId: 'user-1',
      streamId: 'failed-stream',
      owner: { kind: 'generation_job', id: 'failed-stream' },
    });
    const retry = jest.fn().mockResolvedValue({
      accepted: true,
      streamId: 'retry-stream',
      phase: 'restarted',
      label: 'Restarted',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', retry });
    const failed = require('../VoiceTaskService').failVoiceTask(task.taskId, {
      code: 'provider_failure',
      message: 'Provider unavailable',
    });

    expect(failed).toMatchObject({ state: 'failed', retryable: true });
    const liveEvents = [];
    const unsubscribe = subscribeVoiceTasksForCall('call-retry', (event) => liveEvents.push(event));
    const first = retryVoiceTask(task.taskId, { userId: 'user-1' });
    const duplicate = retryVoiceTask(task.taskId, { userId: 'user-1' });
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    unsubscribe();

    expect(retry).toHaveBeenCalledTimes(1);
    expect(firstResult).toMatchObject({
      ok: true,
      events: [
        { state: 'queued', phase: 'queued', sequence: 1, parentTaskId: task.taskId },
        { state: 'running', phase: 'starting', sequence: 2, parentTaskId: task.taskId },
      ],
      task: {
        taskId: expect.not.stringMatching(new RegExp(`^${task.taskId}$`)),
        parentTaskId: task.taskId,
        state: 'running',
        streamId: 'retry-stream',
        retryable: false,
      },
      previousTask: { taskId: task.taskId, state: 'failed' },
      previousEvent: {
        taskId: task.taskId,
        state: 'failed',
        phase: 'retried',
        retryable: false,
      },
    });
    expect(duplicateResult.event.eventId).toBe(firstResult.event.eventId);
    expect(snapshotEvent(task.taskId)).toMatchObject({
      state: 'failed',
      sequence: failed.sequence + 1,
      phase: 'retried',
      error: { code: 'provider_failure' },
    });
    expect(liveEvents.slice(-3)).toMatchObject([
      { taskId: task.taskId, state: 'failed', phase: 'retried' },
      { taskId: firstResult.task.taskId, state: 'queued', phase: 'queued' },
      { taskId: firstResult.task.taskId, state: 'running', phase: 'starting' },
    ]);
  });

  test('publishes child task events to call-scoped subscribers after the parent stream ends', async () => {
    const events = [];
    const unsubscribe = subscribeVoiceTasksForCall('call-live-child', (event) =>
      events.push(event),
    );
    const parent = createVoiceTask({
      callSessionId: 'call-live-child',
      userId: 'user-1',
      streamId: 'parent-generation-stream',
      owner: { kind: 'generation_job', id: 'parent-generation-stream' },
    });
    completeVoiceTask(parent.taskId, { resultMessageId: 'parent-result' });
    const child = createVoiceTask({
      callSessionId: 'call-live-child',
      userId: 'user-1',
      streamId: 'glasshive:run-live-child',
      parentTaskId: parent.taskId,
      owner: { kind: 'glasshive_run', id: 'run-live-child' },
    });
    observeGenerationEvent(child.taskId, {
      event: 'source',
      data: { eventId: 'child-source', source: { title: 'Live source', provider: 'glasshive' } },
    });
    unsubscribe();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: parent.taskId, state: 'completed' }),
        expect.objectContaining({
          taskId: child.taskId,
          parentTaskId: parent.taskId,
          state: 'running',
          type: 'source',
          source: { title: 'Live source', provider: 'glasshive' },
        }),
      ]),
    );
  });

  test('isolates a disconnected call subscriber from task production and other listeners', () => {
    const delivered = [];
    const unsubscribeBroken = subscribeVoiceTasksForCall('call-listener-isolation', () => {
      throw new Error('synthetic closed socket');
    });
    const unsubscribeHealthy = subscribeVoiceTasksForCall('call-listener-isolation', (event) =>
      delivered.push(event),
    );

    expect(() =>
      createVoiceTask({
        callSessionId: 'call-listener-isolation',
        userId: 'user-1',
        streamId: 'listener-isolation-stream',
      }),
    ).not.toThrow();
    unsubscribeBroken();
    unsubscribeHealthy();
    expect(delivered).toHaveLength(2);
  });

  test('isolates a failed task subscriber so durable success reaches later listeners', () => {
    const task = createVoiceTask({
      callSessionId: 'call-task-listener-isolation',
      userId: 'user-1',
      streamId: 'task-listener-isolation-stream',
    });
    let brokenDeliveries = 0;
    const delivered = [];
    const unsubscribeBroken = subscribeVoiceTask(task.taskId, () => {
      brokenDeliveries += 1;
      if (brokenDeliveries > 1) throw new Error('synthetic closed task socket');
    });
    const unsubscribeHealthy = subscribeVoiceTask(task.taskId, (event) => delivered.push(event));

    expect(() =>
      completeVoiceTask(task.taskId, { resultMessageId: 'durable-result' }),
    ).not.toThrow();
    unsubscribeBroken();
    unsubscribeHealthy();

    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'completed' });
    expect(snapshotEvent(task.taskId)).toMatchObject({ resultMessageId: 'durable-result' });
    expect(delivered.at(-1)).toMatchObject({
      type: 'result',
      state: 'completed',
      resultMessageId: 'durable-result',
    });
  });

  test('fails closed when capability flags lack a real owner adapter or ownership mismatches', async () => {
    const task = createVoiceTask({
      callSessionId: 'call-unsupported',
      userId: 'user-1',
      streamId: 'unsupported-stream',
    });
    setVoiceTaskOwnerCapabilities(task.taskId, { acceptsInput: true });

    expect(
      observeGenerationEvent(task.taskId, {
        event: 'needs_input',
        data: { id: 'input-unsupported', prompt: 'Choose', inputType: 'choice' },
      }),
    ).toMatchObject({ state: 'failed', retryable: false });
    await expect(
      submitVoiceTaskInput(task.taskId, 'answer', { userId: 'user-1' }),
    ).resolves.toMatchObject({ ok: false, code: 'input_unsupported' });
    await expect(retryVoiceTask(task.taskId, { userId: 'user-1' })).resolves.toMatchObject({
      ok: false,
      code: 'retry_unsupported',
    });
    expect(
      registerVoiceTaskOwnerAdapter(task.taskId, {
        kind: 'remote_generation',
        provideInput: jest.fn(),
      }),
    ).toBeNull();
  });

  test('reports input capability only from real scoped owner adapters', () => {
    const unsupported = createVoiceTask({
      callSessionId: 'call-capability-inventory',
      userId: 'user-1',
      streamId: 'unsupported-capability-stream',
      owner: { kind: 'generation_job', id: 'unsupported-capability-stream' },
    });
    const inputCapable = createVoiceTask({
      callSessionId: 'call-capability-inventory',
      userId: 'user-1',
      streamId: 'input-capability-stream',
      owner: { kind: 'future_input_owner', id: 'future-run' },
    });
    createVoiceTask({
      callSessionId: 'another-call',
      userId: 'user-1',
      streamId: 'foreign-capability-stream',
      owner: { kind: 'foreign_owner', id: 'foreign-run' },
    });
    setVoiceTaskOwnerCapabilities(unsupported.taskId, { acceptsInput: true });
    registerVoiceTaskOwnerAdapter(inputCapable.taskId, {
      kind: 'future_input_owner',
      provideInput: jest.fn(),
    });

    expect(
      getVoiceTaskOwnerCapabilityInventory({
        callSessionId: 'call-capability-inventory',
        userId: 'user-1',
      }),
    ).toEqual({
      authoritative: true,
      source: 'runtime_voice_task_owner_registry',
      owners: [
        { kind: 'future_input_owner', acceptsInput: true },
        { kind: 'generation_job', acceptsInput: false },
      ],
    });
  });

  test('classifies remote owners as cancellation-unconfirmable without exposing internal flags', () => {
    const task = createVoiceTask({
      callSessionId: 'call-remote',
      userId: 'user-1',
      streamId: 'remote-stream',
    });
    const updated = setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      cancellationConfirmable: false,
    });
    expect(updated).toMatchObject({ owner: { kind: 'remote_generation' } });
    expect(updated).not.toHaveProperty('cancellationConfirmable');
    expect(updated).not.toHaveProperty('suppressed');
  });

  test('reconnect snapshot preserves result and classified error fields', () => {
    const completed = createVoiceTask({
      callSessionId: 'call-complete',
      userId: 'user-1',
      streamId: 'complete',
    });
    completeVoiceTask(completed.taskId, { resultMessageId: 'message-result-1' });
    expect(snapshotEvent(completed.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'message-result-1',
    });

    const failed = createVoiceTask({
      callSessionId: 'call-failed',
      userId: 'user-1',
      streamId: 'failed',
    });
    const { failVoiceTask } = require('../VoiceTaskService');
    failVoiceTask(failed.taskId, { code: 'provider_failure', message: 'Provider unavailable' });
    expect(snapshotEvent(failed.taskId)).toMatchObject({
      state: 'failed',
      error: { code: 'provider_failure', message: 'Provider unavailable' },
    });
  });
});

describe('Stop execution owner barrier', () => {
  const service = require('../VoiceTaskService');
  beforeEach(() => service.resetVoiceTasksForTests());

  test.each(['capabilities', 'stream'])(
    'terminal Stop persistence cannot confirm a late %s replacement',
    async (transition) => {
      const scope = { userId: 'owner-stop', callSessionId: 'call-stop' };
      const owner = { kind: 'remote_generation', id: 'stream-stopped' };
      const task = service.createVoiceTask({ ...scope, streamId: owner.id, owner });
      let releaseWrite;
      let enteredWrite;
      const entered = new Promise((resolve) => {
        enteredWrite = resolve;
      });
      const held = new Promise((resolve) => {
        releaseWrite = resolve;
      });
      const tombstones = [];
      service.setVoiceTaskSuppressionPersistenceForTests({
        persist: async (row) => {
          tombstones.push(row);
          if (row.state === 'cancelled_confirmed') {
            enteredWrite();
            await held;
          }
        },
      });
      const cancel = jest.fn(async () => ({
        accepted: Boolean(
          await service.confirmVoiceTaskOwnerCancellation(task.taskId, 'Released.'),
        ),
      }));
      service.registerVoiceTaskOwnerAdapter(task.taskId, { kind: owner.kind, cancel });
      const request = await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      await entered;
      expect(request.ownerSupported).toBe(true);
      const replacement =
        transition === 'capabilities'
          ? service.setVoiceTaskOwnerCapabilities(task.taskId, {
              kind: 'remote_generation',
              ownerId: 'replacement-stream',
            })
          : service.bindVoiceTaskStream(task.taskId, 'replacement-stream', scope);
      releaseWrite();
      await service.flushVoiceTaskOwnerOperations();
      expect(service.getVoiceTask(task.taskId)).toMatchObject({
        state: 'cancelled_confirmed',
        streamId: owner.id,
        owner,
      });
      expect(replacement).toBeNull();
      expect(tombstones.at(-1)).toMatchObject({ state: 'cancelled_confirmed', owner });
      expect(service.getVoiceTaskByStreamId('replacement-stream')).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  test.each(['capabilities', 'stream'])(
    'a preparing durable Stop blocks a late %s replacement',
    (transition) => {
      const scope = { userId: 'owner-stop', callSessionId: 'call-stop' };
      const owner = { kind: 'generation_job', id: 'stream-stopped' };
      const task = service.createVoiceTask({ ...scope, streamId: owner.id, owner });
      service.cancelVoiceTask(task.taskId, { userId: scope.userId, deferEvent: true });
      const result =
        transition === 'capabilities'
          ? service.setVoiceTaskOwnerCapabilities(task.taskId, {
              kind: 'remote_generation',
              ownerId: owner.id,
            })
          : service.bindVoiceTaskStream(task.taskId, 'replacement-stream', scope);
      expect(result).toBeNull();
      expect(service.getVoiceTask(task.taskId)).toMatchObject({ streamId: owner.id, owner });
      expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
    },
  );

  test('normal initialized generation to remote setup retains its installed native Stop', async () => {
    const { bindHarnessCancellation } = require('../GlassHiveConversationProviderService');
    const { GenerationJobManager } = require('@librechat/api');
    const scope = { userId: 'owner-setup', callSessionId: 'call-setup' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'stream-setup',
      owner: { kind: 'generation_job', id: 'stream-setup' },
    });
    const controller = new AbortController();
    const req = {
      user: { id: scope.userId },
      body: {
        voiceMode: true,
        viventiumVoiceTaskId: task.taskId,
        viventiumActorTrust: 'owner_participant',
        viventiumCanAuthorizeSideEffects: true,
      },
      viventiumVoiceWorkAuthority: { callSessionId: scope.callSessionId },
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'setup:exact',
      _viventiumNativeVoiceInputPolling: Promise.resolve(),
    };
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ capacityReleased: true }),
    }));
    const abort = jest.spyOn(GenerationJobManager, 'abortJob').mockImplementation(async () => {
      controller.abort('user_cancelled');
      return { success: true };
    });
    try {
      bindHarnessCancellation({
        req,
        signal: controller.signal,
        fetchImpl,
        endpointConfig: { baseURL: 'http://native.test/v1', apiKey: 'synthetic-key' },
      });
      service.setVoiceTaskOwnerCapabilities(task.taskId, {
        kind: 'remote_generation',
        ownerId: 'stream-setup',
        cancellationConfirmable: false,
      });
      const cancellation = await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      await service.flushVoiceTaskOwnerOperations();
      expect(cancellation.ownerSupported).toBe(true);
      expect(abort).toHaveBeenCalledWith('stream-setup', 'user_cancelled', scope.userId);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(service.getVoiceTask(task.taskId)).toMatchObject({
        state: 'cancelled_confirmed',
        owner: { kind: 'remote_generation', id: 'stream-setup' },
      });
    } finally {
      abort.mockRestore();
    }
  });

  test.each([
    { kind: 'generation_job', ownerId: 'other-stream' },
    { kind: 'remote_generation', ownerId: 'other-stream' },
    { kind: 'glasshive_run', ownerId: 'stream-setup' },
  ])('normal setup cannot migrate capabilities to a different owner: %j', async (next) => {
    const scope = { userId: 'owner-setup', callSessionId: 'call-setup' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'stream-setup',
      owner: { kind: 'generation_job', id: 'stream-setup' },
    });
    const cancel = jest.fn(async () => ({ accepted: true }));
    service.registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', cancel });
    service.setVoiceTaskOwnerCapabilities(task.taskId, next);
    const cancellation = await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    await service.flushVoiceTaskOwnerOperations();
    await new Promise(setImmediate);
    expect(cancellation.ownerSupported).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  test('migrated input keeps its owner check until normal input re-registration', async () => {
    const scope = { userId: 'owner-setup', callSessionId: 'call-setup' };
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'stream-setup',
      owner: { kind: 'generation_job', id: 'stream-setup' },
    });
    const cancel = jest.fn(async () => ({ accepted: true }));
    const oldInput = jest.fn(async () => {
      if (service.getVoiceTask(task.taskId).owner.kind !== 'generation_job')
        throw new Error('voice_native_input_owner_changed');
      return { accepted: true };
    });
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'generation_job',
      cancel,
      provideInput: oldInput,
    });
    service.observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { prompt: 'Proceed?' },
    });
    service.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      ownerId: 'stream-setup',
    });
    expect(await service.submitVoiceTaskInput(task.taskId, 'allow', scope)).toMatchObject({
      ok: false,
      code: 'owner_input_failed',
    });
    const currentInput = jest.fn(async () => ({ accepted: true }));
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'remote_generation',
      preserveExisting: true,
      provideInput: currentInput,
    });
    expect(await service.submitVoiceTaskInput(task.taskId, 'allow', scope)).toMatchObject({
      ok: true,
    });
    expect(oldInput).toHaveBeenCalledTimes(1);
    expect(currentInput).toHaveBeenCalledTimes(1);
    await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    await service.flushVoiceTaskOwnerOperations();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('failed native foreground attention Cancel', () => {
  const service = require('../VoiceTaskService');
  const { bindHarnessCancellation } = require('../GlassHiveConversationProviderService');
  const { GenerationJobManager } = require('@librechat/api');
  const scope = { userId: 'owner-attention', callSessionId: 'call-attention' };
  let abort;
  beforeEach(() => {
    service.resetVoiceTasksForTests();
    abort = jest.spyOn(GenerationJobManager, 'abortJob').mockResolvedValue({ success: false });
  });
  afterEach(() => abort.mockRestore());
  const setup = (nativeResult = { capacityReleased: true, state: 'cancelled' }) => {
    const task = service.createVoiceTask({
      ...scope,
      streamId: 'stream-attention',
      owner: { kind: 'generation_job', id: 'stream-attention' },
    });
    const controller = new AbortController();
    const req = {
      user: { id: scope.userId },
      body: {
        voiceMode: true,
        viventiumVoiceTaskId: task.taskId,
        viventiumActorTrust: 'owner_participant',
        viventiumCanAuthorizeSideEffects: true,
      },
      viventiumVoiceWorkAuthority: { callSessionId: scope.callSessionId },
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:attention-exact',
      _viventiumNativeVoiceInputPolling: Promise.resolve(),
    };
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => nativeResult }));
    bindHarnessCancellation({
      req,
      signal: controller.signal,
      fetchImpl,
      endpointConfig: { baseURL: 'http://native.test/v1', apiKey: 'synthetic-key' },
    });
    service.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      ownerId: 'stream-attention',
      cancellationConfirmable: false,
    });
    return { task, req, controller, fetchImpl };
  };

  test('explicit attention Cancel releases the captured exact request without aborting a retired Core job', async () => {
    const { task, req, controller, fetchImpl } = setup();
    controller.abort('provider_progress_stalled');
    const failed = service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    expect(failed).toMatchObject({
      state: 'failed',
      cancellable: true,
      retryable: false,
      error: { code: 'provider_progress_stalled' },
    });
    expect(service.snapshotEvent(task.taskId).cancellable).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
    req._viventiumHarnessIdempotencyKey = 'main:later-request';
    const cancelled = await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    expect(cancelled).toMatchObject({ ownerSupported: true, task: { state: 'cancelling' } });
    await service.flushVoiceTaskOwnerOperations();
    expect(abort).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://native.test/v1/requests/by-idempotency/main%3Aattention-exact/cancel',
    );
    expect(fetchImpl.mock.calls[0][1].headers['X-Viventium-User-Id']).toBe(scope.userId);
    expect(service.getVoiceTask(task.taskId)).toMatchObject({
      state: 'cancelled_confirmed',
      owner: { kind: 'remote_generation', id: 'stream-attention' },
    });
    expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
      alreadyCancelled: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('does not confirm a rejected native release', async () => {
    const { task, fetchImpl } = setup();
    fetchImpl.mockResolvedValue({ ok: false, status: 403 });
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    await service.flushVoiceTaskOwnerOperations();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.getVoiceTask(task.taskId).state).toBe('cancelled_unenforceable');
    expect(abort).not.toHaveBeenCalled();
  });

  test('normal native Stop retains creation identity and its pending operation across exact barrier hydration', async () => {
    const { task, controller, fetchImpl } = setup();
    const originalCreatedAt = service.getVoiceTask(task.taskId).createdAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    let release;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let hydrated;
    const afterHydrate = new Promise((resolve) => {
      hydrated = resolve;
    });
    abort.mockImplementation(async () => {
      controller.abort('user_cancelled');
      await service.hydrateVoiceTaskSuppression(task.taskId, scope);
      hydrated();
      return { success: true };
    });
    try {
      await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      await afterHydrate;
      expect(service.getVoiceTask(task.taskId)).toMatchObject({
        state: 'cancelling',
        createdAt: originalCreatedAt,
        owner: { kind: 'remote_generation', id: 'stream-attention' },
      });
      release({ ok: true, json: async () => ({ capacityReleased: true }) });
      await service.flushVoiceTaskOwnerOperations();
      await new Promise(setImmediate);
      expect(service.getVoiceTask(task.taskId)).toMatchObject({
        state: 'cancelled_confirmed',
        createdAt: originalCreatedAt,
      });
      expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
        alreadyCancelled: true,
      });
    } finally {
      release?.({ ok: true, json: async () => ({ capacityReleased: true }) });
      await service.flushVoiceTaskOwnerOperations();
      await new Promise(setImmediate);
    }
  });

  test('normal native Stop still rejects a changed task creation identity', async () => {
    const get = service.getVoiceTask;
    let invalid = false;
    const read = jest.spyOn(service, 'getVoiceTask').mockImplementation((id) => {
      const task = get(id);
      return invalid && task ? { ...task, createdAt: '2001-01-01T00:00:00.000Z' } : task;
    });
    const { task, controller, fetchImpl } = setup();
    abort.mockImplementation(async () => {
      controller.abort('user_cancelled');
      invalid = true;
      return { success: true };
    });
    try {
      await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      await service.flushVoiceTaskOwnerOperations();
      expect(get(task.taskId).state).toBe('cancelled_unenforceable');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
  });

  test('duplicate in-flight attention Cancel waits for one native release and preserves accepted Worker work', async () => {
    const { task, fetchImpl } = setup();
    const worker = service.createVoiceTask({
      ...scope,
      streamId: 'worker-delivery',
      owner: { kind: 'glasshive_run', id: 'accepted-worker' },
    });
    let release;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    expect(service.getVoiceTask(task.taskId).state).toBe('cancelling');
    expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
      alreadyCancelling: true,
      ownerPending: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    release({ ok: true, json: async () => ({ capacityReleased: true, state: 'cancelled' }) });
    await service.flushVoiceTaskOwnerOperations();
    expect(service.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    expect(service.getVoiceTask(worker.taskId)).toMatchObject({
      state: 'running',
      owner: { kind: 'glasshive_run', id: 'accepted-worker' },
    });
    expect(service.isVoiceTaskSuppressed(worker.taskId)).toBe(false);
  });

  test('does not release the captured request after its foreground owner is rebound', async () => {
    const { task, fetchImpl } = setup();
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    service.bindVoiceTaskStream(task.taskId, 'newer-stream', scope);
    expect(service.snapshotEvent(task.taskId).cancellable).toBe(false);
    expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
      alreadyInactive: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  test('native completion wins the explicit Stop race', async () => {
    const { task } = setup({ capacityReleased: true, state: 'completed' });
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
    await service.flushVoiceTaskOwnerOperations();
    expect(service.getVoiceTask(task.taskId).state).toBe('completed');
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(false);
  });

  test('explicit attention Stop retry crosses the durable barrier before native delivery', async () => {
    const { task, fetchImpl } = setup();
    const persist = jest
      .fn()
      .mockRejectedValueOnce(new Error('private store unavailable'))
      .mockResolvedValue(undefined);
    service.setVoiceTaskSuppressionPersistenceForTests({ persist });
    try {
      service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
      await expect(
        service.requestVoiceTaskOwnerCancellation(task.taskId, scope),
      ).rejects.toMatchObject({ code: 'gateway_down' });
      expect(service.getVoiceTask(task.taskId)).toMatchObject({
        state: 'recovering',
        cancellable: true,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      await service.requestVoiceTaskOwnerCancellation(task.taskId, scope);
      await service.flushVoiceTaskOwnerOperations();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(abort).not.toHaveBeenCalled();
      expect(service.getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
    } finally {
      service.setVoiceTaskSuppressionPersistenceForTests(null);
    }
  });

  test.each(['provider_unavailable', 'server_error', 'provider_timeout'])(
    'keeps ordinary failed %s tasks inactive',
    async (code) => {
      const { task, fetchImpl } = setup();
      service.failVoiceTask(task.taskId, { code });
      expect(service.snapshotEvent(task.taskId).cancellable).toBe(false);
      expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
        alreadyInactive: true,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(abort).not.toHaveBeenCalled();
    },
  );

  test('rejects a foreign owner without suppressing the attention task', async () => {
    const { task, fetchImpl } = setup();
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    expect(
      await service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'other-owner' }),
    ).toBeNull();
    expect(service.getVoiceTask(task.taskId).state).toBe('failed');
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['generation_job', 'glasshive_run'])(
    'does not grant failed Cancel to an ordinary %s owner adapter',
    async (kind) => {
      const task = service.createVoiceTask({
        ...scope,
        streamId: 'stream-attention',
        owner: { kind, id: 'stream-attention' },
      });
      const cancel = jest.fn(async () => ({ accepted: true }));
      service.registerVoiceTaskOwnerAdapter(task.taskId, {
        kind,
        cancel,
        ...(kind === 'glasshive_run' ? { cancelFailedProviderAttention: true } : {}),
      });
      service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
      expect(service.snapshotEvent(task.taskId).cancellable).toBe(false);
      expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
        alreadyInactive: true,
      });
      expect(cancel).not.toHaveBeenCalled();
    },
  );

  test('an expired native owner capability hides failed Cancel', async () => {
    const { task, fetchImpl } = setup();
    service.failVoiceTask(task.taskId, { code: 'provider_progress_stalled' });
    service.registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'remote_generation',
      preserveExisting: true,
      expiresAtMs: Date.now() - 1,
    });
    expect(service.snapshotEvent(task.taskId).cancellable).toBe(false);
    expect(await service.requestVoiceTaskOwnerCancellation(task.taskId, scope)).toMatchObject({
      alreadyInactive: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('generation-owned voice task settlement', () => {
  const service = require('../VoiceTaskService');
  const scope = { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' };
  const create = () =>
    service.createVoiceTask({ ...scope, owner: { kind: 'generation_job', id: 'stream-1' } });
  beforeEach(() => service.resetVoiceTasksForTests());

  test.each(['none', 'disconnected'])(
    'persists terminal state with %s task subscribers and replays it once',
    async (mode) => {
      const task = create();
      if (mode === 'disconnected') service.subscribeVoiceTask(task.taskId, jest.fn())();
      await service.settleVoiceTaskGeneration(task.taskId, scope, { resultMessageId: 'result-1' });
      expect(service.snapshotEvent(task.taskId)).toMatchObject({
        state: 'completed',
        resultMessageId: 'result-1',
      });
      const first = service.snapshotEvent(task.taskId);
      await service.settleVoiceTaskGeneration(task.taskId, scope, { resultMessageId: 'result-1' });
      const replay = jest.fn();
      service.subscribeVoiceTask(task.taskId, replay)();
      expect(replay).toHaveBeenCalledTimes(1);
      expect(replay.mock.calls[0][0]).toMatchObject({
        sequence: first.sequence,
        state: 'completed',
      });
    },
  );

  test.each(['userId', 'callSessionId', 'streamId'])(
    'rejects a foreign %s completion',
    async (key) => {
      const task = create();
      expect(
        await service.settleVoiceTaskGeneration(task.taskId, { ...scope, [key]: 'foreign' }, {}),
      ).toBeNull();
      expect(service.getVoiceTask(task.taskId).state).toBe('running');
    },
  );

  test('preserves explicit cancellation and independent pending child work', async () => {
    const parent = create();
    service.markVoiceTaskAwaitingOwnerResult(parent.taskId, 'pending-child');
    await service.settleVoiceTaskGeneration(parent.taskId, scope, {
      resultMessageId: 'parent-result',
    });
    expect(service.getVoiceTask(parent.taskId).state).toBe('running');
    service.linkVoiceTaskOwnerChild(parent.taskId, {
      continuationKey: 'pending-child',
      resolvedOwnerId: 'child-1',
    });
    expect(service.getVoiceTask(parent.taskId).state).toBe('completed');
    service.resetVoiceTasksForTests();
    const cancelled = create();
    service.cancelVoiceTask(cancelled.taskId, { userId: scope.userId });
    expect(await service.settleVoiceTaskGeneration(cancelled.taskId, scope, {})).toBeNull();
    expect(service.getVoiceTask(cancelled.taskId).state).toBe('cancelling');
  });

  test('records provider failure and does not overwrite a different execution owner', async () => {
    const task = create();
    service.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'glasshive_run',
      ownerId: 'worker-run',
    });
    expect(await service.settleVoiceTaskGeneration(task.taskId, scope, {})).toBeNull();
    service.setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      ownerId: scope.streamId,
    });
    await service.settleVoiceTaskGeneration(task.taskId, scope, {
      error: { code: 'provider_unavailable', message: 'Provider unavailable' },
    });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'failed',
      error: { code: 'provider_unavailable' },
    });
  });
});

describe('Voice result presentation freshness', () => {
  beforeEach(() => resetVoiceTasksForTests());
  function receipt() {
    return {
      status: 'recorded',
      ownerStreamId: 'presentation-stream',
      acknowledgement: { logical_turn_id: 'presentation-turn', revision: 1, state: 'committed' },
      presentation: {
        userId: 'presentation-owner',
        conversationId: 'presentation-chat',
        responseMessageId: 'presentation-reply',
        interactionContext: {
          surface: 'voice',
          logical_turn_id: 'presentation-turn',
          revision: 1,
          conversation_id: 'presentation-chat',
        },
      },
    };
  }
  function completed() {
    const scope = {
      callSessionId: 'presentation-call',
      userId: 'presentation-owner',
      conversationId: 'presentation-chat',
      logicalTurnId: 'presentation-turn',
    };
    const task = createVoiceTask({ ...scope, streamId: 'presentation-stream' });
    bindVoiceTaskStream(task.taskId, 'presentation-stream', scope);
    completeVoiceTask(task.taskId, { resultMessageId: 'presentation-reply' });
    return task;
  }
  test('publishes one metadata snapshot after presentation and preserves completion and result identity', async () => {
    const task = completed(),
      before = snapshotEvent(task.taskId),
      seen = [];
    const unsubscribe = subscribeVoiceTasksForCall('presentation-call', (event) =>
      seen.push(event),
    );
    const snapshot = await refreshVoiceTaskCommittedPresentation(receipt(), 'voice');
    expect(snapshot).toMatchObject({
      type: 'snapshot',
      state: 'completed',
      resultMessageId: 'presentation-reply',
      sequence: before.sequence + 1,
      cancellable: false,
    });
    expect(seen.filter((event) => event.type === 'result')).toHaveLength(0);
    expect(seen.filter((event) => event.type === 'snapshot')).toHaveLength(1);
    expect(
      await refreshVoiceTaskCommittedPresentation({ ...receipt(), idempotent: true }, 'voice'),
    ).toBeNull();
    expect(snapshotEvent(task.taskId).sequence).toBe(snapshot.sequence);
    unsubscribe();
  });
  test('does not refresh from another adapter, foreign owner, stale result, failed or removed delivery', async () => {
    const task = completed(),
      sequence = snapshotEvent(task.taskId).sequence;
    expect(await refreshVoiceTaskCommittedPresentation(receipt(), 'telegram')).toBeNull();
    const foreign = receipt();
    foreign.presentation.userId = 'foreign';
    expect(await refreshVoiceTaskCommittedPresentation(foreign, 'voice')).toBeNull();
    const stale = receipt();
    stale.presentation.responseMessageId = 'foreign';
    expect(await refreshVoiceTaskCommittedPresentation(stale, 'voice')).toBeNull();
    for (const state of ['failed', 'partial_removed']) {
      const failed = receipt();
      failed.acknowledgement.state = state;
      expect(await refreshVoiceTaskCommittedPresentation(failed, 'voice')).toBeNull();
    }
    expect(snapshotEvent(task.taskId).sequence).toBe(sequence);
  });
});

describe('completed generation native playout Stop', () => {
  const service = require('../VoiceTaskService');
  beforeEach(() => service.resetVoiceTasksForTests());
  function fixture(suffix = '1') {
    const task = service.createVoiceTask({
      callSessionId: 'call-playout',
      userId: 'user-playout',
      streamId: `stream-playout-${suffix}`,
      owner: { kind: 'remote_generation', id: `stream-playout-${suffix}` },
    });
    service.completeVoiceTask(task.taskId, { resultMessageId: `result-${suffix}` });
    return task;
  }
  function stage(task, state = 'audio.started', ref = 'speech-1', startedAtMs = 1000) {
    return service.recordVoiceTaskPresentation(task.taskId, {
      userId: 'user-playout',
      callSessionId: 'call-playout',
      streamId: task.streamId,
      presentationRef: ref,
      stage: state,
      startedAtMs,
    });
  }
  test('complete text retains its result while exact native speech remains stoppable', async () => {
    const task = fixture();
    const ownerCancel = jest.fn();
    service.registerVoiceTaskOwnerAdapter(task.taskId, { cancel: ownerCancel });
    const start = stage(task);
    expect(start).toMatchObject({
      state: 'completed',
      cancellable: false,
      resultMessageId: 'result-1',
      presentation: { ref: 'speech-1', state: 'speaking', startedAtMs: 1000 },
    });
    const stop = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-playout',
      stopPresentationIfCompleted: true,
      presentationRef: 'speech-1',
    });
    expect(stop.presentationStopRequested).toBe(true);
    expect(stop.event).toMatchObject({
      type: 'state',
      state: 'completed',
      cancellable: false,
      resultMessageId: 'result-1',
      presentation: { ref: 'speech-1', state: 'stop_requested' },
    });
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(false);
    expect(ownerCancel).not.toHaveBeenCalled();
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'result-1',
      presentation: { state: 'stop_requested' },
    });
    const duplicate = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-playout',
      stopPresentationIfCompleted: true,
      presentationRef: 'speech-1',
    });
    expect(duplicate.event.eventId).not.toBe(stop.event.eventId);
    expect(duplicate.event.sequence).toBe(stop.event.sequence + 1);
  });
  test('retry publishes fresh completed speech Stop to both task and call listeners after a lost delivery', async () => {
    const task = fixture();
    stage(task);
    const taskEvents = [];
    const callEvents = [];
    const receivedAfterLostFirst = [];
    const unsubscribeTask = service.subscribeVoiceTask(task.taskId, (event) => {
      if (event.presentation?.state !== 'stop_requested') return;
      taskEvents.push(event);
      if (taskEvents.length > 1) receivedAfterLostFirst.push(event);
    });
    const unsubscribeCall = service.subscribeVoiceTasksForCall('call-playout', (event) =>
      callEvents.push(event),
    );
    try {
      const first = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
        userId: 'user-playout',
        stopPresentationIfCompleted: true,
        presentationRef: 'speech-1',
      });
      const retry = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
        userId: 'user-playout',
        stopPresentationIfCompleted: true,
        presentationRef: 'speech-1',
      });
      expect(taskEvents).toEqual([first.event, retry.event]);
      expect(callEvents).toEqual([first.event, retry.event]);
      expect(receivedAfterLostFirst).toEqual([retry.event]);
      expect(retry.event.eventId).not.toBe(first.event.eventId);
      expect(retry.event.sequence).toBe(first.event.sequence + 1);
      expect(retry.event.presentation).toEqual(first.event.presentation);
      expect(retry.event).toMatchObject({
        state: 'completed',
        resultMessageId: 'result-1',
        cancellable: false,
        retryable: false,
        owner: task.owner,
        streamId: task.streamId,
      });
    } finally {
      unsubscribeTask();
      unsubscribeCall();
    }
  });
  test('repeated completed speech Stop preserves generation, results and unrelated task without a cancellation barrier', async () => {
    const task = fixture();
    stage(task);
    const other = fixture('unrelated');
    const otherBefore = service.snapshotEvent(other.taskId);
    const cancel = jest.fn();
    const persist = jest.fn();
    service.registerVoiceTaskOwnerAdapter(task.taskId, { cancel });
    service.setVoiceTaskSuppressionPersistenceForTests({ persist });
    const events = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      events.push(
        (
          await service.requestVoiceTaskOwnerCancellation(task.taskId, {
            userId: 'user-playout',
            stopPresentationIfCompleted: true,
            presentationRef: 'speech-1',
          })
        ).event,
      );
    }
    expect(new Set(events.map((event) => event.eventId)).size).toBe(3);
    expect(events.map((event) => event.sequence)).toEqual([
      events[0].sequence,
      events[0].sequence + 1,
      events[0].sequence + 2,
    ]);
    expect(cancel).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(service.isVoiceTaskSuppressed(task.taskId)).toBe(false);
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'result-1',
      owner: task.owner,
      presentation: { ref: 'speech-1', state: 'stop_requested' },
    });
    expect(service.snapshotEvent(other.taskId)).toMatchObject({
      sequence: otherBefore.sequence,
      state: otherBefore.state,
      resultMessageId: 'result-unrelated',
    });
  });
  test('pending speech retry rejects another owner, stale ref and terminal ref without publishing', async () => {
    const task = fixture();
    stage(task);
    await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-playout',
      stopPresentationIfCompleted: true,
      presentationRef: 'speech-1',
    });
    const events = [];
    const unsubscribe = service.subscribeVoiceTasksForCall('call-playout', (event) =>
      events.push(event),
    );
    try {
      expect(
        await service.requestVoiceTaskOwnerCancellation(task.taskId, {
          userId: 'other-user',
          stopPresentationIfCompleted: true,
          presentationRef: 'speech-1',
        }),
      ).toBeNull();
      expect(
        (
          await service.requestVoiceTaskOwnerCancellation(task.taskId, {
            userId: 'user-playout',
            stopPresentationIfCompleted: true,
            presentationRef: 'stale-ref',
          })
        ).alreadyCompleted,
      ).toBe(true);
      expect(events).toEqual([]);
      stage(task, 'audio.interrupted');
      events.length = 0;
      const settled = service.snapshotEvent(task.taskId);
      expect(
        (
          await service.requestVoiceTaskOwnerCancellation(task.taskId, {
            userId: 'user-playout',
            stopPresentationIfCompleted: true,
            presentationRef: 'speech-1',
          })
        ).alreadyCompleted,
      ).toBe(true);
      expect(events).toEqual([]);
      expect(service.snapshotEvent(task.taskId)).toMatchObject({
        sequence: settled.sequence,
        state: 'completed',
        resultMessageId: 'result-1',
        presentation: { state: 'interrupted' },
      });
    } finally {
      unsubscribe();
    }
  });
  test('default management Stop and stale presentation keep already-completed behavior', async () => {
    const task = fixture();
    stage(task);
    expect(
      (await service.requestVoiceTaskOwnerCancellation(task.taskId, { userId: 'user-playout' }))
        .alreadyCompleted,
    ).toBe(true);
    const stale = await service.requestVoiceTaskOwnerCancellation(task.taskId, {
      userId: 'user-playout',
      stopPresentationIfCompleted: true,
      presentationRef: 'old-speech',
    });
    expect(stale.alreadyCompleted).toBe(true);
    expect(stale.presentationStopRequested).toBeUndefined();
    expect(service.snapshotEvent(task.taskId).presentation.state).toBe('speaking');
  });
  test('new native active presentation clears old Stop visibility without changing job results', () => {
    const oldTask = fixture('old');
    const newTask = fixture('new');
    stage(oldTask, 'audio.started', 'speech-old', 1000);
    stage(newTask, 'audio.started', 'speech-new', 2000);
    expect(service.snapshotEvent(oldTask.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'result-old',
      presentation: { state: 'superseded' },
    });
    expect(service.snapshotEvent(newTask.taskId).presentation.state).toBe('speaking');
    expect(stage(oldTask, 'audio.started', 'delayed-old', 1500)).toBeNull();
    expect(service.snapshotEvent(newTask.taskId).presentation.state).toBe('speaking');
  });
  test('terminal before started and duplicate started cannot resurrect old speech', () => {
    const task = fixture();
    stage(task, 'audio.completed');
    stage(task, 'audio.started');
    expect(service.snapshotEvent(task.taskId).presentation.state).toBe('completed');
    stage(task, 'audio.started', 'speech-2', 2000);
    stage(task, 'audio.interrupted', 'speech-1', 1000);
    expect(service.snapshotEvent(task.taskId).presentation).toEqual({
      ref: 'speech-2',
      state: 'speaking',
      startedAtMs: 2000,
    });
  });
  test('speech start before text final survives text completion and reconnect snapshots', () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-playout',
      userId: 'user-playout',
      streamId: 'stream-live',
      owner: { kind: 'generation_job', id: 'stream-live' },
    });
    stage(task);
    service.completeVoiceTask(task.taskId, { resultMessageId: 'result-live' });
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'result-live',
      presentation: { ref: 'speech-1', state: 'speaking' },
    });
    stage(task, 'audio.interrupted');
    expect(service.snapshotEvent(task.taskId)).toMatchObject({
      state: 'completed',
      resultMessageId: 'result-live',
      presentation: { state: 'interrupted' },
    });
  });
  test.each([
    { userId: 'other-user' },
    { callSessionId: 'other-call' },
    { streamId: 'other-stream' },
    { presentationRef: '' },
    { startedAtMs: true },
    { startedAtMs: 0 },
  ])('rejects invalid or foreign speech identity %j', (change) => {
    const task = fixture();
    expect(
      service.recordVoiceTaskPresentation(task.taskId, {
        userId: 'user-playout',
        callSessionId: 'call-playout',
        streamId: task.streamId,
        presentationRef: 'speech-1',
        stage: 'audio.started',
        startedAtMs: 1000,
        ...change,
      }),
    ).toBeNull();
    expect(service.snapshotEvent(task.taskId).presentation).toBeUndefined();
  });
  test('background owner cannot acquire foreground native presentation Stop', () => {
    const task = service.createVoiceTask({
      callSessionId: 'call-playout',
      userId: 'user-playout',
      streamId: 'stream-worker',
      owner: { kind: 'glasshive_run', id: 'stream-worker' },
    });
    service.completeVoiceTask(task.taskId, { resultMessageId: 'result-worker' });
    expect(stage(task)).toBeNull();
    expect(service.snapshotEvent(task.taskId).presentation).toBeUndefined();
  });
});

/* === VIVENTIUM START === Canonical delivery tasks own only their exact speech presentation. === */
describe('Worker delivery presentation ownership', () => {
  beforeEach(() => {
    resetVoiceTasksForTests();
    jest.clearAllMocks();
  });
  function delivery(overrides = {}) {
    return {
      deliveryId: 'delivery-one',
      claimId: 'claim-one',
      userId: 'owner-one',
      surface: 'voice',
      voiceCallSessionId: 'call-one',
      conversationId: 'conversation-one',
      voiceRequestId: 'worker-completion-turn',
      callbackMessageId: 'worker-result',
      status: 'claimed',
      runId: 'run-one',
      anchorMessageId: 'NO_PARENT',
      ...overrides,
    };
  }
  const scope = { userId: 'owner-one', callSessionId: 'call-one' };
  function parent(runId, name, changes = {}) {
    const main = createVoiceTask({
      ...scope,
      conversationId: 'conversation-one',
      streamId: name,
      owner: { kind: 'remote_generation', id: name },
      ...changes,
    });
    completeVoiceTask(main.taskId, { resultMessageId: `${name}-result` });
    createVoiceTask({
      ...scope,
      conversationId: 'conversation-one',
      streamId: `glasshive:${runId}`,
      owner: { kind: 'glasshive_run', id: runId },
      parentTaskId: main.taskId,
      ...changes,
    });
    return main;
  }
  function pendingDelivery(overrides = {}) {
    const { buildVoiceWorkerCompletionPresentation } = require('@librechat/api');
    const binding = {
      originRef: 'origin-one',
      workRef: 'work-one',
      workerId: 'worker-one',
      runId: 'run-one',
      callbackRef: 'callback_sha256:' + 'a'.repeat(64),
      attemptNumber: 1,
      resultKey: 'ghtr_' + 'b'.repeat(64),
      acceptedOperationId: 'c'.repeat(32),
      terminalCallbackId: 'cb_terminal_' + 'd'.repeat(64),
      resultDigest: 'sha256:' + 'e'.repeat(64),
      resultRevision: 1,
      effectGeneration: 1,
    };
    const text = 'The requested result is ready.';
    const presentation = buildVoiceWorkerCompletionPresentation({
      ownerId: scope.userId,
      conversationId: 'conversation-one',
      callSessionId: scope.callSessionId,
      responseMessageId: 'worker-result',
      responseText: text,
      bindings: [binding],
    });
    return delivery({
      status: 'pending',
      claimId: '',
      text,
      callbackId: binding.callbackRef,
      voiceRequestId: presentation.turnId,
      workerCompletionPresentation: presentation,
      ...overrides,
    });
  }
  test.each(['busy', 'completed', 'moved-on'])(
    'native question presentation survives Main %s without owning worker consent',
    (state) => {
      const main =
        state === 'busy'
          ? createVoiceTask({
              ...scope,
              conversationId: 'conversation-one',
              streamId: 'main-one',
              owner: { kind: 'remote_generation', id: 'main-one' },
            })
          : parent('run-one', 'main-one');
      if (state === 'busy')
        createVoiceTask({
          ...scope,
          conversationId: 'conversation-one',
          streamId: 'glasshive:run-one',
          owner: { kind: 'glasshive_run', id: 'run-one' },
          parentTaskId: main.taskId,
        });
      if (state === 'moved-on') parent('run-two', 'main-two');
      const child = getVoiceTaskByStreamId('glasshive:run-one');
      registerVoiceTaskOwnerAdapter(child.taskId, {
        kind: 'glasshive_run',
        provideInput: jest.fn(),
      });
      observeGenerationEvent(child.taskId, {
        event: 'needs_input',
        data: {
          prompt: 'Permit this operation?',
          inputType: 'choice',
          choices: [{ value: 'allow_once', label: 'Allow once' }],
        },
      });
      const d = delivery({
        status: 'pending',
        claimId: '',
        event: 'run.needs_input',
        text: 'Permit this operation?',
        callbackId: 'callback_sha256:' + 'a'.repeat(64),
        originRef: 'origin-one',
        workRef: 'work-one',
        workerId: 'worker-one',
        nativeInputBinding: {
          version: 1,
          requestId: 'request-one',
          requestFingerprint: 'b'.repeat(64),
          runId: 'run-one',
          attemptId: 'attempt-one',
          sessionId: 'session-one',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      });
      const question = registerVoiceTaskDeliveryPresentation(d, scope);
      expect(question).toMatchObject({
        state: 'completed',
        owner: { kind: 'glasshive_delivery', id: d.deliveryId },
      });
      expect(getVoiceTask(child.taskId).state).toBe('needs_input');
      expect(snapshotEvent(child.taskId).needsInput.choices).toEqual([
        { value: 'allow_once', label: 'Allow once' },
      ]);
      expect(registerVoiceTaskDeliveryPresentation(d, scope).taskId).toBe(question.taskId);
      expect(snapshotEvent(question.taskId).source.id).toBe(d.callbackId);
    },
  );
  test('scheduled Main admission uses the same durable delivery discovery without a worker run', () => {
    const { buildMainGenerationPresentation } = require('@librechat/api');
    const d = delivery({
      status: 'pending',
      claimId: '',
      runId: '',
      event: 'main.followup',
      text: 'Scheduled Main result.',
      callbackId: 'callback_sha256:' + 'a'.repeat(64),
      voiceRequestId: 'schedule-stream',
      mainGenerationPresentation: buildMainGenerationPresentation(
        { streamId: 'schedule-stream', admissionId: 'schedule-admission' },
        'worker-result',
        'Scheduled Main result.',
      ),
    });
    const task = registerVoiceTaskDeliveryPresentation(d, scope);
    expect(task).toMatchObject({
      state: 'completed',
      owner: { kind: 'glasshive_delivery', id: d.deliveryId },
    });
    expect(snapshotEvent(task.taskId)).toMatchObject({
      phase: 'follow_up',
      resultMessageId: d.callbackMessageId,
      source: { id: d.callbackId },
    });
    expect(registerVoiceTaskDeliveryPresentation(d, scope).taskId).toBe(task.taskId);
    expect(
      registerVoiceTaskDeliveryPresentation({ ...d, userId: 'foreign-owner' }, scope),
    ).toBeNull();
    expect(
      registerVoiceTaskDeliveryPresentation(
        { ...d, deliveryId: 'other-delivery', event: 'run.completed' },
        scope,
      ),
    ).toBeNull();
  });
  test('pending Main delivery publishes one durable typed discovery snapshot before claim', () => {
    const d = pendingDelivery();
    const events = [];
    const unsubscribe = subscribeVoiceTasksForCall(scope.callSessionId, (event) =>
      events.push(event),
    );
    const task = registerVoiceTaskDeliveryPresentation(d, scope);
    expect(task).toMatchObject({
      state: 'completed',
      cancellable: false,
      owner: { kind: 'glasshive_delivery', id: d.deliveryId },
    });
    expect(snapshotEvent(task.taskId)).toMatchObject({
      phase: 'follow_up',
      resultMessageId: d.callbackMessageId,
      source: { id: d.callbackId },
    });
    const count = events.length;
    expect(registerVoiceTaskDeliveryPresentation(d, scope).taskId).toBe(task.taskId);
    expect(
      registerVoiceTaskDeliveryPresentation(
        { ...d, status: 'claimed', claimId: 'claim-one' },
        scope,
      ).taskId,
    ).toBe(task.taskId);
    expect(events).toHaveLength(count);
    expect(JSON.stringify(events)).not.toContain(d.text);
    unsubscribe();
  });
  test.each(['neutral', 'callback', 'digest', 'call', 'owner', 'suppressed'])(
    'pending Main delivery rejects %s without granting discovery or speech',
    (fault) => {
      const d = pendingDelivery();
      if (fault === 'neutral') d.workerCompletionPresentation = null;
      if (fault === 'callback') d.callbackId = 'untyped-callback';
      if (fault === 'digest') d.text = 'A different result.';
      if (fault === 'call') d.voiceCallSessionId = 'foreign-call';
      if (fault === 'owner') d.userId = 'foreign-owner';
      if (fault === 'suppressed') d.status = 'suppressed';
      expect(registerVoiceTaskDeliveryPresentation(d, scope)).toBeNull();
    },
  );
  test.each(['NO_PARENT', 'prior-call-anchor', 'web-anchor', 'telegram-anchor'])(
    'foreign-origin %s retains its truthful standalone delivery task and result',
    (anchorMessageId) => {
      const d = delivery({ anchorMessageId });
      const task = registerVoiceTaskDeliveryPresentation(d, scope);
      expect(task).toMatchObject({
        owner: { kind: 'glasshive_delivery', id: d.deliveryId },
        callSessionId: scope.callSessionId,
        streamId: 'glasshive-delivery:delivery-one',
        turnId: d.voiceRequestId,
        state: 'completed',
        cancellable: false,
      });
      expect(task).not.toHaveProperty('parentTaskId');
      expect(snapshotEvent(task.taskId)).toMatchObject({ resultMessageId: d.callbackMessageId });
      expect(registerVoiceTaskDeliveryPresentation(d, scope).taskId).toBe(task.taskId);
    },
  );
  test('canonical same-call run links its one parent while aggregate mixed parents do not guess', () => {
    const one = parent('run-one', 'main-one');
    expect(registerVoiceTaskDeliveryPresentation(delivery(), scope).parentTaskId).toBe(one.taskId);
    const two = parent('run-two', 'main-two');
    const aggregate = registerVoiceTaskDeliveryPresentation(
      delivery({
        deliveryId: 'aggregate',
        workerCompletionPresentation: { bindings: [{ runId: 'run-one' }, { runId: 'run-two' }] },
      }),
      scope,
    );
    expect(aggregate).not.toHaveProperty('parentTaskId');
    expect(getVoiceTask(one.taskId).owner.kind).toBe('remote_generation');
    expect(getVoiceTask(two.taskId).owner.kind).toBe('remote_generation');
  });
  test('foreign call child and conflicting current-call anchor never select a parent', () => {
    parent('run-one', 'foreign-main', { callSessionId: 'foreign-call' });
    expect(registerVoiceTaskDeliveryPresentation(delivery(), scope)).not.toHaveProperty(
      'parentTaskId',
    );
    resetVoiceTasksForTests();
    const one = parent('run-one', 'main-one');
    const two = parent('run-two', 'main-two');
    expect(
      registerVoiceTaskDeliveryPresentation(
        delivery({ anchorMessageId: 'main-two-result' }),
        scope,
      ),
    ).not.toHaveProperty('parentTaskId');
    expect(getVoiceTask(one.taskId).state).toBe('completed');
    expect(getVoiceTask(two.taskId).state).toBe('completed');
  });
  test.each(['owner', 'call', 'surface', 'missing-claim', 'result-change', 'turn-change'])(
    'rejects %s without presenting or cancelling other work',
    (fault) => {
      const d = delivery();
      const initial = registerVoiceTaskDeliveryPresentation(d, scope);
      if (fault === 'owner') d.userId = 'foreign';
      if (fault === 'call') d.voiceCallSessionId = 'foreign';
      if (fault === 'surface') d.surface = 'telegram';
      if (fault === 'missing-claim') d.claimId = '';
      if (fault === 'result-change') d.callbackMessageId = 'different-result';
      if (fault === 'turn-change') d.voiceRequestId = 'different-turn';
      expect(registerVoiceTaskDeliveryPresentation(d, scope)).toBeNull();
      expect(getVoiceTask(initial.taskId).state).toBe('completed');
    },
  );
  test('exact Worker Stop preserves completed result and fresh retries, without joining Main allowlist', async () => {
    const d = delivery();
    const task = registerVoiceTaskDeliveryPresentation(d, scope);
    const input = {
      ...scope,
      streamId: task.streamId,
      deliveryId: d.deliveryId,
      presentationRef: 'worker-speech-ref',
      stage: 'audio.started',
      startedAtMs: 1000,
    };
    expect(recordVoiceTaskPresentation(task.taskId, input)).toBeNull();
    expect(recordVoiceTaskDeliveryPresentation(task.taskId, input).presentation.state).toBe(
      'speaking',
    );
    const opts = {
      userId: scope.userId,
      stopPresentationIfCompleted: true,
      presentationRef: input.presentationRef,
    };
    const first = await requestVoiceTaskOwnerCancellation(task.taskId, opts);
    const second = await requestVoiceTaskOwnerCancellation(task.taskId, opts);
    expect(first).toMatchObject({
      presentationStopRequested: true,
      ownerAccepted: false,
      task: { state: 'completed' },
      event: { presentation: { state: 'stop_requested' } },
    });
    expect(second.event.sequence).toBe(first.event.sequence + 1);
    expect(second.event.eventId).not.toBe(first.event.eventId);
    expect(snapshotEvent(task.taskId).resultMessageId).toBe(d.callbackMessageId);
    expect(isVoiceTaskSuppressed(task.taskId)).toBe(false);
  });
  test('terminal before delayed start and wrong ref/owner/stream cannot resurrect or interrupt a newer presentation', () => {
    const d = delivery();
    const task = registerVoiceTaskDeliveryPresentation(d, scope);
    const input = {
      ...scope,
      streamId: task.streamId,
      deliveryId: d.deliveryId,
      presentationRef: 'old-ref',
      stage: 'audio.interrupted',
      startedAtMs: 1000,
    };
    recordVoiceTaskDeliveryPresentation(task.taskId, input);
    recordVoiceTaskDeliveryPresentation(task.taskId, { ...input, stage: 'audio.started' });
    expect(snapshotEvent(task.taskId).presentation.state).toBe('interrupted');
    recordVoiceTaskDeliveryPresentation(task.taskId, {
      ...input,
      presentationRef: 'new-ref',
      stage: 'audio.started',
      startedAtMs: 2000,
    });
    for (const bad of [
      { userId: 'foreign' },
      { callSessionId: 'foreign' },
      { streamId: 'foreign' },
      { deliveryId: 'foreign' },
    ]) {
      expect(recordVoiceTaskDeliveryPresentation(task.taskId, { ...input, ...bad })).toBeNull();
    }
    expect(recordVoiceTaskDeliveryPresentation(task.taskId, input)).toBeNull();
    expect(snapshotEvent(task.taskId).presentation).toMatchObject({
      ref: 'new-ref',
      state: 'speaking',
    });
  });
});
/* === VIVENTIUM END === */

describe('native permission operation detail', () => {
  beforeEach(() => resetVoiceTasksForTests());
  const request = {
    version: 1,
    kind: 'permission',
    requestId: 'permission-detail',
    requestFingerprint: 'a'.repeat(64),
    runId: 'run-detail',
    attemptId: 'attempt-detail',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  const offered = {
    prompt: 'May I create the requested file? Allow once or Deny.',
    inputType: 'choice',
    choices: [
      { value: 'allow', label: 'Allow once' },
      { value: 'deny', label: 'Deny' },
    ],
    nativeInputRequest: request,
    operationTitle: 'Create synthetic.txt in the working folder.',
  };
  test('retains current exact detail without replacing the spoken prompt or granting permission', () => {
    const task = createVoiceTask({
      callSessionId: 'call-detail',
      userId: 'owner-detail',
      owner: { kind: 'generation_job', id: 'stream-detail' },
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', provideInput: jest.fn() });
    observeGenerationEvent(task.taskId, { event: 'needs_input', data: offered });
    expect(snapshotEvent(task.taskId).needsInput).toEqual(offered);
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: {
        ...offered,
        operationTitle: 'Read synthetic.txt',
        nativeInputRequest: { ...request, requestFingerprint: 'b'.repeat(64) },
      },
    });
    expect(snapshotEvent(task.taskId).needsInput).toMatchObject({
      prompt: offered.prompt,
      operationTitle: 'Read synthetic.txt',
      nativeInputRequest: { requestFingerprint: 'b'.repeat(64) },
    });
  });
  test.each([
    ['oversized', { operationTitle: 'x'.repeat(8001) }],
    ['wrong type', { operationTitle: 42 }],
    ['no native binding', { nativeInputRequest: undefined }],
    ['question binding', { nativeInputRequest: { ...request, kind: 'question' } }],
  ])('rejects %s operation detail', (_label, change) => {
    const task = createVoiceTask({
      callSessionId: 'call-detail',
      userId: 'owner-detail',
      owner: { kind: 'generation_job', id: 'stream-detail' },
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', provideInput: jest.fn() });
    observeGenerationEvent(task.taskId, { event: 'needs_input', data: { ...offered, ...change } });
    expect(snapshotEvent(task.taskId).needsInput).toBeUndefined();
  });
});
