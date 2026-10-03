import { voiceTaskPublicFailure } from './taskFailure';

describe('public Voice task failures', () => {
  it.each(['native_input_declined', 'native_input_expired', 'native_input_cancelled', 'native_turn_cancelled'])(
    'keeps %s non-retryable without raw provider text', (code) => {
      const result = voiceTaskPublicFailure({ code });
      expect(result.code).toBe(code);
      expect(result.retryAllowed).toBe(false);
    },
  );
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
