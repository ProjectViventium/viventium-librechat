/* === VIVENTIUM START ===
 * Feature: Core orchestration trace ledger adapter.
 * Purpose: Keep legacy API code as a thin Mongo adapter around typed @librechat/api logic.
 * === VIVENTIUM END === */

const {
  appendOrchestrationTraceEvent,
  buildAcceptedLaunchTraceEvent,
  buildCallbackTraceEvents,
  buildDeliveryTraceEvent,
  buildFailedLaunchTraceEvent,
  buildLaunchTraceEvents,
  fingerprintTraceReference,
  ingestGlassHiveWorkDetailTrace,
  readOrchestrationTraceLedger,
} = require('@librechat/api');

const localScopeTails = new Map();

function defaultEventModelProvider() {
  return require('~/db/models').ViventiumOrchestrationTraceEvent;
}

function toRow(row) {
  if (!row) return null;
  const parsedAt = new Date(row.at);
  return {
    schemaVersion: row.schemaVersion,
    ownerScopeHash: row.ownerScopeHash,
    originRefHash: row.originRefHash,
    sequence: row.sequence,
    stage: row.stage,
    at: Number.isFinite(parsedAt.getTime()) ? parsedAt.toISOString() : '',
    facts: row.facts || {},
    eventKeyHash: row.eventKeyHash,
    contentHash: row.contentHash,
    previousEventHash: row.previousEventHash,
    eventHash: row.eventHash,
  };
}

function createMongoStore(getEventModel) {
  return {
    async findByEventKey(query) {
      const EventModel = getEventModel();
      return toRow(await EventModel.findOne(query).lean());
    },
    async findLatest(query) {
      const EventModel = getEventModel();
      return toRow(await EventModel.findOne(query).sort({ sequence: -1 }).lean());
    },
    async findBySequence(query) {
      const EventModel = getEventModel();
      return toRow(await EventModel.findOne(query).lean());
    },
    async insert(row) {
      const EventModel = getEventModel();
      const created = await EventModel.create({ ...row, at: new Date(row.at) });
      return toRow(created.toObject());
    },
    async listPage({ limit, ...query }) {
      const EventModel = getEventModel();
      const rows = await EventModel.find({
        ownerScopeHash: query.ownerScopeHash,
        originRefHash: query.originRefHash,
        sequence: { $gt: query.afterSequence },
      })
        .sort({ sequence: 1 })
        .limit(limit)
        .lean();
      return rows.map(toRow);
    },
  };
}

function traceScope(input = {}) {
  return {
    ownerScopeHash: fingerprintTraceReference('owner', input.ownerId),
    originRefHash: fingerprintTraceReference('origin', input.originRef),
  };
}

function serializeLocalScope(scope, operation) {
  const scopeKey = `${scope.ownerScopeHash}:${scope.originRefHash}`;
  const previous = localScopeTails.get(scopeKey) || Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result
    .catch(() => {})
    .finally(() => {
      if (localScopeTails.get(scopeKey) === tail) localScopeTails.delete(scopeKey);
    });
  localScopeTails.set(scopeKey, tail);
  return result;
}

function exactCallbackIdentity(input = {}) {
  const attemptNumber = input.attemptNumber;
  const preRuntimeTerminal =
    attemptNumber == null &&
    input.workTerminal === true &&
    ['failed', 'cancelled'].includes(String(input.workState || input.state || '').trim()) &&
    ['run.failed', 'run.cancelled', 'run.interrupted'].includes(
      String(input.event || input.callbackEvent || '').trim(),
    );
  return Boolean(
    String(input.workRef || '').trim() &&
    String(input.runRef || '').trim() &&
    /^callback_sha256:[a-f0-9]{64}$/.test(String(input.callbackRef || '').trim()) &&
    (preRuntimeTerminal || (Number.isSafeInteger(attemptNumber) && attemptNumber > 0)),
  );
}

