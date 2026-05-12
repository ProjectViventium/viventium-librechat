const { z } = require('zod');
const { logger } = require('@librechat/data-schemas');
const { createTempChatExpirationDate } = require('@librechat/api');
const { Message } = require('~/db/models');
/* === VIVENTIUM START ===
 * Feature: Conversation Recall RAG proactive sync hooks
 * Added: 2026-02-19
 */
const {
  scheduleConversationRecallSync,
  getMessageText: getConversationRecallMessageText,
  shouldSkipFromRecallCorpus,
} = require('~/server/services/viventium/conversationRecallService');
const {
  buildRecallDerivedParentIdSet,
} = require('~/server/services/viventium/conversationRecallFilters');
/* === VIVENTIUM END === */

const idSchema = z.string().uuid();
const TEXT_CONTENT_TYPE = 'text';
const CORTEX_CONTENT_TYPES = new Set(['cortex_activation', 'cortex_brewing', 'cortex_insight']);
const PLACEHOLDER_RESPONSE_PATTERNS = [
  /^(generation in progress|generation interrupted before completion)\.?$/i,
];

function isPlaceholderAssistantText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  return lines.every((line) => PLACEHOLDER_RESPONSE_PATTERNS.some((pattern) => pattern.test(line)));
}

function textFromContentParts(content) {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part) => part && part.type === TEXT_CONTENT_TYPE)
    .map((part) => {
      if (typeof part.text === 'string') {
        return part.text;
      }
      if (typeof part.text?.value === 'string') {
        return part.text.value;
      }
      return '';
    })
    .join('')
    .trim();
}

function visibleMessageText(message) {
  const directText = typeof message?.text === 'string' ? message.text.trim() : '';
  if (directText && !isPlaceholderAssistantText(directText)) {
    return directText;
  }
  const contentText = textFromContentParts(message?.content);
  return isPlaceholderAssistantText(contentText) ? '' : contentText;
}

function contentHasCortexPart(content) {
  return Array.isArray(content) && content.some((part) => CORTEX_CONTENT_TYPES.has(part?.type));
}

function contentHasTextPart(content) {
  return Array.isArray(content) && content.some((part) => part?.type === TEXT_CONTENT_TYPE);
}

function shouldPreserveExistingAssistantText(update) {
  if (!update || update.isCreatedByUser === true || !Array.isArray(update.content)) {
    return false;
  }
  if (!contentHasCortexPart(update.content) || contentHasTextPart(update.content)) {
    return false;
  }
  const incomingText = typeof update.text === 'string' ? update.text.trim() : '';
  return incomingText === '' || isPlaceholderAssistantText(incomingText);
}

function mergeExistingTextIntoCortexOnlyUpdate(update, existing) {
  if (!shouldPreserveExistingAssistantText(update)) {
    return update;
  }
  const existingText = visibleMessageText(existing);
  if (!existingText) {
    return update;
  }
  return {
    ...update,
    text: existingText,
    content: [
      ...update.content,
      {
        type: TEXT_CONTENT_TYPE,
        text: existingText,
        [TEXT_CONTENT_TYPE]: existingText,
      },
    ],
  };
}

/**
 * Saves a message in the database.
 *
 * @async
 * @function saveMessage
 * @param {ServerRequest} req - The request object containing user information.
 * @param {Object} params - The message data object.
 * @param {string} params.endpoint - The endpoint where the message originated.
 * @param {string} params.iconURL - The URL of the sender's icon.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.newMessageId - The new unique identifier for the message (if applicable).
 * @param {string} params.conversationId - The identifier of the conversation.
 * @param {string} [params.parentMessageId] - The identifier of the parent message, if any.
 * @param {string} params.sender - The identifier of the sender.
 * @param {string} params.text - The text content of the message.
 * @param {boolean} params.isCreatedByUser - Indicates if the message was created by the user.
 * @param {string} [params.error] - Any error associated with the message.
 * @param {boolean} [params.unfinished] - Indicates if the message is unfinished.
 * @param {Object[]} [params.files] - An array of files associated with the message.
 * @param {string} [params.finish_reason] - Reason for finishing the message.
 * @param {number} [params.tokenCount] - The number of tokens in the message.
 * @param {string} [params.plugin] - Plugin associated with the message.
 * @param {string[]} [params.plugins] - An array of plugins associated with the message.
 * @param {string} [params.model] - The model used to generate the message.
 * @param {Object} [metadata] - Additional metadata for this operation
 * @param {string} [metadata.context] - The context of the operation
 * @returns {Promise<TMessage>} The updated or newly inserted message document.
 * @throws {Error} If there is an error in saving the message.
 */
