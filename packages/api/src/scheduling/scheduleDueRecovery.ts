/* VIVENTIUM START: accepted unknown results back off to cold inspection without replaying execution. */
import type { ScheduleDueAdmission } from './scheduleDueReceiver';

export const SCHEDULE_DUE_UNKNOWN_RECOVERY_ATTEMPTS = 16;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_DELAY_MS = 15 * 60_000;

export function scheduleDueUnknownRecovery(
  admission: ScheduleDueAdmission,
  checkedAt = new Date(),
): Partial<ScheduleDueAdmission> {
  const attempts = Math.max(0, Number(admission.resultRecoveryAttempts) || 0) + 1;
  const admittedAt = new Date(admission.admittedAt).getTime();
  const exhausted =
    Boolean(admission.resultRecoveryExhaustedAt) ||
    attempts >= SCHEDULE_DUE_UNKNOWN_RECOVERY_ATTEMPTS ||
    (Number.isFinite(admittedAt) && checkedAt.getTime() - admittedAt >= MAX_AGE_MS);
  return {
    resultRecoveryAttempts: attempts,
    nextAttemptAt: new Date(
      checkedAt.getTime() +
        (exhausted ? MAX_DELAY_MS : Math.min(MAX_DELAY_MS, 2000 * 2 ** Math.min(attempts - 1, 12))),
    ),
    ...(exhausted
      ? {
          resultRecoveryExhaustedAt: admission.resultRecoveryExhaustedAt || checkedAt,
          resultRecoveryDiagnostic: 'schedule_due_result_recovery_exhausted',
        }
      : {}),
  };
}
/* VIVENTIUM END */
