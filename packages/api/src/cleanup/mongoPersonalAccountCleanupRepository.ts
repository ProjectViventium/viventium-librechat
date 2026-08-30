import type { Model } from 'mongoose';
import type { IConversation, IMessage } from '@librechat/data-schemas';
import type {
  ApplyCleanupTombstoneInput,
  CleanupJsonValue,
  CleanupLedgerAdapter,
  CleanupOperationBinding,
  CleanupOperationState,
  CleanupReceiptInput,
  CleanupRepository,
  CleanupSourceState,
  CleanupTargetRef,
  CleanupTombstoneState,
} from './types';

interface CleanupMongoFields {
  _id: object;
  __v?: number;
  updatedAt?: Date;
  deletedAt?: Date;
  cleanupTombstone?: {
    operationId?: string;
    reviewBindingSha256?: string;
    preimageSha256?: string;
    tombstonedAt?: Date;
  };
}

type CleanupMessage = IMessage & CleanupMongoFields;
type CleanupConversation = IConversation & CleanupMongoFields;

interface MongoCleanupDependencies {
  Message: Model<IMessage>;
  Conversation: Model<IConversation>;
  ledger: CleanupLedgerAdapter;
}

function jsonValue(value: unknown): CleanupJsonValue {
  if (value == null) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(jsonValue);
  }
  if (typeof value === 'object') {
    if ('toHexString' in value && typeof value.toHexString === 'function') {
      return String(value.toHexString());
    }
    return Object.entries(value).reduce<{ [key: string]: CleanupJsonValue }>(
      (result, [key, entry]) => {
        if (entry !== undefined) {
          result[key] = jsonValue(entry);
        }
        return result;
      },
      {},
    );
  }
  return String(value);
}

function iso(value: Date | string | undefined): string {
  if (!value) {
    throw new Error('cleanup_target_updated_at_missing');
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('cleanup_target_updated_at_invalid');
  }
  return parsed.toISOString();
}

function messagePayload(message: CleanupMessage): CleanupJsonValue {
  return jsonValue({
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId,
    sender: message.sender,
    text: message.text,
    summary: message.summary,
    content: message.content,
    files: message.files,
    attachments: message.attachments,
    feedback: message.feedback,
    metadata: message.metadata,
    isCreatedByUser: message.isCreatedByUser,
    model: message.model,
    endpoint: message.endpoint,
    thread_id: message.thread_id,
  });
}

function conversationPayload(conversation: CleanupConversation): CleanupJsonValue {
  return jsonValue({
    title: conversation.title,
    messages: conversation.messages,
    files: conversation.files,
    file_ids: conversation.file_ids,
    tags: conversation.tags,
    system: conversation.system,
    instructions: conversation.instructions,
    promptPrefix: conversation.promptPrefix,
    greeting: conversation.greeting,
    examples: conversation.examples,
    agent_id: conversation.agent_id,
    assistant_id: conversation.assistant_id,
    endpoint: conversation.endpoint,
    model: conversation.model,
  });
}

function revisionFilter(revision: number): Record<string, unknown> {
  return revision === 0 ? { $or: [{ __v: 0 }, { __v: { $exists: false } }] } : { __v: revision };
}

function tombstoneMarker(input: ApplyCleanupTombstoneInput) {
  return {
    contractVersion: 1,
    operationId: input.operationId,
    ownerScopeHash: input.ownerScopeHash,
    reviewBindingSha256: input.reviewBindingSha256,
    preimageSha256: input.preimageSha256,
    runNonceHash: input.runNonceHash,
    tombstonedAt: new Date(input.tombstonedAt),
  };
}

