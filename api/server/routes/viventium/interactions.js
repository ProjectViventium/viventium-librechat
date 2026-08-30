'use strict';

/* === VIVENTIUM START ===
 * Feature: Generic interaction delivery acknowledgement.
 * Purpose: Let authenticated presentation adapters record current turn outcomes without trusting
 * client-supplied user, conversation, surface, or revision authority.
 * === VIVENTIUM END === */

const express = require('express');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Message, Conversation } = require('~/db/models');
const {
  adapterSecretConfigured,
  authenticateAdapterSecret,
  parseDeliveryAcknowledgement,
} = require('~/server/services/viventium/interactionDeliveryAck');
const {
  recordTelegramTransportReceipt,
} = require('~/server/services/viventium/TelegramReplyProvenanceService');
const {
  commitAcceptedMainTurnFromPresentation,
} = require('~/server/services/viventium/ViventiumMainContinuityService');
const {
  markCortexInsightDeliveryPresentationFailedByParent,
  markCortexInsightDeliveryPresentationByParent,
  requireExactCortexInsightDeliverySettlement,
} = require('~/server/services/viventium/CortexInsightDeliveryService');
/* === VIVENTIUM START === EMO-UC-048 promoted-parent fault binding. === */
const {
  consumeLocalQaCortexFault,
} = require('~/server/services/viventium/LocalQaCortexFaultService');
/* === VIVENTIUM END === */

const router = express.Router();

async function persistPresentationOutcome(result) {
  if (result?.transportOnly === true) return;
  const acknowledgement = result?.acknowledgement;
  const presentation = result?.presentation;
  const context = presentation?.interactionContext;
  if (
    !acknowledgement ||
    !presentation?.userId ||
    !presentation?.responseMessageId ||
    !context?.logical_turn_id
  ) {
    return;
  }
  const query = {
    user: presentation.userId,
    messageId: presentation.responseMessageId,
    isCreatedByUser: { $ne: true },
    unfinished: true,
    'metadata.viventium.interactionContext.logical_turn_id': context.logical_turn_id,
    'metadata.viventium.interactionContext.revision': context.revision,
  };
  if (presentation.conversationId) {
    query.conversationId = presentation.conversationId;
  }

  if (acknowledgement.state === 'partial_removed') {
    const removed = await Message.findOneAndDelete(query);
    if (removed?._id && presentation.conversationId) {
      await Conversation.updateOne(
        { user: presentation.userId, conversationId: presentation.conversationId },
        { $pull: { messages: removed._id } },
      );
    }
    return;
  }

  await Message.updateOne(query, {
    $set: {
      ...(['committed', 'committed_effect'].includes(acknowledgement.state)
        ? { unfinished: false }
        : {}),
      'metadata.viventium.deliveryAcknowledgement': acknowledgement,
    },
  });
}

async function persistTelegramTransportReceipt(result, adapterSurface) {
  if (
    adapterSurface !== 'telegram' ||
    !['committed', 'committed_effect'].includes(result?.acknowledgement?.state)
  ) {
    return;
  }
  const presentation = result?.presentation;
  if (!presentation?.userId || !presentation?.responseMessageId) return;
  const refs =
    result.acknowledgement.presentation_refs ||
    (result.acknowledgement.presentation_ref ? [result.acknowledgement.presentation_ref] : []);
  const parsed = refs
    .map((value) => /^telegram:([^:]+):([^:]+)$/.exec(String(value || '')))
    .filter(Boolean);
  if (parsed.length === 0) return;
  const chatId = parsed[0][1];
  const sameChatIds = parsed.filter((match) => match[1] === chatId).map((match) => match[2]);
  await recordTelegramTransportReceipt({
    sourceKind: result.acknowledgement.source_kind || 'assistant_message',
    userId: presentation.userId,
    conversationId: presentation.conversationId,
    logicalMessageId: presentation.responseMessageId,
    telegramChatId: chatId,
    telegramSentMessageIds: sameChatIds,
    scheduleId: result.acknowledgement.schedule_id || '',
    scheduleRunId: result.acknowledgement.schedule_run_id || '',
  });
}

