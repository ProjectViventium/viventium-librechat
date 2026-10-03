import {
  MAIN_COMPACTION_SIZE_REPAIR_MAX_ATTEMPTS,
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
