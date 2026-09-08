import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { nativeJobProofJson } from '../implementations/nativeResponse';
import type { SerializableJobData } from '../interfaces/IJobStore';

import { admitted, nativeStoreContract } from './nativeResponse.helper';
const digest = 'a'.repeat(64);

test('assistant retirement wins after recovery read but before actual FINAL publish', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    await manager.commitNativeResponse(identity, digest);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delivered = jest.fn();
    transport.subscribe(identity.streamId, { onChunk: jest.fn(), onDone: delivered });
    const emit = transport.emitDone.bind(transport);
    jest.spyOn(transport, 'emitDone').mockImplementation(async (...args) => {
      entered();
      await held;
      return emit(...args);
    });
    const recovering = manager.finishNativeResponse(identity, {
      final: true,
      responseMessage: { messageId: 'assistant', text: 'Obsolete answer' },
    } as never);
    await started;
    await manager.retireNativeResponse(identity);
    release();
    expect(await recovering).toBe(false);
    expect(delivered).not.toHaveBeenCalled();
    expect(await manager.getJob(identity.streamId)).toBeUndefined();
  } finally {
    await manager.destroy();
  }
});

describe('process-local native publication', () => {
  nativeStoreContract(() => new InMemoryJobStore(), true);
});

test('Stop after commit returns saved winner without emitting cancellation', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  const final = { final: true, responseMessage: { messageId: 'assistant', text: 'Saved answer' } };
  const aborted = transport.emitAbort;
  manager.setNativeResponseRecovery(async (bound) =>
    manager.finishNativeResponse(bound, final as never),
  );
  const result = await manager.abortJob(identity.streamId, 'user_cancelled');
  expect(result.nativeResponse).toBe('committed');
  expect(result.finalEvent).toEqual(final);
  expect(aborted).not.toHaveBeenCalled();
  await manager.destroy();
});

test('ordinary completion and terminal emit cannot replace a pending native answer', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  const emitted = jest.spyOn(transport, 'emitDone');
  await manager.emitDone(identity.streamId, {
    final: true,
    responseMessage: { text: 'unaccepted' },
  } as never);
  await manager.completeJob(identity.streamId, 'transport disconnected');
  expect(emitted).not.toHaveBeenCalled();
  expect((await store.getJob(identity.streamId))?.finalEvent).toBeUndefined();
  expect(await manager.commitNativeResponse(identity, digest)).toMatchObject({
    status: 'committed',
  });
  await manager.destroy();
});

test('revoked unsupported native work releases ordinary graph completion', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.revokeNativeResponse(identity);
  expect(await manager.settleNativeResponse(identity, 'unsupported')).toBe(true);
  const event = { final: true, responseMessage: { text: 'host graph result' } };
  await manager.emitDone(identity.streamId, event as never);
  expect((await store.getJob(identity.streamId))?.finalEvent).toBe(JSON.stringify(event));
  await store.deleteJob(identity.streamId);
  expect(await store.getJob(identity.streamId)).toBeNull();
  await manager.destroy();
});

test('Stop reports saved result pending if recovery cannot yet materialize it', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  manager.setNativeResponseRecovery(async () => false);
  expect(await manager.abortJob(identity.streamId, 'user_cancelled')).toMatchObject({
    nativeResponse: 'pending',
    success: false,
    finalEvent: null,
  });
  expect(transport.emitAbort).not.toHaveBeenCalled();
  expect((await store.getJob(identity.streamId))?.nativeResponseCancelled).not.toBe(true);
  await manager.destroy();
});

test('teardown during bind cannot report success from a replaced service generation', async () => {
  const old = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: old,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  const { identity } = await admitted(old);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bind = old.bindNativeResponse.bind(old);
  jest.spyOn(old, 'bindNativeResponse').mockImplementation(async (value) => {
    await held;
    return bind(value);
  });
  const pending = manager.bindNativeResponse(identity);
  const rejection = pending.then(
    () => 'unexpected success',
    () => 'rejected',
  );
  await manager.destroy();
  release();
  expect(await rejection).toBe('rejected');
});

