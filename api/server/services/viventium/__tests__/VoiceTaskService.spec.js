/* === VIVENTIUM START === VoiceTaskEventV1 state-machine tests. === VIVENTIUM END === */

const {
  cancelVoiceTask,
  canConfirmVoiceTaskCancellation,
  completeVoiceTask,
  confirmVoiceTaskOwnerCancellation,
  createVoiceTask,
  failVoiceTask,
  flushVoiceTaskOwnerOperations,
  getVoiceTask,
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
  beforeEach(() => resetVoiceTasksForTests());

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

  test('marks tool completion structurally without requiring detail-text inference', () => {
    const task = createVoiceTask({ callSessionId: 'call-tool', userId: 'user-1', streamId: 's' });
    const completed = observeGenerationEvent(task.taskId, {
      event: 'on_run_step_completed',
      data: {
        id: 'step-complete',
        stepDetails: { tool_calls: [{ function: { name: 'web_search' } }] },
      },
    });
    expect(completed).toMatchObject({
      type: 'progress',
      state: 'running',
      phase: 'tool_completed',
      label: 'web_search',
    });
  });

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
