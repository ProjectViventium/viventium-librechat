import {
  MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
  recoverMainContinuityCarrierForAdmission,
  retainMainCompactionRoute,
  createMainCompactionStageLease,
  resolveMainCompactionAgent,
  deferAcceptedMainCompactionForCall,
  discardDeferredMainCompaction,
  flushEndedCallMainCompactions,
  resetMainCompactionSchedulingForTests,
  mainCompactionStageBudget,
  mainCompactionStageLeaseRenewal,
  retainMainCompactionCancellationDelivery,
  forgetFailedMainCompaction,
  mainCompactionAcceptanceRetention,
  mainCompactionSourceTargetBytes,
  recordAcceptedMainCompactionClaim,
  recordUnacceptedMainCompactionClaim,
  mainCompactionLeaseRemainingMs,
  mainCompactionSizeRepairBudget,
  recordMainCompactionRejection,
  rememberFailedMainCompaction,
  repeatedFailedMainCompaction,
  retainExternalAcceptanceCompaction,
  scheduleExternallyAcceptedMainCompaction,
} from './mainCompactionScheduling';
import { MAIN_COMPACTION_SOURCE_TARGET_BYTES, createMainCompactionOutputContract } from './mainContinuity';
import type { MainCompactionStructuralIssue } from './mainContinuity';