test('Stop recovers the winner when admission appears after its initial job read', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  const { identity } = await admitted(store);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = store.getJob.bind(store);
  jest.spyOn(store, 'getJob').mockImplementationOnce(async (stream) => {
    const beforeAdmission = structuredClone(await read(stream));
    entered();
    await gate;
    return beforeAdmission;
  });
  const event = {
    final: true,
    responseMessage: { messageId: identity.responseMessageId, text: 'Saved answer' },
  };
  manager.setNativeResponseRecovery(async (bound) =>
    manager.finishNativeResponse(bound, event as never),
  );
  const pendingStop = manager.abortJob(identity.streamId, 'user_cancelled');
  await started;
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  release();
  expect(await pendingStop).toMatchObject({ nativeResponse: 'committed', finalEvent: event });
  await manager.destroy();
});

test('unavailable Stop authority never emits or claims cancellation', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  jest
    .spyOn(store, 'cancelNativeResponse')
    .mockRejectedValue(new Error('synthetic private command payload'));
  expect(await manager.abortJob(identity.streamId, 'user_cancelled')).toMatchObject({
    nativeResponse: 'unavailable',
    success: false,
    finalEvent: null,
  });
  expect(transport.emitAbort).not.toHaveBeenCalled();
  await manager.destroy();
});

test('Phase B Main completion cannot cache an unaccepted native final for reconnect', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  expect(
    await manager.markMainResponseComplete(identity.streamId, {
      final: true,
      responseMessage: { text: 'not committed' },
    } as never),
  ).toBe(false);
  expect(await store.getJob(identity.streamId)).toMatchObject({ status: 'running' });
  await manager.destroy();
});

test('late transport error cannot replace an accepted saved native final', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  await manager.finishNativeResponse(identity, {
    final: true,
    responseMessage: { text: 'saved' },
  } as never);
  const errors = jest.spyOn(transport, 'emitError');
  await manager.emitError(identity.streamId, 'late transport error');
  expect(errors).not.toHaveBeenCalled();
  expect((await store.getJob(identity.streamId))?.error).toBeUndefined();
  await manager.destroy();
});

test('completed native results release ordinary job capacity and volatile content', async () => {
  const store = new InMemoryJobStore({ maxJobs: 1 });
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  const { identity } = await admitted(store);
  store.setContentParts(identity.streamId, [{ type: 'text', text: 'working buffer' }] as never);
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  await manager.finishNativeResponse(identity, {
    final: true,
    responseMessage: { text: 'saved' },
  } as never);
  await manager.completeJob(identity.streamId);
  await expect(store.createJob('too-early', 'owner', 'conversation')).rejects.toThrow('capacity');
  expect(await manager.settleNativeResponse(identity)).toBe(true);
  expect(await store.getContentParts(identity.streamId)).toBeNull();
  await expect(store.createJob('next-stream', 'owner', 'conversation')).resolves.toMatchObject({
    streamId: 'next-stream',
  });
  expect(await store.getNativeResponseCommit(identity)).toMatchObject({ status: 'committed' });
  await manager.destroy();
});

test('recovery replays the saved final event winner when reconstructed metadata differs', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  const { identity } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  const original = {
    final: true,
    title: 'Original title',
    responseMessage: { messageId: identity.responseMessageId, text: 'saved' },
  };
  const replay = { final: true, responseMessage: original.responseMessage };
  await manager.finishNativeResponse(identity, original as never);
  const emitted = jest.spyOn(transport, 'emitDone');
  expect(await manager.finishNativeResponse(identity, replay as never)).toBe(true);
  expect(emitted).toHaveBeenLastCalledWith(
    identity.streamId,
    original,
    expect.objectContaining({ identity }),
  );
  expect((await store.getJob(identity.streamId))?.finalEvent).toBe(JSON.stringify(original));
  await manager.destroy();
});

test('a later logical revision revokes native work retained after transport error', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  const { identity, job } = await admitted(store);
  await manager.bindNativeResponse(identity);
  await manager.completeJob(identity.streamId, 'transport disconnected');
  await manager.createJob('next-stream', 'owner', 'conversation', {
    interactionContext: {
      ...job.interactionContext!,
      source_event_id: 'next-event',
      source_sequence: 2,
    },
  });
  expect(await store.getJob(identity.streamId)).toMatchObject({
    status: 'superseded',
    nativeResponseCancelled: true,
  });
  await manager.destroy();
});

