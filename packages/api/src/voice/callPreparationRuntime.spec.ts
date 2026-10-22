import { createCallPreparationRuntime, isCurrentCallPreparationDispatch } from './callPreparationRuntime';
import { createCallPreparationBinding } from './callPreparation';
import type { CallPreparationRuntimeBridge } from './callPreparationRuntime';
import type { CallPreparationSession } from './callPreparation';
import type { ServerSentEvent } from '../types/events';

jest.mock('../stream/GenerationJobManager', () => ({
  GenerationJobManager: {
    getJob: jest.fn(),
    abortJob: jest.fn(),
    subscribe: jest.fn(),
  },
}));
const manager = jest.requireMock<{
  GenerationJobManager: {
    getJob: jest.Mock;
    abortJob: jest.Mock;
    subscribe: jest.Mock;
  };
}>('../stream/GenerationJobManager').GenerationJobManager;
const initial = (): CallPreparationSession => ({
  callSessionId: 'call-synthetic',
  userId: 'owner-synthetic',
  agentId: 'main-synthetic',
  conversationId: 'new',
  status: 'listening',
  mode: 'call',
  contextPreparation: {
    ...createCallPreparationBinding(true, 'call-synthetic', 'voice.prebuild_context', 120)!,
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
  },
});
function fixture() {
  let current = initial();
  let taskState = 'running';
  let resultMessageId = '';
  const bridge: CallPreparationRuntimeBridge = {
    calls: {
      getCallSession: jest.fn(async () => current),
      materializeCallSessionConversationId: jest.fn(async (_, conversationId) => {
        current = { ...current, conversationId };
        return current;
      }),
    },
    environment: { PORT: '3180', VIVENTIUM_SCHEDULER_SECRET: 'synthetic-secret' },
    getRequiredPromptText: jest.fn(() => 'Gather synthetic context. Set voice=skip.'),
    begin: jest.fn(async (session) => session),
    bindStream: jest.fn(async (_, streamId) => {
      current.contextPreparation!.streamId = streamId;
    }),
    recordRelease: jest.fn(async (session) => {
      if (current.userId !== session.userId || current.conversationId !== session.conversationId ||
        current.contextPreparation?.streamId !== session.contextPreparation?.streamId ||
        current.contextPreparation?.idempotencyKey !== session.contextPreparation?.idempotencyKey) return false;
      current.contextPreparation!.releasedStreamId = session.contextPreparation!.streamId;
      return true;
    }),
    readResultMessage: jest.fn(async (_, messageId) => ({ messageId })),
    tasks: {
      hydrateVoiceTaskByStreamId: jest.fn(async () => ({
        taskId: 'task-synthetic',
        state: taskState,
      })),
      snapshotEvent: jest.fn(() => ({ resultMessageId })),
      createVoiceTask: jest.fn(() => ({ taskId: 'task-synthetic', state: 'running' })),
      bindVoiceTaskStream: jest.fn(() => ({})),
      completeVoiceTask: jest.fn((_, result) => {
        taskState = 'completed';
        resultMessageId = result.resultMessageId;
        return {};
      }),
      cancelVoiceTask: jest.fn(() => {
        if (!['failed', 'completed', 'cancelled_confirmed'].includes(taskState)) taskState = 'cancelling';
        return {};
      }),
      settleVoiceTaskCancellation: jest.fn(async () => {
        if (taskState !== 'cancelling') return null;
        taskState = 'cancelled_confirmed';
        return {};
      }),
      observeGenerationEvent: jest.fn(() => ({})),
      failVoiceTask: jest.fn(() => {
        if (['cancelling', 'cancelled_confirmed', 'completed', 'failed'].includes(taskState)) return null;
        taskState = 'failed';
        return {};
      }),
      flushVoiceTaskPersistence: jest.fn(async () => undefined),
    },
  };
  manager.getJob.mockImplementation(async () => ({
    status: 'running',
    metadata: {
      userId: current.userId,
      conversationId: current.conversationId,
    },
  }));
  manager.abortJob.mockResolvedValue({ success: true });
  manager.subscribe.mockImplementation(
    async (
      _,
      onChunk: (event: ServerSentEvent) => void,
      done: (event: ServerSentEvent) => void,
    ) => {
      onChunk({ event: 'on_cortex_followup', data: { messageId: 'unspoken-child' } });
      onChunk({ event: 'on_source', data: { title: 'Synthetic source' } });
      done({ data: {}, responseMessage: { messageId: 'report-synthetic' } } as ServerSentEvent);
      return { unsubscribe: jest.fn() };
    },
  );
  return {
    bridge,
    getCurrent: () => current,
    setCurrent: (session: CallPreparationSession) => {
      current = session;
    },
  };
}

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.clearAllMocks();
});