async function persistCortexTelegramPresentationReceipt(
  result,
  adapterSurface,
  {
    MessageModel = Message,
    consumeFault = consumeLocalQaCortexFault,
    markPresentationFailedByParent = markCortexInsightDeliveryPresentationFailedByParent,
    markPresentationByParent = markCortexInsightDeliveryPresentationByParent,
    requireExactSettlement = requireExactCortexInsightDeliverySettlement,
  } = {},
) {
  if (
    adapterSurface !== 'telegram' ||
    !['committed', 'committed_effect'].includes(result?.acknowledgement?.state) ||
    result?.transportOnly === true
  ) {
    return;
  }
  const presentation = result?.presentation;
  const cortexPresentation = presentation?.cortexPresentation;
  if (!cortexPresentation) return;
  const revision = Number(cortexPresentation?.revision);
  const presentationGeneration = Number(cortexPresentation?.generation);
  const presentationClaimToken = String(cortexPresentation?.claimToken || '').trim();
  const persistedMessageId = String(cortexPresentation?.messageId || '').trim();
  const parentMessageId = String(cortexPresentation?.parentMessageId || '').trim();
  const deliveryIds = Array.from(
    new Set(
      (Array.isArray(cortexPresentation?.deliveryIds) ? cortexPresentation.deliveryIds : [])
        .map((deliveryId) => String(deliveryId || '').trim())
        .filter(Boolean),
    ),
  ).sort();
  const deliveryReceipts = (
    Array.isArray(cortexPresentation?.deliveryReceipts) ? cortexPresentation.deliveryReceipts : []
  )
    .map((receipt) => ({
      deliveryId: String(receipt?.deliveryId || '').trim(),
      graphResultHash: String(receipt?.graphResultHash || '')
        .trim()
        .toLowerCase(),
    }))
    .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
  const refs = Array.from(
    new Set(
      [
        ...(Array.isArray(result?.acknowledgement?.presentation_refs)
          ? result.acknowledgement.presentation_refs
          : []),
        result?.acknowledgement?.presentation_ref,
      ]
        .map((value) => String(value || '').trim())
        .filter((value) => /^telegram:[^:]+:[^:]+$/.test(value)),
    ),
  ).sort();
  if (
    !presentation?.userId ||
    String(cortexPresentation?.ownerId || '').trim() !== String(presentation.userId).trim() ||
    !persistedMessageId ||
    !parentMessageId ||
    parentMessageId !== String(presentation?.responseMessageId || '').trim() ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(presentationGeneration) ||
    presentationGeneration < 1 ||
    !presentationClaimToken ||
    deliveryIds.length === 0 ||
    deliveryReceipts.length !== deliveryIds.length ||
    deliveryReceipts.some(
      (receipt, index) =>
        receipt.deliveryId !== deliveryIds[index] ||
        !/^[a-f0-9]{64}$/.test(receipt.graphResultHash),
    ) ||
    refs.length === 0
  ) {
    const error = new Error('Exact Cortex Telegram presentation identity is unavailable');
    error.code = 'cortex_telegram_presentation_identity_unavailable';
    throw error;
  }
  /* === VIVENTIUM START === EMO-UC-048 promoted-parent Telegram presentation boundary. === */
  if (persistedMessageId === parentMessageId) {
    const fault = await consumeFault({
      boundary: 'telegram_promoted_parent_presentation',
      ownerId: presentation.userId,
      conversationId: presentation.conversationId,
      parentMessageId,
    });
    if (fault.triggered === true) {
      await markPresentationFailedByParent({
        ownerId: presentation.userId,
        parentMessageId,
        surface: 'telegram',
        reason: 'presentation_failed',
      });
      const error = new Error('Cortex Telegram presentation receipt is unavailable');
      error.code = 'cortex_telegram_presentation_receipt_unavailable';
      throw error;
    }
  }
  /* === VIVENTIUM END === */
  const acknowledgement = {
    ...result.acknowledgement,
    logical_turn_revision: result.acknowledgement.revision,
    revision,
    cortex_presentation_generation: presentationGeneration,
    cortex_presentation_claim_token: presentationClaimToken,
  };
  const messageReceipt = await MessageModel.updateOne(
    {
      user: presentation.userId,
      messageId: persistedMessageId,
      isCreatedByUser: { $ne: true },
      'metadata.viventium.messageRevision': revision,
      'metadata.viventium.cortexPresentationGeneration': presentationGeneration,
      'metadata.viventium.cortexPresentationClaimToken': presentationClaimToken,
    },
    {
      $set: {
        'metadata.viventium.deliveryAcknowledgement': acknowledgement,
      },
    },
  );
  const matchedCount = Number(messageReceipt?.matchedCount ?? messageReceipt?.n ?? 0);
  const modifiedCount = Number(messageReceipt?.modifiedCount ?? messageReceipt?.nModified ?? 0);
  if (messageReceipt?.acknowledged === false || (matchedCount < 1 && modifiedCount < 1)) {
    const error = new Error('Exact Cortex Telegram Message acknowledgement was not persisted');
    error.code = 'cortex_telegram_message_acknowledgement_unmatched';
    throw error;
  }

  const settled = await markPresentationByParent({
    ownerId: presentation.userId,
    parentMessageId,
    surface: 'telegram',
    persistedMessageId,
    messageRevision: revision,
    presentationGeneration,
    presentationClaimToken,
    expectedPresentationLeaseToken: String(cortexPresentation.presentationLeaseToken || '').trim(),
    presentationRef: refs.join('|'),
    expectedDeliveryIds: deliveryIds,
    expectedDeliveryReceipts: deliveryReceipts,
  });
  requireExactSettlement(
    deliveryIds.map((deliveryId) => ({ deliveryId, claimGeneration: presentationGeneration })),
    settled,
  );
}