test('Stop freezes native content and persists it before cancellation or FINAL', async () => {
  const store = new InMemoryJobStore();
  const order: string[] = [];
  const transport = Object.assign(new InMemoryEventTransport(), {
    emitAbort: jest.fn(async () => {
      order.push('abort');
    }),
  });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    const parts = [{ type: 'text', text: 'Accepted partial.' }];
    store.setContentParts(identity.streamId, parts as never);
    manager.setNativeResponseCancellation(async (_bound, snapshot, mode) => {
      order.push(mode === 'published' ? 'published' : 'persist');
      parts[0].text = 'Late mutated content.';
      return { messageId: identity.responseMessageId, ...snapshot };
    });
    const done = jest.spyOn(transport, 'emitDone');
    const result = await manager.abortJob(identity.streamId, 'user_cancelled');
    expect(result).toMatchObject({ success: true, text: 'Accepted partial.' });
    expect(order).toEqual(['persist', 'abort', 'published']);
    expect(done).toHaveBeenCalledWith(
      identity.streamId,
      expect.objectContaining({
        responseMessage: expect.objectContaining({ text: 'Accepted partial.' }),
      }),
      expect.objectContaining({ identity, cancelled: true }),
    );
  } finally {
    await manager.destroy();
  }
});

test('a missing native snapshot owner leaves Stop unavailable without emitting', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    expect(await manager.abortJob(identity.streamId, 'user_cancelled')).toMatchObject({
      success: false,
      nativeResponse: 'unavailable',
    });
    expect(transport.emitAbort).not.toHaveBeenCalled();
    expect(await store.getJob(identity.streamId)).not.toBeNull();
  } finally {
    await manager.destroy();
  }
});

test('Stop adopts an admission that bound after its first job read', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  try {
    const { identity } = await admitted(store);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const read = store.getJob.bind(store);
    jest.spyOn(store, 'getJob').mockImplementationOnce(async (stream) => {
      const prior = structuredClone(await read(stream));
      entered();
      await held;
      return prior;
    });
    const persist = jest.fn(async (_bound, snapshot) => ({
      messageId: identity.responseMessageId,
      ...snapshot,
    }));
    manager.setNativeResponseCancellation(persist);
    const stopped = manager.abortJob(identity.streamId, 'user_cancelled');
    await started;
    await manager.bindNativeResponse(identity);
    release();
    expect(await stopped).toMatchObject({ success: true, jobData: { nativeResponse: identity } });
    expect(persist).toHaveBeenCalledWith(identity, expect.objectContaining({ content: [] }));
  } finally {
    await manager.destroy();
  }
});

test('a replacement job while Stop awaits persistence cannot be cancelled or deleted', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    manager.setNativeResponseCancellation(async (_bound, snapshot) => {
      await store.createJob(identity.streamId, identity.userId, identity.conversationId, {
        responseMessageId: 'replacement',
        createdAt: identity.jobCreatedAt + 1,
      });
      return snapshot;
    });
    expect(await manager.abortJob(identity.streamId, 'user_cancelled')).toMatchObject({
      success: false,
      nativeResponse: 'unavailable',
    });
    expect(transport.emitAbort).not.toHaveBeenCalled();
    expect(await store.getJob(identity.streamId)).toMatchObject({
      responseMessageId: 'replacement',
    });
  } finally {
    await manager.destroy();
  }
});

test('an expected Stop owner or recovery identity cannot authorize a replacement job', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    const cancel = jest.spyOn(store, 'cancelNativeResponse');
    expect(
      (await manager.abortJob(identity.streamId, 'user_cancelled', 'foreign-owner')).success,
    ).toBe(false);
    expect(
      (
        await manager.abortJob(identity.streamId, 'user_cancelled', {
          ...identity,
          invocationId: 'old',
        })
      ).success,
    ).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(transport.emitAbort).not.toHaveBeenCalled();
    expect(await store.getJob(identity.streamId)).toMatchObject({ nativeResponse: identity });
  } finally {
    await manager.destroy();
  }
});

