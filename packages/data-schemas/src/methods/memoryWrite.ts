/* === VIVENTIUM START === Durable admission and receipt reconciliation, not a second job queue. === */
import type { MemoryWriteIdentity, MemoryWriteReceipt, MemoryWriteSource, MemoryWriterEffect } from '~/types/memoryWrite';

export function createMemoryWriteMethods(mongoose: typeof import('mongoose')) {
  // Runtime automatic indexing is intentionally disabled. This additive non-unique index has no
  // deduplication/migration precondition and prevents recovery from scanning conversation history.
  async function ensureMemoryWriteIndex(): Promise<string> {
    return mongoose.models.Message.collection.createIndex({
      'savedMemoryWrite.status': 1, 'savedMemoryWrite.heartbeatAt': 1,
    }, { sparse: true, name: 'viventium_saved_memory_recovery' });
  }
  const identityFilter = ({ userId, messageId, owner }: MemoryWriteIdentity) => ({
    user: userId, messageId, deletedAt: null, 'savedMemoryWrite.owner': owner,
  });

  async function admitMemoryWrite(params: MemoryWriteIdentity & {
    conversationId: string; source: MemoryWriteSource; admittedAt?: Date;
  }): Promise<boolean> {
    const now = new Date();
    const result = await mongoose.models.Message.updateOne({
      user: params.userId, messageId: params.messageId, conversationId: params.conversationId,
      isCreatedByUser: false, deletedAt: null, savedMemoryWrite: { $exists: false },
    }, { $set: { savedMemoryWrite: {
      owner: params.owner, status: 'pending', source: params.source,
      admittedAt: params.admittedAt || now, heartbeatAt: now,
    } } });
    return result.modifiedCount === 1;
  }

  async function startMemoryWrite(params: MemoryWriteIdentity): Promise<boolean> {
    const result = await mongoose.models.Message.updateOne({
      ...identityFilter(params), 'savedMemoryWrite.status': 'pending',
    }, { $set: { 'savedMemoryWrite.status': 'running',
      'savedMemoryWrite.startedAt': new Date(), 'savedMemoryWrite.heartbeatAt': new Date() } });
    return result.modifiedCount === 1;
  }

  async function getMemoryWriteStatus({ userId, messageId }: Omit<MemoryWriteIdentity, 'owner'>) {
    const row = await mongoose.models.Message.findOne({ user: userId, messageId, deletedAt: null })
      .select('savedMemoryWrite.status').lean();
    return row?.savedMemoryWrite?.status ?? null;
  }

  async function listPendingMemoryWrites({ before }: { before: Date }) {
    return mongoose.models.Message.find({ deletedAt: null, 'savedMemoryWrite.status': 'pending',
      'savedMemoryWrite.heartbeatAt': { $lt: before },
    }).select('user messageId conversationId +savedMemoryWrite')
      .sort({ 'savedMemoryWrite.admittedAt': 1, _id: 1 }).limit(100).lean();
  }

  async function reclaimPendingMemoryWrite(params: MemoryWriteIdentity & {
    previousOwner: string; heartbeatAt: Date;
  }): Promise<boolean> {
    const result = await mongoose.models.Message.updateOne({ user: params.userId,
      messageId: params.messageId, deletedAt: null, 'savedMemoryWrite.status': 'pending',
      'savedMemoryWrite.owner': params.previousOwner,
      'savedMemoryWrite.heartbeatAt': params.heartbeatAt,
    }, { $set: { 'savedMemoryWrite.owner': params.owner, 'savedMemoryWrite.heartbeatAt': new Date() } });
    return result.modifiedCount === 1;
  }

  async function hasNewerMemorySource({ userId, admittedAt }: { userId: string; admittedAt: Date }): Promise<boolean> {
    return Boolean(await mongoose.models.Message.exists({ user: userId, deletedAt: null,
      isCreatedByUser: true, updatedAt: { $gt: admittedAt } }));
  }

  async function validateMemoryWriteSnapshot(params: MemoryWriteIdentity & {
    revisions: Record<string, number>; effects: Record<string, MemoryWriterEffect>;
  }): Promise<boolean> {
    const admission = await mongoose.models.Message.findOne({ ...identityFilter(params),
      'savedMemoryWrite.status': 'running',
    }).select('savedMemoryWrite.admittedAt savedMemoryWrite.source.memoryRevisionMap').lean();
    const floor = admission?.savedMemoryWrite?.source?.memoryRevisionMap;
    if (!floor || !params.revisions || !params.effects) return false;
    for (const key of new Set([...Object.keys(floor), ...Object.keys(params.revisions)])) {
      const before = floor[key] ?? null;
      const current = params.revisions[key] ?? null;
      if (before === current) continue;
      if (current == null || !Number.isSafeInteger(current) || (before != null && current <= before)) return false;
      const effect = params.effects[key];
      if (!effect?.operationId || effect.messageId === params.messageId) return false;
      // A newer snapshot may include prior accepted FIFO writes. Manual/panel writes clear this
      // atomic effect marker. Every permitted predecessor must itself enforce an admission floor.
      const predecessor = await mongoose.models.Message.exists({ user: params.userId,
        messageId: effect.messageId, deletedAt: null, 'savedMemoryWrite.owner': effect.owner,
        'savedMemoryWrite.status': { $in: ['running', 'completed', 'failed'] },
        'savedMemoryWrite.source.memoryRevisionMap': { $exists: true },
        'savedMemoryWrite.admittedAt': { $lt: admission.savedMemoryWrite.admittedAt },
      });
      if (!predecessor) return false;
    }
    return true;
  }

  async function refreshMemoryWrites(owner: string, messageIds?: string[]): Promise<number> {
    const result = await mongoose.models.Message.updateMany({
      'savedMemoryWrite.owner': owner, 'savedMemoryWrite.status': { $in: ['pending', 'running'] },
      deletedAt: null,
      ...(messageIds ? { messageId: { $in: messageIds } } : {}),
    }, { $set: { 'savedMemoryWrite.heartbeatAt': new Date() } });
    return result.matchedCount;
  }

  // A single message update commits both the outcome and the receipt. A crash cannot leave a
  // completed marker without the corresponding receipt, and concurrent non-memory artifacts survive.
  const receiptUpdate = (receipts: MemoryWriteReceipt[], status: 'completed' | 'failed') => [{
    $set: {
      'savedMemoryWrite.status': status,
      'savedMemoryWrite.finishedAt': new Date(),
      attachments: { $concatArrays: [
        { $filter: { input: { $ifNull: ['$attachments', []] }, as: 'attachment',
          cond: { $in: [{ $type: '$$attachment.memory' }, ['missing', 'null']] } } },
        { $literal: receipts },
      ] },
    },
  }, { $unset: ['savedMemoryWrite.source.input', 'savedMemoryWrite.source.timeContext'] }];

  async function completeMemoryWrite(params: MemoryWriteIdentity & {
    receipts: MemoryWriteReceipt[];
  }): Promise<boolean> {
    const status = params.receipts.some((receipt) => receipt.memory?.type === 'error')
      ? 'failed' : 'completed';
    const result = await mongoose.models.Message.updateOne({
      ...identityFilter(params), 'savedMemoryWrite.status': 'running',
    }, receiptUpdate(params.receipts, status));
    return result.modifiedCount === 1;
  }

  async function recoverInterruptedMemoryWrites({ before, includePending = true }: {
    before: Date; includePending?: boolean;
  }): Promise<number> {
    // Hidden cleanup tombstones must not retain temporary executable private payloads.
    await mongoose.models.Message.updateMany({ deletedAt: { $ne: null },
      'savedMemoryWrite.source.input': { $exists: true },
    }, { $unset: { 'savedMemoryWrite.source.input': 1, 'savedMemoryWrite.source.timeContext': 1 } });
    const stale = await mongoose.models.Message.find({
      deletedAt: null, 'savedMemoryWrite.status': { $in: includePending ? ['pending', 'running'] : ['running'] },
      'savedMemoryWrite.heartbeatAt': { $lt: before },
    }).select('user messageId conversationId +savedMemoryWrite').limit(100).lean();
    let recovered = 0;
    for (const row of stale) {
      const started = row.savedMemoryWrite.status === 'running';
      // Running work may have committed one or more mutations before losing its receipt. Even if a
      // later correction replaced their effect marker, absence of a marker cannot prove no write.
      const message = started
        ? 'Saving memory was interrupted. Some changes may already be saved. Check Memories before asking to save again.'
        : 'This memory save was interrupted before it started. Ask again to retry.';
      const receipts: MemoryWriteReceipt[] = [{ type: 'memory', messageId: row.messageId,
        conversationId: row.conversationId, memory: { type: 'error', errorType: 'writer_interrupted',
          key: 'system', partialApplied: started, message,
          value: JSON.stringify({ errorType: 'writer_interrupted', partialApplied: started, message }) } }];
      const result = await mongoose.models.Message.updateOne({
        _id: row._id, deletedAt: null,
        'savedMemoryWrite.status': row.savedMemoryWrite.status,
        'savedMemoryWrite.owner': row.savedMemoryWrite.owner,
        'savedMemoryWrite.heartbeatAt': row.savedMemoryWrite.heartbeatAt,
      }, receiptUpdate(receipts, 'failed'));
      recovered += result.modifiedCount;
    }
    return recovered;
  }

  return { admitMemoryWrite, startMemoryWrite, refreshMemoryWrites,
    completeMemoryWrite, recoverInterruptedMemoryWrites, getMemoryWriteStatus,
    listPendingMemoryWrites, reclaimPendingMemoryWrite, hasNewerMemorySource, ensureMemoryWriteIndex,
    validateMemoryWriteSnapshot };
}
export type MemoryWriteMethods = ReturnType<typeof createMemoryWriteMethods>;
