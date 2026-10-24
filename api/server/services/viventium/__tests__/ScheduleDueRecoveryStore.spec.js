/* VIVENTIUM START: actual Mongo store predicates and retry timestamps without a live database. */
const fs = require('node:fs');
const vm = require('node:vm');
const matches = require('sift').default;

function fixture(rows, options = {}) {
  let store;
  const update = jest.fn(async (filter, patch) => {
    const row = rows.find(matches(filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, patch.$set || {});
    for (const key of Object.keys(patch.$unset || {})) delete row[key];
    return { matchedCount: 1, modifiedCount: 1 };
  });
  const collection = {
    findOne: jest.fn(async (filter) => rows.find(matches(filter)) || null),
    updateOne: update,
    findOneAndUpdate: jest.fn(async (filter, patch) => {
      const row = rows.filter(matches(filter)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
      if (!row) return null;
      Object.assign(row, patch.$set);
      return row;
    }),
  };
  let reconcile = jest.fn(async () => undefined);
  const enqueue = jest.fn(async () => ({ configured: 1, enqueued: 1, unresolved: 0 }));
  const dispatch = jest.fn();
  const readFinal = jest.fn(async () => null);
  const module = { exports: {} };
  const requireStub = (name) => {
    if (name === 'crypto') return require('crypto');
    if (name === 'mongoose') return { connection: { collection: () => collection } };
    if (name === '@librechat/api')
      return {
        ...require('@librechat/api'),
        createScheduleDueHost: (deps) => {
          store = deps.store;
          if (!options.realHost) return { reconcile };
          const host = require('@librechat/api').createScheduleDueHost({
            ...deps,
            readOwner: async () => true,
            readConversation: async () => ({ endpoint: 'agents' }),
            readJob: async () => null,
            readMessage: async () => ({ messageId: 'answer', text: 'Saved useful result.' }),
            readActiveCall: async () => null,
            enqueue,
            dispatch,
          });
          reconcile = host.reconcile;
          return host;
        },
      };
    if (name === '@librechat/data-schemas') return { logger: { warn: jest.fn(), info: jest.fn() } };
    if (name === './nativeResponseService') return { readRetainedMainFinal: readFinal };
    if (name === '~/db/models')
      return {
        Message: {
          find: () => ({ select: () => ({ limit: () => ({ lean: async () => [] }) }) }),
          exists: async () => false,
        },
      };
    return {};
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../ScheduleDueService'), 'utf8'), {
    require: requireStub,
    module,
    process: { env: {} },
    Date,
    setImmediate,
  });
  return { store, collection, readFinal, reconcile, enqueue, dispatch, exports: module.exports };
}
const unknown = (id) => ({
  _id: id,
  kind: 'schedule_due',
  status: 'accepted',
  dueState: 'unknown',
  failureCode: 'schedule_due_stream_unavailable',
  updatedAt: new Date(0),
});
test('exhausted unknown prefix cannot starve a new accepted run', async () => {
  const old = Array.from({ length: 16 }, (_, i) => ({
    ...unknown(`old-${i}`),
    resultRecoveryExhaustedAt: new Date(1),
    nextAttemptAt: new Date(Date.now() + 900_000),
  }));
  const current = { ...unknown('current'), dueState: 'running', updatedAt: new Date(2) };
  const f = fixture([...old, current]);
  expect((await f.store.claim())._id).toBe('current');
});
test('release preserves persisted growing unknown backoff rather than rearming two seconds', async () => {
  const row = {
    ...unknown('unknown'),
    claimToken: 'exact-claim',
    nextAttemptAt: new Date(Date.now() + 900_000),
  };
  const next = row.nextAttemptAt;
  const f = fixture([row]);
  await f.store.release(row);
  expect(row.nextAttemptAt).toEqual(next);
  expect(row).not.toHaveProperty('claimToken');
});
test('an exact later canonical result re-arms exhausted unknown without executing work again', async () => {
  const row = {
    ...unknown('unknown'),
    userId: 'owner',
    streamId: 'stream',
    conversationId: 'conversation',
    eventId: 'event',
    envelope: { schedule_id: 'schedule', occurrence_id: 'occurrence' },
    resultRecoveryExhaustedAt: new Date(1),
  };
  const f = fixture([row]);
  f.readFinal.mockResolvedValue({
    responseMessageId: 'answer',
    conversationId: 'conversation',
    interactionContext: {
      origin: 'scheduler',
      source_event_id: 'event',
      schedule_id: 'schedule',
      schedule_run_id: 'occurrence',
    },
  });
  await f.exports.wakeScheduleDueResult({
    userId: 'owner',
    streamId: 'stream',
    responseMessageId: 'answer',
  });
  expect(row.resultMessageId).toBe('answer');
  expect(row).not.toHaveProperty('resultRecoveryExhaustedAt');
  expect(f.reconcile).toHaveBeenCalledTimes(1);
});
/* VIVENTIUM END */

test('a foreign scheduled source cannot re-arm an exhausted result admission', async () => {
  const row = {
    ...unknown('unknown'),
    userId: 'owner',
    streamId: 'stream',
    conversationId: 'conversation',
    eventId: 'event',
    envelope: { schedule_id: 'schedule', occurrence_id: 'occurrence' },
    resultRecoveryExhaustedAt: new Date(1),
  };
  const f = fixture([row]);
  f.readFinal.mockResolvedValue({
    responseMessageId: 'answer',
    conversationId: 'conversation',
    interactionContext: {
      origin: 'scheduler',
      source_event_id: 'different-event',
      schedule_id: 'schedule',
      schedule_run_id: 'occurrence',
    },
  });
  await f.exports.wakeScheduleDueResult({
    userId: 'owner',
    streamId: 'stream',
    responseMessageId: 'answer',
  });
  expect(row).not.toHaveProperty('resultMessageId');
  expect(row.resultRecoveryExhaustedAt).toEqual(new Date(1));
  expect(f.reconcile).not.toHaveBeenCalled();
});

test('after save-before-wake crash a fresh host cold-inspects an exhausted row and delivers once', async () => {
  const row = {
    ...unknown('unknown'),
    userId: 'owner',
    streamId: 'stream',
    conversationId: 'conversation',
    eventId: 'event',
    bindingRef: 'binding',
    resultRecoveryAttempts: 16,
    resultRecoveryExhaustedAt: new Date(1),
    nextAttemptAt: new Date(0),
    envelope: {
      schedule_id: 'schedule',
      occurrence_id: 'occurrence',
      principal: { tenant_id: 'test' },
    },
  };
  const binding = {
    _id: 'binding',
    kind: 'schedule_binding',
    active: true,
    ownerId: 'owner',
    tenantId: 'test',
    conversationId: 'conversation',
    destinations: [{ surface: 'librechat' }],
  };
  const rows = [row, binding];
  const f = fixture(rows, { realHost: true });
  f.readFinal.mockResolvedValue({
    responseMessageId: 'answer',
    conversationId: 'conversation',
    interactionContext: {
      origin: 'scheduler',
      source_event_id: 'event',
      schedule_id: 'schedule',
      schedule_run_id: 'occurrence',
    },
  });
  await f.reconcile();
  expect(row).toMatchObject({ dueState: 'delivery_queued', resultMessageId: 'answer' });
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.dispatch).not.toHaveBeenCalled();
  await f.reconcile();
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});
test('cold inspections retain lease exclusivity and continue after the previous fast budget', async () => {
  const row = {
    ...unknown('unknown'),
    resultRecoveryExhaustedAt: new Date(1),
    nextAttemptAt: new Date(0),
  };
  const f = fixture([row]);
  const claims = await Promise.all([f.store.claim(), f.store.claim()]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claim = claims.find(Boolean);
  await f.store.update(claim, { nextAttemptAt: new Date(Date.now() + 900_000) });
  await f.store.release(claim);
  expect(await f.store.claim()).toBeNull();
  row.nextAttemptAt = new Date(0);
  expect((await f.store.claim())._id).toBe('unknown');
});

test('sixteen due cold inspections defer unknowns so the next cycle reaches a useful later result', async () => {
  const binding = {
    _id: 'binding',
    kind: 'schedule_binding',
    active: true,
    ownerId: 'owner',
    tenantId: 'test',
    conversationId: 'conversation',
    destinations: [{ surface: 'librechat' }],
  };
  const rows = Array.from({ length: 17 }, (_, i) => ({
    ...unknown(`row-${i}`),
    userId: 'owner',
    streamId: i === 16 ? 'current' : `old-${i}`,
    conversationId: 'conversation',
    eventId: 'event',
    bindingRef: 'binding',
    resultRecoveryAttempts: 16,
    resultRecoveryExhaustedAt: new Date(1),
    nextAttemptAt: new Date(0),
    updatedAt: new Date(i),
    envelope: {
      schedule_id: 'schedule',
      occurrence_id: 'occurrence',
      principal: { tenant_id: 'test' },
    },
  }));
  const f = fixture([...rows, binding], { realHost: true });
  f.readFinal.mockImplementation(async (scope) =>
    scope.streamId === 'current'
      ? {
          responseMessageId: 'answer',
          conversationId: 'conversation',
          interactionContext: {
            origin: 'scheduler',
            source_event_id: 'event',
            schedule_id: 'schedule',
            schedule_run_id: 'occurrence',
          },
        }
      : null,
  );
  await f.reconcile();
  expect(f.enqueue).not.toHaveBeenCalled();
  for (const row of rows.slice(0, 16)) {
    expect(row.dueState).toBe('unknown');
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(890_000);
    expect(row.resultRecoveryExhaustedAt).toEqual(new Date(1));
  }
  await f.reconcile();
  expect(rows[16].dueState).toBe('delivery_queued');
  expect(f.enqueue).toHaveBeenCalledTimes(1);
  expect(f.dispatch).not.toHaveBeenCalled();
});