describe('Main compaction after external acceptance', () => {
  const presentation = { userId: 'owner-1', responseMessageId: 'answer-1' };

  test('runs the finished turn schedule once when its acceptance commits', () => {
    const schedule = jest.fn(() => true);
    retainExternalAcceptanceCompaction({ ...presentation, schedule, now: 1000 });

    expect(scheduleExternallyAcceptedMainCompaction(presentation, { status: 'committed' }, 1001)).toBe(
      true,
    );
    expect(schedule).toHaveBeenCalledWith({ status: 'committed' });
    expect(scheduleExternallyAcceptedMainCompaction(presentation, { status: 'committed' }, 1002)).toBe(
      false,
    );
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('keeps the schedule for a retried acknowledgement until acceptance commits', () => {
    const schedule = jest.fn(() => true);
    retainExternalAcceptanceCompaction({ ...presentation, schedule, now: 1000 });

    expect(
      scheduleExternallyAcceptedMainCompaction(presentation, { status: 'not_accepted' }, 1001),
    ).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    expect(
      scheduleExternallyAcceptedMainCompaction(presentation, { status: 'already_committed' }, 1002),
    ).toBe(true);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('schedules nothing for another owner, an expired entry or an unknown presentation', () => {
    const schedule = jest.fn(() => true);
    retainExternalAcceptanceCompaction({ ...presentation, schedule, now: 1000 });

    expect(
      scheduleExternallyAcceptedMainCompaction(
        { userId: 'owner-2', responseMessageId: 'answer-1' },
        { status: 'committed' },
        1001,
      ),
    ).toBe(false);
    expect(
      scheduleExternallyAcceptedMainCompaction(
        presentation,
        { status: 'committed' },
        1000 + mainCompactionAcceptanceRetention.ttlMs,
      ),
    ).toBe(false);
    expect(scheduleExternallyAcceptedMainCompaction(null, { status: 'committed' }, 1001)).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  test('retains a bounded number of finished turns', () => {
    const { maxRetained } = mainCompactionAcceptanceRetention;
    const schedules = Array.from({ length: maxRetained + 1 }, () => jest.fn(() => true));
    schedules.forEach((schedule, index) =>
      retainExternalAcceptanceCompaction({
        userId: 'owner-1',
        responseMessageId: `bounded-${index}`,
        schedule,
        now: 5000,
      }),
    );

    expect(
      scheduleExternallyAcceptedMainCompaction(
        { userId: 'owner-1', responseMessageId: 'bounded-0' },
        { status: 'committed' },
        5001,
      ),
    ).toBe(false);
    expect(
      scheduleExternallyAcceptedMainCompaction(
        { userId: 'owner-1', responseMessageId: `bounded-${maxRetained}` },
        { status: 'committed' },
        5001,
      ),
    ).toBe(true);
  });
});

describe('bounded Main compaction size repair', () => {
  const overflow = (actual: number): MainCompactionStructuralIssue => ({
    path: '',
    constraint: 'max_bytes',
    actual,
    limit: 6144,
    unit: 'utf8_bytes',
  });
  const lease = (now: number, remainingMs: number) => new Date(now + remainingMs);

  const proposal = (summaryBytes: number, items: number) => ({
    version: 1,
    summary: 'a'.repeat(summaryBytes),
    pendingAsks: Array.from({ length: items }, (_, index) => `${index}:${'b'.repeat(900)}`),
    commitments: [],
    corrections: [],
    decisions: [],
    recurrenceOutcomes: [],
    toolPairs: [],
    durableIdentifiers: [],
  });

  test('converges while the whole proposal shrinks across any byte-size rejection', () => {
    // A summary overflow first, then a smaller whole-proposal overflow, as observed live.
    let state = recordMainCompactionRejection(
      null,
      { path: 'summary', constraint: 'max_bytes', actual: 7000, limit: 6144, unit: 'utf8_bytes' },
      1,
      proposal(7000, 6),
    );
    expect(state.converging).toBe(true);
    state = recordMainCompactionRejection(state, overflow(9000), 2, proposal(4000, 5));
    expect(state.converging).toBe(true);
    expect(recordMainCompactionRejection(state, overflow(9900), 3, proposal(4000, 6)).converging).toBe(
      false,
    );
    expect(
      recordMainCompactionRejection(
        state,
        { path: 'pendingAsks', constraint: 'max_items', actual: 33, limit: 32, unit: 'items' },
        3,
        proposal(100, 1),
      ).converging,
    ).toBe(false);
  });

  test('allows a repair only when the store lease holds it and a review of the slowest length', () => {
    const state = { proposalBytes: 8536, converging: true };
    const now = 1_000_000;
    expect(
      mainCompactionSizeRepairBudget({
        state,
        attempts: 2,
        leaseExpiresAt: lease(now, 200_000),
        now,
        slowestCallMs: 45_000,
        maxCallMs: 240_000,
      }),
    ).toEqual({ allowed: true, timeoutMs: 155_000 });
    expect(
      mainCompactionSizeRepairBudget({
        state,
        attempts: 2,
        leaseExpiresAt: lease(now, 80_000),
        now,
        slowestCallMs: 45_000,
        maxCallMs: 240_000,
      }).allowed,
    ).toBe(false);
    expect(
      mainCompactionSizeRepairBudget({
        state,
        attempts: MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
        leaseExpiresAt: lease(now, 290_000),
        now,
        slowestCallMs: 45_000,
        maxCallMs: 240_000,
      }).allowed,
    ).toBe(false);
    expect(
      mainCompactionSizeRepairBudget({
        state: { proposalBytes: 8600, converging: false },
        attempts: 2,
        leaseExpiresAt: lease(now, 290_000),
        now,
        slowestCallMs: 45_000,
        maxCallMs: 240_000,
      }).allowed,
    ).toBe(false);
  });

  test('reads the remaining lease from the store-owned expiry', () => {
    expect(mainCompactionLeaseRemainingMs(new Date(5000), 2000)).toBe(3000);
    expect(mainCompactionLeaseRemainingMs(new Date(1000).toISOString(), 2000)).toBe(0);
    expect(mainCompactionLeaseRemainingMs(undefined, 2000)).toBe(0);
  });
});

describe('unchanged failed Main compaction', () => {
  const failure = {
    domainEpochKey: 'epoch-1',
    sourceDigest: 'source-1',
    contractKey: 'contract-1',
    reason: 'schema_invalid',
  };

  test('reports an identical failed claim and nothing else', () => {
    expect(rememberFailedMainCompaction(failure)).toBe(true);
    expect(repeatedFailedMainCompaction(failure)).toBe('schema_invalid');
    expect(repeatedFailedMainCompaction({ ...failure, sourceDigest: 'source-2' })).toBeNull();
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: 'contract-2' })).toBeNull();
    expect(repeatedFailedMainCompaction({ ...failure, domainEpochKey: 'epoch-2' })).toBeNull();
    forgetFailedMainCompaction('epoch-1');
    expect(repeatedFailedMainCompaction(failure)).toBeNull();
  });

  test('ignores an incomplete failure record', () => {
    expect(rememberFailedMainCompaction({ ...failure, reason: '' })).toBe(false);
    expect(repeatedFailedMainCompaction(failure)).toBeNull();
  });
});

describe('claim source target after an unaccepted proposal', () => {
  test('halves the next claim source, keeps at least one turn, and resets after promotion', () => {
    expect(mainCompactionSourceTargetBytes('epoch-a')).toBe(MAIN_COMPACTION_SOURCE_TARGET_BYTES);
    expect(recordUnacceptedMainCompactionClaim({ key: 'epoch-a', sourceBytes: 80_000 })).toBe(40_000);
    expect(mainCompactionSourceTargetBytes('epoch-a')).toBe(40_000);
    expect(mainCompactionSourceTargetBytes('epoch-b')).toBe(MAIN_COMPACTION_SOURCE_TARGET_BYTES);
    expect(recordUnacceptedMainCompactionClaim({ key: 'epoch-a', sourceBytes: 1 })).toBe(1);
    recordAcceptedMainCompactionClaim('epoch-a');
    expect(mainCompactionSourceTargetBytes('epoch-a')).toBe(MAIN_COMPACTION_SOURCE_TARGET_BYTES);
  });

  test('never grows beyond the default target', () => {
    expect(
      recordUnacceptedMainCompactionClaim({ key: 'epoch-c', sourceBytes: 10 * MAIN_COMPACTION_SOURCE_TARGET_BYTES }),
    ).toBe(MAIN_COMPACTION_SOURCE_TARGET_BYTES);
  });
});


describe('enclosing compaction deadline and child cancellation', () => {
  test('admits a fidelity repair using distinct observed generation and review durations', () => {
    const input = { leaseExpiresAt: new Date(300000), deadlineAt: new Date(600000),
      completionReserveMs: 200000, now: 142300, slowestCallMs: 130500,
      slowestCompactionCallMs: 130500, slowestReviewCallMs: 11800, maxCallMs: 240000 };
    expect(mainCompactionStageBudget({ ...input, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 145900 });
    expect(mainCompactionStageBudget({ ...input, now: 272800, stage: 'review' }))
      .toEqual({ allowed: true, timeoutMs: 27200 });
    expect(mainCompactionStageBudget({ ...input, now: 160000, stage: 'compaction' }))
      .toEqual({ allowed: false, timeoutMs: 128200 });
    expect(mainCompactionStageBudget({ ...input, now: 295000, stage: 'review' }))
      .toEqual({ allowed: false, timeoutMs: 5000 });
    expect(mainCompactionStageBudget({ ...input, deadlineAt: new Date(330000), stage: 'compaction' }))
      .toEqual({ allowed: false, timeoutMs: 0 });
  });
  test('does not use an observed generation as an unknown review estimate', () => {
    const input = { leaseExpiresAt: new Date(300000), deadlineAt: new Date(600000),
      completionReserveMs: 200000, now: 130500, slowestCallMs: 130500,
      slowestCompactionCallMs: 130500, maxCallMs: 240000 };
    expect(mainCompactionStageBudget({ ...input, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 169500 });
    expect(mainCompactionStageBudget({ ...input, stage: 'review' }))
      .toEqual({ allowed: true, timeoutMs: 169500 });
  });
  test('reserves measured review and Main completion without extending either owner deadline', () => {
    const input = { leaseExpiresAt: new Date(300000), deadlineAt: new Date(600000),
      completionReserveMs: 200000, now: 100000, slowestCallMs: 80000,
      slowestCompactionCallMs: 80000, slowestReviewCallMs: 80000, maxCallMs: 240000 };
    expect(mainCompactionStageBudget({ ...input, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 120000 });
    expect(mainCompactionStageBudget({ ...input, now: 230000, stage: 'compaction' }))
      .toEqual({ allowed: false, timeoutMs: 0 });
    expect(mainCompactionStageBudget({ ...input, now: 230000, stage: 'review' }))
      .toEqual({ allowed: false, timeoutMs: 70000 });
  });
  test('native receipt eligibility plans measured stages against the enclosing budget, not its initial guard', () => {
    const input = { leaseExpiresAt: new Date(721000), deadlineAt: new Date(1201000),
      completionReserveMs: 10000, now: 421000, slowestCallMs: 400000,
      slowestCompactionCallMs: 400000, slowestReviewCallMs: 20000,
      maxCallMs: 240000, stage: 'compaction' as const };
    expect(mainCompactionStageBudget(input)).toEqual({ allowed: false, timeoutMs: 240000 });
    expect(mainCompactionStageBudget({ ...input, nativeDeadlineAdmission: true }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
    expect(mainCompactionStageBudget({ ...input, nativeDeadlineAdmission: true,
      deadlineAt: new Date(841000) })).toEqual({ allowed: false, timeoutMs: 240000 });
    expect(mainCompactionStageBudget({ ...input, nativeDeadlineAdmission: true,
      leaseExpiresAt: new Date(421000) })).toEqual({ allowed: false, timeoutMs: 0 });
    expect(mainCompactionStageBudget({ ...input, nativeDeadlineAdmission: true,
      slowestReviewCallMs: 400000, stage: 'review' }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
    expect(mainCompactionStageBudget({ ...input, nativeDeadlineAdmission: true,
      deadlineAt: new Date(441000) })).toEqual({ allowed: false, timeoutMs: 0 });
  });
  test('a previously admitted Native window prevents an impossible extension from starting', () => {
    const input = { leaseExpiresAt: new Date(661000), deadlineAt: new Date(1201000),
      completionReserveMs: 240000, now: 361000, slowestCallMs: 330000,
      slowestCompactionCallMs: 330000, slowestReviewCallMs: 30000, maxCallMs: 240000,
      stage: 'compaction' as const, nativeDeadlineAdmission: true, nativeAdmittedWindowMs: 675000 };
    expect(mainCompactionStageBudget(input)).toEqual({ allowed: false, timeoutMs: 240000 });
    expect(mainCompactionStageBudget({ ...input, deadlineAt: new Date(1441000) }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
  });
  test('the existing Stop ACK waits for exact child release and restores its parent owner', async () => {
    const controller = new AbortController(); const parent = Promise.resolve({ delivered: true });
    Object.defineProperty(controller.signal, '_viventiumHarnessCancellationDelivery',
      { configurable: true, get: () => parent });
    let settle!: () => void; let released = false;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const restore = retainMainCompactionCancellationDelivery({ signal: controller.signal,
      settled, capacityReleased: () => released });
    const delivery = (controller.signal as unknown as Record<string, Promise<unknown>>)
      ._viventiumHarnessCancellationDelivery;
    let acknowledged = false; void delivery.then(() => { acknowledged = true; });
    await Promise.resolve(); expect(acknowledged).toBe(false);
    released = true; settle(); await expect(delivery).resolves.toEqual({ delivered: true });
    restore(); expect((controller.signal as unknown as Record<string, unknown>)
      ._viventiumHarnessCancellationDelivery).toBe(parent);
  });
  test('never reports delivered when a settled child has unresolved native capacity', async () => {
    const controller = new AbortController();
    const restore = retainMainCompactionCancellationDelivery({ signal: controller.signal,
      settled: Promise.resolve(), capacityReleased: () => false });
    await expect((controller.signal as unknown as Record<string, Promise<unknown>>)
      ._viventiumHarnessCancellationDelivery).rejects.toThrow('main_compaction_native_release_unconfirmed');
    restore(); expect(controller.signal).not.toHaveProperty('_viventiumHarnessCancellationDelivery');
  });
});


describe('cold stage admission and observed size repair', () => {
  const cold = { leaseExpiresAt: new Date(300000), deadlineAt: new Date(600000),
    completionReserveMs: 200000, now: 0, slowestCallMs: 0,
    slowestCompactionCallMs: 0, slowestReviewCallMs: 0, maxCallMs: 240000 };
  test('does not cut an unobserved generation to half its live claim lease', () => {
    expect(mainCompactionStageBudget({ ...cold, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
    expect(mainCompactionStageLeaseRenewal({ ...cold, stage: 'compaction' })).toBeNull();
    expect(mainCompactionStageBudget({ ...cold, now: 2061, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
  });
  test('an unobserved stage can use positive remaining time but not an expired budget', () => {
    expect(mainCompactionStageBudget({ ...cold, now: 299999, stage: 'review' }))
      .toEqual({ allowed: true, timeoutMs: 1 });
    expect(mainCompactionStageBudget({ ...cold, now: 300000, stage: 'review' }))
      .toEqual({ allowed: false, timeoutMs: 0 });
    expect(mainCompactionStageBudget({ ...cold, now: 0,
      deadlineAt: new Date(200000), stage: 'compaction' }))
      .toEqual({ allowed: false, timeoutMs: 0 });
  });
  test('uses only each observed stage and retains its measured admission gate', () => {
    expect(mainCompactionStageBudget({ ...cold, now: 110000, slowestCallMs: 160000,
      slowestCompactionCallMs: 160000, slowestReviewCallMs: 16000, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 174000 });
    expect(mainCompactionStageBudget({ ...cold, now: 125000,
      slowestCompactionCallMs: 160000, slowestReviewCallMs: 16000, stage: 'compaction' }))
      .toEqual({ allowed: false, timeoutMs: 159000 });
  });
  test('retains no-deadline lease and per-call bounds', () => {
    expect(mainCompactionStageBudget({ ...cold, deadlineAt: undefined,
      slowestCompactionCallMs: 300000, stage: 'compaction' }))
      .toEqual({ allowed: true, timeoutMs: 240000 });
  });
  test('stage-aware converging repair reserves its measured review, not generation twice', () => {
    const repair = { state: { proposalBytes: 9000, converging: true }, attempts: 2,
      leaseExpiresAt: new Date(300000), now: 110000, slowestCallMs: 160000,
      slowestCompactionCallMs: 160000, slowestReviewCallMs: 16000, maxCallMs: 240000 };
    expect(mainCompactionSizeRepairBudget(repair)).toEqual({ allowed: true, timeoutMs: 174000 });
    expect(mainCompactionSizeRepairBudget({ ...repair, attempts: 4 }).allowed).toBe(false);
    expect(mainCompactionSizeRepairBudget({ ...repair, state: { ...repair.state, converging: false } }).allowed).toBe(false);
    expect(mainCompactionSizeRepairBudget({ ...repair, now: 300000 }).allowed).toBe(false);
    expect(mainCompactionSizeRepairBudget({ ...repair, now: 125000 }).allowed).toBe(false);
  });
});

describe('enclosing compaction lease renewal', () => {
  const budget = { leaseExpiresAt: new Date(300000), deadlineAt: new Date(600000),
    completionReserveMs: 200000, now: 161370, slowestCallMs: 145780,
    slowestCompactionCallMs: 145780, slowestReviewCallMs: 15590,
    maxCallMs: 240000, stage: 'compaction' as const };
  test('the measured legal correction fits only after bounded live-lease renewal', () => {
    expect(mainCompactionStageBudget(budget).allowed).toBe(false);
    const expiresAt = mainCompactionStageLeaseRenewal(budget);
    expect(expiresAt).toEqual(new Date(400000));
    expect(mainCompactionStageBudget({ ...budget, leaseExpiresAt: expiresAt }).allowed).toBe(true);
  });
  test('each renewal retains the existing stale-holder duration even with more enclosing time', () => {
    expect(mainCompactionStageLeaseRenewal({ ...budget, deadlineAt: new Date(900000) }))
      .toEqual(new Date(budget.now + 300000));
  });
  test.each([
    { deadlineAt: undefined },
    { deadlineAt: new Date(500000) },
    { leaseExpiresAt: new Date(161370) },
    { leaseExpiresAt: new Date(400000) },
  ])('does not renew without a live blocking lease and sufficient enclosing budget: %p', change => {
    expect(mainCompactionStageLeaseRenewal({ ...budget, ...change })).toBeNull();
  });
});


describe('accepted compaction during a live call', () => {
  const call = { userId: 'owner-a', callSessionId: 'call-a', status: 'listening', expiresAtMs: 10000 };
  beforeEach(resetMainCompactionSchedulingForTests);
  test('keeps only the latest domain input and starts it once at End', async () => {
    const first = jest.fn(async () => 'old'), latest = jest.fn(async () => 'latest');
    expect(deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call, schedule: first, now: 1000 })).toBe(true);
    expect(deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call, schedule: latest, now: 2000 })).toBe(true);
    expect(first).not.toHaveBeenCalled(); expect(latest).not.toHaveBeenCalled();
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 3000)).toBe(1);
    expect(first).not.toHaveBeenCalled(); expect(latest).toHaveBeenCalledTimes(1);
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 3001)).toBe(0);
  });
  test('late acceptance after End and invalid calls use ordinary scheduling', async () => {
    const schedule = jest.fn(async () => 'run');
    await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 1000);
    for (const candidate of [call, { ...call, callSessionId: 'another', userId: 'foreign' },
      { ...call, callSessionId: 'another', status: 'ended' }, { ...call, callSessionId: 'another', expiresAtMs: 1 }, null]) {
      expect(deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call: candidate, schedule, now: 2000 })).toBe(false);
    }
    expect(schedule).not.toHaveBeenCalled();
  });
  test('expiry or process state reset discards only schedules, never claims completed work', async () => {
    const schedule = jest.fn(async () => 'run');
    deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call, schedule, now: 1000 });
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 10001)).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
    resetMainCompactionSchedulingForTests();
    expect(deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call, schedule, now: 1000 })).toBe(true);
    resetMainCompactionSchedulingForTests();
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 2000)).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
  });
  test('foreground recovery removes only its same-domain deferred input', async () => {
    const first = jest.fn(async () => 'first'), second = jest.fn(async () => 'second');
    deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-a', call, schedule: first, now: 1000 });
    deferAcceptedMainCompactionForCall({ ownerId: 'owner-a', domainKey: 'domain-b', call, schedule: second, now: 1000 });
    discardDeferredMainCompaction('domain-a');
    expect(await flushEndedCallMainCompactions({ ...call, status: 'ended' }, 2000)).toBe(1);
    expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledTimes(1);
  });
});


