import { RedisEventTransport } from '../implementations/RedisEventTransport';

/* Viventium-owned deterministic regression coverage for acknowledged Redis
 * connection, channel-demand, reconnect, teardown, and ownership lifecycles. */

type Listener = (...args: unknown[]) => void;

interface MockSubscriber {
  status: string;
  on: jest.Mock;
  once: jest.Mock;
  off: jest.Mock;
  removeListener: jest.Mock;
  connect: jest.Mock;
  disconnect: jest.Mock;
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  emit: (event: string, ...args: unknown[]) => void;
}

function createSubscriber(initialStatus: string = 'ready') {
  const listeners = new Map<string, Set<Listener>>();

  const subscriber: MockSubscriber = {
    status: initialStatus,
    on: jest.fn((event: string, listener: Listener) => {
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return subscriber;
    }),
    once: jest.fn((event: string, listener: Listener) => {
      const wrapped: Listener = (...args) => {
        listeners.get(event)?.delete(wrapped);
        listener(...args);
      };
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(wrapped);
      listeners.set(event, eventListeners);
      return subscriber;
    }),
    off: jest.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return subscriber;
    }),
    removeListener: jest.fn((event: string, listener: Listener) => {
      listeners.get(event)?.delete(listener);
      return subscriber;
    }),
    connect: jest.fn(async () => {
      subscriber.status = 'ready';
    }),
    disconnect: jest.fn(),
    subscribe: jest.fn().mockResolvedValue(1),
    unsubscribe: jest.fn().mockResolvedValue(0),
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) {
        listener(...args);
      }
    },
  };

  const publisher = {
    publish: jest.fn().mockResolvedValue(1),
  };

  return { subscriber, publisher };
}

