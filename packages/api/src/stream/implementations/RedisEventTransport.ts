import type { Redis, Cluster } from 'ioredis';
import { logger } from '@librechat/data-schemas';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';

/**
 * Redis key prefixes for pub/sub channels
 */
const CHANNELS = {
  /** Main event channel: stream:{streamId}:events (hash tag for cluster compatibility) */
  events: (streamId: string) => `stream:{${streamId}}:events`,
};

/**
 * Event types for pub/sub messages
 */
const EventTypes = {
  CHUNK: 'chunk',
  DONE: 'done',
  ERROR: 'error',
  ABORT: 'abort',
} as const;

interface PubSubMessage {
  type: (typeof EventTypes)[keyof typeof EventTypes];
  /** Sequence number for ordering (critical for Redis Cluster) */
  seq?: number;
  data?: unknown;
  error?: string;
}

/**
 * Reorder buffer state for a stream subscription.
 * Handles out-of-order message delivery in Redis Cluster mode.
 */
interface ReorderBuffer {
  /** Next expected sequence number */
  nextSeq: number;
  /** Buffered messages waiting for earlier sequences */
  pending: Map<number, PubSubMessage>;
  /** Timeout handle for flushing stale messages */
  flushTimeout: ReturnType<typeof setTimeout> | null;
}

/** Max time (ms) to wait for out-of-order messages before force-flushing */
const REORDER_TIMEOUT_MS = 500;
/** Max messages to buffer before force-flushing (prevents memory issues) */
const MAX_BUFFER_SIZE = 100;

/**
 * Subscriber state for a stream
 */
interface StreamSubscribers {
  count: number;
  handlers: Map<
    string,
    {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    }
  >;
  allSubscribersLeftCallbacks: Array<() => void>;
  /** Abort callbacks - called when abort signal is received from any replica */
  abortCallbacks: Array<() => void>;
  /** Reorder buffer for handling out-of-order delivery in Redis Cluster */
  reorderBuffer: ReorderBuffer;
}

/**
 * Redis Pub/Sub implementation of IEventTransport.
 * Enables real-time event delivery across multiple instances.
 *
 * Architecture (inspired by https://upstash.com/blog/resumable-llm-streams):
 * - Publisher: Emits events to Redis channel when chunks arrive
 * - Subscriber: Listens to Redis channel and forwards to SSE clients
 * - Decoupled: Generator and consumer don't need direct connection
 *
 * Note: Requires TWO Redis connections - one for publishing, one for subscribing.
 * This is a Redis limitation: a client in subscribe mode can't publish.
 *
 * @example
 * ```ts
 * const transport = new RedisEventTransport(publisherClient, subscriberClient);
 * transport.subscribe(streamId, { onChunk: (e) => res.write(e) });
 * transport.emitChunk(streamId, { text: 'Hello' });
 * ```
 */
export class RedisEventTransport implements IEventTransport {
  /** Redis client for publishing events */
  private publisher: Redis | Cluster;
  /** Redis client for subscribing to events (separate connection required) */
  private subscriber: Redis | Cluster;
  /** Track subscribers per stream */
  private streams = new Map<string, StreamSubscribers>();
  /** Track which channels we're subscribed to */
  private subscribedChannels = new Set<string>();
  /* === VIVENTIUM START ===
   * Purpose: Let callers await the actual Redis subscription acknowledgement so
   * the first published event cannot disappear into a subscribe/publish race.
   * === VIVENTIUM END === */
  private subscriptionReady = new Map<string, Promise<void>>();
  /* === VIVENTIUM START ===
   * Purpose: Serialize Redis pub/sub mode transitions for reconnect safety.
   * === VIVENTIUM END === */
  /**
   * Serialize the acknowledgement boundary between UNSUBSCRIBE and a later
   * SUBSCRIBE for the same channel. Redis changes connection modes at those
   * boundaries, so overlapping transitions can corrupt the subscriber client.
   */
  private subscriptionTransitions = new Map<string, Promise<void>>();
  /* === VIVENTIUM START ===
   * Purpose: Record connection ownership and stable listeners so asynchronous
   * teardown is idempotent and does not leak borrowed subscriber references.
   * === VIVENTIUM END === */
  /** Whether this transport must close the dedicated subscriber it was given. */
  private ownsSubscriber: boolean;
  /** Stable error listener for factory-owned duplicates. */
  private ownedSubscriberErrorListener?: (error: Error) => void;
  /** Idempotent asynchronous teardown. */
  private destroyPromise?: Promise<void>;
  private destroyed = false;
  /** Increments whenever the subscriber connection is lost. */
  private connectionGeneration = 0;
  /** Rejectors for connection-readiness waits that teardown must cancel. */
  private connectionWaiterCancellations = new Set<(error: Error) => void>();
  /* === VIVENTIUM START ===
   * Purpose: Cancel every class of pending Redis lifecycle work at teardown.
   */
  /** Rejects every in-flight Redis lifecycle operation when teardown starts. */
  private readonly teardownSignal: Promise<never>;
  private rejectTeardownSignal?: (error: Error) => void;
  /* === VIVENTIUM END === */
  /** Stable reference so borrowed subscribers do not retain this transport. */
  private readonly subscriberMessageListener = (channel: string, message: string) => {
    this.handleMessage(channel, message);
  };