async function saveMessage(req, params, metadata) {
  if (!req?.user?.id) {
    throw new Error('User not authenticated');
  }

  const validConvoId = idSchema.safeParse(params.conversationId);
  if (!validConvoId.success) {
    logger.warn(`Invalid conversation ID: ${params.conversationId}`);
    logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
    logger.info(`---Invalid conversation ID Params: ${JSON.stringify(params, null, 2)}`);
    return;
  }

  try {
    let update = {
      ...params,
      user: req.user.id,
      messageId: params.newMessageId || params.messageId,
    };

    if (req?.body?.isTemporary) {
      try {
        const appConfig = req.config;
        update.expiredAt = createTempChatExpirationDate(appConfig?.interfaceConfig);
      } catch (err) {
        logger.error('Error creating temporary chat expiration date:', err);
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
        update.expiredAt = null;
      }
    } else {
      update.expiredAt = null;
    }

    if (update.tokenCount != null && isNaN(update.tokenCount)) {
      logger.warn(
        `Resetting invalid \`tokenCount\` for message \`${params.messageId}\`: ${update.tokenCount}`,
      );
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
      update.tokenCount = 0;
    }
    /* === VIVENTIUM START ===
     * Feature: Preserve Phase A text when background cortex parts are saved later.
     *
     * Why:
     * Resumable/stream snapshots and final agent saves can touch the same assistant message id.
     * A later cortex-only write must not erase an already-saved main answer; background cards are
     * additive and the original Phase A answer remains durable.
     * === VIVENTIUM END === */
    if (shouldPreserveExistingAssistantText(update)) {
      const existing = await Message.findOne({
        messageId: params.messageId,
        user: req.user.id,
      }).lean();
      update = mergeExistingTextIntoCortexOnlyUpdate(update, existing);
    }
    const options = { upsert: true, new: true };
    /* === VIVENTIUM START ===
     * Feature: Deterministic timestamp preservation for imported/callback messages
     * Rationale: callers that explicitly provide timestamps expect ordering-sensitive
     * operations such as branch deletion and GlassHive callback placement to honor them.
     */
    if (params.createdAt != null || params.updatedAt != null) {
      options.timestamps = false;
      options.overwriteImmutable = true;
    }
    /* === VIVENTIUM END === */
    const message = await Message.findOneAndUpdate(
      { messageId: params.messageId, user: req.user.id },
      update,
      options,
    );

    /* === VIVENTIUM START ===
     * Feature: Conversation Recall RAG proactive sync on message upsert
     * Added: 2026-02-19
     */
    scheduleConversationRecallSync({
      userId: req.user.id,
      conversationId: update.conversationId,
    });
    /* === VIVENTIUM END === */

    return message.toObject();
  } catch (err) {
    logger.error('Error saving message:', err);
    logger.info(`---\`saveMessage\` context: ${metadata?.context}`);

    // Check if this is a duplicate key error (MongoDB error code 11000)
    if (err.code === 11000 && err.message.includes('duplicate key error')) {
      // Log the duplicate key error but don't crash the application
      logger.warn(`Duplicate messageId detected: ${params.messageId}. Continuing execution.`);

      try {
        // Try to find the existing message with this ID
        const existingMessage = await Message.findOne({
          messageId: params.messageId,
          user: req.user.id,
        });

        // If we found it, return it
        if (existingMessage) {
          /* === VIVENTIUM START ===
           * Feature: Conversation Recall RAG proactive sync on duplicate-write fallback
           * Added: 2026-02-19
           */
          scheduleConversationRecallSync({
            userId: req.user.id,
            conversationId: existingMessage.conversationId,
          });
          /* === VIVENTIUM END === */
          return existingMessage.toObject();
        }

        // If we can't find it (unlikely but possible in race conditions)
        return {
          ...params,
          messageId: params.messageId,
          user: req.user.id,
        };
      } catch (findError) {
        // If the findOne also fails, log it but don't crash
        logger.warn(
          `Could not retrieve existing message with ID ${params.messageId}: ${findError.message}`,
        );
        return {
          ...params,
          messageId: params.messageId,
          user: req.user.id,
        };
      }
    }

    throw err; // Re-throw other errors
  }
}

/**
 * Saves multiple messages in the database in bulk.
 *
 * @async
 * @function bulkSaveMessages
 * @param {Object[]} messages - An array of message objects to save.
 * @param {boolean} [overrideTimestamp=false] - Indicates whether to override the timestamps of the messages. Defaults to false.
 * @returns {Promise<Object>} The result of the bulk write operation.
 * @throws {Error} If there is an error in saving messages in bulk.
 */
async function bulkSaveMessages(messages, overrideTimestamp = false) {
  try {
    const bulkOps = messages.map((message) => ({
      updateOne: {
        filter: { messageId: message.messageId },
        update: message,
        timestamps: !overrideTimestamp,
        upsert: true,
      },
    }));
    const result = await Message.bulkWrite(bulkOps);
    return result;
  } catch (err) {
    logger.error('Error saving messages in bulk:', err);
    throw err;
  }
}