function createProjectedTracePreflightStore(store) {
  const staged = [];
  const sameScope = (row, query) =>
    row.ownerScopeHash === query.ownerScopeHash && row.originRefHash === query.originRefHash;
  return {
    async findByEventKey(query) {
      return (
        staged.find((row) => sameScope(row, query) && row.eventKeyHash === query.eventKeyHash) ||
        store.findByEventKey(query)
      );
    },
    async findLatest(query) {
      const persisted = await store.findLatest(query);
      const pending = staged
        .filter((row) => sameScope(row, query))
        .sort((left, right) => right.sequence - left.sequence)[0];
      if (!pending || Number(persisted?.sequence || 0) > pending.sequence) return persisted;
      return pending;
    },
    async findBySequence(query) {
      return (
        staged.find((row) => sameScope(row, query) && row.sequence === query.sequence) ||
        store.findBySequence(query)
      );
    },
    async insert(row) {
      staged.push(row);
      return row;
    },
    listPage: (query) => store.listPage(query),
  };
}

function createOrchestrationTraceLedgerService({ EventModel, eventModelProvider } = {}) {
  let getEventModel = defaultEventModelProvider;
  if (EventModel) getEventModel = () => EventModel;
  else if (typeof eventModelProvider === 'function') getEventModel = eventModelProvider;
  const store = createMongoStore(getEventModel);
  const withScopeLock = (input, operation) => {
    const scope = traceScope(input);
    return serializeLocalScope(scope, () => {
      const model = getEventModel();
      if (typeof model.withOrchestrationTraceScopeLock === 'function') {
        return model.withOrchestrationTraceScopeLock(scope, operation);
      }
      return operation();
    });
  };
  const appendUnlocked = (input) => appendOrchestrationTraceEvent({ ...input, store });
  const append = (input) => withScopeLock(input, () => appendUnlocked(input));
  const appendProjectedUnlocked = async ({ ownerId, originRef, events }) => {
    const rows = [];
    for (const event of events) {
      rows.push(await appendUnlocked({ ownerId, originRef, ...event }));
    }
    return rows;
  };
  const preflightProjected = async ({ ownerId, originRef, events }) => {
    const preflightStore = createProjectedTracePreflightStore(store);
    for (const event of events) {
      await appendOrchestrationTraceEvent({ ownerId, originRef, ...event, store: preflightStore });
    }
  };
  const appendProjected = ({ ownerId, originRef, events }) =>
    withScopeLock({ ownerId, originRef }, async () => {
      await preflightProjected({ ownerId, originRef, events });
      return appendProjectedUnlocked({ ownerId, originRef, events });
    });
  return Object.freeze({
    append,
    read: (input) => readOrchestrationTraceLedger({ ...input, store }),
    recordLaunch: (input) =>
      appendProjected({
        ownerId: input.ownerId,
        originRef: input.originRef,
        events: buildLaunchTraceEvents(input),
      }),
    recordAcceptedLaunch: (input) => append({ ...input, ...buildAcceptedLaunchTraceEvent(input) }),
    recordFailedLaunch: (input) => append({ ...input, ...buildFailedLaunchTraceEvent(input) }),
    recordCallback: async (input) => {
      if (!exactCallbackIdentity(input)) return Promise.resolve([]);
      const events = buildCallbackTraceEvents(input);
      return appendProjected({
        ownerId: input.ownerId,
        originRef: input.originRef,
        events,
      });
    },
    recordDelivery: (input) => {
      if (!exactCallbackIdentity(input)) return Promise.resolve(null);
      return append({ ...input, ...buildDeliveryTraceEvent(input) });
    },
    recordGlassHiveWorkDetail: (input) =>
      withScopeLock(input, async () => {
        const preflightStore = createProjectedTracePreflightStore(store);
        const preflight = await ingestGlassHiveWorkDetailTrace({
          ...input,
          store: preflightStore,
        });
        if (!preflight.accepted) return preflight;
        return ingestGlassHiveWorkDetailTrace({ ...input, store });
      }),
  });
}

const defaultService = createOrchestrationTraceLedgerService();

module.exports = {
  createOrchestrationTraceLedgerService,
  recordOrchestrationTraceEvent: defaultService.append,
  recordOrchestrationTraceLaunch: defaultService.recordLaunch,
  recordOrchestrationTraceAcceptedLaunch: defaultService.recordAcceptedLaunch,
  recordOrchestrationTraceFailedLaunch: defaultService.recordFailedLaunch,
  recordOrchestrationTraceCallback: defaultService.recordCallback,
  recordOrchestrationTraceDelivery: defaultService.recordDelivery,
  recordGlassHiveWorkDetailTrace: defaultService.recordGlassHiveWorkDetail,
  readOrchestrationTraceEvents: defaultService.read,
};
