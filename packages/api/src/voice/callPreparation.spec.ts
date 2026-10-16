import {
  createCallPreparationBinding,
  createCallPreparationService,
  waitForCallPreparation,
} from './callPreparation';
import type { CallPreparationDependencies, CallPreparationSession } from './callPreparation';
const makeSession = (): CallPreparationSession => ({
  callSessionId: 'call-synthetic',
  userId: 'owner-synthetic',
  agentId: 'main-synthetic',
  conversationId: 'conversation-synthetic',
  mode: 'call',
  status: 'listening',
  contextPreparation: {
    ...createCallPreparationBinding(true, 'call-synthetic', 'voice.prebuild_context', 120)!,
    deadlineAt: new Date(Date.now() + 120000).toISOString(),
  },
});
const dependencies = (session: CallPreparationSession): CallPreparationDependencies => ({
  readSession: jest.fn(async () => session),
  begin: jest.fn(async () => session),
  admit: jest.fn(async () => ({
    streamId: 'stream-synthetic',
    conversationId: session.conversationId,
  })),
  bind: jest.fn(async (_, admitted) => ({
    ...session,
    contextPreparation: { ...session.contextPreparation!, streamId: admitted.streamId },
  })),
  readResult: jest.fn(async () => null),
  observe: jest.fn(async () => undefined),
  waitForResult: jest.fn(async () => ({
    prepared: true as const,
    responseMessageId: 'answer-synthetic',
  })),
  cancel: jest.fn(async () => true),
  failure: jest.fn(async () => undefined),
});
describe('opt-in native call preparation dependency', () => {
  it('starts no model when disabled or Listen-Only', async () => {
    expect(createCallPreparationBinding(false, 'call', '', 0)).toBeUndefined();
    const session = { ...makeSession(), mode: 'listen_only' };
    const deps = dependencies(session);
    await createCallPreparationService(deps).start(session);
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.observe).not.toHaveBeenCalled();
  });
  it('rechecks Listen-Only when mode changes during deadline initialization', async () => {
    const session = makeSession();
    const deps = dependencies(session);
    deps.begin = jest.fn(async () => ({ ...session, mode: 'listen_only' }));
    await createCallPreparationService(deps).start(session);
    expect(deps.admit).not.toHaveBeenCalled();
    expect(deps.observe).not.toHaveBeenCalled();
  });

  it('does not start the deadline merely by opening settings', () => {
    expect(createCallPreparationBinding(true, 'call', 'voice.prebuild_context', 120)).toEqual({
      version: 1,
      promptId: 'voice.prebuild_context',
      deadlineAt: '',
      timeoutSeconds: 120,
      idempotencyKey: 'call-context:call:v1',
    });
  });
  it('coalesces concurrent start attempts and keeps one admitted conversation', async () => {
    const session = makeSession();
    const deps = dependencies(session);
    let release!: (value: { streamId: string; conversationId: string }) => void;
    deps.admit = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const service = createCallPreparationService(deps);
    const a = service.start(session);
    const b = service.start(session);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    release({ streamId: 'stream-synthetic', conversationId: session.conversationId });
    const [first, second] = await Promise.all([a, b]);
    expect(deps.admit).toHaveBeenCalledTimes(1);
    expect(first.conversationId).toBe(second.conversationId);
    expect(deps.observe).toHaveBeenCalledTimes(1);
  });
  it('retains the dependency before releasing early input', async () => {
    const session = makeSession();
    const deps = dependencies(session);
    let release!: (value: { prepared: true; responseMessageId: string }) => void;
    deps.waitForResult = jest.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    let ready = false;
    const waiting = waitForCallPreparation(session, deps).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release({ prepared: true as const, responseMessageId: 'answer-synthetic' });
    await waiting;
    expect(ready).toBe(true);
  });
  it('abandons only the disconnected input waiter, never the shared preparation', async () => {
    const session = makeSession();
    const deps = dependencies(session);
    deps.waitForResult = jest.fn(() => new Promise(() => undefined));
    const request = new AbortController();
    const waiting = waitForCallPreparation(session, deps, request.signal);
    const checked = expect(waiting).rejects.toMatchObject({ code: 'call_context_wait_abandoned' });
    request.abort();
    await checked;
    expect(deps.cancel).not.toHaveBeenCalled();
  });

  it('keeps End terminal after late completion', async () => {
    const session = makeSession();
    const deps = dependencies(session);
    deps.readSession = jest.fn(async () => ({ ...session, status: 'ended' }));
    await expect(waitForCallPreparation(session, deps)).rejects.toMatchObject({
      code: 'call_ended',
    });
  });
  it('cancels only the owning prep on its absolute deadline', async () => {
    jest.useFakeTimers();
    const session = makeSession();
    const deps = dependencies(session);
    session.contextPreparation!.deadlineAt = new Date(Date.now() + 10).toISOString();
    deps.waitForResult = jest.fn(() => new Promise(() => undefined));
    const waiting = waitForCallPreparation(session, deps);
    const checked = expect(waiting).resolves.toMatchObject({
      callSessionId: session.callSessionId,
    });
    await jest.advanceTimersByTimeAsync(11);
    await checked;
    expect(deps.cancel).toHaveBeenCalledWith(session);
    jest.useRealTimers();
  });
});
