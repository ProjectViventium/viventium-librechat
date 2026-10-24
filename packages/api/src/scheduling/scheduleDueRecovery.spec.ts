import {
  scheduleDueUnknownRecovery,
  SCHEDULE_DUE_UNKNOWN_RECOVERY_ATTEMPTS,
} from './scheduleDueRecovery';
import type { ScheduleDueAdmission } from './scheduleDueReceiver';

test('unknown reinspection backs off through the existing time field to its cold inspection budget', () => {
  const now = new Date('2030-01-01T12:00:00Z');
  const row = { admittedAt: now } as ScheduleDueAdmission;
  let previousDelay = 0;
  for (let attempt = 1; attempt <= SCHEDULE_DUE_UNKNOWN_RECOVERY_ATTEMPTS; attempt++) {
    const patch = scheduleDueUnknownRecovery(row, now);
    Object.assign(row, patch);
    const delay = patch.nextAttemptAt!.getTime() - now.getTime();
    expect(delay).toBeGreaterThanOrEqual(previousDelay);
    expect(delay).toBeLessThanOrEqual(900_000);
    expect(!!patch.resultRecoveryExhaustedAt).toBe(
      attempt === SCHEDULE_DUE_UNKNOWN_RECOVERY_ATTEMPTS,
    );
    previousDelay = delay;
  }
  expect(row.resultRecoveryDiagnostic).toBe('schedule_due_result_recovery_exhausted');
  expect(row).not.toHaveProperty('resultMessageId');
  expect(row).not.toHaveProperty('dueState');
});
test('old unknown admission retains typed unknown and moves to cold inspection', () => {
  const now = new Date('2030-01-02T12:00:00Z');
  const patch = scheduleDueUnknownRecovery(
    { admittedAt: new Date('2030-01-01T11:59:59Z') } as ScheduleDueAdmission,
    now,
  );
  expect(patch).toMatchObject({ resultRecoveryExhaustedAt: now, resultRecoveryAttempts: 1 });
});

test('after the fast budget cold inspection persists across restart without a hot loop', () => {
  const exhaustedAt = new Date('2030-01-01T12:00:00Z');
  const now = new Date('2030-01-02T12:00:00Z');
  const row = {
    admittedAt: exhaustedAt,
    resultRecoveryAttempts: 16,
    resultRecoveryExhaustedAt: exhaustedAt,
  } as ScheduleDueAdmission;
  const patch = scheduleDueUnknownRecovery(row, now);
  expect(patch.nextAttemptAt!.getTime() - now.getTime()).toBe(900_000);
  expect(patch.resultRecoveryExhaustedAt).toEqual(exhaustedAt);
  expect(patch.resultRecoveryAttempts).toBe(17);
  expect(patch.resultRecoveryDiagnostic).toBe('schedule_due_result_recovery_exhausted');
  expect(patch).not.toHaveProperty('dueState');
  expect(patch).not.toHaveProperty('status');
});
