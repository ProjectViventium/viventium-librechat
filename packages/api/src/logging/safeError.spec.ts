import { safeErrorCode, safeErrorLogFields } from './safeError';

describe('safeErrorLogFields', () => {
  it('keeps only bounded structural fields and never the raw message', () => {
    const error = Object.assign(
      new Error('synthetic-token=do-not-log /Users/example/private customer.invalid/internal'),
      { code: 'provider_timeout', status: 504 },
    );

    expect(safeErrorLogFields(error, 'operation_failed')).toEqual({
      name: 'Error',
      code: 'provider_timeout',
      status: 504,
    });
    const serialized = JSON.stringify(safeErrorLogFields(error, 'operation_failed'));
    expect(serialized).not.toContain('do-not-log');
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('customer.invalid');
  });

  it('replaces unsafe codes, names, and primitive error text with a declared fallback', () => {
    expect(
      safeErrorLogFields(
        { code: 'secret=https://private.invalid', name: '/Users/example/private' },
        'account_read_failed',
      ),
    ).toEqual({ name: 'Error', code: 'account_read_failed' });
    expect(safeErrorLogFields('raw private provider response', 'operation_failed')).toEqual({
      name: 'Error',
      code: 'operation_failed',
    });
    expect(safeErrorCode({ code: 11000 }, 'database_failed')).toBe('11000');
  });
});
