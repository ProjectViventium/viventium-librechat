import { voiceTaskPublicFailure } from './taskFailure';

describe('public Voice task failures', () => {
  it('preserves route-locked attention without terminal Retry or raw provider text', () => {
    expect(voiceTaskPublicFailure({ code: 'provider_progress_stalled' })).toEqual({
      code: 'provider_progress_stalled',
      message: 'The model needs attention because progress stopped.',
      retryAllowed: false,
    });
  });
  it('reports a file delivery failure without offering to repeat completed effects', () => {
    expect(voiceTaskPublicFailure({ code: 'native_output_file_unavailable' })).toEqual({
      code: 'native_output_file_unavailable',
      message: 'The file could not be attached.',
      retryAllowed: false,
    });
  });
  it('reports file delivery failure without inviting replay of completed effects', () => {
    expect(voiceTaskPublicFailure({ code: 'native_output_file_unavailable' })).toEqual({
      code: 'native_output_file_unavailable',
      message: 'The file could not be attached.',
      retryAllowed: false,
    });
  });
  it.each(['native_input_declined', 'native_input_expired', 'native_input_cancelled', 'native_turn_cancelled'])(
    'keeps %s non-retryable without raw provider text', (code) => {
      const result = voiceTaskPublicFailure({ code });
      expect(result.code).toBe(code);
      expect(result.retryAllowed).toBe(false);
    },
  );
  it('keeps access denial distinct from a model connection authentication failure', () => {
    expect(voiceTaskPublicFailure({ code: 'provider_access_denied' })).toEqual({
      code: 'provider_access_denied',
      message: 'The model provider denied access to this request.',
      retryAllowed: true,
    });
    expect(voiceTaskPublicFailure({ code: 'provider_unauthorized' }).code).toBe('provider_unauthorized');
  });
  it('does not echo an unknown provider error', () => {
    expect(voiceTaskPublicFailure({ code: 'PRIVATE_ERROR_CANARY' })).toEqual({
      code: 'generation_failed', message: 'The task failed. Please try again.', retryAllowed: true,
    });
  });
  it.each(['glasshive_checkpoint_unavailable', 'glasshive_run_failed', 'owner_input_failed',
    'owner_retry_failed', 'owner_callback_unavailable', 'invalid_agent_builder_control_output'])(
    'preserves server-authored %s while replacing raw error text', (code) => {
      const result = voiceTaskPublicFailure({ code });
      expect(result.code).toBe(code);
      expect(result.message).not.toContain('PRIVATE');
    },
  );
});