describe('canonical Main compaction route', () => {
  const main = () => ({ id: 'main', provider: 'selected-main', model: 'selected-primary',
    model_parameters: { reasoning_effort: 'high', nested: { chosen: true } },
    fallback_llm_provider: 'selected-fallback', fallback_llm_model: 'selected-backup',
    fallback_llm_model_parameters: { reasoning_effort: 'high' } });

  test('retains the authorized Main tuple across a Voice override and later configuration edits', () => {
    const req = { user: { id: 'owner' } }; const declaration = main();
    expect(retainMainCompactionRoute(req, declaration)).toBe(true);
    declaration.model_parameters.nested.chosen = false;
    const voice = { ...declaration, provider: 'voice-route', endpoint: 'voice-route',
      model: 'voice-model', model_parameters: { reasoning_effort: 'low', nested: { chosen: false } },
      fallback_llm_provider: 'voice-fallback', fallback_llm_model: 'voice-backup' };
    expect(retainMainCompactionRoute(req, voice)).toBe(true);
    const isolated = resolveMainCompactionAgent(req, voice);
    expect(isolated).toMatchObject(main());
    expect(isolated.endpoint).toBe('selected-main');
    isolated.model_parameters.nested.chosen = false;
    expect(resolveMainCompactionAgent(req, voice).model_parameters.nested.chosen).toBe(true);
    expect(voice.provider).toBe('voice-route');
  });

  test('does not inherit Voice-only fallback or transport configuration when Main declares none', () => {
    const req = { user: { id: 'owner' } };
    const declaration = { id: 'main', provider: 'selected-main', model: 'selected-primary',
      model_parameters: { reasoning_effort: 'high', configuration: { transport: () => true } } };
    retainMainCompactionRoute(req, declaration);
    const voice = { ...declaration, fallback_llm_provider: 'voice-only',
      fallback_llm_model: 'voice-only-model', fallback_llm_model_parameters: { reasoning_effort: 'low' },
      viventiumFallbackLlmAssignment: { provider: 'voice-only', model: 'voice-only-model' },
      viventiumFallbackLlm: { provider: 'voice-only', model: 'voice-only-model' },
      viventiumFallbackLlmInitializationError: new Error('synthetic-voice-only') };
    const isolated = resolveMainCompactionAgent(req, voice);
    expect(isolated.fallback_llm_provider).toBeUndefined();
    expect(isolated.fallback_llm_model).toBeUndefined();
    expect(isolated.fallback_llm_model_parameters).toEqual({});
    expect(isolated.viventiumFallbackLlmAssignment).toBeUndefined();
    expect(isolated.viventiumFallbackLlm).toBeUndefined();
    expect(isolated.viventiumFallbackLlmInitializationError).toBeUndefined();
    expect(isolated.model_parameters).toEqual({ reasoning_effort: 'high' });
  });

  test('keeps ordinary text selection and unrelated requests unchanged', () => {
    const req = { user: { id: 'owner' } }; const selected = main();
    retainMainCompactionRoute(req, selected);
    expect(resolveMainCompactionAgent(req, selected)).toMatchObject(selected);
    expect(resolveMainCompactionAgent({ user: { id: 'another-owner' } }, selected)).toBe(selected);
  });

  test('never applies another agent or owner route on the same request', () => {
    const req = { user: { id: 'owner' } }; const selected = main();
    retainMainCompactionRoute(req, selected);
    expect(() => resolveMainCompactionAgent(req, { ...selected, id: 'other' })).toThrow('main_compaction_route_owner_mismatch');
    expect(() => retainMainCompactionRoute(req, { ...selected, id: 'other' })).toThrow('main_compaction_route_owner_mismatch');
    req.user.id = 'another-owner';
    expect(() => resolveMainCompactionAgent(req, selected)).toThrow('main_compaction_route_owner_mismatch');
  });
});


