const {
  loadScheduledFailureContract,
  scheduledFailureMetadata,
} = require('../ScheduledFailureContractService');

describe('ScheduledFailureContractService', () => {
  it('loads the same closed v1 contract used by Scheduling Cortex', () => {
    const contract = loadScheduledFailureContract();

    expect(contract.version).toBe(1);
    expect(contract.retry_dispositions).toEqual(
      expect.arrayContaining([
        'retry_scheduled',
        'next_occurrence_only',
        'terminal_action_required',
      ]),
    );
  });

  it('falls back to the closed embedded contract when the source file is unavailable', () => {
    const reader = jest.fn(() => {
      throw new Error('missing file');
    });
    const contract = loadScheduledFailureContract(reader);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(contract.version).toBe(1);
    expect(contract.classes.conversation_capability_grant_required.retryable).toBe(false);
    expect(contract.classes.conversation_session_authority_conflict.retryable).toBe(true);
    expect(contract.classes.provider_unauthorized.retryable).toBe(false);
    expect(contract.classes.provider_rate_limited.retryable).toBe(true);
  });

  it('returns explicit retryability and closes unknown classes', () => {
    expect(scheduledFailureMetadata('provider_rate_limited')).toEqual({
      error_class: 'provider_rate_limited',
      failure_retryable: true,
      failure_contract_version: 1,
    });
    expect(scheduledFailureMetadata('provider_unauthorized')).toEqual({
      error_class: 'provider_unauthorized',
      failure_retryable: false,
      failure_contract_version: 1,
    });
    expect(scheduledFailureMetadata('provider_auth_missing')).toEqual({
      error_class: 'provider_auth_missing',
      failure_retryable: false,
      failure_contract_version: 1,
    });
    expect(scheduledFailureMetadata('untrusted_new_failure')).toEqual({
      error_class: 'untrusted_new_failure',
      failure_retryable: true,
      failure_contract_version: 1,
    });
  });
});
