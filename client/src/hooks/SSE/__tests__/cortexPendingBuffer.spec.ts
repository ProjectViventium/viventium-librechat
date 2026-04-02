import type { TMessage } from 'librechat-data-provider';
import { createCortexPendingBuffer } from '../cortexPendingBuffer';

describe('cortexPendingBuffer', () => {
  test('applies cortex update immediately when response message exists', () => {
    let messages = [{ messageId: 'user-1_' } as TMessage];
    const getMessages = () => messages;
    const setMessages = (next: TMessage[]) => {
      messages = next;
    };
    const schedule = jest.fn();

    const buffer = createCortexPendingBuffer({
      getMessages,
      setMessages,
      schedule,
    });

    buffer.handleCortexUpdate('user-1_', {
      type: 'cortex_activation',
      cortex_id: 'c1',
      status: 'activating',
    });

    const parts = (messages[0] as TMessage & { __viventiumCortexParts?: unknown[] })
      .__viventiumCortexParts;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ cortex_id: 'c1', status: 'activating' });
    expect(schedule).not.toHaveBeenCalled();
  });

  test('buffers updates before created and flushes them after message appears', () => {
    let messages: TMessage[] = [];
    const getMessages = () => messages;
    const setMessages = (next: TMessage[]) => {
      messages = next;
    };

    const scheduled: Array<() => void> = [];
    const schedule = (fn: () => void) => {
      scheduled.push(fn);
      return 0;
    };

    const buffer = createCortexPendingBuffer({
      getMessages,
      setMessages,
      schedule,
      retryDelayMs: 1,
      maxFlushAttempts: 8,
    });

    buffer.handleCortexUpdate('user-2_', {
      type: 'cortex_activation',
      cortex_id: 'c1',
      status: 'activating',
    });
    buffer.handleCortexUpdate('user-2_', {
      type: 'cortex_brewing',
      cortex_id: 'c1',
      status: 'brewing',
    });

    // "created" arrives, but message isn't in cache yet.
    buffer.handleCreated('user-2');
    expect((messages[0] as any)?.__viventiumCortexParts).toBeUndefined();

    // Cache catches up; retry flush should attach pending cortex part.
    messages = [{ messageId: 'user-2_' } as TMessage];
    while (scheduled.length > 0) {
      const fn = scheduled.shift();
      fn?.();
    }

    const parts = (messages[0] as TMessage & { __viventiumCortexParts?: unknown[] })
      .__viventiumCortexParts;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({
      cortex_id: 'c1',
      type: 'cortex_brewing',
      status: 'brewing',
    });
  });

  test('upserts multiple cortex IDs independently while buffering', () => {
    let messages: TMessage[] = [];
    const getMessages = () => messages;
    const setMessages = (next: TMessage[]) => {
      messages = next;
    };
    const scheduled: Array<() => void> = [];

    const buffer = createCortexPendingBuffer({
      getMessages,
      setMessages,
      schedule: (fn: () => void) => {
        scheduled.push(fn);
        return 0;
      },
      retryDelayMs: 1,
      maxFlushAttempts: 8,
    });

    buffer.handleCortexUpdate('user-3_', {
      type: 'cortex_activation',
      cortex_id: 'c1',
      status: 'activating',
    });
    buffer.handleCortexUpdate('user-3_', {
      type: 'cortex_activation',
      cortex_id: 'c2',
      status: 'activating',
    });
    buffer.handleCortexUpdate('user-3_', {
      type: 'cortex_brewing',
      cortex_id: 'c2',
      status: 'brewing',
    });

    messages = [{ messageId: 'user-3_' } as TMessage];
    while (scheduled.length > 0) {
      const fn = scheduled.shift();
      fn?.();
    }

    const parts = (messages[0] as TMessage & { __viventiumCortexParts?: unknown[] })
      .__viventiumCortexParts as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    const byId = new Map(parts.map((p) => [String(p.cortex_id), p]));
    expect(byId.get('c1')).toMatchObject({ status: 'activating' });
    expect(byId.get('c2')).toMatchObject({ status: 'brewing' });
  });
});
