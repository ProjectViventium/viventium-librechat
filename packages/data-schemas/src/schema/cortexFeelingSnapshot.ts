/* === VIVENTIUM START ===
 * Feature: Strict private request-pinned Feelings receipt.
 * Purpose: Give every durable Cortex store one exact, bounded, non-coercing receipt contract.
 * === VIVENTIUM END === */

import mongoose, { Schema } from 'mongoose';
import type { IViventiumCortexFeelingSnapshot } from '~/types/cortexFeelingSnapshot';

function invalidFeelingValue(path: string, value: unknown): mongoose.Error.CastError {
  return new mongoose.Error.CastError('ViventiumFeelingReceipt', value, path);
}

function exactBoolean(path: string) {
  return (value: unknown): boolean => {
    if (typeof value !== 'boolean') throw invalidFeelingValue(path, value);
    return value;
  };
}

function exactInteger(path: string) {
  return (value: unknown): number => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalidFeelingValue(path, value);
    }
    return value;
  };
}

function exactString(path: string) {
  return (value: unknown): string => {
    if (typeof value !== 'string') throw invalidFeelingValue(path, value);
    return value;
  };
}

function exactTimestamp(value: unknown): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value !== 'string') throw invalidFeelingValue('asOf', value);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw invalidFeelingValue('asOf', value);
  }
  return timestamp;
}

export function createViventiumCortexFeelingSnapshotSchema() {
  const boundedCount = (path: string) => ({
    type: Number,
    required: true,
    min: 0,
    max: 1_000_000,
    set: exactInteger(path),
  });

  const schema = new Schema<IViventiumCortexFeelingSnapshot>(
    {
      available: { type: Boolean, required: true, set: exactBoolean('available') },
      enabled: { type: Boolean, required: true, set: exactBoolean('enabled') },
      agentScope: {
        type: String,
        required: true,
        enum: ['all_agents', 'conscious_agent'],
        set: exactString('agentScope'),
      },
      version: {
        type: Number,
        required: true,
        min: 0,
        set: exactInteger('version'),
      },
      asOf: { type: Date, required: true, set: exactTimestamp },
      capsule: {
        type: String,
        maxlength: 16_000,
        set: exactString('capsule'),
      },
      snapshotHash: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        set: exactString('snapshotHash'),
      },
      rangePromptOverrideCount: boundedCount('rangePromptOverrideCount'),
      activeRangePromptOverrideCount: boundedCount('activeRangePromptOverrideCount'),
      activeRangePromptOverrideChars: boundedCount('activeRangePromptOverrideChars'),
    },
    { _id: false, strict: 'throw' },
  );

  schema.pre('validate', function requireExactCapsule(next) {
    if (typeof this.get('capsule') !== 'string') {
      return next(invalidFeelingValue('capsule', this.get('capsule')));
    }
    return next();
  });

  return schema;
}
