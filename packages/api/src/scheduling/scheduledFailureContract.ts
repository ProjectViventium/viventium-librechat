/* === VIVENTIUM START ===
 * Feature: Shared scheduled failure truth.
 * Purpose: LibreChat authors the structured provider failure and Scheduling Cortex decides the
 * occurrence transition from the same closed, versioned contract.
 * === VIVENTIUM END === */

export interface ScheduledFailureContract {
  version: number;
  one_time_max_attempts?: number;
  auto_pause_consecutive_failures?: number | null;
  classes: Record<string, { retryable: boolean }>;
  retry_dispositions?: readonly string[];
}

export const defaultScheduledFailureContract: ScheduledFailureContract = Object.freeze({
  version: 1,
  one_time_max_attempts: 3,
  auto_pause_consecutive_failures: null,
  classes: Object.freeze({
    activation_provider_unavailable: { retryable: true },
    completion_error: { retryable: true },
    conversation_capability_grant_required: { retryable: false },
    conversation_session_authority_conflict: { retryable: true },
    context_length_exceeded: { retryable: false },
    provider_access_denied: { retryable: false },
    provider_auth_missing: { retryable: false },
    provider_connected_account_reconnect_required: { retryable: false },
    provider_quota_exhausted: { retryable: false },
    provider_rate_limited: { retryable: true },
    provider_response_deadline_exceeded: { retryable: true },
    provider_temporarily_unavailable: { retryable: true },
    provider_timeout: { retryable: true },
    provider_unauthorized: { retryable: false },
    recoverable_provider_error: { retryable: true },
    timeout: { retryable: true },
  }),
  retry_dispositions: Object.freeze([
    'retry_scheduled',
    'next_occurrence_only',
    'paused',
    'terminal_action_required',
    'no_retry',
  ]),
});

export type ScheduledFailureContractReader = (filePath: string, encoding: string) => string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScheduledFailureContract(value: unknown): value is ScheduledFailureContract {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.classes)) {
    return false;
  }
  return Object.values(value.classes).every(
    (entry) => isRecord(entry) && typeof entry.retryable === 'boolean',
  );
}

export function createScheduledFailureContractService({
  contractPath,
  readFile,
}: {
  contractPath: string;
  readFile: ScheduledFailureContractReader;
}) {
  function loadScheduledFailureContract(
    reader: ScheduledFailureContractReader = readFile,
  ): ScheduledFailureContract {
    try {
      const parsed: unknown = JSON.parse(reader(contractPath, 'utf8'));
      if (!isScheduledFailureContract(parsed)) {
        throw new Error('scheduled_failure_contract_invalid');
      }
      return parsed;
    } catch {
      return defaultScheduledFailureContract;
    }
  }

  const scheduledFailureContract = Object.freeze(loadScheduledFailureContract());

  function scheduledFailureMetadata(errorClass: unknown): {
    error_class: string;
    failure_retryable: boolean;
    failure_contract_version: number;
  } {
    const normalized = String(errorClass || '')
      .trim()
      .toLowerCase();
    const classContract = scheduledFailureContract.classes[normalized];
    if (!classContract || typeof classContract.retryable !== 'boolean') {
      return {
        error_class: normalized || 'completion_error',
        failure_retryable: Boolean(scheduledFailureContract.classes.completion_error?.retryable),
        failure_contract_version: scheduledFailureContract.version,
      };
    }
    return {
      error_class: normalized,
      failure_retryable: classContract.retryable,
      failure_contract_version: scheduledFailureContract.version,
    };
  }

  return { loadScheduledFailureContract, scheduledFailureContract, scheduledFailureMetadata };
}
