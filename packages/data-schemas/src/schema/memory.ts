import { Schema } from 'mongoose';
import type { IMemoryEntry } from '~/types/memory';

const MemoryEntrySchema: Schema<IMemoryEntry> = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    index: true,
    required: true,
  },
  key: {
    type: String,
    required: true,
    validate: {
      validator: (v: string) => /^[a-z_]+$/.test(v),
      message: 'Key must only contain lowercase letters and underscores',
    },
  },
  value: {
    type: String,
    required: true,
  },
  tokenCount: {
    type: Number,
    default: 0,
  },
  updated_at: {
    type: Date,
    default: Date.now,
  },
  /* === VIVENTIUM START ===
   * Retained tombstones keep each user/key revision monotonic across delete/recreate cycles.
   * User-facing reads exclude these rows; CAS snapshots include them.
   * === VIVENTIUM END === */
  deletedAt: {
    type: Date,
    default: undefined,
  },
});

MemoryEntrySchema.index(
  { userId: 1, key: 1 },
  { unique: true, name: 'viventium_unique_memory_user_key' },
);

export default MemoryEntrySchema;