/**
 * Records a message in the database.
 *
 * @async
 * @function recordMessage
 * @param {Object} params - The message data object.
 * @param {string} params.user - The identifier of the user.
 * @param {string} params.endpoint - The endpoint where the message originated.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.conversationId - The identifier of the conversation.
 * @param {string} [params.parentMessageId] - The identifier of the parent message, if any.
 * @param {Partial<TMessage>} rest - Any additional properties from the TMessage typedef not explicitly listed.
 * @returns {Promise<Object>} The updated or newly inserted message document.
 * @throws {Error} If there is an error in saving the message.
 */
async function recordMessage({
  user,
  endpoint,
  messageId,
  conversationId,
  parentMessageId,
  ...rest
}) {
  try {
    // No parsing of convoId as may use threadId
    const message = {
      user,
      endpoint,
      messageId,
      conversationId,
      parentMessageId,
      ...rest,
    };

    const savedMessage = await Message.findOneAndUpdate({ user, messageId }, message, {
      upsert: true,
      new: true,
    });

    /* === VIVENTIUM START ===
     * Feature: Conversation Recall RAG proactive sync on direct recordMessage writes
     * Purpose: Keep recall freshness aligned across all message persistence surfaces, not only
     * saveMessage/updateMessage.
     * Added: 2026-04-21
     * === VIVENTIUM END === */
    if (savedMessage?.conversationId) {
      scheduleConversationRecallSync({
        userId: user,
        conversationId: savedMessage.conversationId,
      });
    }

    return savedMessage;
  } catch (err) {
    logger.error('Error recording message:', err);
    throw err;
  }
}

/**
 * Updates the text of a message.
 *
 * @async
 * @function updateMessageText
 * @param {Object} params - The update data object.
 * @param {Object} req - The request object.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.text - The new text content of the message.
 * @returns {Promise<void>}
 * @throws {Error} If there is an error in updating the message text.
 */
async function updateMessageText(req, { messageId, text }) {
  try {
    const result = await Message.findOneAndUpdate(
      { messageId, user: req.user.id },
      { text },
      { new: true },
    );

    if (result?.conversationId) {
      scheduleConversationRecallSync({
        userId: req.user.id,
        conversationId: result.conversationId,
      });
    }
  } catch (err) {
    logger.error('Error updating message text:', err);
    throw err;
  }
}

/**
 * Updates a message.
 *
 * @async
 * @function updateMessage
 * @param {Object} req - The request object.
 * @param {Object} message - The message object containing update data.
 * @param {string} message.messageId - The unique identifier for the message.
 * @param {string} [message.text] - The new text content of the message.
 * @param {Object[]} [message.files] - The files associated with the message.
 * @param {boolean} [message.isCreatedByUser] - Indicates if the message was created by the user.
 * @param {string} [message.sender] - The identifier of the sender.
 * @param {number} [message.tokenCount] - The number of tokens in the message.
 * @param {Object} [metadata] - The operation metadata
 * @param {string} [metadata.context] - The operation metadata
 * @returns {Promise<TMessage>} The updated message document.
 * @throws {Error} If there is an error in updating the message or if the message is not found.
 */
async function updateMessage(req, message, metadata) {
  try {
    const { messageId, ...update } = message;
    const options = {
      new: true,
    };
    if (metadata?.overrideTimestamp === true) {
      options.timestamps = false;
      options.overwriteImmutable = true;
    }
    const updatedMessage = await Message.findOneAndUpdate(
      { messageId, user: req.user.id },
      update,
      options,
    );

    if (!updatedMessage) {
      throw new Error('Message not found or user not authorized.');
    }

    /* === VIVENTIUM START ===
     * Feature: Conversation Recall RAG proactive sync on message update
     * Added: 2026-02-19
     */
    scheduleConversationRecallSync({
      userId: req.user.id,
      conversationId: updatedMessage.conversationId,
    });
    /* === VIVENTIUM END === */

    return {
      messageId: updatedMessage.messageId,
      conversationId: updatedMessage.conversationId,
      parentMessageId: updatedMessage.parentMessageId,
      sender: updatedMessage.sender,
      text: updatedMessage.text,
      isCreatedByUser: updatedMessage.isCreatedByUser,
      tokenCount: updatedMessage.tokenCount,
      feedback: updatedMessage.feedback,
    };
  } catch (err) {
    logger.error('Error updating message:', err);
    if (metadata && metadata?.context) {
      logger.info(`---\`updateMessage\` context: ${metadata.context}`);
    }
    throw err;
  }
}