  private readonly subscriberCloseListener = () => {
    if (this.destroyed) {
      return;
    }

    /* === VIVENTIUM START ===
     * Purpose: Redis readiness is connection-generation-specific. Invalidate
     * acknowledged channels so reconnect consumers cannot reuse a stale promise.
     * === VIVENTIUM END === */
    this.connectionGeneration++;
    for (const channel of this.subscribedChannels) {
      this.subscriptionReady.delete(channel);
    }
    this.subscribedChannels.clear();
  };

  private readonly subscriberReadyListener = () => {
    if (this.destroyed) {
      return;
    }

    /* === VIVENTIUM START ===
     * Purpose: ioredis announces connection readiness before its automatic
     * resubscribe commands are acknowledged. Explicitly establish every channel
     * still demanded by event or abort listeners after that internal turn.
     * === VIVENTIUM END === */
    setImmediate(() => {
      if (this.destroyed || (this.subscriber as { status?: string }).status !== 'ready') {
        return;
      }
      for (const [streamId, state] of this.streams) {
        if (this.hasStreamDemand(state)) {
          void this.ensureChannelSubscribed(CHANNELS.events(streamId)).catch(() => undefined);
        }
      }
    });
  };

  /** Counter for generating unique subscriber IDs */
  private subscriberIdCounter = 0;
  /** Sequence counters per stream for publishing (ensures ordered delivery in cluster mode) */
  private sequenceCounters = new Map<string, number>();

  /* === VIVENTIUM START ===
   * Purpose: Centralize stream-state construction so reconnect preservation,
   * abort callbacks, and ordering buffers stay structurally identical.
   * === VIVENTIUM END === */
  private createStreamState(): StreamSubscribers {
    return {
      count: 0,
      handlers: new Map(),
      allSubscribersLeftCallbacks: [],
      abortCallbacks: [],
      reorderBuffer: {
        nextSeq: 0,
        pending: new Map(),
        flushTimeout: null,
      },
    };
  }

  private hasStreamDemand(state: StreamSubscribers): boolean {
    return state.count > 0 || state.abortCallbacks.length > 0;
  }