router.post('/delivery-ack', async (req, res) => {
  if (!adapterSecretConfigured()) {
    return res.status(503).json({ acknowledged: false, error: 'adapter_auth_unavailable' });
  }
  const adapterSurface = authenticateAdapterSecret(req.get('x-viventium-adapter-secret'));
  if (!adapterSurface) {
    return res.status(401).json({ acknowledged: false, error: 'unauthorized' });
  }
  const parsed = parseDeliveryAcknowledgement(req.body);
  if (!parsed.acknowledgement) {
    return res.status(400).json({ error: 'invalid_delivery_ack', field: parsed.error });
  }

  try {
    let result =
      parsed.acknowledgement.source_kind === 'schedule_result'
        ? await GenerationJobManager.acknowledgeServerCommittedTransportReceipt(
            parsed.acknowledgement,
            adapterSurface,
          )
        : await (parsed.cortexPresentation
            ? GenerationJobManager.acknowledgeDelivery(
                parsed.acknowledgement,
                adapterSurface,
                parsed.cortexPresentation,
              )
            : GenerationJobManager.acknowledgeDelivery(
                parsed.acknowledgement,
                adapterSurface,
              ));
    if (result.status === 'stale_revision' && parsed.acknowledgement.state === 'committed') {
      result = await GenerationJobManager.acknowledgeDurableEffectDelivery(
        parsed.acknowledgement,
        adapterSurface,
      );
    }
    if (result.status === 'recorded') {
      await persistPresentationOutcome(result);
      await persistTelegramTransportReceipt(result, adapterSurface);
      await persistCortexTelegramPresentationReceipt(result, adapterSurface);
      if (
        result.transportOnly !== true &&
        ['committed', 'committed_effect'].includes(result.acknowledgement?.state)
      ) {
        const presentationCommittedAt = result.acknowledgement.presentation_committed_at;
        await commitAcceptedMainTurnFromPresentation({
          ...result.presentation,
          ...(Number.isSafeInteger(presentationCommittedAt) && presentationCommittedAt > 0
            ? { presentationCommittedAt }
            : {}),
        });
      }
      return res.json({ acknowledged: true, idempotent: result.idempotent === true });
    }
    let statusCode = 409;
    if (result.status === 'not_found') statusCode = 404;
    if (result.status === 'retryable_conflict') statusCode = 503;
    return res.status(statusCode).json({ acknowledged: false, error: result.status });
  } catch (error) {
    logger.error('[VIVENTIUM][interactions/delivery-ack] Persistence failed', {
      error: error?.name || 'Error',
    });
    return res.status(503).json({ acknowledged: false, error: 'persistence_unavailable' });
  }
});

module.exports = router;
module.exports.__testables = Object.freeze({ persistCortexTelegramPresentationReceipt });
