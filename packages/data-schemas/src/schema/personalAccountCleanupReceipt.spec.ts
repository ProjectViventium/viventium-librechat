import mongoose from 'mongoose';
import { createViventiumPersonalAccountCleanupReceiptSchema } from './personalAccountCleanupReceipt';

const database = new mongoose.Mongoose();
const Receipt = database.model(
  'SyntheticPersonalAccountCleanupReceipt',
  createViventiumPersonalAccountCleanupReceiptSchema(),
);

describe('Viventium personal-account cleanup receipt schema', () => {
  test('contains no raw content, path, prompt, or email fields', () => {
    for (const forbidden of ['text', 'title', 'prompt', 'content', 'preimage', 'email', 'path']) {
      expect(Receipt.schema.path(forbidden)).toBeUndefined();
    }
    expect(Receipt.schema.path('targets').schema.options.strict).toBe('throw');
    expect(Receipt.schema.path('events').schema.options.strict).toBe('throw');
  });

  test('keeps cleanup operations unique within owner and hashed target scope', () => {
    expect(Receipt.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ operationId: 1 }, expect.objectContaining({ unique: true })],
        [{ ownerId: 1, operationId: 1 }, expect.objectContaining({ unique: true })],
        [{ ownerScopeHash: 1, targetSetSha256: 1 }, expect.any(Object)],
      ]),
    );
  });
});