describe('call preparation existing-owner wiring', () => {
  it('bounds stop acknowledgement while retaining its exact late receipt for retries', async () => {
    jest.useFakeTimers();
    try {
      const { bridge, getCurrent } = fixture();
      getCurrent().contextPreparation!.streamId = 'stream-synthetic';
      let acknowledge!: (value: { success: boolean }) => void;
      manager.abortJob.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
      const service = createCallPreparationRuntime(bridge);
      const stopping = service.cancel(getCurrent());
      await jest.advanceTimersByTimeAsync(8001);
      expect(await stopping).toBe(false);
      expect(bridge.tasks.settleVoiceTaskCancellation).not.toHaveBeenCalled();
      const retry = service.cancel(getCurrent());
      await Promise.resolve();
      acknowledge({ success: true });
      expect(await retry).toBe(true);
      expect(manager.abortJob).toHaveBeenCalledTimes(1);
      expect(bridge.tasks.settleVoiceTaskCancellation).toHaveBeenCalledWith('task-synthetic',
        expect.objectContaining({ confirmed: true }));
    } finally { jest.useRealTimers(); }
  });

  it('uses normal scheduler Main and chat-only delivery, without model or audio task overrides', async () => {
    const { bridge, getCurrent } = fixture();
    jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            streamId: 'stream-synthetic',
            conversationId: 'conversation-synthetic',
          }),
          { status: 202 },
        ),
    );
    await createCallPreparationRuntime(bridge).start(getCurrent());
    const init = jest.mocked(global.fetch).mock.calls[0][1]!;
    const body = JSON.parse(String(init.body));
    expect(body.deliveryChannels).toEqual(['librechat']);
    expect(body.agentId).toBe('main-synthetic');
    expect(body.callPreparation).toEqual({ callSessionId: 'call-synthetic' });
    expect(body).not.toHaveProperty('scheduledAgentExecution');
    expect(body).not.toHaveProperty('voiceMode');
    expect(body).not.toHaveProperty('viventiumVoiceTaskId');
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('model');
    expect(getCurrent().conversationId).toBe('conversation-synthetic');
  });

  it('keeps preparation visible through writing progress without changing native evidence', async () => {
    const { bridge, getCurrent } = fixture();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      streamId: 'stream-synthetic', conversationId: 'conversation-synthetic',
    }), { status: 202 }));
    const native = { event: 'on_run_step', data: { id: 'step-synthetic', type: 'message_creation', name: 'Writing reply' } } as ServerSentEvent;
    const original = JSON.stringify(native);
    manager.subscribe.mockImplementation(async (_, chunk, done) => {
      chunk(native);
      chunk({ event: 'on_source', data: { title: 'Synthetic source' } });
      done({ responseMessage: { messageId: 'report-synthetic' } });
      return { unsubscribe: jest.fn() };
    });
    const service = createCallPreparationRuntime(bridge);
    await service.start(getCurrent());
    await service.wait(getCurrent());
    expect(bridge.tasks.observeGenerationEvent).toHaveBeenCalledWith('task-synthetic', {
      event: 'on_run_step', data: { id: 'step-synthetic', type: 'message_creation', name: 'Waking up - gathering context.' },
    });
    expect(bridge.tasks.observeGenerationEvent).toHaveBeenCalledWith('task-synthetic', {
      event: 'on_source', data: { title: 'Synthetic source' },
    });
    expect(JSON.stringify(native)).toBe(original);
  });

  it('never projects preparation cortex follow-ups into Call audio task wakes', async () => {
    const { bridge, getCurrent } = fixture();
    jest.spyOn(global, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            streamId: 'stream-synthetic',
            conversationId: 'conversation-synthetic',
          }),
          { status: 202 },
        ),
    );
    const service = createCallPreparationRuntime(bridge);
    await service.start(getCurrent());
    await service.wait(getCurrent());
    const events = jest
      .mocked(bridge.tasks.observeGenerationEvent)
      .mock.calls.map((call) => call[1].event);
    expect(events).toContain('on_source');
    expect(events).not.toContain('on_cortex_followup');
  });

  it.each(['ended', 'listen_only'])(
    'aborts admission if call changes to %s before bind',
    async (state) => {
      const { bridge, getCurrent, setCurrent } = fixture();
      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        setCurrent({
          ...getCurrent(),
          ...(state === 'ended' ? { status: state } : { mode: state }),
        });
        return new Response(
          JSON.stringify({
            streamId: 'stream-synthetic',
            conversationId: 'conversation-synthetic',
          }),
          { status: 202 },
        );
      });
      const started = createCallPreparationRuntime(bridge).start(getCurrent());
      if (state === 'ended') await expect(started).rejects.toMatchObject({ code: 'call_ended' });
      else await started;
      expect(manager.abortJob).toHaveBeenCalledWith(
        'stream-synthetic',
        'user_cancelled',
        'owner-synthetic',
      );
      expect(bridge.bindStream).not.toHaveBeenCalled();
    },
  );

  it('suppresses a cancelled prep error before aborting and preserves the cancellation receipt', async () => {
    const { bridge, getCurrent } = fixture();
    getCurrent().contextPreparation!.streamId = 'stream-synthetic';
    const finals: Array<(event: ServerSentEvent) => void> = [];
    manager.subscribe.mockImplementation(async (_, _chunk, done) => {
      finals.push(done);
      return { unsubscribe: jest.fn() };
    });
    manager.abortJob.mockImplementation(async () => {
      expect(bridge.tasks.cancelVoiceTask).toHaveBeenCalledWith('task-synthetic', { userId: 'owner-synthetic' });
      expect(bridge.tasks.flushVoiceTaskPersistence).toHaveBeenCalled();
      for (const done of finals) done({ data: {}, responseMessage: { error: true, unfinished: true } } as ServerSentEvent);
      return { success: true };
    });
    const service = createCallPreparationRuntime(bridge);
    const waiting = service.wait(getCurrent());
    await new Promise<void>((resolve) => setImmediate(resolve));
    await service.cancel(getCurrent());
    await waiting;
    expect((await bridge.tasks.hydrateVoiceTaskByStreamId('stream-synthetic', getCurrent()))?.state).toBe('cancelled_confirmed');
    expect(manager.abortJob).toHaveBeenCalledTimes(1);
  });

  it('keeps a reached deadline as a failure while releasing the exact authoring owner', async () => {
    jest.useFakeTimers();
    try {
      const { bridge, getCurrent } = fixture();
      getCurrent().contextPreparation!.streamId = 'stream-synthetic';
      getCurrent().contextPreparation!.deadlineAt = new Date(Date.now() + 10).toISOString();
      manager.subscribe.mockImplementation(async () => ({ unsubscribe: jest.fn() }));
      const waiting = createCallPreparationRuntime(bridge).wait(getCurrent());
      await jest.advanceTimersByTimeAsync(11);
      await waiting;
      expect(bridge.tasks.failVoiceTask).toHaveBeenCalledWith('task-synthetic', expect.objectContaining({ code: 'call_context_deadline' }));
      expect((await bridge.tasks.hydrateVoiceTaskByStreamId('stream-synthetic', getCurrent()))?.state).toBe('failed');
      expect(manager.abortJob).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('failed Main preparation releases normal Voice after confirmed exact cancellation', async () => {
    const { bridge, getCurrent } = fixture();
    jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      streamId: 'stream-synthetic', conversationId: 'conversation-synthetic',
    }), { status: 202 }));
    manager.subscribe.mockImplementation(async (_, _chunk: (event: ServerSentEvent) => void,
      done: (event: ServerSentEvent) => void) => {
      done({ data: {}, responseMessage: { messageId: 'failed-report', error: true } } as ServerSentEvent);
      return { unsubscribe: jest.fn() };
    });
    const service = createCallPreparationRuntime(bridge);
    await service.start(getCurrent());
    const released = await service.wait(getCurrent());
    expect(released.callSessionId).toBe('call-synthetic');
    expect(manager.abortJob).toHaveBeenCalledWith('stream-synthetic', 'user_cancelled', 'owner-synthetic');
    expect(bridge.tasks.failVoiceTask).toHaveBeenCalled();
  });

  it('retains failure and durable release after native abort deletes the job and runtime restarts', async () => {
    const { bridge, getCurrent } = fixture();
    getCurrent().conversationId = 'conversation-synthetic';
    getCurrent().contextPreparation!.streamId = 'stream-synthetic';
    bridge.tasks.failVoiceTask('task-synthetic', { code: 'call_context_deadline', message: 'Timed out.' });
    manager.abortJob.mockImplementation(async () => {
      manager.getJob.mockResolvedValue(null);
      return { success: true };
    });
    const service = createCallPreparationRuntime(bridge);
    expect(await service.cancel(getCurrent())).toBe(true);
    expect(getCurrent().contextPreparation!.releasedStreamId).toBe('stream-synthetic');
    expect((await bridge.tasks.hydrateVoiceTaskByStreamId('stream-synthetic', getCurrent()))?.state).toBe('failed');
    const reloaded = createCallPreparationRuntime(bridge);
    expect((await reloaded.wait(getCurrent())).callSessionId).toBe('call-synthetic');
    expect(manager.abortJob).toHaveBeenCalledTimes(1);
  });

  it('retries durable release persistence with its retained native receipt, not a second abort', async () => {
    const { bridge, getCurrent } = fixture();
    getCurrent().contextPreparation!.streamId = 'stream-synthetic';
    bridge.tasks.failVoiceTask('task-synthetic', { code: 'call_context_failed', message: 'Failed.' });
    manager.abortJob.mockImplementation(async () => {
      manager.getJob.mockResolvedValue(null);
      return { success: true };
    });
    jest.mocked(bridge.recordRelease).mockRejectedValueOnce(new Error('Synthetic database unavailable'));
    const service = createCallPreparationRuntime(bridge);
    await expect(service.cancel(getCurrent())).rejects.toThrow('Synthetic database unavailable');
    expect(await service.cancel(getCurrent())).toBe(true);
    expect(manager.abortJob).toHaveBeenCalledTimes(1);
  });

  it('an exact already-complete failed job persists release without aborting it again', async () => {
    const { bridge, getCurrent } = fixture();
    getCurrent().contextPreparation!.streamId = 'stream-synthetic';
    bridge.tasks.failVoiceTask('task-synthetic', { code: 'call_context_failed', message: 'Failed.' });
    manager.getJob.mockResolvedValue({ status: 'complete', metadata: {
      userId: getCurrent().userId, conversationId: getCurrent().conversationId } });
    expect(await createCallPreparationRuntime(bridge).cancel(getCurrent())).toBe(true);
    expect(getCurrent().contextPreparation!.releasedStreamId).toBe('stream-synthetic');
    expect(manager.abortJob).not.toHaveBeenCalled();
  });

  it('missing job and failed task without exact release proof stay blocked', async () => {
    const { bridge, getCurrent } = fixture();
    getCurrent().contextPreparation!.streamId = 'stream-synthetic';
    bridge.tasks.failVoiceTask('task-synthetic', { code: 'call_context_failed', message: 'Failed.' });
    manager.getJob.mockResolvedValue(null);
    expect(await createCallPreparationRuntime(bridge).cancel(getCurrent())).toBe(false);
    expect(bridge.recordRelease).not.toHaveBeenCalled();
  });

  it.each(['userId', 'conversationId', 'streamId', 'idempotencyKey'])(
    'a stale %s cannot use another preparation release proof', async (field) => {
      const { bridge, getCurrent } = fixture();
      getCurrent().conversationId = 'conversation-synthetic';
      getCurrent().contextPreparation!.streamId = 'stream-synthetic';
      getCurrent().contextPreparation!.releasedStreamId = 'stream-synthetic';
      const stale = { ...getCurrent(), contextPreparation: { ...getCurrent().contextPreparation! } };
      if (field === 'userId' || field === 'conversationId') stale[field] = 'foreign-synthetic';
      else stale.contextPreparation![field] = 'foreign-synthetic';
      expect(await createCallPreparationRuntime(bridge).cancel(stale)).toBe(false);
      expect(manager.abortJob).not.toHaveBeenCalled();
    });

  it('reconciles a lost admission reply through its existing exact scheduler dispatch receipt', async () => {
    const { bridge, getCurrent } = fixture();
    let requests = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      if (++requests === 1) throw new Error('Synthetic transport loss');
      return new Response(
        JSON.stringify({ streamId: 'stream-synthetic', conversationId: 'conversation-synthetic' }),
      );
    });
    await createCallPreparationRuntime(bridge).start(getCurrent());
    expect(jest.mocked(global.fetch).mock.calls[1][0]).toContain(
      '/scheduler/dispatches/call-context%3Acall-synthetic%3Av1',
    );
    expect(bridge.bindStream).toHaveBeenCalledTimes(1);
  });
});

