/* VIVENTIUM START: thin Mongo/message binding for the typed Telegram ingress lifecycle. */
const {
  createTelegramInputService,
  telegramIngressDedupeTtlSeconds,
  telegramInputConversationGeneration,
  GenerationJobManager,
} = require('@librechat/api');
const { ViventiumTelegramIngressEvent: Ingress, Message } = require('~/db/models');
const { getFiles } = require('~/models');
const { resolveTelegramMapping } = require('../TelegramLinkService');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');
const { mutateNativeResponseSources } = require('./nativeResponseService');

const fields = {
  state: 'inputState',
  claimToken: 'inputClaimToken',
  leaseUntil: 'inputLeaseUntil',
  retryAt: 'inputRetryAt',
  attempts: 'inputAttempts',
  failureCode: 'inputFailureCode',
  preparedDigest: 'inputPreparedDigest',
  registrationId: 'inputRegistrationId',
  failures: 'inputFailures',
  primarySourceEventId: 'inputPrimarySourceEventId',
  relatedSourceEventIds: 'inputRelatedSourceEventIds',
};
const decode = (row) =>
  row
    ? Object.fromEntries([
        ...Object.entries(row).filter(([key]) => !Object.values(fields).includes(key)),
        ...Object.entries(fields).map(([key, stored]) => [key, row[stored]]),
      ])
    : null;
const encode = (record) =>
  Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !['_id', '__v', 'createdAt', 'updatedAt'].includes(key))
      .map(([key, value]) => [fields[key] || key, value]),
  );
const identityFilter = (record) => ({
  sourceEventId: record.sourceEventId,
  libreChatUserId: record.libreChatUserId,
});
const exactFilter = (record) => ({
  ...identityFilter(record),
  inputState: record.state,
  inputClaimToken: record.claimToken,
  inputLeaseUntil: record.leaseUntil,
  streamId: record.streamId,
});
const messageFilter = (record) => ({
  user: record.libreChatUserId,
  conversationId: record.conversationId,
  messageId: record.sourceMessageId,
  isCreatedByUser: true,
  'metadata.viventium.telegramInput.sourceEventId': record.sourceEventId,
});

