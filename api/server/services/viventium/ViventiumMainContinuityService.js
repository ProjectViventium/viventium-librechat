/* === VIVENTIUM START === Thin legacy adapter for typed accepted Main continuity. === */
const { createMainContinuityService } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Conversation, Message, ViventiumMainContinuityState } = require('~/db/models');

const persistence = {
  async read(key) {
    return ViventiumMainContinuityState.findOne({ domainEpochKey: key }).lean();
  },
  async readLatestDomain(domainId, excludeKey = '') {
    return ViventiumMainContinuityState.findOne({
      continuityDomainId: domainId,
      ...(excludeKey ? { domainEpochKey: { $ne: excludeKey } } : {}),
    })
      .sort({ updatedAt: -1, _id: -1 })
      .lean();
  },
  async create(state) {
    try {
      await ViventiumMainContinuityState.create(state);
      return true;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  },
  async compareAndSwap(key, version, state) {
    const { version: _ignored, ...next } = state;
    const result = await ViventiumMainContinuityState.updateOne(
      { domainEpochKey: key, version },
      { $set: next, $inc: { version: 1 } },
    );
    return result.modifiedCount === 1;
  },
};

async function loadPresentation(userId, responseMessageId) {
  const assistant = await Message.findOne({
    user: userId,
    messageId: responseMessageId,
    isCreatedByUser: { $ne: true },
    unfinished: { $ne: true },
    error: { $ne: true },
    'metadata.viventium.visibility': { $ne: 'internal' },
  }).lean();
  if (!assistant) return { assistant: null, userMessage: null, conversation: null };
  const [userMessage, conversation] = await Promise.all([
    Message.findOne({
      user: userId,
      messageId: assistant.parentMessageId,
      isCreatedByUser: true,
    }).lean(),
    Conversation.findOne({
      user: userId,
      conversationId: assistant.conversationId,
    }).lean(),
  ]);
  return { assistant, userMessage, conversation };
}

module.exports = createMainContinuityService({ persistence, logger, loadPresentation });
/* === VIVENTIUM END === */