  private hasChannelDemand(channel: string): boolean {
    const match = channel.match(/^stream:\{([^}]+)\}:events$/);
    const state = match ? this.streams.get(match[1]) : undefined;
    return state ? this.hasStreamDemand(state) : false;
  }

  /**
   * Create a new Redis event transport.
   *
   * @param publisher - Redis client for publishing (can be shared)
   * @param subscriber - Redis client for subscribing (must be dedicated)
   */
  /* === VIVENTIUM START ===
   * Purpose: Track dedicated-client ownership, connection generations, stable
   * listeners, and the cancellation signal required by acknowledged readiness.
   */
  constructor(
    publisher: Redis | Cluster,
    subscriber: Redis | Cluster,
    options: { ownsSubscriber?: boolean } = {},
  ) {
    this.publisher = publisher;
    this.subscriber = subscriber;
    this.ownsSubscriber = options.ownsSubscriber ?? false;
    this.teardownSignal = new Promise<never>((_, reject) => {
      this.rejectTeardownSignal = reject;
    });
    // The signal can reject before any operation races it (for example, an
    // unused transport). Keep that intentional rejection handled.
    void this.teardownSignal.catch(() => undefined);

    // Set up message handler for all subscriptions
    this.subscriber.on('message', this.subscriberMessageListener);
    this.subscriber.on('close', this.subscriberCloseListener);
    this.subscriber.on('ready', this.subscriberReadyListener);

    /* === VIVENTIUM START ===
     * Purpose: Duplicated ioredis clients do not inherit the publisher's event
     * listeners. Keep owned subscriber failures observable and handled.
     * === VIVENTIUM END === */
    if (this.ownsSubscriber) {
      this.ownedSubscriberErrorListener = (error: Error) => {
        logger.error('[RedisEventTransport] Subscriber connection error:', error);
      };
      this.subscriber.on('error', this.ownedSubscriberErrorListener);
    }
  }
  /* === VIVENTIUM END === */

  /* === VIVENTIUM START ===
   * Purpose: Teardown must settle even when ioredis leaves connect, subscribe,
   * or a preceding channel transition pending indefinitely.
   * === VIVENTIUM END === */
  private withTeardownCancellation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new Error('Redis event transport has been destroyed'));
    }
    return Promise.race([Promise.resolve().then(operation), this.teardownSignal]);
  }

  /* === VIVENTIUM START ===
   * Purpose: A newly duplicated ioredis connection performs a server readiness
   * check before it can safely enter subscriber mode. Sending SUBSCRIBE first
   * can make that check issue INFO after Redis has already restricted the
   * connection to pub/sub commands.
   * === VIVENTIUM END === */
  private waitForSubscriberConnection(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Redis event transport destroyed before connection ready'));
    }

    const getStatus = () => (this.subscriber as { status?: string }).status;
    const currentStatus = getStatus();

    // Test doubles and compatible clients without a public status property are
    // already expected to queue commands safely.
    if (!currentStatus || currentStatus === 'ready') {
      return Promise.resolve();
    }
    if (currentStatus === 'wait') {
      return this.withTeardownCancellation(() => this.subscriber.connect()).then(() => undefined);
    }
    if (currentStatus === 'end') {
      return Promise.reject(new Error('Redis subscriber connection has ended'));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let cancel = (_error: Error) => undefined;
      const removeListener = (event: string, listener: () => void) => {
        if (typeof this.subscriber.off === 'function') {
          this.subscriber.off(event, listener);
        } else {
          this.subscriber.removeListener(event, listener);
        }
      };
      const cleanup = () => {
        removeListener('ready', onReady);
        removeListener('end', onEnd);
        this.connectionWaiterCancellations.delete(cancel);
      };
      const onReady = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onEnd = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error('Redis subscriber connection ended before it became ready'));
      };
      cancel = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      };

      this.connectionWaiterCancellations.add(cancel);
      this.subscriber.once('ready', onReady);
      this.subscriber.once('end', onEnd);

      // Close the narrow check/listener-registration race.
      const statusAfterListeners = getStatus();
      if (statusAfterListeners === 'ready') {
        onReady();
      } else if (statusAfterListeners === 'end') {
        onEnd();
      }
    });
  }

  /* === VIVENTIUM START ===
   * Purpose: Make every channel consumer share one readiness promise and keep
   * SUBSCRIBE ordered after any preceding UNSUBSCRIBE acknowledgement.
   * === VIVENTIUM END === */
  private ensureChannelSubscribed(channel: string): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Redis event transport has been destroyed'));
    }

    const existing = this.subscriptionReady.get(channel);
    if (existing) {
      return existing;
    }

    const precedingTransition = this.subscriptionTransitions.get(channel) ?? Promise.resolve();
    const ready = this.withTeardownCancellation(() => precedingTransition)
      .then(async () => {
        /* === VIVENTIUM START ===
         * Purpose: Retry a changed connection generation inside this one
         * readiness promise. Recursive re-entry would wait on the same channel's
         * unsubscribe transition and create a P -> transition -> P deadlock.
         * === VIVENTIUM END === */
        while (this.hasChannelDemand(channel)) {
          await this.waitForSubscriberConnection();
          const connectionGeneration = this.connectionGeneration;
          await this.withTeardownCancellation(() => this.subscriber.subscribe(channel));
          if (connectionGeneration === this.connectionGeneration) {
            return;
          }
        }
      })
      .then(() => {
        if (this.subscriptionReady.get(channel) === ready) {
          this.subscribedChannels.add(channel);
        }
      })
      .catch((err) => {
        if (this.subscriptionReady.get(channel) === ready) {
          this.subscribedChannels.delete(channel);
          this.subscriptionReady.delete(channel);
        }
        logger.error(`[RedisEventTransport] Failed to subscribe to ${channel}:`, err);
        throw err;
      });

    this.subscriptionReady.set(channel, ready);
    // Direct transport consumers may only need `unsubscribe`; keep an ignored
    // readiness rejection from becoming an unhandled process rejection.
    void ready.catch(() => undefined);
    return ready;
  }

  /* === VIVENTIUM START ===
   * Purpose: Redis does not acknowledge its return from subscriber mode until
   * UNSUBSCRIBE resolves. Track that transition so an immediate reconnect
   * cannot overtake it.
   * === VIVENTIUM END === */
  private queueChannelUnsubscribe(channel: string): Promise<void> {
    const readiness = this.subscriptionReady.get(channel);
    const active = this.subscribedChannels.has(channel);
    const existingTransition = this.subscriptionTransitions.get(channel);

    /* === VIVENTIUM START ===
     * Purpose: Shutdown is a cancellation boundary, not an acknowledgement
     * barrier. Issue a best-effort cleanup command for borrowed ready clients,
     * then let an owned client disconnect without awaiting stalled Redis work.
     * === VIVENTIUM END === */
    if (this.destroyed) {
      this.subscriptionReady.delete(channel);
      this.subscribedChannels.delete(channel);
      const subscriberStatus = (this.subscriber as { status?: string }).status;
      if (!subscriberStatus || subscriberStatus === 'ready') {
        void Promise.resolve()
          .then(() => this.subscriber.unsubscribe(channel))
          .catch((err) => {
            logger.error(`[RedisEventTransport] Failed teardown unsubscribe from ${channel}:`, err);
          });
      } else if (!this.ownsSubscriber && subscriberStatus !== 'end') {
        this.deferChannelUnsubscribe(channel);
      }
      return Promise.resolve();
    }

    if (!readiness && !active && existingTransition) {
      return existingTransition;
    }

    if (this.subscriptionReady.get(channel) === readiness) {
      this.subscriptionReady.delete(channel);
    }
    this.subscribedChannels.delete(channel);

    const transitionBase = readiness ?? existingTransition ?? Promise.resolve();
    const transition = transitionBase
      .catch(() => undefined)
      .then(() => {
        if (this.destroyed) {
          return undefined;
        }
        const subscriberStatus = (this.subscriber as { status?: string }).status;
        if (subscriberStatus && subscriberStatus !== 'ready') {
          if (subscriberStatus !== 'end' && !(this.destroyed && this.ownsSubscriber)) {
            this.deferChannelUnsubscribe(channel);
          }
          return undefined;
        }
        return this.subscriber.unsubscribe(channel);
      })
      .then(() => undefined)
      .catch((err) => {
        logger.error(`[RedisEventTransport] Failed to unsubscribe from ${channel}:`, err);
      })
      .finally(() => {
        if (this.subscriptionTransitions.get(channel) === transition) {
          this.subscriptionTransitions.delete(channel);
        }
      });

    this.subscriptionTransitions.set(channel, transition);
    return transition;
  }

  /* === VIVENTIUM START ===
   * Purpose: Cleanup must not hang on a reconnecting client. Defer its channel
   * unsubscribe until ioredis finishes automatic resubscribe work; full teardown
   * still closes an owned client directly and never closes a borrowed client.
   * === VIVENTIUM END === */
  private deferChannelUnsubscribe(channel: string): void {
    let settled = false;
    let onReady = () => undefined;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (typeof this.subscriber.off === 'function') {
        this.subscriber.off('ready', onReady);
        this.subscriber.off('end', cleanup);
      } else {
        this.subscriber.removeListener('ready', onReady);
        this.subscriber.removeListener('end', cleanup);
      }
    };
    onReady = () => {
      setImmediate(() => {
        void this.subscriber
          .unsubscribe(channel)
          .catch((error) => {
            logger.error(
              `[RedisEventTransport] Failed deferred unsubscribe from ${channel}:`,
              error,
            );
          })
          .finally(cleanup);
      });
    };

    this.subscriber.once('ready', onReady);
    this.subscriber.once('end', cleanup);
  }

  /** Get next sequence number for a stream (0-indexed) */
  private getNextSequence(streamId: string): number {
    const current = this.sequenceCounters.get(streamId) ?? 0;
    this.sequenceCounters.set(streamId, current + 1);
    return current;
  }

  /** Reset sequence counter for a stream */
  resetSequence(streamId: string): void {
    this.sequenceCounters.delete(streamId);
  }

  /**
   * Handle incoming pub/sub message with reordering support for Redis Cluster
   */
  private handleMessage(channel: string, message: string): void {
    const match = channel.match(/^stream:\{([^}]+)\}:events$/);
    if (!match) {
      return;
    }
    const streamId = match[1];

    const streamState = this.streams.get(streamId);
    if (!streamState) {
      return;
    }

    try {
      const parsed = JSON.parse(message) as PubSubMessage;

      if (parsed.type === EventTypes.CHUNK && parsed.seq != null) {
        this.handleOrderedChunk(streamId, streamState, parsed);
      } else if (
        (parsed.type === EventTypes.DONE || parsed.type === EventTypes.ERROR) &&
        parsed.seq != null
      ) {
        this.handleTerminalEvent(streamId, streamState, parsed);
      } else {
        this.deliverMessage(streamState, parsed);
      }
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to parse message:`, err);
    }
  }

  /**
   * Handle terminal events (done/error) with sequence-based ordering.
   * Buffers the terminal event and delivers after all preceding chunks arrive.
   */
  private handleTerminalEvent(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (seq < buffer.nextSeq) {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate terminal event for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
      return;
    }

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;
      this.flushPendingMessages(streamId, streamState);
    } else {
      buffer.pending.set(seq, message);
      this.scheduleFlushTimeout(streamId, streamState);
    }
  }

  /**
   * Handle chunk messages with sequence-based reordering.
   * Buffers out-of-order messages and delivers them in sequence.
   */
  private handleOrderedChunk(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;

      this.flushPendingMessages(streamId, streamState);
    } else if (seq > buffer.nextSeq) {
      buffer.pending.set(seq, message);

      if (buffer.pending.size >= MAX_BUFFER_SIZE) {
        logger.warn(`[RedisEventTransport] Buffer overflow for stream ${streamId}, force-flushing`);
        this.forceFlushBuffer(streamId, streamState);
      } else {
        this.scheduleFlushTimeout(streamId, streamState);
      }
    } else {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate/old message for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
    }
  }

  /** Deliver consecutive pending messages */
  private flushPendingMessages(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    while (buffer.pending.has(buffer.nextSeq)) {
      const message = buffer.pending.get(buffer.nextSeq)!;
      buffer.pending.delete(buffer.nextSeq);
      this.deliverMessage(streamState, message);
      buffer.nextSeq++;
    }

    if (buffer.pending.size === 0 && buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
  }

  /** Force-flush all pending messages in order (used on timeout or overflow) */
  private forceFlushBuffer(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }

    if (buffer.pending.size === 0) {
      return;
    }

    const sortedSeqs = [...buffer.pending.keys()].sort((a, b) => a - b);
    const skipped = sortedSeqs[0] - buffer.nextSeq;

    if (skipped > 0) {
      logger.warn(
        `[RedisEventTransport] Stream ${streamId}: skipping ${skipped} missing messages (seq ${buffer.nextSeq}-${sortedSeqs[0] - 1})`,
      );
    }

    for (const seq of sortedSeqs) {
      const message = buffer.pending.get(seq)!;
      buffer.pending.delete(seq);
      this.deliverMessage(streamState, message);
    }

    buffer.nextSeq = sortedSeqs[sortedSeqs.length - 1] + 1;
  }

  /** Schedule a timeout to force-flush if gaps aren't filled */
  private scheduleFlushTimeout(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      return;
    }

    buffer.flushTimeout = setTimeout(() => {
      buffer.flushTimeout = null;
      if (buffer.pending.size > 0) {
        logger.warn(
          `[RedisEventTransport] Stream ${streamId}: timeout waiting for seq ${buffer.nextSeq}, force-flushing ${buffer.pending.size} messages`,
        );
        this.forceFlushBuffer(streamId, streamState);
      }
    }, REORDER_TIMEOUT_MS);
  }

  /** Deliver a message to all handlers */
  private deliverMessage(streamState: StreamSubscribers, message: PubSubMessage): void {
    for (const [, handlers] of streamState.handlers) {
      switch (message.type) {
        case EventTypes.CHUNK:
          handlers.onChunk(message.data);
          break;
        case EventTypes.DONE:
          handlers.onDone?.(message.data);
          break;
        case EventTypes.ERROR:
          handlers.onError?.(message.error ?? 'Unknown error');
          break;
        case EventTypes.ABORT:
          break;
      }
    }

    if (message.type === EventTypes.ABORT) {
      for (const callback of streamState.abortCallbacks) {
        try {
          callback();
        } catch (err) {
          logger.error(`[RedisEventTransport] Error in abort callback:`, err);
        }
      }
    }
  }

  /**
   * Subscribe to events for a stream.
   *
   * On first subscriber for a stream, subscribes to the Redis channel.
   * Returns unsubscribe function that cleans up when last subscriber leaves.
   */
  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown) => void;
      onError?: (error: string) => void;
    },
  ): { unsubscribe: () => void; ready: Promise<void> } {
    const channel = CHANNELS.events(streamId);
    const subscriberId = `sub_${++this.subscriberIdCounter}`;

    // Initialize stream state if needed
    if (!this.streams.has(streamId)) {
      /* === VIVENTIUM START ===
       * Purpose: Use the shared state constructor introduced for reconnect-safe
       * stream lifecycle handling.
       * === VIVENTIUM END === */
      this.streams.set(streamId, this.createStreamState());
    }

    const streamState = this.streams.get(streamId)!;
    streamState.count++;
    streamState.handlers.set(subscriberId, handlers);

    /* === VIVENTIUM START ===
     * Purpose: Preserve and expose the Redis acknowledgement promise. Callers
     * can wait until the channel is actually live, and a failed attempt clears
     * optimistic bookkeeping so the next subscription can retry.
     */
    const ready = this.ensureChannelSubscribed(channel);
    /* === VIVENTIUM END === */

    // Return unsubscribe function
    let closed = false;
    return {
      ready,
      unsubscribe: () => {
        /* === VIVENTIUM START ===
         * Purpose: Make each handle idempotent and prevent a stale handle from
         * decrementing replacement state created later for the same stream ID.
         * === VIVENTIUM END === */
        if (closed) {
          return;
        }
        closed = true;

        const state = this.streams.get(streamId);
        if (!state || state !== streamState || !state.handlers.delete(subscriberId)) {
          return;
        }

        state.count = state.handlers.size;

        // If last subscriber left, unsubscribe from Redis and notify
        if (state.count === 0) {
          // Clear any pending flush timeout and buffered messages
          if (state.reorderBuffer.flushTimeout) {
            clearTimeout(state.reorderBuffer.flushTimeout);
            state.reorderBuffer.flushTimeout = null;
          }
          state.reorderBuffer.pending.clear();

          /* === VIVENTIUM START ===
           * Purpose: Abort listeners remain active for the job lifetime and
           * share this channel. Leave subscriber mode only after cleanup
           * removes the final channel consumer.
           * === VIVENTIUM END === */
          if (state.abortCallbacks.length === 0) {
            void this.queueChannelUnsubscribe(channel);
          }

          // Call all-subscribers-left callbacks
          for (const callback of state.allSubscribersLeftCallbacks) {
            try {
              callback();
            } catch (err) {
              logger.error(`[RedisEventTransport] Error in allSubscribersLeft callback:`, err);
            }
          }
          /* === VIVENTIUM START ===
           * Purpose: Preserve per-stream callbacks and reorder state across
           * reconnect cycles. Cleanup still owns final deletion when the job
           * ends; deleting here makes later subscribers lose sync/reset hooks.
           * === VIVENTIUM END === */
        }
      },
    };
  }

  /**
   * Publish a chunk event to all subscribers across all instances.
   * Includes sequence number for ordered delivery in Redis Cluster mode.
   */
  async emitChunk(streamId: string, event: unknown): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const seq = this.getNextSequence(streamId);
    const message: PubSubMessage = { type: EventTypes.CHUNK, seq, data: event };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish chunk:`, err);
    }
  }

  /**
   * Publish a done event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitDone(streamId: string, event: unknown): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const seq = this.getNextSequence(streamId);
    const message: PubSubMessage = { type: EventTypes.DONE, seq, data: event };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish done:`, err);
      /* === VIVENTIUM START ===
       * Purpose: Terminal event publish failures must reject so callers and CI
       * can detect that the final stream state was not delivered.
       * === VIVENTIUM END === */
      throw err;
    }
  }

  /**
   * Publish an error event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitError(streamId: string, error: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const seq = this.getNextSequence(streamId);
    const message: PubSubMessage = { type: EventTypes.ERROR, seq, error };

    try {
      await this.publisher.publish(channel, JSON.stringify(message));
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to publish error:`, err);
      /* === VIVENTIUM START ===
       * Purpose: Error event publish failures must reject so callers and CI can
       * detect that the stream error state was not delivered.
       * === VIVENTIUM END === */
      throw err;
    }
  }

  /**
   * Get subscriber count for a stream (local instance only).
   *
   * Note: In a multi-instance setup, this only returns local subscriber count.
   * For global count, would need to track in Redis (e.g., with a counter key).
   */
  getSubscriberCount(streamId: string): number {
    return this.streams.get(streamId)?.count ?? 0;
  }

  /**
   * Check if this is the first subscriber (local instance only).
   */
  isFirstSubscriber(streamId: string): boolean {
    return this.getSubscriberCount(streamId) === 1;
  }

  /**
   * Register callback for when all subscribers leave.
   */
  onAllSubscribersLeft(streamId: string, callback: () => void): void {
    const state = this.streams.get(streamId);
    if (state) {
      state.allSubscribersLeftCallbacks.push(callback);
    } else {
      // Create state just for the callback
      /* === VIVENTIUM START ===
       * Purpose: Keep callback-only stream state structurally aligned with
       * reconnect-safe subscriber state.
       * === VIVENTIUM END === */
      const newState = this.createStreamState();
      newState.allSubscribersLeftCallbacks.push(callback);
      this.streams.set(streamId, newState);
    }
  }

  /* === VIVENTIUM START ===
   * Purpose: Align Redis transport with the public IEventTransport contract
   * and reconnect regression tests. A first subscriber after a disconnect must
   * not wait for stale sequence numbers that were published while disconnected.
   * === VIVENTIUM END === */
  syncReorderBuffer(streamId: string): void {
    let state = this.streams.get(streamId);
    if (!state) {
      state = this.createStreamState();
      this.streams.set(streamId, state);
    }

    const buffer = state.reorderBuffer;
    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
    buffer.pending.clear();
    buffer.nextSeq = this.sequenceCounters.get(streamId) ?? buffer.nextSeq;
  }

  /**
   * Publish an abort signal to all replicas.
   * This enables cross-replica abort: when a user aborts on Replica B,
   * the generating Replica A receives the signal and stops.
   */
  emitAbort(streamId: string): void {
    const channel = CHANNELS.events(streamId);
    const message: PubSubMessage = { type: EventTypes.ABORT };

    this.publisher.publish(channel, JSON.stringify(message)).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to publish abort:`, err);
    });
  }

  /**
   * Register callback for abort signals from any replica.
   * Called when abort is triggered on any replica (including this one).
   *
   * @param streamId - The stream identifier
   * @param callback - Called when abort signal is received
   */
  onAbort(streamId: string, callback: () => void): Promise<void> {
    const channel = CHANNELS.events(streamId);
    let state = this.streams.get(streamId);

    if (!state) {
      /* === VIVENTIUM START ===
       * Purpose: Keep abort-only stream state structurally aligned with
       * reconnect-safe subscriber state.
       * === VIVENTIUM END === */
      state = this.createStreamState();
      this.streams.set(streamId, state);
    }

    state.abortCallbacks.push(callback);

    /* === VIVENTIUM START ===
     * Purpose: Abort and event listeners share one acknowledged channel
     * lifecycle, preventing duplicate SUBSCRIBE calls during first connection.
     * === VIVENTIUM END === */
    return this.ensureChannelSubscribed(channel);
  }

  /**
   * Get all tracked stream IDs (for orphan cleanup)
   */
  getTrackedStreamIds(): string[] {
    return Array.from(this.streams.keys());
  }

  /**
   * Cleanup resources for a specific stream.
   */
  cleanup(streamId: string): void {
    const channel = CHANNELS.events(streamId);
    const state = this.streams.get(streamId);

    if (state) {
      // Clear flush timeout
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      // Clear all handlers and callbacks
      state.handlers.clear();
      state.allSubscribersLeftCallbacks = [];
      state.abortCallbacks = [];
      state.reorderBuffer.pending.clear();
    }

    // Reset sequence counter for this stream
    this.resetSequence(streamId);

    /* === VIVENTIUM START ===
     * Purpose: Unsubscribe only after any in-flight subscribe acknowledgement,
     * and make a future subscription wait for this transition to complete.
     * === VIVENTIUM END === */
    void this.queueChannelUnsubscribe(channel);

    this.streams.delete(streamId);
  }

  /**
   * Destroy all resources.
   */
  destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    this.destroyed = true;
    const cancellationError = new Error('Redis event transport destroyed before connection ready');
    this.rejectTeardownSignal?.(cancellationError);
    this.rejectTeardownSignal = undefined;
    for (const cancel of [...this.connectionWaiterCancellations]) {
      cancel(cancellationError);
    }
    this.destroyPromise = this.destroyInternal();
    return this.destroyPromise;
  }

  private async destroyInternal(): Promise<void> {
    // Clear all flush timeouts and buffered messages
    for (const [, state] of this.streams) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      state.reorderBuffer.pending.clear();
    }

    /* === VIVENTIUM START ===
     * Purpose: Apply the same ordered transition boundary to active and
     * in-flight channels during shutdown.
     * === VIVENTIUM END === */
    const channels = new Set([
      ...this.subscribedChannels,
      ...this.subscriptionReady.keys(),
      ...this.subscriptionTransitions.keys(),
      ...[...this.streams.keys()].map((streamId) => CHANNELS.events(streamId)),
    ]);
    await Promise.all([...channels].map((channel) => this.queueChannelUnsubscribe(channel)));

    this.subscribedChannels.clear();
    this.subscriptionReady.clear();
    this.subscriptionTransitions.clear();
    this.streams.clear();
    this.sequenceCounters.clear();
    if (typeof this.subscriber.removeListener === 'function') {
      this.subscriber.removeListener('message', this.subscriberMessageListener);
      this.subscriber.removeListener('close', this.subscriberCloseListener);
      this.subscriber.removeListener('ready', this.subscriberReadyListener);
    }

    /* === VIVENTIUM START ===
     * Purpose: Close only factory-owned duplicates after their subscription
     * transitions drain. Explicitly supplied subscriber clients stay borrowed.
     * === VIVENTIUM END === */
    if (this.ownsSubscriber) {
      this.subscriber.disconnect();
      if (this.ownedSubscriberErrorListener) {
        this.subscriber.removeListener('error', this.ownedSubscriberErrorListener);
      }
    }

    logger.info('[RedisEventTransport] Destroyed');
  }
}
