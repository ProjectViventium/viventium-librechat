import type { Types, Document } from 'mongoose';

// Base memory interfaces
export interface IMemoryEntry extends Document {
  userId: Types.ObjectId;
  key: string;
  value: string;
  tokenCount?: number;
  updated_at?: Date;
  __v?: number;
}

export interface IMemoryEntryLean {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  key: string;
  value: string;
  tokenCount?: number;
  updated_at?: Date;
  __v?: number;
}

// Method parameter interfaces
export interface SetMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  value: string;
  tokenCount?: number;
  /** Undefined preserves legacy last-write behavior; null means the key was absent in the snapshot. */
  expectedRevision?: number | null;
}

export interface DeleteMemoryParams {
  userId: string | Types.ObjectId;
  key: string;
  expectedRevision?: number | null;
}

export interface GetFormattedMemoriesParams {
  userId: string | Types.ObjectId;
  memories?: IMemoryEntryLean[];
}

// Result interfaces
export interface MemoryResult {
  ok: boolean;
  conflict?: boolean;
  updatedAt?: Date;
  revision?: number;
  currentRevision?: number;
}

export interface FormattedMemoriesResult {
  withKeys: string;
  withoutKeys: string;
  totalTokens?: number;
  /* === VIVENTIUM START ===
   * Fix: Expose per-key token counts to support overwrite-aware tokenLimit checks.
   * Added: 2026-02-09
   * === VIVENTIUM END === */
  memoryTokenMap?: Record<string, number>;
}
