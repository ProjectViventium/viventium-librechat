/**
 * === VIVENTIUM START ===
 * Feature: Durable channel delivery queue.
 * Purpose: Prove idempotency, staged retries, repair recovery, handoff safety, and partition concurrency.
 * === VIVENTIUM END ===
 */

const { ChannelDeliveryQueue } = require('../channelDeliveryQueue');

const envelope = {
  channel: 'slack',
  accountId: 'workspace-1',
  externalUserId: 'U1',
  externalUsername: '',
  externalConversationId: 'C1',
  externalThreadId: '',
  externalMessageId: 'M1',
  externalUpdateId: 'E1',
  inputMode: 'text',
  audioRequested: false,
  text: 'hello',
  attachments: [],
};

function createQueue({ state = () => 'connected', maxAttempts } = {}) {
  const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
  const model = { updateOne };
  const queue = new ChannelDeliveryQueue({
    model,
    dedupe: () => 'a'.repeat(64),
    logger: { warn: jest.fn() },
    getConnectionState: async () => state(),
    heartbeatMs: 60_000,
    maxAttempts,
  });
  return { queue, model, updateOne };
}

function delivery(overrides = {}) {
  return {
    _id: 'delivery-1',
    envelope,
    attempts: 1,
    state: 'agent_processing',
    channel: 'slack',
    accountId: 'workspace-1',
    egressCursor: 0,
    ...overrides,
  };
}

function consumer(processor) {
  return { stopRequested: false, processor };
}

