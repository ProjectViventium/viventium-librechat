import { withNativeConversationAdmission } from './nativeConversationAdmission';

const deferred = () => {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const options = (sessionKey: string, signal?: AbortSignal) => ({
  sessionKey,
  timeoutMs: 1000,
  signals: signal ? [signal] : [],
  isCancelled: () => signal?.aborted === true,
});

describe('native conversation admission', () => {
  it('waits only for the same native session and assembles its next invocation after release', async () => {
    const first = deferred();
    const firstEntered = deferred();
    const events: string[] = [];
    const a = withNativeConversationAdmission(options('same'), async () => {
      events.push('a');
      firstEntered.resolve();
      await first.promise;
      events.push('a-ended');
      return 'a';
    });
    await firstEntered.promise;
    const b = withNativeConversationAdmission(options('same'), async () => {
      events.push('b-fresh-grant');
      return 'b';
    });
    const c = withNativeConversationAdmission(options('other'), async () => {
      events.push('c');
      return 'c';
    });
    expect(await c).toBe('c');
    expect(events).toEqual(['a', 'c']);
    first.resolve();
    expect(await Promise.all([a, b])).toEqual(['a', 'b']);
    expect(events).toEqual(['a', 'c', 'a-ended', 'b-fresh-grant']);
  });

  it('cancels a queued invocation without admitting it or releasing its active predecessor', async () => {
    const first = deferred();
    const entered = deferred();
    const controller = new AbortController();
    const a = withNativeConversationAdmission(options('cancel'), async () => {
      entered.resolve();
      await first.promise;
    });
    await entered.promise;
    const invoke = jest.fn(async () => 'must not run');
    const b = withNativeConversationAdmission(options('cancel', controller.signal), invoke);
    const rejected = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort('user_cancelled');
    await rejected;
    const next = jest.fn(async () => 'next');
    const c = withNativeConversationAdmission(options('cancel'), next);
    expect(next).not.toHaveBeenCalled();
    first.resolve();
    await a;
    expect(await c).toBe('next');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('bounds a queued wait and cleans up after a failed predecessor', async () => {
    const first = deferred();
    const entered = deferred();
    const a = withNativeConversationAdmission(options('timeout'), async () => {
      entered.resolve();
      await first.promise;
      throw new Error('typed rejection');
    });
    const aFailure = expect(a).rejects.toThrow('typed rejection');
    await entered.promise;
    const invoke = jest.fn(async () => 'must not run');
    await expect(
      withNativeConversationAdmission({ ...options('timeout'), timeoutMs: 5 }, invoke),
    ).rejects.toMatchObject({ name: 'AbortError', message: 'Native session admission timed out' });
    first.resolve();
    await aFailure;
    expect(await withNativeConversationAdmission(options('timeout'), async () => 'recovered')).toBe(
      'recovered',
    );
    expect(invoke).not.toHaveBeenCalled();
  });
});