async function verifyOwner(record) {
  const mapping = await resolveTelegramMapping({
    telegramUserId: record.telegramUserId,
  });
  return (
    String(mapping?.libreChatUserId || mapping?.userId || '') === record.libreChatUserId &&
    Boolean(await Message.exists(messageFilter(record)))
  );
}
async function resolvePendingConversation(identity) {
  if (!identity.requestedConversationId || identity.requestedConversationId === 'new') return null;
  const record = decode(await Ingress.findOne({
    libreChatUserId: identity.libreChatUserId,
    telegramUserId: identity.telegramUserId,
    telegramChatId: identity.telegramChatId,
    telegramMessageThreadId: identity.telegramMessageThreadId,
    sourceOrderScope: identity.sourceOrderScope,
    conversationGeneration: identity.conversationGeneration,
    conversationId: identity.requestedConversationId,
    sourceSequence: { $lt: identity.sourceSequence },
    inputState: { $in: ['preparing', 'ready', 'admitted'] },
    // A ready input waiting for Main has deliberately released its preparation lease.
    $or: [{ inputState: 'ready' }, { inputLeaseUntil: { $gt: Date.now() } }],
  }).lean());
  if (!record || !await verifyOwner(record)) return null;
  return { conversationId: record.conversationId };
}
async function readPrepared(record) {
  const message = await Message.findOne(messageFilter(record)).lean();
  if (
    !message ||
    !['ready', 'admitted'].includes(message.metadata?.viventium?.telegramInput?.state)
  )
    return null;
  const fileIds = (message.files || []).map((file) =>
    typeof file === 'string' ? file : file.file_id,
  );
  const files = fileIds.length
    ? await getFiles({
        user: record.libreChatUserId,
        file_id: { $in: fileIds },
      })
    : [];
  if (new Set(files.map((file) => file.file_id)).size !== new Set(fileIds).size) return null;
  return {
    text: message.text || '',
    fileIds,
    imageUrls: (message.content || [])
      .filter((part) => part?.type === 'image_url')
      .map((part) => part.image_url?.url)
      .filter(Boolean),
  };
}
const service = createTelegramInputService({
  transaction: (operation) =>
    runGlassHiveTerminalCallbackTransaction(operation, { retry: 'native' }),
  repository: {
    read: async (identity) => decode(await Ingress.findOne(identityFilter(identity)).lean()),
    insert: async (record) => {
      await Ingress.updateOne(
        identityFilter(record),
        {
          $setOnInsert: {
            ...encode(record),
            dedupeKey: `m:${record.telegramChatId}:${record.sourceSequence}`,
            telegramMessageId: String(record.sourceSequence),
            expiresAt: null,
          },
        },
        { upsert: true },
      );
      return decode(await Ingress.findOne(identityFilter(record)).lean());
    },
    replace: async (previous, next) =>
      Boolean(
        (
          await Ingress.updateOne(exactFilter(previous), {
            $set: {
              ...encode(next),
              expiresAt: ['completed', 'cancelled'].includes(next.state)
                ? new Date(Date.now() + telegramIngressDedupeTtlSeconds() * 1000)
                : null,
            },
          })
        ).matchedCount,
      ),
    due: async (now, limit) =>
      (
        await Ingress.find({
          inputState: { $in: ['preparing', 'ready', 'admitted', 'failed'] },
          inputLeaseUntil: { $lte: now },
          inputRetryAt: { $lte: now },
          $expr: { $eq: ['$inputPrimarySourceEventId', '$sourceEventId'] },
          $or: [{ inputState: { $ne: 'failed' } }, { inputRetryAt: { $gt: 0 } }],
        })
          .sort({ updatedAt: 1 })
          .limit(limit)
          .lean()
      ).map(decode),
    group: async (record) =>
      (
        await Ingress.find({
          libreChatUserId: record.libreChatUserId,
          telegramUserId: record.telegramUserId,
          telegramChatId: record.telegramChatId,
          telegramMessageThreadId: record.telegramMessageThreadId,
          conversationGeneration: record.conversationGeneration,
          mediaGroupId: record.mediaGroupId,
          inputState: { $in: ['preparing', 'failed'] },
          $expr: { $eq: ['$inputPrimarySourceEventId', '$sourceEventId'] },
        })
          .sort({ sourceSequence: 1 })
          .lean()
      ).map(decode),
  },
  verifyOwner,
  persistPrepared: async (record, input) => {
    const files = input.fileIds.length
      ? await getFiles({
          user: record.libreChatUserId,
          file_id: { $in: input.fileIds },
        })
      : [];
    if (new Set(files.map((file) => file.file_id)).size !== new Set(input.fileIds).size) {
      throw Object.assign(new Error('Prepared attachments are unavailable'), {
        code: 'source_input_attachment_unavailable',
      });
    }
    const filter = messageFilter(record);
    const updated = await mutateNativeResponseSources(filter, () =>
      Message.updateOne(filter, {
        $set: {
          text: input.text,
          files,
          content: input.imageUrls.map((url) => ({
            type: 'image_url',
            image_url: { url, detail: 'auto' },
          })),
          'metadata.viventium.telegramInput.state': 'ready',
        },
      }),
    );
    if (!updated?.matchedCount)
      throw Object.assign(new Error('Original input is unavailable'), {
        code: 'source_input_message_unavailable',
      });
  },
  readPrepared,
  hasCommittedDelivery: async (record) => Boolean(await Message.exists({
    user: record.libreChatUserId,
    conversationId: record.conversationId,
    isCreatedByUser: false,
    unfinished: { $ne: true },
    'metadata.viventium.deliveryAcknowledgement.state': 'committed',
    'metadata.viventium.deliverySourceCoverage.source_order_scope': record.sourceOrderScope,
    'metadata.viventium.deliverySourceCoverage.source_conversation_generation':
      { $in: [...new Set([
        telegramInputConversationGeneration(record),
        // The same fresh conversation is subsequently addressed by its canonical
        // ID. Both names belong to this retained source and captured generation.
        telegramInputConversationGeneration({ ...record, requestedConversationId: record.conversationId }),
      ])] },
    'metadata.viventium.deliverySourceCoverage.sources': { $elemMatch: {
      source_event_id: record.sourceEventId,
      source_message_id: record.sourceMessageId,
      source_sequence: record.sourceSequence,
    } },
    $expr: { $and: [
      { $eq: ['$metadata.viventium.deliverySourceCoverage.logical_turn_id',
        '$metadata.viventium.deliveryAcknowledgement.logical_turn_id'] },
      { $eq: ['$metadata.viventium.deliverySourceCoverage.revision',
        '$metadata.viventium.deliveryAcknowledgement.revision'] },
    ] },
  })),
  verifyStream: async (record, streamId) => {
    const job = await GenerationJobManager.getJob(streamId);
    const context = job?.metadata?.interactionContext;
    return (
      job?.metadata?.userId === record.libreChatUserId &&
      job?.metadata?.conversationId === record.conversationId &&
      context?.source_event_id === record.sourceEventId &&
      context?.source_sequence === record.sourceSequence &&
      context?.source_order_scope === record.sourceOrderScope
    );
  },
  readStream: async (streamId, ownerId) => {
    const job = await GenerationJobManager.getJob(streamId);
    if (!job || job.metadata?.userId !== ownerId) return 'missing';
    const ack = job.metadata?.deliveryAcknowledgement;
    if (ack?.state === 'committed') return 'completed';
    return ['error', 'aborted', 'superseded'].includes(job.status) ? 'failed' : 'pending';
  },
});
async function inputEnvelope(record) {
  const message = await Message.findOne(messageFilter(record)).lean();
  if (!message) return null;
  return {
    ...record,
    preparation: message.metadata?.viventium?.telegramInput?.preparation,
    text: message.text || '',
    inputClaim: {
      sourceEventId: record.sourceEventId,
      claimToken: record.claimToken,
    },
  };
}
module.exports = { ...service, readPrepared, inputEnvelope, messageFilter, resolvePendingConversation };
/* VIVENTIUM END */
