const {
  getDeferredFallbackErrorText,
  normalizeDeferredFallbackErrorClass,
} = require('../cortexFallbackText');

describe('cortexFallbackText deferred errors', () => {
  test('keeps scheduled deferred fallback silent', () => {
    expect(
      getDeferredFallbackErrorText({
        scheduleId: 'sched-1',
        errorClass: 'timeout',
      }),
    ).toBe('');
  });

  test.each([
    [
      { recoveryReason: 'stale_cortex_startup_recovery' },
      'restart_recovered',
      'That background check was interrupted by a runtime restart before it finished.',
    ],
    [
      { errorClass: 'provider_access_denied' },
      'provider_access_denied',
      'I could not reach the configured provider for that check. Please verify provider access or network routing and try again.',
    ],
    [
      { error: 'Unauthorized provider credentials' },
      'provider_unauthorized',
      'I could not finish that check because the configured provider rejected the credentials.',
    ],
    [
      { error: 'rate limit exceeded' },
      'provider_rate_limited',
      'That background check was rate-limited by the configured provider.',
    ],
    [{ error: 'timeout' }, 'timeout', 'That background check timed out before it could finish.'],
  ])('maps deferred fallback class %#', (input, expectedClass, expectedText) => {
    expect(normalizeDeferredFallbackErrorClass(input)).toBe(expectedClass);
    expect(getDeferredFallbackErrorText(input)).toBe(expectedText);
  });

  test('falls back to generic text for unknown error classes', () => {
    expect(getDeferredFallbackErrorText({ error: 'unexpected failure' })).toBe(
      "I couldn't finish that check just now.",
    );
  });
});