/**
 * Deletes messages in a conversation since a specific message.
 *
 * @async
 * @function deleteMessagesSince
 * @param {Object} params - The parameters object.
 * @param {Object} req - The request object.
 * @param {string} params.messageId - The unique identifier for the message.
 * @param {string} params.conversationId - The identifier of the conversation.
 * @returns {Promise<Number>} The number of deleted messages.
 * @throws {Error} If there is an error in deleting messages.
 */
async function deleteMessagesSince(req, { messageId, conversationId }) {
  try {
    const message = await Message.findOne({ messageId, user: req.user.id }).lean();

    if (message) {
      const query = Message.find({ conversationId, user: req.user.id });
      const result = await query.deleteMany({
        createdAt: { $gt: message.createdAt },
      });
      /* === VIVENTIUM START ===
       * Feature: Conversation Recall RAG proactive sync on branch delete
       * Added: 2026-02-19
       */
      scheduleConversationRecallSync({
        userId: req.user.id,
        conversationId,
      });
      /* === VIVENTIUM END === */
      return result;
    }
    return undefined;
  } catch (err) {
    logger.error('Error deleting messages:', err);
    throw err;
  }
}

/**
 * Retrieves messages from the database.
 * @async
 * @function getMessages
 * @param {Record<string, unknown>} filter - The filter criteria.
 * @param {string | undefined} [select] - The fields to select.
 * @returns {Promise<TMessage[]>} The messages that match the filter criteria.
 * @throws {Error} If there is an error in retrieving messages.
 */
async function getMessages(filter, select) {
  try {
    if (select) {
      return await Message.find(filter).select(select).sort({ createdAt: 1 }).lean();
    }

    return await Message.find(filter).sort({ createdAt: 1 }).lean();
  } catch (err) {
    logger.error('Error getting messages:', err);
    throw err;
  }
}

/* === VIVENTIUM START ===
 * Feature: Recall freshness timestamp helper.
 * Purpose: Let runtime attachment logic compare a recall corpus timestamp against the newest
 * recall-eligible message instead of blindly trusting stale vector state.
 * Added: 2026-04-08
 * === VIVENTIUM END === */
async function getLatestRecallEligibleMessageCreatedAt({ user, scanLimit = 200 }) {
  try {
    if (!user) {
      return null;
    }

    const messages = await Message.find({
      user,
      unfinished: { $ne: true },
      error: { $ne: true },
      $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
    })
      .select(
        'messageId parentMessageId conversationId createdAt text content attachments isCreatedByUser metadata',
      )
      .sort({ createdAt: -1 })
      .limit(Math.max(1, scanLimit))
      .lean();

    const recallDerivedParentIds = buildRecallDerivedParentIdSet(messages);

    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const messageText = getConversationRecallMessageText(message);
      if (
        shouldSkipFromRecallCorpus({
          message,
          messageText,
          isCreatedByUser: message?.isCreatedByUser,
          hasRecallDerivedChild: recallDerivedParentIds.has(message?.messageId),
        })
      ) {
        continue;
      }
      return message?.createdAt ?? null;
    }

    return null;
  } catch (err) {
    logger.error('Error getting latest recall-eligible message timestamp:', err);
    throw err;
  }
}

/**
 * Retrieves a single message from the database.
 * @async
 * @function getMessage
 * @param {{ user: string, messageId: string }} params - The search parameters
 * @returns {Promise<TMessage | null>} The message that matches the criteria or null if not found
 * @throws {Error} If there is an error in retrieving the message
 */
async function getMessage({ user, messageId }) {
  try {
    return await Message.findOne({
      user,
      messageId,
    }).lean();
  } catch (err) {
    logger.error('Error getting message:', err);
    throw err;
  }
}

/**
 * Deletes messages from the database.
 *
 * @async
 * @function deleteMessages
 * @param {import('mongoose').FilterQuery<import('mongoose').Document>} filter - The filter criteria to find messages to delete.
 * @returns {Promise<import('mongoose').DeleteResult>} The metadata with count of deleted messages.
 * @throws {Error} If there is an error in deleting messages.
 */
async function deleteMessages(filter) {
  try {
    return await Message.deleteMany(filter);
  } catch (err) {
    logger.error('Error deleting messages:', err);
    throw err;
  }
}

module.exports = {
  saveMessage,
  bulkSaveMessages,
  recordMessage,
  updateMessageText,
  updateMessage,
  deleteMessagesSince,
  getMessages,
  getLatestRecallEligibleMessageCreatedAt,
  getMessage,
  deleteMessages,
  __testables: {
    mergeExistingTextIntoCortexOnlyUpdate,
    shouldPreserveExistingAssistantText,
    isPlaceholderAssistantText,
    visibleMessageText,
  },
};