describe('RedisEventTransport subscription lifecycle', () => {
  test('waits for the Redis connection readiness check before entering subscriber mode', async () => {
    const { publisher, subscriber } = createSubscriber('connecting');
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    const abortReady = transport.onAbort('initial-ready', () => undefined);
    const subscription = transport.subscribe('initial-ready', { onChunk: () => undefined });

    await Promise.resolve();
    expect(subscriber.subscribe).not.toHaveBeenCalled();

    subscriber.status = 'ready';
    subscriber.emit('ready');
    await Promise.all([abortReady, subscription.ready]);

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledWith('stream:{initial-ready}:events');
  });

  test('connects a lazy subscriber before entering subscriber mode', async () => {
    const { publisher, subscriber } = createSubscriber('wait');
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    const subscription = transport.subscribe('lazy-connect', { onChunk: () => undefined });
    await subscription.ready;

    expect(subscriber.connect).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
  });

  test('invalidates readiness and explicitly re-subscribes after connection recovery', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    await transport.onAbort('network-reconnect', () => undefined);
    const first = transport.subscribe('network-reconnect', { onChunk: () => undefined });
    await first.ready;
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    subscriber.status = 'reconnecting';
    subscriber.emit('close');
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    subscriber.status = 'ready';
    subscriber.emit('ready');
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);

    const second = transport.subscribe('network-reconnect', { onChunk: () => undefined });
    await second.ready;
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    await transport.destroy();
  });

  test('defers last-consumer unsubscribe across an active connection loss', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('disconnect-cleanup', { onChunk: () => undefined });
    await subscription.ready;

    subscriber.status = 'reconnecting';
    subscriber.emit('close');
    subscription.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();

    subscriber.status = 'ready';
    subscriber.emit('ready');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    await transport.destroy();
  });

  test('cancels a deferred unsubscribe when same-channel demand returns before ready', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const first = transport.subscribe('renewed-demand', { onChunk: () => undefined });
    await first.ready;

    subscriber.status = 'reconnecting';
    subscriber.emit('close');
    first.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacement = transport.subscribe('renewed-demand', { onChunk: () => undefined });
    subscriber.status = 'ready';
    subscriber.emit('ready');
    await replacement.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    await transport.destroy();
  });

  test('serializes a resubscribe behind the preceding unsubscribe acknowledgement', async () => {
    const { publisher, subscriber } = createSubscriber();
    let acknowledgeUnsubscribe: (() => void) | undefined;
    subscriber.unsubscribe.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          acknowledgeUnsubscribe = () => resolve(0);
        }),
    );
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    const first = transport.subscribe('reconnect', { onChunk: () => undefined });
    await first.ready;
    first.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const second = transport.subscribe('reconnect', { onChunk: () => undefined });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    acknowledgeUnsubscribe?.();
    await second.ready;

    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  test('does not deadlock a pending subscribe-unsubscribe-resubscribe across reconnect', async () => {
    const { publisher, subscriber } = createSubscriber('connecting');
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    const first = transport.subscribe('pending-reconnect-cycle', { onChunk: () => undefined });
    first.unsubscribe();
    const second = transport.subscribe('pending-reconnect-cycle', { onChunk: () => undefined });

    subscriber.status = 'reconnecting';
    subscriber.emit('close');
    subscriber.status = 'ready';
    subscriber.emit('ready');

    const outcome = await Promise.race([
      second.ready.then(() => 'ready' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);
    await transport.destroy();

    expect(outcome).toBe('ready');
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('makes unsubscribe idempotent for each subscription handle', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('idempotent', { onChunk: () => undefined });
    await subscription.ready;

    subscription.unsubscribe();
    subscription.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(transport.getSubscriberCount('idempotent')).toBe(0);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('ignores an old handle after cleanup creates replacement stream state', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const oldSubscription = transport.subscribe('replacement', { onChunk: () => undefined });
    await oldSubscription.ready;

    transport.cleanup('replacement');
    const replacement = transport.subscribe('replacement', { onChunk: () => undefined });
    await replacement.ready;

    oldSubscription.unsubscribe();
    expect(transport.getSubscriberCount('replacement')).toBe(1);

    replacement.unsubscribe();
    await transport.destroy();
  });

  test('shares one pending subscription between abort and event listeners', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    transport.onAbort('shared-channel', () => undefined);
    const subscription = transport.subscribe('shared-channel', { onChunk: () => undefined });
    await subscription.ready;

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    await Promise.resolve();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();

    transport.cleanup('shared-channel');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test('rolls back a failed subscription generation and allows a clean retry', async () => {
    const { publisher, subscriber } = createSubscriber();
    subscriber.subscribe
      .mockRejectedValueOnce(new Error('synthetic subscribe failure'))
      .mockResolvedValueOnce(1);
    const transport = new RedisEventTransport(publisher as never, subscriber as never);

    const first = transport.subscribe('retry', { onChunk: () => undefined });
    await expect(first.ready).rejects.toThrow('synthetic subscribe failure');
    first.unsubscribe();

    const second = transport.subscribe('retry', { onChunk: () => undefined });
    await expect(second.ready).resolves.toBeUndefined();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
  });

  test('drains lifecycle transitions and closes only an owned subscriber', async () => {
    const owned = createSubscriber();
    const ownedTransport = new RedisEventTransport(
      owned.publisher as never,
      owned.subscriber as never,
      { ownsSubscriber: true },
    );
    const ownedSubscription = ownedTransport.subscribe('owned', { onChunk: () => undefined });
    await ownedSubscription.ready;

    await ownedTransport.destroy();

    expect(owned.subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(owned.subscriber.disconnect).toHaveBeenCalledTimes(1);

    const borrowed = createSubscriber();
    const borrowedTransport = new RedisEventTransport(
      borrowed.publisher as never,
      borrowed.subscriber as never,
    );
    const borrowedSubscription = borrowedTransport.subscribe('borrowed', {
      onChunk: () => undefined,
    });
    await borrowedSubscription.ready;

    await borrowedTransport.destroy();

    expect(borrowed.subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    expect(borrowed.subscriber.disconnect).not.toHaveBeenCalled();
  });

  test('cancels connection waiters so owned teardown cannot hang during reconnect', async () => {
    const { publisher, subscriber } = createSubscriber('reconnecting');
    const transport = new RedisEventTransport(publisher as never, subscriber as never, {
      ownsSubscriber: true,
    });
    const subscription = transport.subscribe('stalled-reconnect', { onChunk: () => undefined });
    void subscription.ready.catch(() => undefined);

    await expect(transport.destroy()).resolves.toBeUndefined();
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });

  test('rejects a subscriber connection that never becomes ready', async () => {
    jest.useFakeTimers();
    const { publisher, subscriber } = createSubscriber('reconnecting');
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('ready-timeout', { onChunk: () => undefined });

    try {
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(subscription.ready).rejects.toThrow(
        'Redis subscriber connection did not become ready within 10000ms',
      );
    } finally {
      jest.useRealTimers();
      await transport.destroy();
    }
  });

  test('rejects a lazy connection attempt that never settles', async () => {
    jest.useFakeTimers();
    const { publisher, subscriber } = createSubscriber('wait');
    subscriber.connect.mockReturnValue(new Promise<void>(() => undefined));
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('connect-timeout', { onChunk: () => undefined });

    try {
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(subscription.ready).rejects.toThrow(
        'Redis subscriber connection attempt did not settle within 10000ms',
      );
    } finally {
      jest.useRealTimers();
      await transport.destroy();
    }
  });

  test('rejects a subscription acknowledgement that never settles', async () => {
    jest.useFakeTimers();
    const { publisher, subscriber } = createSubscriber();
    subscriber.subscribe.mockReturnValue(new Promise<number>(() => undefined));
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('subscribe-timeout', { onChunk: () => undefined });

    try {
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(subscription.ready).rejects.toThrow(
        'Redis subscriber subscription acknowledgement did not settle within 10000ms',
      );
    } finally {
      jest.useRealTimers();
      await transport.destroy();
    }
  });

  test('permits a recovered subscription after an acknowledgement timeout', async () => {
    jest.useFakeTimers();
    const { publisher, subscriber } = createSubscriber();
    let releaseTimedOutAcknowledgement: (() => void) | undefined;
    subscriber.subscribe
      .mockImplementationOnce(
        () =>
          new Promise<number>((resolve) => {
            releaseTimedOutAcknowledgement = () => resolve(1);
          }),
      )
      .mockResolvedValueOnce(1);
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const timedOut = transport.subscribe('subscribe-timeout-recovery', {
      onChunk: () => undefined,
    });

    try {
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(timedOut.ready).rejects.toThrow(
        'Redis subscriber subscription acknowledgement did not settle within 10000ms',
      );
      timedOut.unsubscribe();

      const onChunk = jest.fn();
      const recovered = transport.subscribe('subscribe-timeout-recovery', { onChunk });
      await recovered.ready;

      releaseTimedOutAcknowledgement?.();
      await Promise.resolve();
      subscriber.emit(
        'message',
        'stream:{subscribe-timeout-recovery}:events',
        JSON.stringify({ type: 'chunk', seq: 0, data: 'recovered-live' }),
      );

      expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
      expect(subscriber.unsubscribe).not.toHaveBeenCalled();
      expect(onChunk).toHaveBeenCalledWith('recovered-live');
    } finally {
      jest.useRealTimers();
      await transport.destroy();
    }
  });

  test('times out a stalled unsubscribe transition and permits recovery', async () => {
    const { publisher, subscriber } = createSubscriber();
    subscriber.unsubscribe.mockImplementationOnce(() => new Promise<number>(() => undefined));
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const first = transport.subscribe('unsubscribe-timeout-recovery', {
      onChunk: () => undefined,
    });
    await first.ready;
    first.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);

    jest.useFakeTimers();
    const timedOut = transport.subscribe('unsubscribe-timeout-recovery', {
      onChunk: () => undefined,
    });

    try {
      await jest.advanceTimersByTimeAsync(10_000);
      await expect(timedOut.ready).rejects.toThrow(
        'Redis subscriber preceding channel transition did not settle within 10000ms',
      );
      timedOut.unsubscribe();

      const onChunk = jest.fn();
      const recovered = transport.subscribe('unsubscribe-timeout-recovery', { onChunk });
      await recovered.ready;
      subscriber.emit(
        'message',
        'stream:{unsubscribe-timeout-recovery}:events',
        JSON.stringify({ type: 'chunk', seq: 0, data: 'recovered-after-unsubscribe-timeout' }),
      );

      expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
      expect(onChunk).toHaveBeenCalledWith('recovered-after-unsubscribe-timeout');
    } finally {
      jest.useRealTimers();
      await transport.destroy();
    }
  });

  test('cancels a stalled lazy connect so owned teardown cannot hang', async () => {
    const { publisher, subscriber } = createSubscriber('wait');
    subscriber.connect.mockReturnValue(new Promise<void>(() => undefined));
    const transport = new RedisEventTransport(publisher as never, subscriber as never, {
      ownsSubscriber: true,
    });
    const subscription = transport.subscribe('stalled-connect', { onChunk: () => undefined });
    void subscription.ready.catch(() => undefined);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.connect).toHaveBeenCalledTimes(1);
    await expect(transport.destroy()).resolves.toBeUndefined();
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });

  test('cancels a stalled subscribe acknowledgement so owned teardown cannot hang', async () => {
    const { publisher, subscriber } = createSubscriber();
    subscriber.subscribe.mockReturnValue(new Promise<number>(() => undefined));
    const transport = new RedisEventTransport(publisher as never, subscriber as never, {
      ownsSubscriber: true,
    });
    const subscription = transport.subscribe('stalled-subscribe', { onChunk: () => undefined });
    void subscription.ready.catch(() => undefined);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    await expect(transport.destroy()).resolves.toBeUndefined();
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });

  test('bypasses a stalled pre-existing transition during owned teardown', async () => {
    const { publisher, subscriber } = createSubscriber();
    subscriber.unsubscribe
      .mockReturnValueOnce(new Promise<number>(() => undefined))
      .mockResolvedValue(0);
    const transport = new RedisEventTransport(publisher as never, subscriber as never, {
      ownsSubscriber: true,
    });
    const first = transport.subscribe('stalled-transition', { onChunk: () => undefined });
    await first.ready;
    first.unsubscribe();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = transport.subscribe('stalled-transition', { onChunk: () => undefined });
    void second.ready.catch(() => undefined);

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    await expect(transport.destroy()).resolves.toBeUndefined();
    expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
  });

  test('settles borrowed teardown without leaving a stale reconnect listener', async () => {
    const { publisher, subscriber } = createSubscriber();
    const transport = new RedisEventTransport(publisher as never, subscriber as never);
    const subscription = transport.subscribe('borrowed-reconnect', { onChunk: () => undefined });
    await subscription.ready;

    subscriber.status = 'reconnecting';
    subscriber.emit('close');

    await expect(transport.destroy()).resolves.toBeUndefined();
    expect(subscriber.disconnect).not.toHaveBeenCalled();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();

    const onChunk = jest.fn();
    const replacementTransport = new RedisEventTransport(publisher as never, subscriber as never);
    const replacement = replacementTransport.subscribe('borrowed-reconnect', { onChunk });
    subscriber.status = 'ready';
    subscriber.emit('ready');
    await replacement.ready;
    await new Promise<void>((resolve) => setImmediate(resolve));
    subscriber.emit(
      'message',
      'stream:{borrowed-reconnect}:events',
      JSON.stringify({ type: 'chunk', seq: 0, data: 'replacement-live' }),
    );

    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    expect(onChunk).toHaveBeenCalledWith('replacement-live');
    await replacementTransport.destroy();
  });
});
