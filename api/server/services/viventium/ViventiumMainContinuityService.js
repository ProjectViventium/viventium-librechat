/* === VIVENTIUM START === Thin legacy adapter for typed accepted Main continuity. === */
const { createMainContinuityService } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { Conversation, Message, ViventiumMainContinuityState } = require('~/db/models');

const persistence = {
  async read(key) {
    return ViventiumMainContinuityState.findOne({ domainEpochKey: key }).lean();
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
  // Hydration also runs inside the acceptance/promotion transaction's inherited session.
  const userMessage = await Message.findOne({
    user: userId,
    messageId: assistant.parentMessageId,
    isCreatedByUser: true,
  }).lean();
  const conversation = await Conversation.findOne({
    user: userId,
    conversationId: assistant.conversationId,
  }).lean();
  return { assistant, userMessage, conversation };
}

async function loadPresentations(userId, responseMessageIds) {
  const assistants = await Message.find({
    user: userId,
    messageId: { $in: responseMessageIds },
    isCreatedByUser: { $ne: true },
    unfinished: { $ne: true },
    error: { $ne: true },
    'metadata.viventium.visibility': { $ne: 'internal' },
  }).lean();
  const users = await Message.find({
    user: userId,
    messageId: { $in: assistants.map((item) => item.parentMessageId) },
    isCreatedByUser: true,
  }).lean();
  const conversations = await Conversation.find({
    user: userId,
    conversationId: { $in: assistants.map((item) => item.conversationId) },
  }).lean();
  const userById = new Map(users.map((item) => [item.messageId, item]));
  const conversationById = new Map(conversations.map((item) => [item.conversationId, item]));
  return assistants.map((assistant) => ({
    assistant,
    userMessage: userById.get(assistant.parentMessageId) || null,
    conversation: conversationById.get(assistant.conversationId) || null,
  }));
}

module.exports = createMainContinuityService({
  persistence,
  logger,
  loadPresentation,
  loadPresentations,
  history: {
    read: (identity, options) => require('~/models').readAcceptedMainHistory(identity, options),
    legacy: (identity, cursor) => require('~/models').readLegacyMainInput(identity, cursor),
    fence: (identity, turns, operation) =>
      require('~/models').fenceAcceptedMainCompaction(
        identity,
        turns,
        operation,
        require('./GlassHiveTerminalCallbackTransaction').runGlassHiveTerminalCallbackTransaction,
      ),
  },
  commitPresentation: (identity, turn, operation) =>
    require('~/models').projectAcceptedMainPresentation(
      identity,
      turn,
      operation,
      require('./GlassHiveTerminalCallbackTransaction').runGlassHiveTerminalCallbackTransaction,
    ),
});
/* === VIVENTIUM END === */
