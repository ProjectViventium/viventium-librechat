'use strict';

// Service tests replace storage only. The compiled typed continuity service remains real;
// native transaction, source hydration and cross-epoch races have owning Mongo tests.
module.exports = function mainContinuityFixture() {
  const { createMainContinuityService } = require('@librechat/api');
  let store;
  let domains = new Map();
  const domain = (identity) => {
    let state = domains.get(identity.continuityDomainId);
    if (!state) {
      state = { position: 0, generation: 0, accepted: new Map() };
      domains.set(identity.continuityDomainId, state);
    }
    return state;
  };
  const service = createMainContinuityService({
    logger: { warn: jest.fn() },
    persistence: {
      read: (key) => store.read(key),
      create: (state) => store.create(state),
      compareAndSwap: (...args) => store.compareAndSwap(...args),
    },
    history: {
      read: async (identity, options = {}) => {
        const { accepted, position, generation } = domain(identity);
        const turns = [...accepted.values()]
          .filter(
            (turn) =>
              turn.acceptedPosition > (options.after || 0) &&
              turn.acceptedPosition <= (options.through ?? position),
          )
          .sort(
            (a, b) => (a.acceptedPosition - b.acceptedPosition) * (options.descending ? -1 : 1),
          );
        return {
          position,
          generation,
          legacyAvailable: false,
          count: turns.length,
          turns: turns.slice(0, options.limit || 64),
        };
      },
      legacy: async () => ({ artifact: null, stateCursor: '', messageCursor: '', complete: true }),
      fence: async (_identity, _turns, operation) => operation(),
    },
    commitPresentation: async (identity, turn, operation) => {
      const state = domain(identity);
      const accepted = state.accepted;
      store.accepted = accepted;
      const prior = accepted.get(turn.logicalTurnId);
      if (prior && prior.revision >= turn.revision)
        return { status: 'already_committed', acceptedRevision: prior.revision };
      const result = await operation();
      if (result.status !== 'committed') return result;
      if (prior) state.generation++;
      accepted.set(turn.logicalTurnId, { ...turn, acceptedPosition: ++state.position });
      return { status: 'committed', version: state.position, compactionNeeded: true };
    },
  });
  return {
    ...service,
    setMainContinuityPersistenceForTests(adapter) {
      store = adapter;
      domains = new Map();
    },
  };
};
