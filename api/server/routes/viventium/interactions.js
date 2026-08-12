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

const router = express.Router();

async function persistPresentationOutcome(result) {
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
      ...(acknowledgement.state === 'committed' ? { unfinished: false } : {}),
      'metadata.viventium.deliveryAcknowledgement': acknowledgement,
    },
  });
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
    const result = await GenerationJobManager.acknowledgeDelivery(
      parsed.acknowledgement,
      adapterSurface,
    );
    if (result.status === 'recorded') {
      await persistPresentationOutcome(result);
      return res.json({ acknowledged: true, idempotent: result.idempotent === true });
    }
    const statusCode = result.status === 'not_found' ? 404 : 409;
    return res.status(statusCode).json({ acknowledged: false, error: result.status });
  } catch (error) {
    logger.error('[VIVENTIUM][interactions/delivery-ack] Persistence failed', {
      error: error?.name || 'Error',
    });
    return res.status(503).json({ acknowledged: false, error: 'persistence_unavailable' });
  }
});

module.exports = router;