test('Stop retry after publication failure keeps the first saved FINAL and marks only after DONE', async () => {
  const store = new InMemoryJobStore();
  const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    const marked = jest.fn();
    manager.setNativeResponseCancellation(async (_bound, snapshot, mode) => {
      if (mode === 'published') marked();
      return { messageId: identity.responseMessageId, ...snapshot };
    });
    store.setContentParts(identity.streamId, [{ type: 'text', text: 'First partial.' }] as never);
    const emit = transport.emitDone.bind(transport);
    jest.spyOn(transport, 'emitDone').mockRejectedValueOnce(new Error('Transport unavailable'));
    await expect(manager.abortJob(identity.streamId, 'user_cancelled')).rejects.toThrow(
      'Transport unavailable',
    );
    const original = (await store.getJob(identity.streamId))!.finalEvent;
    expect(marked).not.toHaveBeenCalled();
    store.setContentParts(identity.streamId, [{ type: 'text', text: 'Changed retry.' }] as never);
    jest.spyOn(transport, 'emitDone').mockImplementation(emit);
    const retried = await manager.abortJob(identity.streamId, 'user_cancelled', identity);
    expect(retried.success).toBe(true);
    expect(JSON.stringify(retried.finalEvent)).toBe(original);
    expect(retried.text).toBe('First partial.');
    expect(marked).toHaveBeenCalledTimes(1);
  } finally {
    await manager.destroy();
  }
});

test.each([
  undefined,
  { messageId: 'other-answer', text: 'Wrong response.', content: [] },
  { messageId: 'assistant', text: 7, content: [] },
])(
  'Stop retry rejects a retained FINAL without its typed canonical response: %j',
  async (responseMessage) => {
    const store = new InMemoryJobStore();
    const transport = Object.assign(new InMemoryEventTransport(), { emitAbort: jest.fn() });
    const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
    try {
      const { identity } = await admitted(store);
      await manager.bindNativeResponse(identity);
      manager.setNativeResponseCancellation(async (_bound, snapshot) => ({
        messageId: identity.responseMessageId,
        ...snapshot,
      }));
      store.setContentParts(identity.streamId, [{ type: 'text', text: 'First partial.' }] as never);
      const emit = transport.emitDone.bind(transport);
      const done = jest
        .spyOn(transport, 'emitDone')
        .mockRejectedValueOnce(new Error('Transport unavailable'));
      await expect(manager.abortJob(identity.streamId, 'user_cancelled')).rejects.toThrow(
        'Transport unavailable',
      );
      const retained = (await store.getJob(identity.streamId))!;
      retained.finalEvent = JSON.stringify({ final: true, aborted: true, responseMessage });
      transport.emitAbort.mockClear();
      done.mockClear().mockImplementation(emit);
      const retried = await manager.abortJob(identity.streamId, 'user_cancelled', identity);
      expect(retried).toMatchObject({ success: false, nativeResponse: 'unavailable' });
      expect(transport.emitAbort).not.toHaveBeenCalled();
      expect(done).not.toHaveBeenCalled();
      expect(await store.getJob(identity.streamId)).not.toBeNull();
    } finally {
      await manager.destroy();
    }
  },
);

test('received native event proof follows late binding but cannot reach a replacement callback', async () => {
  class DetachedJobStore extends InMemoryJobStore {
    async createJob(...args: Parameters<InMemoryJobStore['createJob']>) {
      return structuredClone(await super.createJob(...args));
    }

    async getJob(stream: string): Promise<SerializableJobData | null> {
      return structuredClone(await super.getJob(stream));
    }
  }
  const store = new DetachedJobStore();
  const callbacks: Array<(reason?: string, proof?: string) => void> = [];
  const transport = Object.assign(new InMemoryEventTransport(), {
    onAbort: (_stream: string, callback: (reason?: string, proof?: string) => void) => {
      callbacks.push(callback);
    },
  });
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const first = await manager.createJob('late-bind', 'owner', 'conversation', {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: 'conversation',
        source_event_id: 'first',
        revision: 1,
      },
    });
    const accepted = jest.fn();
    await manager.subscribe('late-bind', jest.fn(), accepted);
    await manager.updateMetadata('late-bind', {
      responseMessageId: 'answer',
      userMessage: { messageId: 'source' },
    });
    const data = (await store.getJob('late-bind'))!;
    const admittedAt = Date.now();
    const identity = {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'late-bind',
      jobCreatedAt: data.createdAt,
      logicalTurnId: data.interactionContext!.logical_turn_id!,
      revision: data.interactionContext!.revision,
      invocationId: 'invocation',
      bodySha256: 'b'.repeat(64),
      originSha256: 'c'.repeat(64),
      providerId: 'provider',
      agentId: 'agent',
      source: { id: 'source-id', messageId: 'source', digest: 'd'.repeat(64) },
      admittedAt,
      recoverUntil: admittedAt + 86400000,
    };
    expect(await manager.bindNativeResponse(identity)).toBe(true);
    const proof = nativeJobProofJson(data);
    callbacks[0]('user_cancelled', proof);
    expect(first.abortController.signal.aborted).toBe(true);
    const final = { final: true, responseMessage: { text: 'Old partial.' } };
    transport.emitDone('late-bind', final, { identity, isCurrent: () => true });
    expect(accepted).toHaveBeenCalledWith(final);
    const replacement = await manager.createJob('late-bind', 'owner', 'conversation');
    expect(replacement.abortController.signal.aborted).toBe(false);
    const rejected = jest.fn();
    await manager.subscribe('late-bind', jest.fn(), rejected);
    callbacks.at(-1)!('user_cancelled', proof);
    transport.emitDone('late-bind', final, { identity, isCurrent: () => true });
    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(rejected).not.toHaveBeenCalled();
  } finally {
    await manager.destroy();
  }
});

