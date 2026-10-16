/* === VIVENTIUM START === Public task failures never retain raw provider error text. === */
const PUBLIC_FAILURES: Readonly<Record<string, string>> = Object.freeze({
  call_context_failed: 'Context gathering did not finish. Voice continues with available context.',
  call_context_unavailable: 'Context gathering is unavailable. Voice uses available context.',
  call_context_deadline: 'Context gathering exceeded its time limit.',
  call_context_interrupted: 'Context gathering was interrupted.',
  native_input_declined: 'You declined that action. It was stopped.',
  native_input_expired: 'The approval request expired, so that action was stopped. Please retry.',
  native_input_cancelled: 'That action was cancelled.',
  native_turn_cancelled: 'That action was cancelled.',
  provider_progress_stalled: 'The model needs attention because progress stopped.',
  provider_failure: 'Provider unavailable',
  provider_unavailable: 'Provider unavailable',
  provider_unauthorized: 'The model connection needs attention. Please check its connection.',
  provider_access_denied: 'The model provider denied access to this request.',
  provider_rate_limited: 'The model is busy. Please try again shortly.',
  provider_timeout: 'The model did not respond in time. Please try again.',
  remote_failed: 'The task failed.',
  generation_failed: 'The task failed. Please try again.',
  glasshive_checkpoint_unavailable: 'The worker stopped at a checkpoint that cannot accept call input.',
  glasshive_run_failed: 'The worker failed.',
  worker_failed: 'The worker failed.',
  owner_input_failed: 'The worker could not accept that input.',
  owner_retry_failed: 'The worker could not start a new attempt.',
  owner_callback_unavailable: 'The worker result connection is unavailable.',
  provider_quota_exhausted: 'The model quota is exhausted. Please check its connection.',
  provider_auth_unavailable: 'The model connection needs attention. Please check its connection.',
  unsupported_access_mode: 'This model does not support the configured access mode.',
  invalid_agent_builder_control_output: 'The model returned an invalid harness response.',
  native_output_contract_invalid: 'The model returned an invalid harness response.',
  native_output_file_unavailable: 'The file could not be attached.',
  source_context_unavailable: 'The conversation context is unavailable.',
  queue_wait_timeout: 'The worker did not start in time.',
  host_worker_busy: 'The worker is busy. Please try again shortly.',
  host_capacity: 'The worker is busy. Please try again shortly.',
});
const NATIVE_STOPS = new Set([
  'native_input_declined', 'native_input_expired', 'native_input_cancelled', 'native_turn_cancelled',
]);

export function voiceTaskPublicFailure(error: { code?: string } | null | undefined) {
  const supplied = error?.code;
  const code = supplied && Object.prototype.hasOwnProperty.call(PUBLIC_FAILURES, supplied)
    ? supplied : 'generation_failed';
  return {
    code,
    message: PUBLIC_FAILURES[code],
    retryAllowed:
      !NATIVE_STOPS.has(code) &&
      code !== 'native_output_file_unavailable' &&
      code !== 'provider_progress_stalled',
  };
}
/* === VIVENTIUM END === */
