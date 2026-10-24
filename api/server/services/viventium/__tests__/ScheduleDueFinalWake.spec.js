/* VIVENTIUM START: real native cleanup must preserve the scheduled-result wake. */
const fs = require('node:fs');
const vm = require('node:vm');
const {
  GenerationJobManagerClass,
  InMemoryJobStore,
  InMemoryEventTransport,
} = require('@librechat/api');

async function completedNative(origin = 'scheduler') {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  await manager.initialize();
  const claim = await store.claimLogicalTurn('stream', 'owner', {
    actor_kind: 'external_user',
    origin,
    surface: 'web',
    conversation_id: 'conversation',
    revision: 1,
    source_event_id: 'event',
  });
  const job = await store.createJob('stream', 'owner', 'conversation', {
    interactionContext: claim.interactionContext,
    responseMessageId: 'answer',
    userMessage: { messageId: 'question' },
  });
  const digest = 'a'.repeat(64);
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    streamId: 'stream',
    responseMessageId: 'answer',
    jobCreatedAt: job.createdAt,
    logicalTurnId: claim.interactionContext.logical_turn_id,
    revision: claim.interactionContext.revision,
    invocationId: 'invocation',
    bodySha256: digest,
    providerId: 'provider',
    agentId: 'agent',
    originSha256: digest,
    source: { id: 'source-db', messageId: 'question', digest },
    admittedAt: Date.now(),
    recoverUntil: Date.now() + 86_400_000,
  };
  await manager.bindNativeResponse(identity);
  await manager.commitNativeResponse(identity, digest);
  await manager.finishNativeResponse(identity, {
    final: true,
    responseMessage: { messageId: 'answer', text: 'Saved useful result.' },
  });
  return { manager, identity };
}
function producer(manager) {
  const source = fs.readFileSync(require.resolve('../nativeResponseService'), 'utf8');
  const start = source.indexOf('async function markNativeResponseReplayStored(');
  const end = source.indexOf('\nasync function recoverNativeResponse(', start);
  const wake = jest.fn(async () => undefined);
  const marked = jest.fn(async () => true);
  const module = { exports: {} };
  vm.runInNewContext(
    `${source.slice(start, end)}\nmodule.exports = markNativeResponseReplayStored;`,
    {
      module,
      GenerationJobManager: manager,
      setImmediate,
      logger: { warn: jest.fn() },
      require: (name) => {
        if (name === '~/models') return { markNativeResponseReplayStored: marked };
        if (name === './ScheduleDueService') return { wakeScheduleDueResult: wake };
        if (name === './GlassHiveMissionAdjudicationService')
          return { wakeGlassHiveMissionAdjudications: jest.fn() };
        return { logger: { warn: jest.fn() } };
      },
    },
  );
  return { mark: module.exports, wake, marked };
}

test('normal native cleanup deletes the job yet still wakes its scheduled canonical result', async () => {
  const { manager, identity } = await completedNative();
  try {
    expect((await manager.getJob('stream')).metadata.interactionContext.origin).toBe('scheduler');
    const f = producer(manager);
    expect(await f.mark(identity)).toBe(true);
    expect(await manager.getJob('stream')).toBeUndefined();
    await new Promise(setImmediate);
    expect(f.wake).toHaveBeenCalledTimes(1);
    expect(f.wake).toHaveBeenCalledWith({
      userId: 'owner',
      streamId: 'stream',
      responseMessageId: 'answer',
    });
  } finally {
    await manager.destroy();
  }
});
test('ordinary interactive native completion does not wake scheduled admissions', async () => {
  const { manager, identity } = await completedNative('interactive');
  try {
    const f = producer(manager);
    expect(await f.mark(identity)).toBe(true);
    await new Promise(setImmediate);
    expect(f.wake).not.toHaveBeenCalled();
  } finally {
    await manager.destroy();
  }
});
/* VIVENTIUM END */

test('missing temporary scheduler context cannot prevent exact committed native settlement', async () => {
  const { manager, identity } = await completedNative();
  try {
    jest.spyOn(manager, 'getJob').mockRejectedValueOnce(new Error('cache unavailable'));
    const f = producer(manager);
    expect(await f.mark(identity)).toBe(true);
    expect(await manager.getJob('stream')).toBeUndefined();
    await new Promise(setImmediate);
    expect(f.wake).not.toHaveBeenCalled();
  } finally {
    await manager.destroy();
  }
});