export function createMongoPersonalAccountCleanupRepository({
  Message,
  Conversation,
  ledger,
}: MongoCleanupDependencies): CleanupRepository {
  async function readActiveTarget(
    kind: 'message' | 'conversation',
    ownerId: string,
    resourceId: string,
  ): Promise<CleanupSourceState | null> {
    if (kind === 'message') {
      const row = (await Message.findOne({ user: ownerId, messageId: resourceId, deletedAt: null })
        .select('+_meiliIndex')
        .lean()) as CleanupMessage | null;
      if (!row) return null;
      return {
        kind,
        ownerId: row.user,
        resourceId: row.messageId,
        revision: Number(row.__v ?? 0),
        updatedAt: iso(row.updatedAt),
        payload: messagePayload(row),
      };
    }
    const row = (await Conversation.findOne({
      user: ownerId,
      conversationId: resourceId,
      deletedAt: null,
    })
      .select('+_meiliIndex')
      .lean()) as CleanupConversation | null;
    if (!row) return null;
    return {
      kind,
      ownerId: String(row.user || ''),
      resourceId: row.conversationId,
      revision: Number(row.__v ?? 0),
      updatedAt: iso(row.updatedAt),
      payload: conversationPayload(row),
    };
  }

  async function readMatchingTombstone(
    kind: 'message' | 'conversation',
    ownerId: string,
    resourceId: string,
  ): Promise<CleanupTombstoneState | null> {
    const idField = kind === 'message' ? 'messageId' : 'conversationId';
    const filter = { user: ownerId, [idField]: resourceId, deletedAt: { $ne: null } };
    const row = (
      kind === 'message'
        ? await Message.findOne(filter)
            .select('user messageId conversationId __v deletedAt cleanupTombstone')
            .lean()
        : await Conversation.findOne(filter)
            .select('user messageId conversationId __v deletedAt cleanupTombstone')
            .lean()
    ) as CleanupMessage | CleanupConversation | null;
    const marker = row?.cleanupTombstone;
    if (!row || !row.deletedAt || !marker?.operationId || !marker.tombstonedAt) return null;
    return {
      kind,
      ownerId,
      resourceId,
      operationId: marker.operationId,
      reviewBindingSha256: String(marker.reviewBindingSha256 || ''),
      preimageSha256: String(marker.preimageSha256 || ''),
      revision: Number(row.__v ?? 0),
      tombstonedAt: iso(marker.tombstonedAt),
    };
  }

  async function applyTombstone(input: ApplyCleanupTombstoneInput) {
    const at = new Date(input.tombstonedAt);
    const filter = {
      user: input.source.ownerId,
      deletedAt: null,
      updatedAt: new Date(input.source.updatedAt),
      ...revisionFilter(input.source.revision),
    } as Record<string, unknown>;
    const marker = tombstoneMarker(input);
    let updated: CleanupMessage | CleanupConversation | null;
    if (input.source.kind === 'message') {
      filter.messageId = input.source.resourceId;
      updated = (await Message.findOneAndReplace(
        filter,
        {
          messageId: input.source.resourceId,
          conversationId: String(
            (input.source.payload as { conversationId?: CleanupJsonValue }).conversationId || '',
          ),
          user: input.source.ownerId,
          text: '',
          summary: '',
          content: [],
          files: [],
          attachments: [],
          isCreatedByUser: false,
          deletedAt: at,
          cleanupTombstone: marker,
          _meiliIndex: false,
          __v: input.source.revision + 1,
        },
        { new: true, runValidators: true },
      ).lean()) as CleanupMessage | null;
    } else if (input.source.kind === 'conversation') {
      filter.conversationId = input.source.resourceId;
      updated = (await Conversation.findOneAndReplace(
        filter,
        {
          conversationId: input.source.resourceId,
          user: input.source.ownerId,
          endpoint: 'cleanup_tombstone',
          title: '',
          messages: [],
          files: [],
          file_ids: [],
          tags: [],
          isArchived: true,
          deletedAt: at,
          cleanupTombstone: marker,
          _meiliIndex: false,
          __v: input.source.revision + 1,
        },
        { new: true, runValidators: true },
      ).lean()) as CleanupConversation | null;
    } else {
      throw new Error('cleanup_mongo_target_kind_invalid');
    }
    if (!updated) {
      const current = await readActiveTarget(
        input.source.kind,
        input.source.ownerId,
        input.source.resourceId,
      );
      return {
        applied: false,
        revision: current?.revision ?? input.source.revision,
        tombstonedAt: input.tombstonedAt,
      };
    }
    return {
      applied: true,
      revision: Number(updated.__v ?? input.source.revision + 1),
      tombstonedAt: input.tombstonedAt,
    };
  }

  async function verifyMongoTargets(
    ownerId: string,
    operationId: string,
    targets: CleanupTargetRef[],
    nonceHash?: string,
  ): Promise<number> {
    let verified = 0;
    for (const target of targets) {
      if (target.kind === 'schedule' || target.kind === 'memory') continue;
      if (target.kind !== 'message' && target.kind !== 'conversation') {
        throw new Error('cleanup_mongo_target_kind_invalid');
      }
      const idField = target.kind === 'message' ? 'messageId' : 'conversationId';
      const filter = {
        user: ownerId,
        [idField]: target.resourceId,
        deletedAt: { $ne: null },
        'cleanupTombstone.operationId': operationId,
        ...(nonceHash ? { 'cleanupTombstone.runNonceHash': nonceHash } : {}),
      };
      const row =
        target.kind === 'message'
          ? await Message.findOne(filter).select('_id').lean()
          : await Conversation.findOne(filter).select('_id').lean();
      if (!row) {
        throw new Error('cleanup_sweep_source_residue');
      }
      verified += 1;
    }
    return verified;
  }

  return {
    assertBackupVerified: (binding: CleanupOperationBinding) =>
      ledger.assertBackupVerified(binding),
    readActiveTarget,
    readMatchingTombstone,
    countActiveConversationMessages: (ownerId: string, conversationId: string) =>
      Message.countDocuments({ user: ownerId, conversationId, deletedAt: null }),
    applyTombstone,
    async listOperationTombstones(ownerId: string, operationId: string) {
      const state = await ledger.getOperationState(ownerId, operationId);
      if (!state) return [];
      const mongoTargets = state.targets.filter(
        (target) => target.kind === 'message' || target.kind === 'conversation',
      );
      await verifyMongoTargets(ownerId, operationId, mongoTargets);
      return mongoTargets;
    },
    appendReceipt: (input: CleanupReceiptInput) => ledger.appendReceipt(input),
    getOperationState: (
      ownerId: string,
      operationId: string,
    ): Promise<CleanupOperationState | null> => ledger.getOperationState(ownerId, operationId),
    async verifySourceTombstones({ ownerId, operationId, targets, nonceHash }) {
      return { verifiedCount: await verifyMongoTargets(ownerId, operationId, targets, nonceHash) };
    },
  };
}
