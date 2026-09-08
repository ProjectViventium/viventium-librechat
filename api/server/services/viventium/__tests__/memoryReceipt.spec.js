const { memoryReceiptFromAttachments } = require('../memoryReceipt');

const error = (details) => ({
  type: 'memory',
  memory: {
    key: 'system',
    type: 'error',
    value: JSON.stringify(details),
  },
});
const saved = {
  type: 'memory',
  memory: { key: 'preferences', type: 'update', value: 'private value' },
};

describe('saved-memory receipt failure projection', () => {
  test('preserves ordered provider failures and omits raw private error fields', () => {
    const receipt = memoryReceiptFromAttachments([
      error({
        errorType: 'usage_limit_reached',
        provider: 'openAI',
        message: 'Bearer private-secret',
        headers: { authorization: 'private-secret' },
        providerLabel: 'private supplied label',
      }),
      error({ errorType: 'provider_auth', provider: 'anthropic', accountId: 'private-account' }),
    ]);
    expect(receipt).toEqual({
      status: 'failed',
      keys: [],
      errorType: 'provider_auth',
      failures: [
        {
          errorType: 'usage_limit_reached',
          provider: 'openAI',
          providerLabel: 'OpenAI',
          partialApplied: false,
        },
        {
          errorType: 'provider_auth',
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          partialApplied: false,
        },
      ],
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private|Bearer|authorization|accountId/);
  });

  test('does not publish an unknown provider identifier or supplied label', () => {
    const receipt = memoryReceiptFromAttachments([
      error({
        errorType: 'provider_auth',
        provider: 'private-provider',
        providerLabel: 'private-label',
      }),
    ]);
    expect(receipt.failures).toEqual([{ errorType: 'provider_auth', partialApplied: false }]);
    expect(JSON.stringify(receipt)).not.toContain('private');
  });

  test.each([
    ['writer_interrupted', true, 'uncertain'],
    ['usage_limit_reached', true, 'partial'],
    ['usage_limit_reached', false, 'failed'],
  ])(
    'retains earlier %s partial=%s when a later login failure arrives',
    (errorType, partialApplied, status) => {
      const receipt = memoryReceiptFromAttachments([
        error({ errorType, partialApplied }),
        error({ errorType: 'provider_auth' }),
      ]);
      expect(receipt.status).toBe(status);
      expect(receipt.errorType).toBe('provider_auth');
      expect(receipt.failures[0]).toMatchObject({ errorType, partialApplied });
    },
  );

  test('an applied update plus a failure is partial even without a repeated flag', () => {
    expect(
      memoryReceiptFromAttachments([saved, error({ errorType: 'provider_auth' })]),
    ).toMatchObject({ status: 'partial', keys: ['preferences'] });
  });

  test('preserves successful and unchanged projection and never publishes values', () => {
    expect(memoryReceiptFromAttachments([saved])).toEqual({
      status: 'saved',
      keys: ['preferences'],
    });
    expect(memoryReceiptFromAttachments([])).toBeNull();
    expect(memoryReceiptFromAttachments([{ type: 'file' }])).toBeNull();
  });
});

test('unchanged receipts retain terminal truth without inventing an update or partial failure', () => {
  const unchanged = {
    type: 'memory',
    memory: { type: 'unchanged', key: 'preferences', revision: 8, value: 'private value' },
  };
  expect(memoryReceiptFromAttachments([unchanged])).toEqual({ status: 'unchanged', keys: [] });
  expect(memoryReceiptFromAttachments([unchanged, saved])).toEqual({
    status: 'saved',
    keys: ['preferences'],
  });
  expect(
    memoryReceiptFromAttachments([unchanged, error({ errorType: 'provider_auth' })]),
  ).toMatchObject({ status: 'failed', keys: [] });
});
