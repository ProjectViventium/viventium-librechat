/* === VIVENTIUM START ===
 * Feature: Durable source authority for retained Telegram inputs.
 * Purpose: A retained (prepared) Telegram input is admitted through its ingress row, which already
 * carries the verified owner, chat, message and source identity. Once the input's exact stream is
 * admitted, that row is bound as the turn's durable source authority, as a fresh ingress row is
 * bound before authoring. The durable Telegram dispatcher only presents a late follow-up of a turn
 * whose ingress row is bound, so without this a retained turn's follow-up could never reach
 * Telegram. A continued admission of the same stream keeps its first binding time; a row that is
 * not this owner's source on this stream fails closed.
 * === VIVENTIUM END === */
const { ViventiumTelegramIngressEvent, Message } = require('~/db/models');
const {
  runGlassHiveTerminalCallbackTransaction,
} = require('./GlassHiveTerminalCallbackTransaction');

async function bindRetainedTelegramIngressAuthority({
  ownerId,
  sourceEventId,
  streamId,
  IngressModel = ViventiumTelegramIngressEvent,
}) {
  const owner = String(ownerId || '').trim();
  const source = String(sourceEventId || '').trim();
  const stream = String(streamId || '').trim();
  const result =
    owner && source && stream
      ? await IngressModel.updateOne(
          { sourceEventId: source, libreChatUserId: owner, streamId: stream },
          [{ $set: { authorityBoundAt: { $ifNull: ['$authorityBoundAt', '$$NOW'] } } }],
        )
      : null;
  if (result?.acknowledged === false || Number(result?.matchedCount ?? result?.n ?? 0) < 1) {
    const error = new Error('Retained Telegram input authority could not be bound to its stream');
    error.code = 'TELEGRAM_INGRESS_AUTHORITY_UNAVAILABLE';
    throw error;
  }
}

/* VIVENTIUM START: the existing ingress receipt binds one actual assistant, never a guessed child. */
async function bindRetainedTelegramResponse({
  record,
  streamId,
  conversationId,
  sourceMessageId,
  responseMessageId,
  interactionContext,
  IngressModel = ViventiumTelegramIngressEvent,
}) {
  if (
    !record ||
    !responseMessageId ||
    record.streamId !== streamId ||
    record.conversationId !== conversationId ||
    record.sourceMessageId !== sourceMessageId ||
    interactionContext?.source_event_id !== record.sourceEventId ||
    !interactionContext.logical_turn_id ||
    !Number.isSafeInteger(interactionContext.revision) ||
    interactionContext.revision < 1
  ) {
    throw Object.assign(new Error('Telegram response identity is unavailable'), {
      code: 'TELEGRAM_RESPONSE_IDENTITY_UNAVAILABLE',
    });
  }
  const responseBinding = {
    streamId,
    responseMessageId,
    logicalTurnId: interactionContext.logical_turn_id,
    revision: interactionContext.revision,
  };
  const result = await IngressModel.updateOne(
    {
      sourceEventId: record.sourceEventId,
      libreChatUserId: record.libreChatUserId,
      conversationId,
      sourceMessageId,
      streamId,
      inputState: 'admitted',
      inputClaimToken: record.claimToken,
      authorityBoundAt: { $ne: null },
      $or: [
        { responseBinding: { $exists: false } },
        { responseBinding },
        { 'responseBinding.streamId': { $ne: streamId } },
      ],
    },
    { $set: { responseBinding } },
  );
  if (result?.acknowledged === false || Number(result?.matchedCount ?? result?.n ?? 0) < 1) {
    throw Object.assign(new Error('Telegram response author changed'), {
      code: 'TELEGRAM_RESPONSE_IDENTITY_UNAVAILABLE',
    });
  }
}

