const { timingSafeTextEqual } = require('../gateway/security');

describe('timingSafeTextEqual', () => {
  it('accepts only the exact shared secret across equal and unequal lengths', () => {
    expect(timingSafeTextEqual('gateway-secret', 'gateway-secret')).toBe(true);
    expect(timingSafeTextEqual('gateway-secret', 'gateway-secrex')).toBe(false);
    expect(timingSafeTextEqual('gateway-secret', 'short')).toBe(false);
    expect(timingSafeTextEqual('gateway-secret', '')).toBe(false);
  });
});