describe('ChannelDeliveryQueue', () => {
  it('enqueues idempotently with a private partition hash and no plaintext key', async () => {
    const { queue, updateOne } = createQueue();
    await queue.enqueue(envelope);
    expect(updateOne).toHaveBeenCalledWith(
      { dedupeKey: 'a'.repeat(64) },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          state: 'inbound_pending',
          partitionKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
      { upsert: true },
    );
    expect(JSON.stringify(updateOne.mock.calls[0][0])).not.toContain('hello');
  });

  it('partitions ordering by conversation and thread instead of blocking every turn from one user', async () => {
    const { queue, updateOne } = createQueue();
    await queue.enqueue({ ...envelope, externalConversationId: 'C1', externalThreadId: 'T1' });
    await queue.enqueue({
      ...envelope,
      externalMessageId: 'M2',
      externalConversationId: 'C2',
      externalThreadId: 'T2',
    });
    await queue.enqueue({
      ...envelope,
      externalMessageId: 'M3',
      externalConversationId: 'C1',
      externalThreadId: 'T1',
    });

    const partitions = updateOne.mock.calls.map(([, update]) => update.$setOnInsert.partitionKey);
    expect(partitions[0]).not.toBe(partitions[1]);
    expect(partitions[0]).toBe(partitions[2]);
  });

  it('persists only a pairing-code hash and redacted command', async () => {
    const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    const queue = new ChannelDeliveryQueue({
      model: { updateOne },
      dedupe: () => 'pair-event',
      logger: { warn: jest.fn() },
      admit: async (value) => ({
        ...value,
        text: '/pair [REDACTED]',
        authorizationSnapshot: { kind: 'pairing', pairingTokenHash: 'f'.repeat(64) },
      }),
    });
    await queue.enqueue({ ...envelope, text: '/pair ABCD-EFGH' });
    const persisted = JSON.stringify(updateOne.mock.calls);
    expect(persisted).not.toContain('ABCD-EFGH');
    expect(persisted).toContain('/pair [REDACTED]');
    expect(persisted).toContain('f'.repeat(64));
  });

  it('applies durable backpressure before creating a delivery record', async () => {
    const updateOne = jest.fn();
    const queue = new ChannelDeliveryQueue({
      model: { updateOne },
      dedupe: () => 'event-1',
      logger: { warn: jest.fn() },
      rateLimiter: {
        reserve: async () => ({ accepted: false, notify: true, retryAfterMs: 60_000 }),
      },
    });
    await expect(queue.enqueue(envelope)).resolves.toMatchObject({
      accepted: false,
      notify: true,
      replyText: expect.stringContaining('Wait'),
    });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('persists a reply before egress, backs off a 429, then sends exactly once on retry', async () => {
    const { queue, updateOne } = createQueue();
    const prepare = jest.fn(async () => ({ text: 'persisted reply' }));
    const send = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('rate limited'), {
          providerResponded: true,
          issueCode: 'rate_limited',
          confirmedChunks: 0,
        }),
      )
      .mockResolvedValueOnce({ providerMessageId: 'sent-1' });
    const onRejected = jest.fn();
    const worker = consumer({ prepare, send, onRejected });
    await queue.processClaim(worker, { delivery: delivery(), lockToken: 'lock-1' });
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'reply_ready' && update.$set.replyText === 'persisted reply',
      ),
    ).toBe(true);
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'reply_ready' &&
          update.$set.lastErrorCode === 'provider_rejected',
      ),
    ).toBe(true);
    await queue.processClaim(worker, {
      delivery: delivery({ state: 'reply_ready', replyText: 'persisted reply', attempts: 2 }),
      lockToken: 'lock-2',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(updateOne.mock.calls.some(([, update]) => update?.$set?.state === 'completed')).toBe(
      true,
    );
  });

  it('preserves a 401-rejected reply through repair and resumes from its chunk cursor', async () => {
    let connectionState = 'connected';
    const { queue, updateOne } = createQueue({ state: () => connectionState });
    const prepare = jest.fn(async () => ({ text: 'durable answer' }));
    const send = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('unauthorized'), {
          providerResponded: true,
          issueCode: 'invalid_credentials',
          confirmedChunks: 1,
        }),
      )
      .mockResolvedValueOnce({ providerMessageId: 'sent-after-repair' });
    const onRejected = jest.fn(async () => {
      connectionState = 'reauth_required';
    });
    const worker = consumer({ prepare, send, onRejected });
    await queue.processClaim(worker, { delivery: delivery(), lockToken: 'lock-1' });
    await queue.processClaim(worker, {
      delivery: delivery({
        state: 'reply_ready',
        replyText: 'durable answer',
        egressCursor: 1,
        attempts: 2,
      }),
      lockToken: 'lock-2',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      updateOne.mock.calls.some(([, update]) => update?.$set?.lastErrorCode === 'repair_required'),
    ).toBe(true);
    connectionState = 'connected';
    await queue.processClaim(worker, {
      delivery: delivery({
        state: 'reply_ready',
        replyText: 'durable answer',
        egressCursor: 1,
        attempts: 3,
      }),
      lockToken: 'lock-3',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(envelope, 'durable answer', 1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('reports uncertain delivery only when this worker wins the terminal state transition', async () => {
    const updateOne = jest
      .fn()
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 1 })
      .mockResolvedValueOnce({ matchedCount: 0 });
    const queue = new ChannelDeliveryQueue({
      model: { updateOne },
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
      heartbeatMs: 60_000,
    });
    const onUncertain = jest.fn();

    await queue.processClaim(
      consumer({
        prepare: async () => ({ text: 'persisted answer' }),
        send: async () => {
          throw new Error('synthetic ambiguous network failure');
        },
        onUncertain,
      }),
      { delivery: delivery(), lockToken: 'stale-lock' },
    );

    expect(
      updateOne.mock.calls.some(([, update]) => update?.$set?.state === 'delivery_uncertain'),
    ).toBe(true);
    expect(onUncertain).not.toHaveBeenCalled();
  });

  it('stops an automatically retrying poison turn after the configured attempt limit', async () => {
    const { queue, updateOne } = createQueue({ maxAttempts: 2 });
    const worker = consumer({
      prepare: async () => {
        throw new Error('synthetic persistent agent failure');
      },
      send: jest.fn(),
    });

    await queue.processClaim(worker, {
      delivery: delivery({ attempts: 2 }),
      lockToken: 'lock-final',
    });

    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'cancelled' &&
          update.$set.lastErrorCode === 'agent_processing_failed_retry_exhausted' &&
          update.$set.envelope === null &&
          update.$set.replyText === null,
      ),
    ).toBe(true);
    expect(updateOne.mock.calls.some(([, update]) => update?.$set?.nextAttemptAt)).toBe(false);
  });

  it('stops provider-rejected egress after the configured attempt limit without rerunning the agent', async () => {
    const { queue, updateOne } = createQueue({ maxAttempts: 2 });
    const prepare = jest.fn();
    const send = jest.fn(async () => {
      throw Object.assign(new Error('synthetic provider rejection'), {
        providerResponded: true,
        confirmedChunks: 1,
      });
    });

    await queue.processClaim(consumer({ prepare, send, onRejected: jest.fn() }), {
      delivery: delivery({
        state: 'reply_ready',
        replyText: 'persisted answer',
        attempts: 2,
        egressCursor: 1,
      }),
      lockToken: 'lock-final-provider',
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'cancelled' &&
          update.$set.lastErrorCode === 'provider_rejected_retry_exhausted' &&
          update.$set.envelope === null &&
          update.$set.replyText === null,
      ),
    ).toBe(true);
    expect(updateOne.mock.calls.some(([, update]) => update?.$set?.nextAttemptAt)).toBe(false);
  });

  it('releases a prepared reply during worker handoff instead of cancelling it', async () => {
    const { queue, updateOne } = createQueue({ state: () => 'verifying' });
    let finishPrepare;
    const prepared = new Promise((resolve) => {
      finishPrepare = resolve;
    });
    const worker = consumer({ prepare: () => prepared, send: jest.fn() });
    const running = queue.processClaim(worker, { delivery: delivery(), lockToken: 'lock-1' });
    worker.stopRequested = true;
    finishPrepare({ text: 'answer survives handoff' });
    await running;
    expect(worker.processor.send).not.toHaveBeenCalled();
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.lastErrorCode === 'worker_handoff' && update.$set.lockToken === null,
      ),
    ).toBe(true);
    expect(updateOne.mock.calls.some(([, update]) => update?.$set?.state === 'cancelled')).toBe(
      false,
    );
  });

  it('cancels a prepared reply when explicit disconnect wins the handoff race', async () => {
    const { queue, updateOne } = createQueue({ state: () => 'disconnected' });
    const send = jest.fn();
    const worker = consumer({ prepare: async () => ({ text: 'must not send' }), send });
    worker.stopRequested = true;
    await queue.processClaim(worker, { delivery: delivery(), lockToken: 'lock-1' });
    expect(send).not.toHaveBeenCalled();
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'cancelled' && update.$set.lastErrorCode === 'connection_stopped',
      ),
    ).toBe(true);
    expect(
      updateOne.mock.calls.some(([, update]) => update?.$set?.lastErrorCode === 'worker_handoff'),
    ).toBe(false);
  });

  it('revalidates mapping before paid Agent work and sends only one recovery reply after remap', async () => {
    const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    const send = jest.fn(async () => ({ providerMessageId: 'generic-only' }));
    const prepare = jest.fn(async () => ({ text: 'private answer for user A' }));
    const queue = new ChannelDeliveryQueue({
      model: { updateOne },
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
      getConnectionState: async () => 'connected',
      validateAuthorization: async () => false,
      heartbeatMs: 60_000,
    });
    await queue.processClaim(
      consumer({
        prepare,
        send,
      }),
      { delivery: delivery(), lockToken: 'lock-1' },
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      envelope,
      'Your channel account link changed. Please send that message again.',
      0,
    );
    expect(send.mock.calls.flat().join(' ')).not.toContain('private answer for user A');
  });

  it('does not retry a remap recovery message after a provider rejection', async () => {
    const updateOne = jest.fn(async () => ({ matchedCount: 1 }));
    const prepare = jest.fn();
    const send = jest.fn(async () => {
      throw Object.assign(new Error('synthetic provider rejection'), {
        providerResponded: true,
        confirmedChunks: 0,
      });
    });
    const queue = new ChannelDeliveryQueue({
      model: { updateOne },
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
      getConnectionState: async () => 'connected',
      validateAuthorization: async () => false,
      heartbeatMs: 60_000,
    });

    await queue.processClaim(consumer({ prepare, send, onRejected: jest.fn() }), {
      delivery: delivery(),
      lockToken: 'lock-remapped',
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      updateOne.mock.calls.some(
        ([, update]) =>
          update?.$set?.state === 'cancelled' &&
          update.$set.lastErrorCode === 'authorization_changed_delivery_failed' &&
          update.$set.envelope === null &&
          update.$set.replyText === null,
      ),
    ).toBe(true);
    expect(updateOne.mock.calls.some(([, update]) => update?.$set?.nextAttemptAt)).toBe(false);
  });

  it('keeps strict order within a blocked partition while claiming another conversation', async () => {
    const now = Date.now();
    const a1 = delivery({
      _id: 'a1',
      partitionKey: 'A',
      state: 'reply_ready',
      lockToken: 'held',
      lockedUntil: new Date(now + 60_000),
      createdAt: new Date(1),
    });
    const b1 = delivery({
      _id: 'b1',
      partitionKey: 'B',
      state: 'inbound_pending',
      createdAt: new Date(3),
    });
    const claimed = { ...b1, state: 'agent_processing' };
    const model = {
      aggregate: jest.fn(async () => [a1, b1]),
      findOneAndUpdate: jest.fn(() => ({ lean: async () => claimed })),
    };
    const queue = new ChannelDeliveryQueue({
      model,
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
    });
    await expect(queue.claim('slack', 'workspace-1')).resolves.toMatchObject({
      delivery: { _id: 'b1' },
      partitionKey: 'B',
    });
    expect(model.findOneAndUpdate.mock.calls[0][0]._id).toBe('b1');
    const pipeline = model.aggregate.mock.calls[0][0];
    expect(pipeline.some((stage) => stage.$group?.delivery?.$first === '$$ROOT')).toBe(true);
    const groupIndex = pipeline.findIndex((stage) => stage.$group);
    const limitIndex = pipeline.findIndex((stage) => stage.$limit);
    expect(groupIndex).toBeGreaterThanOrEqual(0);
    expect(limitIndex).toBeGreaterThan(groupIndex);
    expect(pipeline[limitIndex]).toEqual({ $limit: 100 });
  });

  it('cannot let 201 blocked turns in conversation A hide ready conversation B', async () => {
    const now = Date.now();
    const aHead = delivery({
      _id: 'a-1',
      partitionKey: 'A',
      state: 'reply_ready',
      lockToken: 'held',
      lockedUntil: new Date(now + 60_000),
      createdAt: new Date(1),
    });
    const bHead = delivery({
      _id: 'b-1',
      partitionKey: 'B',
      state: 'inbound_pending',
      createdAt: new Date(202),
    });
    const model = {
      aggregate: jest.fn(async () => [aHead, bHead]),
      findOneAndUpdate: jest.fn(() => ({
        lean: async () => ({ ...bHead, state: 'agent_processing' }),
      })),
    };
    const queue = new ChannelDeliveryQueue({
      model,
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
    });
    await expect(queue.claim('slack', 'workspace-1')).resolves.toMatchObject({ partitionKey: 'B' });
  });

  it('runs a fast conversation while an unrelated conversation is still slow', async () => {
    let finishSlow;
    const slow = new Promise((resolve) => {
      finishSlow = resolve;
    });
    const completed = [];
    const queue = new ChannelDeliveryQueue({
      model: {},
      dedupe: jest.fn(),
      logger: { warn: jest.fn() },
      pollMs: 60_000,
      maxConcurrentPartitions: 2,
    });
    queue.markExpiredSendingUncertain = jest.fn(async () => undefined);
    queue.claim = jest
      .fn()
      .mockResolvedValueOnce({ delivery: { _id: 'A' }, lockToken: '1', partitionKey: 'A' })
      .mockResolvedValueOnce({ delivery: { _id: 'B' }, lockToken: '2', partitionKey: 'B' })
      .mockResolvedValue(null);
    queue.processClaim = jest.fn(async (_worker, claim) => {
      if (claim.partitionKey === 'A') {
        await slow;
      }
      completed.push(claim.partitionKey);
    });
    queue.start('slack', 'workspace-1', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toEqual(['B']);
    finishSlow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toEqual(['B', 'A']);
    queue.stop('slack', 'workspace-1');
  });
});
