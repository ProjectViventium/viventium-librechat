import type { Model } from 'mongoose';
import type { IMemoryEntry } from '@librechat/data-schemas';
import { cleanupStateSha256, ownerScopeSha256 } from './personalAccountCleanup';
import type {
  ApplyCleanupTombstoneInput,
  CleanupJsonValue,
  CleanupSourceState,
  MemoryCleanupAdapter,
} from './types';

const HASH = /^[a-f0-9]{64}$/;
const PREFIXED_HASH = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

type MemoryRow = IMemoryEntry & {
  __v?: number;
  updated_at?: Date;
  deletedAt?: Date;
};

function revisionFilter(revision: number): Record<string, unknown> {
  return revision === 0 ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: revision };
}

function iso(value: Date | string | undefined, label: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}_invalid`);
  return parsed.toISOString();
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(String(value || '')) || ['all', '*', '.', '..'].includes(value)) {
    throw new Error(`${label}_invalid`);
  }
}

function sourceState(row: MemoryRow): CleanupSourceState {
  return {
    kind: 'memory',
    ownerId: String(row.userId),
    resourceId: row.key,
    revision: Number(row.__v ?? 0),
    updatedAt: iso(row.updated_at, 'cleanup_memory_updated_at'),
    payload: {
      value: String(row.value || ''),
      tokenCount: Number(row.tokenCount || 0),
    } as CleanupJsonValue,
  };
}

function assertTombstoneInput(input: ApplyCleanupTombstoneInput): void {
  if (input.source.kind !== 'memory') throw new Error('cleanup_memory_target_kind_invalid');
  assertSafeId(input.source.ownerId, 'cleanup_memory_owner');
  assertSafeId(input.source.resourceId, 'cleanup_memory_resource');
  assertSafeId(input.operationId, 'cleanup_memory_operation');
  if (input.ownerScopeHash !== ownerScopeSha256(input.source.ownerId)) {
    throw new Error('cleanup_memory_owner_scope_mismatch');
  }
  if (!HASH.test(input.reviewBindingSha256) || !HASH.test(input.preimageSha256)) {
    throw new Error('cleanup_memory_review_binding_invalid');
  }
  if (!PREFIXED_HASH.test(input.runNonceHash)) {
    throw new Error('cleanup_memory_nonce_hash_invalid');
  }
  if (cleanupStateSha256(input.source) !== input.preimageSha256) {
    throw new Error('cleanup_memory_preimage_mismatch');
  }
  iso(input.tombstonedAt, 'cleanup_memory_tombstoned_at');
}

export function createMongoMemoryCleanupAdapter(
  MemoryEntry: Model<IMemoryEntry>,
): MemoryCleanupAdapter {
  return {
    async readActiveTarget(ownerId, resourceId) {
      assertSafeId(ownerId, 'cleanup_memory_owner');
      assertSafeId(resourceId, 'cleanup_memory_resource');
      const row = (await MemoryEntry.findOne({
        userId: ownerId,
        key: resourceId,
        deletedAt: null,
      }).lean()) as MemoryRow | null;
      return row ? sourceState(row) : null;
    },

    async readRetainedTombstone(ownerId, resourceId) {
      assertSafeId(ownerId, 'cleanup_memory_owner');
      assertSafeId(resourceId, 'cleanup_memory_resource');
      const row = (await MemoryEntry.findOne({
        userId: ownerId,
        key: resourceId,
        deletedAt: { $ne: null },
        value: '',
        tokenCount: 0,
      })
        .select('__v deletedAt')
        .lean()) as MemoryRow | null;
      if (!row?.deletedAt) return null;
      return {
        revision: Number(row.__v ?? 0),
        tombstonedAt: iso(row.deletedAt, 'cleanup_memory_tombstoned_at'),
      };
    },

    async applyTombstone(input) {
      assertTombstoneInput(input);
      const at = new Date(input.tombstonedAt);
      const updated = (await MemoryEntry.findOneAndUpdate(
        {
          userId: input.source.ownerId,
          key: input.source.resourceId,
          deletedAt: null,
          updated_at: new Date(input.source.updatedAt),
          ...revisionFilter(input.source.revision),
        },
        {
          $set: { value: '', tokenCount: 0, deletedAt: at, updated_at: at },
          $inc: { __v: 1 },
        },
        // The shipped retained-memory tombstone contract intentionally stores an empty value.
        // MemoryEntry's create-time validator requires non-empty text, so match the existing
        // revision-safe deleteMemory product path and do not re-run create validators here.
        { new: true },
      ).lean()) as MemoryRow | null;
      if (!updated) {
        const current = (await MemoryEntry.findOne({
          userId: input.source.ownerId,
          key: input.source.resourceId,
        })
          .select('__v')
          .lean()) as MemoryRow | null;
        return {
          applied: false,
          revision: Number(current?.__v ?? input.source.revision),
          tombstonedAt: input.tombstonedAt,
        };
      }
      return {
        applied: true,
        revision: Number(updated.__v ?? input.source.revision + 1),
        tombstonedAt: input.tombstonedAt,
      };
    },

    async verifyOperation({ ownerId, operationId, targets, nonceHash }) {
      assertSafeId(ownerId, 'cleanup_memory_owner');
      assertSafeId(operationId, 'cleanup_memory_operation');
      if (!PREFIXED_HASH.test(nonceHash)) throw new Error('cleanup_memory_nonce_hash_invalid');
      const seen = new Set<string>();
      let verifiedCount = 0;
      const tombstones: Array<{ resourceId: string; revision: number; tombstonedAt: string }> = [];
      for (const target of targets) {
        if (target.kind !== 'memory') throw new Error('cleanup_memory_target_kind_invalid');
        assertSafeId(target.resourceId, 'cleanup_memory_resource');
        if (seen.has(target.resourceId)) throw new Error('cleanup_memory_target_duplicate');
        seen.add(target.resourceId);
        const row = (await MemoryEntry.findOne({
          userId: ownerId,
          key: target.resourceId,
          deletedAt: { $ne: null },
          value: '',
          tokenCount: 0,
        })
          .select('__v deletedAt')
          .lean()) as MemoryRow | null;
        if (!row?.deletedAt) throw new Error('cleanup_memory_residue');
        tombstones.push({
          resourceId: target.resourceId,
          revision: Number(row.__v ?? 0),
          tombstonedAt: iso(row.deletedAt, 'cleanup_memory_tombstoned_at'),
        });
        verifiedCount += 1;
      }
      return { verifiedCount, tombstones };
    },
  };
}
