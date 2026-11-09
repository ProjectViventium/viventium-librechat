/* === VIVENTIUM START === Existing Native/Main/channel receipts recover one saved publication. === */
const mongoose = require('mongoose');
const { nativeCoordinatorResultEventId } = require('@librechat/api');
const {
  Message,
  ViventiumCortexInsightDelivery,
  ViventiumGlassHiveCallbackDelivery,
} = require('~/db/models');
const { cortexInsightDeliveryService } = require('./CortexInsightDeliveryService');
const { requestAccountApi } = require('./GlassHiveAccountService');
const {
  createNativeCoordinatorPresentationService,
  bindNativeResultAuthority,
} = require('./nativeCoordinatorPresentation');

const bindings = () => mongoose.connection.collection('viventium_glasshive_callback_bindings');
const tenantId = () => process.env.VIVENTIUM_TENANT_ID || 'local';
const readMessage = ({ ownerId, conversationId, messageId }) =>
  Message.findOne({
    user: ownerId,
    conversationId,
    messageId,
  }).lean();

async function bindMessage(message, fence) {
  const metadata = message.metadata?.viventium || {};
  const set = {
    'metadata.viventium.mainGenerationPresentation': metadata.mainGenerationPresentation,
    'metadata.viventium.cortexPresentationParentMessageId': fence.parentMessageId,
    'metadata.viventium.cortexPresentationGeneration': fence.claimGeneration,
    'metadata.viventium.cortexPresentationClaimToken': fence.claimToken,
  };
  if (metadata.cortexFollowUpDecision?.dropReason === 'delivery_attempts_exhausted') {
    set['metadata.viventium.cortexFollowUpDecision.deliveryStatus'] = 'pending';
    set['metadata.viventium.cortexFollowUpDecision.dropReason'] = '';
    set['metadata.viventium.cortexFollowUpDecision.terminalAt'] = null;
  }
  const saved = await Message.findOneAndUpdate(
    {
      user: fence.ownerId,
      conversationId: fence.conversationId,
      messageId: message.messageId,
      parentMessageId: message.parentMessageId,
      text: message.text,
      isCreatedByUser: false,
      error: { $ne: true },
      unfinished: { $ne: true },
      deletedAt: null,
      'metadata.viventium.messageRevision': metadata.messageRevision || 1,
      'metadata.viventium.cortexInsightDeliveryIds': metadata.cortexInsightDeliveryIds,
      'metadata.viventium.cortexPresentationGeneration': metadata.cortexPresentationGeneration,
      'metadata.viventium.cortexPresentationClaimToken': metadata.cortexPresentationClaimToken,
      'metadata.viventium.mainGenerationPresentation': fence.previousAuthority ?? {
        $exists: false,
      },
    },
    { $set: set },
    { new: true },
  ).lean();
  if (!saved)
    throw Object.assign(new Error('coordinator_presentation_snapshot_changed'), {
      code: 'coordinator_presentation_snapshot_changed',
    });
  if (metadata.cortexFollowUpDecision?.dropReason === 'delivery_attempts_exhausted') {
    await Message.updateMany(
      {
        user: fence.ownerId,
        conversationId: fence.conversationId,
        messageId: { $in: [fence.parentMessageId, message.messageId] },
        'metadata.viventium.cortexFollowUpDecision.persistedMessageId': message.messageId,
        'metadata.viventium.cortexFollowUpDecision.deliveryStatus': 'dropped',
        'metadata.viventium.cortexFollowUpDecision.dropReason': 'delivery_attempts_exhausted',
      },
      {
        $set: {
          'metadata.viventium.cortexFollowUpDecision.deliveryStatus': 'pending',
          'metadata.viventium.cortexFollowUpDecision.dropReason': '',
          'metadata.viventium.cortexFollowUpDecision.terminalAt': null,
        },
      },
    );
  }
  return saved;
}

