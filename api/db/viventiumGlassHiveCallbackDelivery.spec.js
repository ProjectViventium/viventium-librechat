/* === VIVENTIUM START === Strict native file metadata survives the durable callback carrier. === */
const mongoose = require('mongoose');
const createModel = require('./viventiumGlassHiveCallbackDelivery');
const Model = createModel(new mongoose.Mongoose());

function delivery(nativeOutputFile) {
  return new Model({
    deliveryKey: 'synthetic-delivery',
    deliveryId: 'synthetic-delivery',
    callbackMessageId: 'synthetic-response',
    userId: 'synthetic-owner',
    conversationId: 'synthetic-conversation',
    surface: 'telegram',
    event: 'main.followup',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    attachments: [{ filename: 'result.md', object: 'file', nativeOutputFile }],
  });
}

const available = {
  version: 1,
  status: 'available',
  messageId: 'synthetic-response',
  downloadUrl: 'https://files.example.test/v1/link-refs/synthetic-grant',
};

test('retains the available native grant exactly in the strict delivery schema', () => {
  const doc = delivery(available);
  expect(doc.validateSync()).toBeUndefined();
  expect(doc.toObject().attachments[0].nativeOutputFile).toEqual(available);
});

test('retains the unavailable native file receipt', () => {
  const receipt = { version: 1, status: 'unavailable', code: 'native_output_file_digest_mismatch' };
  const doc = delivery(receipt);
  expect(doc.validateSync()).toBeUndefined();
  expect(doc.toObject().attachments[0].nativeOutputFile).toEqual(receipt);
});

test.each(['messageId', 'downloadUrl'])('available carrier requires %s', (field) => {
  const receipt = { ...available };
  delete receipt[field];
  expect(delivery(receipt).validateSync()).toBeDefined();
});

test('unavailable carrier still requires its failure code', () => {
  expect(delivery({ version: 1, status: 'unavailable' }).validateSync()).toBeDefined();
});

test.each([
  { ...available, version: 2 },
  { ...available, status: 'unknown' },
  { ...available, forgedAuthority: 'synthetic-extra-field' },
])('rejects invalid version, state or undeclared fields: %p', (receipt) => {
  expect(delivery(receipt).validateSync()).toBeDefined();
});
/* === VIVENTIUM END === */