async function readRetainedTelegramTerminal({
  ownerId,
  streamId,
  telegramUserId,
  includeSettled = false,
  IngressModel = ViventiumTelegramIngressEvent,
  MessageModel = Message,
}) {
  if (!ownerId || !streamId) return null;
  const filter = {
    libreChatUserId: ownerId,
    streamId,
    inputState: { $in: ['admitted', 'completed', 'failed'] },
    authorityBoundAt: { $ne: null },
    $or: [
      { inputState: { $ne: 'failed' } },
      {
        inputFailureCode: {
          $in: includeSettled
            ? ['accepted_response_unavailable', 'source_terminal_presented']
            : ['accepted_response_unavailable'],
        },
      },
    ],
    ...(telegramUserId ? { telegramUserId } : {}),
  };
  const record = await IngressModel.findOne(filter).lean();
  const binding = record?.responseBinding;
  if (
    !record?.sourceEventId ||
    !record.sourceMessageId ||
    !record.conversationId ||
    binding?.streamId !== streamId ||
    !binding.responseMessageId ||
    !binding.logicalTurnId ||
    !Number.isSafeInteger(binding.revision) ||
    binding.revision < 1
  )
    return null;
  const hostFinal = await require('./nativeResponseService').readRetainedMainFinal({
    userId: ownerId,
    streamId,
    surface: 'telegram',
    includeSettled,
  });
  if (
    hostFinal?.responseMessageId === binding.responseMessageId &&
    hostFinal.conversationId === record.conversationId &&
    hostFinal.finalEvent?.requestMessage?.messageId === record.sourceMessageId &&
    hostFinal.interactionContext?.source_event_id === record.sourceEventId &&
    hostFinal.interactionContext?.logical_turn_id === binding.logicalTurnId &&
    hostFinal.interactionContext?.revision === binding.revision &&
    (await IngressModel.exists({ ...filter, responseBinding: binding }))
  )
    return hostFinal;
  const messageQuery = MessageModel.findOne({
    user: ownerId,
    conversationId: record.conversationId,
    messageId: binding.responseMessageId,
    parentMessageId: record.sourceMessageId,
    isCreatedByUser: false,
    unfinished: false,
    error: true,
    deletedAt: null,
    'metadata.viventium.interactionContext.source_event_id': record.sourceEventId,
    'metadata.viventium.interactionContext.logical_turn_id': binding.logicalTurnId,
    'metadata.viventium.interactionContext.revision': binding.revision,
  });
  const message = await (
    messageQuery.select ? messageQuery.select('+nativeResponse +hostFinal') : messageQuery
  ).lean();
  const failures = Array.isArray(message?.content)
    ? message.content.filter(
        (part) =>
          part?.type === 'error' &&
          typeof part.error_class === 'string' &&
          part.error_class.length > 0 &&
          part.error_class.length <= 128 &&
          typeof part.error === 'string' &&
          part.error.length > 0,
      )
    : [];
  if (failures.length !== 1) return null;
  const acknowledgement = message.metadata?.viventium?.deliveryAcknowledgement;
  if (
    ['committed', 'committed_effect', 'failed'].includes(acknowledgement?.state) &&
    !includeSettled
  )
    return null;
  // A continuation/replacement that raced the message lookup cannot publish the former author.
  if (!(await IngressModel.exists({ ...filter, responseBinding: binding }))) return null;
  return {
    error: failures[0].error,
    error_class: failures[0].error_class,
    responseMessageId: binding.responseMessageId,
    conversationId: record.conversationId,
    interactionContext: {
      ...message.metadata.viventium.interactionContext,
      ...(message.nativeResponse?.sourceSequence || message.hostFinal?.sourceSequence
        ? {
            source_sequence: Math.max(
              Number(message.metadata.viventium.interactionContext.source_sequence) || 0,
              Number(message.nativeResponse?.sourceSequence) || 0,
              Number(message.hostFinal?.sourceSequence) || 0,
            ),
          }
        : {}),
    },
    acknowledgement,
    ...(message.nativeResponse ? { nativeFailure: message.nativeResponse } : {}),
  };
}
async function acknowledgeRetainedTelegramFailure(
  acknowledgement,
  adapterSurface,
  { IngressModel = ViventiumTelegramIngressEvent, MessageModel = Message } = {},
) {
  if (
    adapterSurface !== 'telegram' ||
    acknowledgement.state !== 'failed' ||
    acknowledgement.effect_ref ||
    acknowledgement.source_kind === 'schedule_result'
  )
    return { status: 'not_found' };
  return runGlassHiveTerminalCallbackTransaction(
    async () => {
      const record = await IngressModel.findOne({
        'responseBinding.logicalTurnId': acknowledgement.logical_turn_id,
        'responseBinding.revision': acknowledgement.revision,
        authorityBoundAt: { $ne: null },
      }).lean();
      if (!record) return { status: 'not_found' };
      const terminal = await readRetainedTelegramTerminal({
        ownerId: record.libreChatUserId,
        streamId: record.streamId,
        includeSettled: true,
        IngressModel,
        MessageModel,
      });
      if (!terminal || terminal.responseMessageId !== record.responseBinding?.responseMessageId)
        return { status: 'not_found' };
      const job = await require('@librechat/api').GenerationJobManager.getJob(record.streamId);
      if (
        job &&
        (!['complete', 'error', 'aborted', 'superseded'].includes(job.status) ||
          job.metadata?.userId !== record.libreChatUserId ||
          job.metadata?.conversationId !== record.conversationId ||
          job.metadata?.responseMessageId !== terminal.responseMessageId ||
          job.metadata?.interactionContext?.logical_turn_id !== acknowledgement.logical_turn_id ||
          job.metadata?.interactionContext?.revision !== acknowledgement.revision)
      )
        return { status: 'not_found' };
      const nativeFailure = terminal.nativeFailure;
      if (
        nativeFailure &&
        (!['failed', 'cancelled'].includes(nativeFailure.status) ||
          !(nativeFailure.finalReplayStoredAt > 0) ||
          nativeFailure.userId !== record.libreChatUserId ||
          nativeFailure.conversationId !== record.conversationId ||
          nativeFailure.streamId !== record.streamId ||
          nativeFailure.responseMessageId !== terminal.responseMessageId ||
          nativeFailure.source?.messageId !== record.sourceMessageId ||
          nativeFailure.logicalTurnId !== acknowledgement.logical_turn_id ||
          nativeFailure.revision !== acknowledgement.revision ||
          !(await require('~/models').nativeResponseSourceMatches(nativeFailure)))
      )
        return { status: 'not_found' };
      if (
        terminal.acknowledgement &&
        terminal.acknowledgement.state !== 'partial_removed' &&
        JSON.stringify(terminal.acknowledgement) !== JSON.stringify(acknowledgement)
      )
        return { status: 'conflict' };
      const result = await MessageModel.updateOne(
        {
          user: record.libreChatUserId,
          conversationId: record.conversationId,
          messageId: terminal.responseMessageId,
          parentMessageId: record.sourceMessageId,
          unfinished: false,
          error: true,
          ...(nativeFailure ? { nativeResponse: nativeFailure } : {}),
          'metadata.viventium.interactionContext.source_event_id': record.sourceEventId,
          'metadata.viventium.interactionContext.logical_turn_id': acknowledgement.logical_turn_id,
          'metadata.viventium.interactionContext.revision': acknowledgement.revision,
          $or: [
            { 'metadata.viventium.deliveryAcknowledgement': { $exists: false } },
            { 'metadata.viventium.deliveryAcknowledgement': acknowledgement },
            ...(terminal.acknowledgement?.state === 'partial_removed'
              ? [{ 'metadata.viventium.deliveryAcknowledgement': terminal.acknowledgement }]
              : []),
          ],
        },
        { $set: { 'metadata.viventium.deliveryAcknowledgement': acknowledgement } },
      );
      if (Number(result?.matchedCount ?? result?.n ?? 0) < 1) return { status: 'conflict' };
      const settled = await IngressModel.updateOne(
        {
          libreChatUserId: record.libreChatUserId,
          sourceEventId: record.sourceEventId,
          streamId: record.streamId,
          responseBinding: record.responseBinding,
          inputState: record.inputState,
          inputClaimToken: record.inputClaimToken,
        },
        {
          $set: {
            inputState: 'failed',
            inputFailureCode: 'source_terminal_presented',
            inputRetryAt: 0,
            inputLeaseUntil: 0,
            inputClaimToken: '',
          },
        },
      );
      if (Number(settled?.matchedCount ?? settled?.n ?? 0) < 1)
        throw Object.assign(new Error('Telegram terminal author changed'), {
          code: 'telegram_terminal_ack_conflict',
        });
      const relatedSourceIds = new Set(
        Array.isArray(record.inputRelatedSourceEventIds) ? record.inputRelatedSourceEventIds : [],
      );
      relatedSourceIds.delete(record.sourceEventId);
      for (const sourceEventId of relatedSourceIds) {
        const relatedFilter = {
          libreChatUserId: record.libreChatUserId,
          sourceEventId,
          inputPrimarySourceEventId: record.sourceEventId,
          conversationId: record.conversationId,
          streamId: record.streamId,
          inputState: 'admitted',
        };
        const related = await IngressModel.findOne(relatedFilter).lean();
        if (!related) continue;
        const settledRelated = await IngressModel.updateOne(
          {
            ...relatedFilter,
            inputClaimToken: related.inputClaimToken,
          },
          {
            $set: {
              inputState: 'failed',
              inputFailureCode: 'source_terminal_presented',
              inputRetryAt: 0,
              inputLeaseUntil: 0,
              inputClaimToken: '',
            },
          },
        );
        if (Number(settledRelated?.matchedCount ?? settledRelated?.n ?? 0) < 1)
          throw Object.assign(new Error('Telegram grouped terminal author changed'), {
            code: 'telegram_terminal_ack_conflict',
          });
      }
      return {
        status: 'recorded',
        acknowledgement,
        transportOnly: true,
        idempotent: terminal.acknowledgement?.state === 'failed',
      };
    },
    { retry: 'native' },
  );
}
/* VIVENTIUM END */
module.exports = {
  bindRetainedTelegramIngressAuthority,
  bindRetainedTelegramResponse,
  readRetainedTelegramTerminal,
  acknowledgeRetainedTelegramFailure,
};
