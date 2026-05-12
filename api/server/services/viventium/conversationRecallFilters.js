'use strict';

const {
  isListenOnlyTranscriptMessage,
} = require('~/server/services/viventium/listenOnlyTranscript');

/* === VIVENTIUM START ===
 * Feature: Shared conversation-recall filtering rules.
 *
 * Purpose:
 * - Keep corpus-build, freshness, and degraded-runtime filtering aligned.
 * - Prevent meta recall chatter and assistant recall-echo answers from being treated as source history.
 *
 * Added: 2026-04-09
 * === VIVENTIUM END === */

const INTERNAL_CONTROL_TEXT_REGEX =
  /<!--\s*viv_internal:|<memory_search>|<\/memory_search>|<query>|<\/query>|##\s*background processing\s*\(brewing\)|scheduled self-prompt|wake\.\s*check date,\s*time,\s*timezone|conversation_policy|output:\s*\{nta\}|^#\s*current chat:/i;
const NTA_ONLY_REGEX = /^\{NTA\}\.?$/i;
const ASSISTANT_LOW_SIGNAL_REGEX =
  /^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|sure|sounds good|what's up)\b[!.?]*$/i;
const ASSISTANT_MEMORY_DISCLAIMER_REGEX =
  /(?:\b(?:i\s+(?:don't|do not|can't|cannot)\s+(?:have|see|find|access|recall|remember)|i\s+have\s+no\s+(?:specific\s+)?(?:memory|memories|record|records|information|mentions?)|no\s+memories?\s+found)\b[\s\S]{0,180}\b(?:memory|memories|conversation|chat history|past chats|history|name|details?|mention|criteria)\b|\bi\s+don't\s+think\s+you(?:'ve| have)\s+told\s+me\s+that\s+yet\b|\bi\s+don't\s+know\s+(?:your|the)\s+name\b)/i;
const ASSISTANT_RETRIEVAL_SUMMARY_REGEX =
  /(?:\bbased on (?:my|our) (?:search|scan|review)\b|\b(?:from|in) (?:our|your) (?:conversation|chat) history\b|\bin (?:our|your) previous (?:conversation|chats)\b|\bi (?:remember|recall) (?:you|that|when)\b|\bi (?:have|can see) (?:a )?(?:record|records)\b)/i;
const CONVERSATION_RECALL_FILE_ID_PREFIX = 'conversation_recall:';

function cleanupText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.split('\0').join(' ').replace(/\s+/g, ' ').trim();
}

function isConversationRecallFileId(fileId) {
  return typeof fileId === 'string' && fileId.startsWith(CONVERSATION_RECALL_FILE_ID_PREFIX);
}

function getFileSearchSources(message) {
  if (!message || !Array.isArray(message.attachments)) {
    return [];
  }

  return message.attachments.flatMap((attachment) => {
    if (attachment?.type !== 'file_search') {
      return [];
    }
    return Array.isArray(attachment?.file_search?.sources) ? attachment.file_search.sources : [];
  });
}

function messageUsesConversationRecallSearch(message) {
  return getFileSearchSources(message).some((source) => isConversationRecallFileId(source?.fileId));
}

function buildRecallDerivedParentIdSet(messages = []) {
  const parentIds = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!messageUsesConversationRecallSearch(message)) {
      continue;
    }
    const parentMessageId =
      typeof message?.parentMessageId === 'string' ? message.parentMessageId.trim() : '';
    if (!parentMessageId) {
      continue;
    }
    parentIds.add(parentMessageId);
  }
  return parentIds;
}

function isAssistantLowSignalText(messageText) {
  return ASSISTANT_LOW_SIGNAL_REGEX.test(cleanupText(messageText));
}

function isAssistantMemoryDisclaimer(messageText) {
  return ASSISTANT_MEMORY_DISCLAIMER_REGEX.test(cleanupText(messageText));
}

function isAssistantRetrievalSummary(messageText) {
  return ASSISTANT_RETRIEVAL_SUMMARY_REGEX.test(cleanupText(messageText));
}

function shouldSkipRecallMessage({
  message,
  messageText,
  isCreatedByUser,
  hasRecallDerivedChild = false,
}) {
  const cleaned = cleanupText(messageText);
  if (!cleaned) {
    return true;
  }
  if (INTERNAL_CONTROL_TEXT_REGEX.test(cleaned)) {
    return true;
  }
  if (NTA_ONLY_REGEX.test(cleaned)) {
    return true;
  }
  if (isListenOnlyTranscriptMessage(message)) {
    return true;
  }
  if (messageUsesConversationRecallSearch(message)) {
    return true;
  }
  if (isCreatedByUser === true && hasRecallDerivedChild) {
    return true;
  }
  if (isCreatedByUser === false && isAssistantMemoryDisclaimer(cleaned)) {
    return true;
  }
  if (!isCreatedByUser && isAssistantLowSignalText(cleaned)) {
    return true;
  }
  return false;
}

module.exports = {
  buildRecallDerivedParentIdSet,
  cleanupText,
  getFileSearchSources,
  isListenOnlyTranscriptMessage,
  isAssistantLowSignalText,
  isAssistantMemoryDisclaimer,
  isConversationRecallFileId,
  messageUsesConversationRecallSearch,
  shouldSkipRecallMessage,
};
