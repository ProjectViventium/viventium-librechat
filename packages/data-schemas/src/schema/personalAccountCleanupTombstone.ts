import { Schema } from 'mongoose';
import type { IPersonalAccountCleanupTombstone } from '~/types/personalAccountCleanupTombstone';

const HASH = /^sha256:[a-f0-9]{64}$/;
const BARE_HASH = /^[a-f0-9]{64}$/;

export const personalAccountCleanupTombstoneSchema = new Schema<IPersonalAccountCleanupTombstone>(
  {
    contractVersion: { type: Number, required: true, enum: [1], immutable: true },
    operationId: { type: String, required: true, minlength: 1, maxlength: 160, immutable: true },
    ownerScopeHash: { type: String, required: true, match: HASH, immutable: true },
    reviewBindingSha256: { type: String, required: true, match: BARE_HASH, immutable: true },
    preimageSha256: { type: String, required: true, match: BARE_HASH, immutable: true },
    runNonceHash: { type: String, required: true, match: HASH, immutable: true },
    tombstonedAt: { type: Date, required: true, immutable: true },
  },
  { _id: false, strict: 'throw' },
);

function queryExplicitlySelectsDeletedState(query: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(query, 'deletedAt')) {
    return true;
  }
  for (const operator of ['$and', '$or', '$nor']) {
    const clauses = query[operator];
    if (
      Array.isArray(clauses) &&
      clauses.some(
        (clause) =>
          clause &&
          typeof clause === 'object' &&
          queryExplicitlySelectsDeletedState(clause as Record<string, unknown>),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function addCleanupVisibilityToAggregate(pipeline: Array<Record<string, unknown>>): void {
  const first = pipeline[0];
  const firstStageMustRemainFirst =
    first != null &&
    ['$geoNear', '$search', '$searchMeta', '$vectorSearch', '$changeStream', '$documents'].some(
      (operator) => Object.prototype.hasOwnProperty.call(first, operator),
    );
  pipeline.splice(firstStageMustRemainFirst ? 1 : 0, 0, { $match: { deletedAt: null } });
}

/** Hide retained cleanup tombstones from ordinary reads and writes unless explicitly requested. */
export function applyPersonalAccountCleanupVisibility(schema: Schema): void {
  for (const operation of [
    'find',
    'findOne',
    'countDocuments',
    'findOneAndUpdate',
    'findOneAndReplace',
    'updateOne',
    'updateMany',
  ] as const) {
    schema.pre(operation, function excludeCleanupTombstones() {
      const query = this.getQuery() as Record<string, unknown>;
      if (!queryExplicitlySelectsDeletedState(query)) {
        this.where({ deletedAt: null });
      }
    });
  }

  // Product-authorized deletion must still erase retained tombstones, including full-account
  // deletion. Tombstones remain hidden from reads and protected from ordinary updates.

  schema.pre('aggregate', function excludeCleanupTombstonesFromAggregate() {
    const pipeline = this.pipeline();
    const explicit = pipeline.some((stage) => {
      const match = stage?.$match;
      return (
        match &&
        typeof match === 'object' &&
        queryExplicitlySelectsDeletedState(match as Record<string, unknown>)
      );
    });
    if (!explicit) {
      addCleanupVisibilityToAggregate(pipeline as Array<Record<string, unknown>>);
    }
  });
}
