const mongoose = require('mongoose');
const createIngress = require('./viventiumTelegramIngressEvent');

const Ingress = createIngress(mongoose.createConnection());

test('retains prepared input identity and recovery state through the real schema', () => {
  const prepared = {
    dedupeKey: 'm:123:1',
    telegramUserId: '123',
    requestedConversationId: 'new',
    conversationGeneration: 'a'.repeat(64),
    sourceMessageId: 'source-message',
    mediaGroupId: '',
    inputState: 'preparing',
    inputClaimToken: 'claim-token',
    inputLeaseUntil: 1234,
    inputRetryAt: 0,
    inputAttempts: 0,
    inputFailureCode: '',
    inputPreparedDigest: '',
    inputRegistrationId: 'registration-id',
    inputPrimarySourceEventId: 'b'.repeat(64),
    inputRelatedSourceEventIds: ['c'.repeat(64)],
    inputFailures: [{ code: 'retryable', at: 123 }],
    expiresAt: null,
  };
  const document = new Ingress(prepared);
  expect(document.validateSync()).toBeUndefined();
  expect(new Ingress(document.toObject()).toObject()).toMatchObject(prepared);
  document.inputState = 'completed';
  expect(document.validateSync().errors.expiresAt).toBeDefined();
  document.expiresAt = new Date();
  expect(document.validateSync()).toBeUndefined();
});

test('legacy ingress does not acquire prepared-input authority and still requires expiry', () => {
  const document = new Ingress({ dedupeKey: 'legacy', telegramUserId: '123' });
  expect(document.inputState).toBeUndefined();
  expect(document.inputRelatedSourceEventIds).toBeUndefined();
  expect(document.validateSync().errors.expiresAt).toBeDefined();
});