describe('admitted private compaction stage lease', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
  afterEach(() => jest.useRealTimers());
  function fixture(deadlineMs = 661000, initialExpiry = 301000) {
    const controller = new AbortController(); let expiry = initialExpiry;
    const renew = jest.fn(async (target: Date) => {
      expect(expiry).toBeGreaterThan(Date.now());
      expect(target.getTime()).toBeLessThanOrEqual(Date.now() + 300000);
      expiry = target.getTime(); return { status: 'renewed' };
    });
    const onLost = jest.fn(() => controller.abort('compaction_lease_lost'));
    const lease = createMainCompactionStageLease({ signal: controller.signal, graceMs: 15000,
      leaseExpiresAt: () => expiry, renew, onLost });
    return { lease, renew, onLost, controller,
      receipt: { requestId: 'native-request', responseDeadlineAt: new Date(deadlineMs).toISOString() } };
  }
  test('retains one exact lease beyond five minutes through an admitted provider deadline', async () => {
    const f = fixture(); expect(await f.lease.admit(f.receipt)).toBe(true);
    await jest.advanceTimersByTimeAsync(660000);
    expect(f.renew).toHaveBeenCalledTimes(3);
    expect(f.renew.mock.calls[2][0].getTime()).toBe(676000);
    expect(f.onLost).not.toHaveBeenCalled();
    await f.lease.settle(); await jest.advanceTimersByTimeAsync(600000);
    expect(f.renew).toHaveBeenCalledTimes(3);
    expect(await f.lease.admit(f.receipt)).toBe(false);
  });
  test('renews an inherited short remaining lease before accepting the next stage deadline', async () => {
    const f = fixture(661000, 16000); expect(await f.lease.admit(f.receipt)).toBe(true);
    expect(f.renew).toHaveBeenCalledTimes(1);
    expect(f.renew.mock.calls[0][0].getTime()).toBe(301000);
    await jest.advanceTimersByTimeAsync(150000); expect(f.onLost).not.toHaveBeenCalled();
    await f.lease.settle();
  });
  test('skips renewal when the current lease already covers deadline plus grace', async () => {
    const f = fixture(201000); await f.lease.admit(f.receipt);
    await jest.advanceTimersByTimeAsync(150000);
    expect(f.renew).not.toHaveBeenCalled(); expect(f.onLost).not.toHaveBeenCalled();
    await f.lease.settle();
  });
  test('never overlaps CAS and waits for the final in-flight renewal during cleanup', async () => {
    const f = fixture(); let release!: () => void;
    f.renew.mockImplementation(() => new Promise(resolve => { release = () => resolve({ status: 'renewed' }); }));
    await f.lease.admit(f.receipt); await jest.advanceTimersByTimeAsync(200000);
    expect(f.renew).toHaveBeenCalledTimes(1);
    let settled = false; const done = f.lease.settle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false);
    release(); await done; await jest.advanceTimersByTimeAsync(600000);
    expect(f.renew).toHaveBeenCalledTimes(1);
  });
  test.each(['stale_lease', 'unavailable'])('cancels only its existing owner on genuine %s', async status => {
    const f = fixture(); f.renew.mockResolvedValue({ status }); await f.lease.admit(f.receipt);
    await jest.advanceTimersByTimeAsync(150000);
    expect(f.controller.signal.reason).toBe('compaction_lease_lost');
    expect(f.onLost).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(600000); expect(f.renew).toHaveBeenCalledTimes(1);
    await f.lease.settle();
  });
  test.each(['active', 'settling'])('a stalled renewal cannot outlive known expiry while %s', async mode => {
    const f = fixture(); await f.lease.admit(f.receipt);
    f.renew.mockImplementation(() => new Promise(() => {}));
    await jest.advanceTimersByTimeAsync(150000); expect(f.renew).toHaveBeenCalledTimes(1);
    let settled = false; const done = mode === 'settling'
      ? f.lease.settle().then(() => { settled = true; }) : null;
    await jest.advanceTimersByTimeAsync(149999);
    expect(settled).toBe(false); expect(f.onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    if (done) await done;
    else { await f.lease.settle(); settled = true; }
    expect(f.controller.signal.reason).toBe('compaction_lease_lost');
    expect(f.onLost).toHaveBeenCalledTimes(1); expect(settled).toBe(true);
    expect(f.renew).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  test('active CAS contention retains the live lease, then cancels at its known expiry', async () => {
    const f = fixture(); await f.lease.admit(f.receipt);
    f.renew.mockResolvedValue({ status: 'busy' });
    await jest.advanceTimersByTimeAsync(150000);
    expect(f.onLost).not.toHaveBeenCalled(); expect(f.controller.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(149999); expect(f.onLost).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1); expect(f.onLost).toHaveBeenCalledTimes(1);
    expect(f.renew).toHaveBeenCalledTimes(1); await f.lease.settle();
  });
  test('initial contention declines the longer guard without inventing ownership loss', async () => {
    const f = fixture(661000, 16000); f.renew.mockResolvedValue({ status: 'busy' });
    expect(await f.lease.admit(f.receipt)).toBe(false);
    expect(f.onLost).not.toHaveBeenCalled(); expect(f.controller.signal.aborted).toBe(false);
    await f.lease.settle(); await jest.advanceTimersByTimeAsync(600000);
    expect(f.renew).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
  });
  test('missing, malformed, past or late admissions cannot start a keepalive', async () => {
    const f = fixture();
    expect(await f.lease.admit({ requestId: '', responseDeadlineAt: f.receipt.responseDeadlineAt })).toBe(false);
    expect(await f.lease.admit({ requestId: 'native-request', responseDeadlineAt: 'invalid' })).toBe(false);
    expect(await f.lease.admit({ requestId: 'native-request', responseDeadlineAt: new Date(0).toISOString() })).toBe(false);
    f.controller.abort('maintenance_yield'); expect(await f.lease.admit(f.receipt)).toBe(false);
    await jest.advanceTimersByTimeAsync(600000); expect(f.renew).not.toHaveBeenCalled();
    await f.lease.settle();
  });
  test('intentional yield stops the admitted timer without changing the abort reason', async () => {
    const f = fixture(); await f.lease.admit(f.receipt); f.controller.abort('maintenance_yield');
    await jest.advanceTimersByTimeAsync(600000);
    expect(f.renew).not.toHaveBeenCalled(); expect(f.controller.signal.reason).toBe('maintenance_yield');
    expect(f.onLost).not.toHaveBeenCalled(); await f.lease.settle();
  });
});

describe('bounded idle legacy continuation', () => {
  const { runMainCompactionIdleBatch } = jest.requireActual('./mainCompactionScheduling');

  test('continues only successful reviewed legacy progress and yields between claims', async () => {
    const run = jest.fn()
      .mockResolvedValueOnce({ status: 'compacted', continuationPending: true })
      .mockResolvedValueOnce({ status: 'compacted', version: 2 });
    const yieldIdle = jest.fn(async () => {});
    const result = await runMainCompactionIdleBatch({ run, yieldIdle, shouldYield: () => false, now: () => 1000 });
    expect(result).toEqual({ status: 'compacted', version: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(yieldIdle).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(new Date(1201000).toISOString());
  });

  test.each(['degraded', 'busy', 'stale_source', 'empty'])('stops on %s without retrying work', async status => {
    const run = jest.fn(async () => ({ status, continuationPending: true }));
    await runMainCompactionIdleBatch({ run, shouldYield: () => false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('bounds batches and leaves the durable cursor to the existing claim owner', async () => {
    const run = jest.fn(async () => ({ status: 'compacted', continuationPending: true }));
    const result = await runMainCompactionIdleBatch({ run, shouldYield: () => false, yieldIdle: async () => {} });
    expect(run).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ continuationPending: true, reason: 'idle_budget_exhausted' });
  });

  test('only successful reviewed progress can re-arm an exhausted stage budget', async () => {
    const exhausted = { status: 'degraded', reason: 'compaction_enclosing_deadline' };
    const run = jest.fn().mockResolvedValueOnce({ status: 'compacted', continuationPending: true })
      .mockResolvedValueOnce(exhausted);
    expect(await runMainCompactionIdleBatch({ run, shouldYield: () => false, yieldIdle: async () => {} }))
      .toMatchObject({ status: 'compacted', continuationPending: true, reason: 'idle_budget_exhausted' });
    for (const failure of [exhausted, { status: 'degraded', reason: 'main_compaction_provider_failed' }]) {
      const noProgress = jest.fn(async () => failure);
      expect(await runMainCompactionIdleBatch({ run: noProgress, shouldYield: () => false }))
        .toEqual(failure);
      expect(noProgress).toHaveBeenCalledTimes(1);
    }
  });
  test('gives foreground admission priority before and between claims', async () => {
    let interactive = true;
    const run = jest.fn(async () => ({ status: 'compacted', continuationPending: true }));
    const input = { run, shouldYield: () => interactive, yieldIdle: async () => { interactive = true; } };
    expect(await runMainCompactionIdleBatch(input)).toMatchObject({ status: 'deferred', reason: 'interactive_priority' });
    expect(run).not.toHaveBeenCalled();
    interactive = false;
    await runMainCompactionIdleBatch(input);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('inherits the shorter enclosing deadline and does not begin a claim after it', async () => {
    let now = 1000;
    const run = jest.fn(async deadlineAt => {
      expect(deadlineAt).toBe(new Date(2000).toISOString());
      now = 2001;
      return { status: 'compacted', continuationPending: true };
    });
    const result = await runMainCompactionIdleBatch({ run, shouldYield: () => false, now: () => now,
      deadlineAt: new Date(2000).toISOString(), yieldIdle: async () => {} });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe('idle_budget_exhausted');
  });
});

describe('existing deferral owner re-arms idle legacy continuation', () => {
  const { deferAcceptedMainCompactionForIdle } = jest.requireActual('./mainCompactionScheduling');
  beforeEach(() => { jest.useFakeTimers(); resetMainCompactionSchedulingForTests(); });
  afterEach(() => { resetMainCompactionSchedulingForTests(); jest.useRealTimers(); });

  test('continues after an idle window without another accepted user turn', async () => {
    let batches = 0;
    const input = { ownerId: 'owner', domainKey: 'idle-domain', shouldYield: () => false,
      onError: jest.fn(), schedule: async () => {
        batches++;
        if (batches < 2) deferAcceptedMainCompactionForIdle(input);
      } };
    expect(deferAcceptedMainCompactionForIdle(input)).toBe(true);
    expect(batches).toBe(0);
    await jest.advanceTimersByTimeAsync(60000);
    expect(batches).toBe(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('waits for foreground work, then runs once; explicit discard prevents invocation', async () => {
    let foreground = true;
    const schedule = jest.fn(async () => {});
    const input = { ownerId: 'owner', domainKey: 'idle-domain', schedule,
      shouldYield: () => foreground, onError: jest.fn() };
    deferAcceptedMainCompactionForIdle(input);
    await jest.advanceTimersByTimeAsync(30000);
    expect(schedule).not.toHaveBeenCalled();
    foreground = false;
    await jest.advanceTimersByTimeAsync(30000);
    expect(schedule).toHaveBeenCalledTimes(1);
    deferAcceptedMainCompactionForIdle(input);
    discardDeferredMainCompaction(input.domainKey);
    await jest.advanceTimersByTimeAsync(30000);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  test('cancellation and a failed continuation stop without an automatic provider retry', async () => {
    const controller = new AbortController(), onError = jest.fn();
    const schedule = jest.fn(async () => { throw new Error('provider unavailable'); });
    const input = { ownerId: 'owner', domainKey: 'idle-domain', schedule,
      shouldYield: () => false, onError, signal: controller.signal };
    deferAcceptedMainCompactionForIdle(input);
    await jest.advanceTimersByTimeAsync(30000);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    deferAcceptedMainCompactionForIdle(input);
    controller.abort();
    await jest.advanceTimersByTimeAsync(30000);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe('bounded idle whole-source size recovery', () => {
  const { runMainCompactionIdleBatch } = jest.requireActual('./mainCompactionScheduling');
  const failed = { status: 'degraded', reason: 'schema_invalid', canReduceSource: true,
    sourceDigest: 'a'.repeat(64), domainEpochKey: 'size-domain', sourceBytes: 80000,
    nextSourceTargetBytes: 40000 };

  test.each(['schema_invalid', 'source_packet_budget'])('passes exact %s source to a smaller claim in the same deadline', async reason => {
    const run = jest.fn().mockResolvedValueOnce({ ...failed, reason }).mockResolvedValueOnce({ status: 'compacted' });
    const result = await runMainCompactionIdleBatch({ run, shouldYield: () => false,
      now: () => 1000, yieldIdle: async () => {} });
    expect(result).toEqual({ status: 'compacted' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]).toEqual([new Date(1201000).toISOString(), {
      sourceDigest: failed.sourceDigest, domainEpochKey: failed.domainEpochKey,
      sourceBytes: 80000, nextSourceTargetBytes: 40000,
    }]);
  });

  test.each([
    { canReduceSource: false }, { canReduceSource: undefined }, { sourceDigest: '' },
    { domainEpochKey: '' }, { sourceBytes: 0 }, { sourceBytes: 80000.5 },
    { nextSourceTargetBytes: 0 }, { nextSourceTargetBytes: 80000 },
    { nextSourceTargetBytes: 90000 }, { nextSourceTargetBytes: 1.5 },
    { reason: 'provider_failed' }, { reason: 'review_provider_failed' },
    { reason: 'semantic_fidelity' }, { reason: 'compaction_cancelled' },
  ])('does not retry without valid typed size reduction: %j', async invalid => {
    const run = jest.fn(async () => ({ ...failed, ...invalid }));
    await runMainCompactionIdleBatch({ run, shouldYield: () => false, yieldIdle: async () => {} });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test.each([
    { sourceDigest: failed.sourceDigest }, { sourceBytes: 80000 }, { sourceBytes: 90000 },
    { domainEpochKey: 'foreign-domain' }, { nextSourceTargetBytes: 40000 },
  ])('does not loop on a non-progressing second result: %j', async invalid => {
    const run = jest.fn().mockResolvedValueOnce(failed).mockResolvedValue({ ...failed,
      sourceDigest: 'b'.repeat(64), sourceBytes: 50000, nextSourceTargetBytes: 25000, ...invalid });
    await runMainCompactionIdleBatch({ run, shouldYield: () => false, yieldIdle: async () => {} });
    expect(run).toHaveBeenCalledTimes(2);
  });

  test('counts reductions against the same four-claim cap without a reviewed-success rearm', async () => {
    let calls = 0;
    const run = jest.fn(async () => ({ ...failed, sourceDigest: String(++calls).repeat(64),
      sourceBytes: 80000 / 2 ** (calls - 1), nextSourceTargetBytes: 40000 / 2 ** (calls - 1) }));
    expect(await runMainCompactionIdleBatch({ run, shouldYield: () => false, yieldIdle: async () => {} }))
      .toMatchObject({ status: 'degraded', reason: 'idle_budget_exhausted' });
    expect(run).toHaveBeenCalledTimes(4);
  });

  test.each(['interactive', 'deadline'])('stops before a reduced claim for %s priority', async stop => {
    let blocked = false, now = 1000;
    const run = jest.fn(async () => failed);
    await runMainCompactionIdleBatch({ run, shouldYield: () => blocked, now: () => now,
      deadlineAt: new Date(2000).toISOString(), yieldIdle: async () => {
        if (stop === 'interactive') blocked = true;
        else now = 2000;
      } });
    expect(run).toHaveBeenCalledTimes(1);
  });
});


describe('terminal size exhaustion under monotone allocation', () => {
  const key = (reserved: number, model = 'synthetic', consumer: 'accepted_core' | 'conversation_legacy' = 'accepted_core') =>
    JSON.stringify({ provider: 'native', model, effort: 'high', constraints:
      createMainCompactionOutputContract({ consumer, carrierMaxUtf8Bytes: 131072, reservedUtf8Bytes: reserved }) });
  test('suppresses only compatible equal or tighter allocations after true size exhaustion', () => {
    const failure = { domainEpochKey: 'size-exhausted', sourceDigest: 'same-source',
      contractKey: key(55000), reason: 'schema_invalid', sizeExhausted: true };
    expect(rememberFailedMainCompaction(failure)).toBe(true);
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(55000) })).toBe('schema_invalid');
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(56000) })).toBe('schema_invalid');
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(54000) })).toBeNull();
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(56000, 'different') })).toBeNull();
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(56000, 'synthetic', 'conversation_legacy') })).toBeNull();
    expect(repeatedFailedMainCompaction({ ...failure, sourceDigest: 'changed-source', contractKey: key(56000) })).toBeNull();
    forgetFailedMainCompaction(failure.domainEpochKey);
    expect(rememberFailedMainCompaction({ ...failure, sizeExhausted: false,
      reason: 'compaction_enclosing_deadline' })).toBe(true);
    expect(repeatedFailedMainCompaction({ ...failure, contractKey: key(56000) })).toBeNull();
    forgetFailedMainCompaction(failure.domainEpochKey);
  });
});

describe('parallel Main carrier dependency recovery', () => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  test('a fitting Main never reads or waits for active memory', async () => {
    const getActiveCompactions = jest.fn(() => [new Promise<void>(() => {})]);
    const ensure = jest.fn();
    const load = jest.fn(async () => ({ status: 'available' }));
    expect(
      await recoverMainContinuityCarrierForAdmission({
        identityKey: 'domain',
        load,
        ensure,
        getActiveCompactions,
      }),
    ).toEqual({ status: 'available' });
    expect(getActiveCompactions).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
  });
  test('rechecks the next bounded claim across the idle continuation boundary', async () => {
    const first = gate(),
      second = gate();
    let active = [first.promise],
      fits = false;
    first.promise.then(() =>
      setImmediate(() => {
        active = [second.promise];
      }),
    );
    second.promise.then(() => {
      active = [];
      fits = true;
    });
    const ensure = jest.fn(async () => ({ status: 'busy' }));
    const load = jest.fn(async () => ({ status: fits ? 'available' : 'context_budget' }));
    const waiting = recoverMainContinuityCarrierForAdmission({
      identityKey: 'domain',
      load,
      ensure,
      getActiveCompactions: () => active,
    });
    void waiting.catch(() => {});
    await Promise.resolve();
    expect(ensure).not.toHaveBeenCalled();
    first.resolve();
    await new Promise<void>((done) => setImmediate(done));
    await new Promise<void>((done) => setImmediate(done));
    expect(ensure).not.toHaveBeenCalled();
    second.resolve();
    expect(await waiting).toEqual({ status: 'available' });
    expect(ensure).not.toHaveBeenCalled();
  });
  test('settlement without a fitting reviewed result uses the existing ensure once', async () => {
    const first = gate();
    let active = [first.promise],
      fits = false;
    first.promise.then(() => {
      active = [];
    });
    const ensure = jest.fn(async () => {
      fits = true;
    });
    const request = {};
    const waiting = recoverMainContinuityCarrierForAdmission({
      request,
      identityKey: 'domain',
      load: async () => ({ status: fits ? 'available' : 'context_budget' }),
      ensure,
      getActiveCompactions: () => active,
    });
    await Promise.resolve();
    expect(ensure).not.toHaveBeenCalled();
    first.resolve();
    expect(await waiting).toEqual({ status: 'available' });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  test('a stopped waiting request does not cancel its shared producer or spend recovery', async () => {
    const first = gate(),
      controller = new AbortController(),
      request = {};
    const ensure = jest.fn();
    let active = [first.promise];
    const waiting = recoverMainContinuityCarrierForAdmission({
      request,
      identityKey: 'domain',
      load: async () => ({ status: 'context_budget' }),
      ensure,
      signal: controller.signal,
      getActiveCompactions: () => active,
    });
    void waiting.catch(() => {});
    await Promise.resolve();
    controller.abort('user_stop');
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(request).not.toHaveProperty('_viventiumAcceptedMainCarrierRecovery');
    expect(ensure).not.toHaveBeenCalled();
    active = [];
    first.resolve();
  });
  test('a late busy ensure rechecks the already-started same-domain producer', async () => {
    const first = gate();
    let active: Promise<void>[] = [],
      fits = false;
    const ensure = jest.fn(async () => {
      active = [first.promise];
      return { status: 'busy' };
    });
    first.promise.then(() => {
      active = [];
      fits = true;
    });
    const waiting = recoverMainContinuityCarrierForAdmission({
      identityKey: 'domain',
      load: async () => ({ status: fits ? 'available' : 'context_budget' }),
      ensure,
      getActiveCompactions: () => active,
    });
    void waiting.catch(() => {});
    await new Promise<void>((done) => setImmediate(done));
    first.resolve();
    expect(await waiting).toEqual({ status: 'available' });
    expect(ensure).toHaveBeenCalledTimes(1);
  });
  test.each([false, true])(
    'a non-fitting late producer retries only an unclaimed busy result, dispatched=%s',
    async (dispatched) => {
      const first = gate();
      let active: Promise<void>[] = [],
        fits = false;
      const ensure = jest.fn(async () => {
        if (ensure.mock.calls.length === 1) {
          active = [first.promise];
          return { status: 'busy', ...(dispatched ? { attempts: 1 } : {}) };
        }
        fits = true;
        return { status: 'compacted', attempts: 1 };
      });
      first.promise.then(() => {
        active = [];
      });
      const waiting = recoverMainContinuityCarrierForAdmission({
        request: {},
        identityKey: 'domain',
        load: async () => ({ status: fits ? 'available' : 'context_budget' }),
        ensure,
        getActiveCompactions: () => active,
      });
      void waiting.catch(() => {});
      await new Promise<void>((done) => setImmediate(done));
      first.resolve();
      if (dispatched) {
        await expect(waiting).rejects.toMatchObject({
          code: 'source_context_unavailable',
          status: 413,
        });
        expect(ensure).toHaveBeenCalledTimes(1);
      } else {
        expect(await waiting).toEqual({ status: 'available' });
        expect(ensure).toHaveBeenCalledTimes(2);
      }
    },
  );
});