test('a late producer cannot finish, error, or clean up while Stop awaits its snapshot', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    manager.setNativeResponseCancellation(async (_bound, snapshot, mode) => {
      if (!mode) {
        entered();
        await held;
      }
      return { messageId: identity.responseMessageId, ...snapshot };
    });
    const done = jest.spyOn(transport, 'emitDone');
    const error = jest.spyOn(transport, 'emitError');
    const stopping = manager.abortJob(identity.streamId, 'user_cancelled');
    await started;
    try {
      await manager.emitDone(identity.streamId, {
        final: true,
        responseMessage: { text: 'Late producer.' },
      } as never);
      await manager.emitError(identity.streamId, 'Late provider error');
      expect(await manager.markMainResponseComplete(identity.streamId)).toBe(false);
      await manager.completeJob(identity.streamId, 'Late transport error');
      expect(done).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(await store.getJob(identity.streamId)).not.toBeNull();
    } finally {
      release();
    }
    expect((await stopping).success).toBe(true);
  } finally {
    await manager.destroy();
  }
});

test('Stop publishes its canonical FINAL before waiting for cancellation acknowledgement activity', async () => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  let release!: (value: { delivered: boolean }) => void;
  const delivery = new Promise<{ delivered: boolean }>((resolve) => {
    release = resolve;
  });
  try {
    const { identity } = await admitted(store);
    await manager.bindNativeResponse(identity);
    const job = await manager.getJob(identity.streamId);
    job!.abortController.signal.addEventListener('abort', () => {
      (
        job!.abortController.signal as AbortSignal & {
          _viventiumHarnessCancellationDelivery?: Promise<unknown>;
        }
      )._viventiumHarnessCancellationDelivery = delivery;
    });
    manager.setNativeResponseCancellation(async (_identity, snapshot) => ({
      messageId: identity.responseMessageId,
      ...snapshot,
    }));
    const done = jest.spyOn(transport, 'emitDone');
    const stopping = manager.abortJob(identity.streamId, 'user_cancelled');
    await new Promise(setImmediate);
    try {
      expect(done).toHaveBeenCalledTimes(1);
    } finally {
      release({ delivered: true });
    }
    expect((await stopping).success).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
  } finally {
    release({ delivered: true });
    await manager.destroy();
  }
});

test('settled adapter FINAL survives cleanup until acknowledgement, retirement or its fixed deadline', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const store = new InMemoryJobStore({ ttlAfterComplete: 1 });
  try {
    const { identity } = await admitted(store);
    await store.updateJob(identity.streamId, {
      deliveryPolicy: { commit_authority: 'external_adapter' },
    });
    await store.bindNativeResponse(identity);
    await store.commitNativeResponse(identity, digest);
    await store.finishNativeResponse(identity, digest, 'saved');
    await store.settleNativeResponse(identity);
    jest.setSystemTime(Date.now() + 1000);
    await store.updateJob(identity.streamId, { status: 'complete' });
    await store.cleanup();
    await store.deleteJob(identity.streamId);
    expect(await store.hasJob(identity.streamId)).toBe(true);
    await store.updateJob(identity.streamId, {
      deliveryAcknowledgement: {
        logical_turn_id: identity.logicalTurnId,
        revision: identity.revision + 1,
        state: 'committed',
        presentation_ref: 'telegram:synthetic:1',
      },
    });
    await store.deleteJob(identity.streamId);
    expect(await store.hasJob(identity.streamId)).toBe(true);
    jest.setSystemTime(identity.recoverUntil + 1);
    await store.cleanup();
    expect(await store.hasJob(identity.streamId)).toBe(false);
  } finally {
    await store.destroy();
    jest.useRealTimers();
  }
});