const service = createNativeCoordinatorPresentationService({
  tenantId,
  ledger: cortexInsightDeliveryService,
  async readRows({ ownerId, parentMessageId, publicationId, deliveryIds }) {
    // The shared owner validates complete immutable batches before private proof fields are read.
    const publicRows = await cortexInsightDeliveryService.listByParent({
      ownerId,
      parentMessageId,
      ...(deliveryIds ? { deliveryIds } : { publicationId: publicationId || '' }),
    });
    if (!publicRows.length) return [];
    return ViventiumCortexInsightDelivery.find({
      userId: ownerId,
      parentMessageId,
      deliveryId: { $in: publicRows.map((row) => row.deliveryId) },
    })
      .select('+insight +insightHash +graphResultHash +events +claimToken +streamId')
      .lean();
  },
  readMessage,
  findMessages: ({ ownerId, conversationId, parentMessageId, deliveryIds }) =>
    Message.find({
      user: ownerId,
      conversationId,
      'metadata.viventium.cortexPresentationParentMessageId': parentMessageId,
      'metadata.viventium.cortexInsightDeliveryIds': {
        $all: deliveryIds,
        $size: deliveryIds.length,
      },
    })
      .limit(2)
      .lean(),
  readDelivery: (candidate) =>
    ViventiumGlassHiveCallbackDelivery.findOne({
      deliveryId: candidate.deliveryId,
      userId: candidate.userId,
      conversationId: candidate.conversationId,
      callbackMessageId: candidate.callbackMessageId,
      status: 'sent',
    }).lean(),
  async readSources(parent, retained) {
    const selected = await bindings()
      .find({
        kind: 'native_coordinator_binding',
        active: true,
        tenantId: tenantId(),
        ownerId: parent.ownerId,
        conversationId: parent.conversationId,
        ...(retained
          ? { _id: retained.bindingRef, nativeConversationId: retained.nativeConversationId }
          : {}),
      })
      .toArray();
    if (!selected.length) return [];
    const sources = await bindings()
      .find({
        kind: 'native_coordinator_source',
        bindingRef: { $in: selected.map((binding) => binding._id) },
        ...(retained ? { turnId: retained.sourceTurnId } : {}),
        $or: [
          { 'requestBody.messageId': parent.parentMessageId },
          { 'requestBody.parentMessageId': parent.parentMessageId },
        ],
      })
      .toArray();
    return sources.map((source) => ({
      source,
      binding: selected.find((binding) => binding._id === source.bindingRef),
    }));
  },
  readSnapshot: (binding) =>
    requestAccountApi({
      ownerId: binding.ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(binding.nativeConversationId)}?include_history=false`,
      maxResponseBytes: null,
    }),
  async readPublications(binding) {
    const publications = [];
    const seen = new Set();
    let cursor = null;
    do {
      const page = await requestAccountApi({
        ownerId: binding.ownerId,
        path: `/v1/coordinator/conversations/${encodeURIComponent(binding.nativeConversationId)}/publications${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
      });
      if (
        page?.conversation_id !== binding.nativeConversationId ||
        !Array.isArray(page.publications) ||
        (page.next_cursor !== null && typeof page.next_cursor !== 'string')
      )
        throw Object.assign(new Error('coordinator_publication_metadata_invalid'), {
          code: 'coordinator_publication_metadata_invalid',
        });
      publications.push(...page.publications);
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor))
        throw Object.assign(new Error('coordinator_publication_cursor_repeated'), {
          code: 'coordinator_publication_cursor_repeated',
        });
      if (cursor) seen.add(cursor);
    } while (cursor);
    return publications;
  },
  readTurnResult: (binding, turn) =>
    requestAccountApi({
      ownerId: binding.ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(binding.nativeConversationId)}/turns/${encodeURIComponent(turn.turn_id)}/result?request_id=${encodeURIComponent(turn.request_id)}&run_id=${encodeURIComponent(turn.run_id)}&offset=0&max_chars=1`,
    }),
  readResult: (binding, goal) =>
    requestAccountApi({
      ownerId: binding.ownerId,
      path: `/v1/coordinator/conversations/${encodeURIComponent(binding.nativeConversationId)}/goals/${encodeURIComponent(goal.goal_id)}/result?run_id=${encodeURIComponent(goal.run_id)}&offset=0&max_chars=1`,
    }),
  bindMessage,
  enqueue: (owned) =>
    require('./NativeCoordinatorContextService').enqueueSavedNativeCoordinatorPresentation({
      ...owned,
      eventId: nativeCoordinatorResultEventId(owned.data),
    }),
  publishUnpublished: (input) =>
    require('./NativeCoordinatorContextService').publishNativeCoordinatorResult(input),
});

async function persistAuthority(message, binding, source, data) {
  const bound = bindNativeResultAuthority(message, binding, source, data);
  return bindMessage(bound, {
    ownerId: binding.ownerId,
    conversationId: binding.conversationId,
    parentMessageId: source.requestBody.messageId || source.requestBody.parentMessageId,
    claimGeneration: message.metadata.viventium.cortexPresentationGeneration,
    claimToken: message.metadata.viventium.cortexPresentationClaimToken,
    previousAuthority: message.metadata?.viventium?.mainGenerationPresentation,
  });
}

module.exports = { ...service, persistAuthority };
/* === VIVENTIUM END === */
