import {
  MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
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
import { MAIN_COMPACTION_SOURCE_TARGET_BYTES } from './mainContinuity';
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