test.each(['stop', 'replacement'])('authored preview cannot cross asynchronous %s fence', async (action) => {
  const store = new InMemoryJobStore();
  const transport = new InMemoryEventTransport();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
  manager.initialize();
  try {
    const first = await manager.createJob('preview', 'owner', 'conversation', {
      interactionContext: { actor_kind: 'external_user', origin: 'interactive', surface: 'web',
        conversation_id: 'conversation', source_event_id: 'preview-source', revision: 1 },
    });
    await manager.updateMetadata('preview', { responseMessageId: 'answer', userMessage: { messageId: 'source' } });
    const job = (await store.getJob('preview'))!;
    const admittedAt = Date.now();
    const identity = { userId: 'owner', conversationId: 'conversation', responseMessageId: 'answer',
      streamId: 'preview', jobCreatedAt: job.createdAt, logicalTurnId: job.interactionContext!.logical_turn_id!,
      revision: job.interactionContext!.revision, invocationId: 'invocation', bodySha256: digest,
      originSha256: digest, providerId: 'provider', agentId: 'agent',
      source: { id: 'source-id', messageId: 'source', digest }, admittedAt, recoverUntil: admittedAt + 86400000 };
    expect(await manager.bindNativeResponse(identity)).toBe(true);
    const emitted = jest.spyOn(transport, 'emitChunk');
    const preview = { type: 'text', preview: true, text: 'Early answer.' } as never;
    await manager.emitChunk('preview', preview, identity);
    expect(emitted).toHaveBeenCalledTimes(1);
    emitted.mockClear();
    let release!: () => void;
    let enter!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    jest.spyOn(store, 'isCurrentLogicalTurn').mockImplementationOnce(async () => { enter(); await held; return true; });
    const pending = manager.emitChunk('preview', preview, identity);
    await entered;
    if (action === 'stop') first.abortController.abort();
    else {
      await store.deleteJob('preview');
      await store.createJob('preview', 'owner', 'conversation', { responseMessageId: 'replacement' });
    }
    release();
    await pending;
    expect(emitted).not.toHaveBeenCalled();
  } finally { await manager.destroy(); }
});


test('Web removal acknowledgement validates presentation and fences a replacement during projection', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: new InMemoryEventTransport() });
  manager.initialize();
  try {
    const { identity } = await admitted(store);
    await store.bindNativeResponse(identity);
    await store.updateJob(identity.streamId, { status: 'superseded' });
    const ack = { state: 'partial_removed' as const, presentation_ref: identity.responseMessageId };
    expect(await manager.acknowledgeStreamDelivery(identity.streamId, { ...ack, presentation_ref: 'other' }, identity)).toEqual({ status: 'conflict' });
    expect(await manager.acknowledgeStreamDelivery(identity.streamId, ack, identity)).toMatchObject({ status: 'recorded' });
    (await store.getJob(identity.streamId))!.deliveryAcknowledgement = undefined;
    const update = store.updateJob.bind(store);
    jest.spyOn(store, 'updateJob').mockImplementationOnce(async (streamId, changes, expected) => {
      // Simulate stream reuse after the manager read and before the store mutation.
      const current = (await store.getJob(streamId))!;
      current.createdAt += 1;
      current.nativeResponse = { ...identity, jobCreatedAt: current.createdAt };
      return update(streamId, changes, expected);
    });
    expect(await manager.acknowledgeStreamDelivery(identity.streamId, ack, identity)).toEqual({ status: 'conflict' });
    expect((await store.getJob(identity.streamId))?.deliveryAcknowledgement).toBeUndefined();
  } finally { await manager.destroy(); }
});