describe('current call preparation dispatch binding', () => {
  const dispatchFor = (session: CallPreparationSession) => ({
    callSessionId: session.callSessionId,
    userId: session.userId,
    conversationId: session.conversationId,
    agentId: session.agentId,
    idempotencyKey: session.contextPreparation!.idempotencyKey,
    authoringDeadlineAt: session.contextPreparation!.deadlineAt,
  });

  it('accepts only the current bound preparation, including its exact idempotent retry', () => {
    const session = initial();
    expect(isCurrentCallPreparationDispatch(session, dispatchFor(session))).toBe(true);
    session.contextPreparation!.streamId = 'same-accepted-stream';
    expect(isCurrentCallPreparationDispatch(session, dispatchFor(session))).toBe(true);
  });

  it.each(['callSessionId', 'userId', 'conversationId', 'agentId', 'idempotencyKey', 'authoringDeadlineAt'] as const)(
    'rejects a changed %s without execution authority', (field) => {
      const session = initial();
      expect(isCurrentCallPreparationDispatch(session, {
        ...dispatchFor(session), [field]: 'different-synthetic',
      })).toBe(false);
    },
  );

  it('rejects ended, listen-only, released, expired and absent preparations', () => {
    const session = initial();
    const dispatch = dispatchFor(session);
    expect(isCurrentCallPreparationDispatch(null, dispatch)).toBe(false);
    expect(isCurrentCallPreparationDispatch({ ...session, status: 'ended' }, dispatch)).toBe(false);
    expect(isCurrentCallPreparationDispatch({ ...session, mode: 'listen_only' }, dispatch)).toBe(false);
    expect(isCurrentCallPreparationDispatch({ ...session, contextPreparation: undefined }, dispatch)).toBe(false);
    expect(isCurrentCallPreparationDispatch(session, dispatch,
      new Date(dispatch.authoringDeadlineAt).getTime())).toBe(false);
    session.contextPreparation!.releasedStreamId = 'released-synthetic';
    expect(isCurrentCallPreparationDispatch(session, dispatch)).toBe(false);
  });
});
