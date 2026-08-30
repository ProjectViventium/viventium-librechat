import mongoose, { Schema } from 'mongoose';
import { createViventiumCortexFeelingSnapshotSchema } from './cortexFeelingSnapshot';

const database = new mongoose.Mongoose();
const Receipt = database.model(
  'SyntheticCortexFeelingReceipt',
  new Schema({ snapshot: { type: createViventiumCortexFeelingSnapshotSchema(), required: true } }),
);

const validSnapshot = {
  available: true,
  enabled: true,
  agentScope: 'all_agents',
  version: 1,
  asOf: '2026-08-30T12:00:00.000Z',
  capsule: 'Synthetic exact capsule.',
  snapshotHash: 'a'.repeat(64),
  rangePromptOverrideCount: 1,
  activeRangePromptOverrideCount: 1,
  activeRangePromptOverrideChars: 24,
};

describe('Viventium Cortex feeling snapshot schema', () => {
  test('preserves exact valid capsule bytes and timestamp', async () => {
    const receipt = new Receipt({ snapshot: validSnapshot });

    await expect(receipt.validate()).resolves.toBeUndefined();
    expect(receipt.snapshot.capsule).toBe(validSnapshot.capsule);
    expect(receipt.snapshot.asOf.toISOString()).toBe(validSnapshot.asOf);
  });

  test('rejects coercion, malformed timestamps, missing capsules, and extra private fields', async () => {
    await expect(
      new Receipt({ snapshot: { ...validSnapshot, available: 'true' } }).validate(),
    ).rejects.toThrow();
    await expect(
      new Receipt({ snapshot: { ...validSnapshot, asOf: '2026-08-30' } }).validate(),
    ).rejects.toThrow();
    const withoutCapsule: Partial<typeof validSnapshot> = { ...validSnapshot };
    delete withoutCapsule.capsule;
    await expect(new Receipt({ snapshot: withoutCapsule }).validate()).rejects.toThrow();
    await expect(
      new Receipt({ snapshot: { ...validSnapshot, privatePayload: 'reject' } }).validate(),
    ).rejects.toThrow();
  });
});
