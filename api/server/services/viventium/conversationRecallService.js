/* === VIVENTIUM START ===
 * Feature: Conversation Recall RAG (proactive indexing + upkeep)
 *
 * Purpose:
 * - Maintain deterministic vector resources for:
 *   1) all user conversations, and
 *   2) optional agent-scoped conversation history.
 * - Reuse existing `file_search` retrieval path by materializing corpora as embedded files.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

'use strict';

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs').promises;
const { logger } = require('@librechat/data-schemas');
const {
  FileContext,
  FileSources,
  parseTextParts,
  ConversationRecallScope,
  buildConversationRecallFileId,
  buildConversationRecallFilename,
  parseConversationRecallAgentIdFromFilename,
} = require('librechat-data-provider');
const { uploadVectors, deleteVectors } = require('~/server/services/Files/VectorDB/crud');
const { Agent, Conversation, File, Message, User } = require('~/db/models');
const {
  buildRecallDerivedParentIdSet,
  cleanupText,
  messageUsesConversationRecallSearch,
  shouldSkipRecallMessage,
} = require('./conversationRecallFilters');

const timers = new Map();
const pendingConversationSyncByUser = new Map();
const inFlightConversationSyncUsers = new Set();
const conversationSyncFailureCountByUser = new Map();
const conversationSyncCooldownUntilByUser = new Map();
const lastSuccessfulConversationSyncAtByUser = new Map();
const lastUploadedCorpusDigestByFileId = new Map();

const normalizeBooleanEnv = (value, defaultValue = false) => {
  if (value == null) {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

const DEBOUNCE_MS = Number.parseInt(
  process.env.VIVENTIUM_CONVERSATION_RECALL_DEBOUNCE_MS || '15000',
  10,
);
const MAX_MESSAGES = Number.parseInt(
  process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGES || '1200',
  10,
);
const RAW_FETCH_MULTIPLIER = Math.max(
  1,
  Number.parseFloat(process.env.VIVENTIUM_CONVERSATION_RECALL_FETCH_MULTIPLIER || '4'),
);
const RAW_FETCH_MAX_MESSAGES = Math.max(
  Math.max(1, MAX_MESSAGES),
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_SCAN_MESSAGES || '8000', 10),
);
const MAX_CHARS = Number.parseInt(
  process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_CHARS || '350000',
  10,
);
const MAX_MESSAGE_TEXT_CHARS = Math.max(
  120,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_MESSAGE_TEXT_CHARS || '2400', 10),
);
const MAX_AGENT_CONVERSATIONS = Math.max(
  50,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_AGENT_CONVERSATIONS || '1500', 10),
);
const INCLUDE_ASSISTANT_MESSAGES = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_INCLUDE_ASSISTANT,
  true,
);
const CORPUS_DEBUG = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_CORPUS_DEBUG,
  false,
);
const CORPUS_TEXT_ONLY = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_TEXT_ONLY,
  true,
);
const parsedPruneMultiplier = Number.parseFloat(
  process.env.VIVENTIUM_CONVERSATION_RECALL_CORPUS_PRUNE_MULTIPLIER || '1.5',
);
const CORPUS_PRUNE_MULTIPLIER = Math.max(
  1.1,
  Number.isFinite(parsedPruneMultiplier) ? parsedPruneMultiplier : 1.5,
);
const UPLOAD_MAX_ATTEMPTS = Math.max(
  1,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_ATTEMPTS || '4', 10),
);
const UPLOAD_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MS || '60000', 10),
);
const UPLOAD_TIMEOUT_PER_100K_CHARS_MS = Math.max(
  0,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_PER_100K_CHARS_MS || '20000',
    10,
  ),
);
const UPLOAD_TIMEOUT_MAX_MS = Math.max(
  UPLOAD_TIMEOUT_MS,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_TIMEOUT_MAX_MS || '180000',
    10,
  ),
);
const UPLOAD_RETRY_BASE_MS = Math.max(
  0,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_RETRY_BASE_MS || '750', 10),
);
const UPLOAD_MAX_CORPUS_REDUCTIONS = Math.max(
  0,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_MAX_CORPUS_REDUCTIONS || '3',
    10,
  ),
);
const UPLOAD_REDUCTION_FACTOR = Math.min(
  0.95,
  Math.max(
    0.2,
    Number.parseFloat(process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_REDUCTION_FACTOR || '0.65'),
  ),
);
const MIN_CORPUS_CHARS = Math.max(
  5000,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_CHARS || '30000', 10),
);
const UPLOAD_SEED_CHARS = Math.max(
  5000,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_UPLOAD_SEED_CHARS || '45000', 10),
);
const MAX_PENDING_CONVERSATION_SYNCS = Math.max(
  1,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_PENDING_SYNCS || '8', 10),
);
const FAILURE_COOLDOWN_BASE_MS = Math.max(
  1000,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_FAILURE_COOLDOWN_BASE_MS || '30000', 10),
);
const FAILURE_COOLDOWN_MAX_MS = Math.max(
  FAILURE_COOLDOWN_BASE_MS,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_FAILURE_COOLDOWN_MAX_MS || '300000', 10),
);
const MAX_TRANSIENT_SYNC_FAILURES = Math.max(
  1,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MAX_TRANSIENT_FAILURES || '4', 10),
);
const MIN_SYNC_INTERVAL_MS = Math.max(
  0,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_MIN_SYNC_INTERVAL_MS || '45000', 10),
);
function isConversationRecallInfraEnabled() {
  if (!process.env.RAG_API_URL) {
    return false;
  }
  return normalizeBooleanEnv(process.env.VIVENTIUM_CONVERSATION_RECALL_ENABLED, true);
}

function scheduleTask(key, fn, debounceMs = DEBOUNCE_MS) {
  const existing = timers.get(key);
  if (existing) {
    clearTimeout(existing);
  }

  const timer = setTimeout(
    async () => {
      timers.delete(key);
      try {
        await fn();
      } catch (error) {
        logger.error(`[conversationRecall] Scheduled task failed (${key})`, error);
      }
    },
    Math.max(0, debounceMs),
  );

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  timers.set(key, timer);
}

function getSyncKey(userId) {
  return `conversation:${userId}`;
}

function clearSyncFailureState(userId) {
  conversationSyncFailureCountByUser.delete(userId);
  conversationSyncCooldownUntilByUser.delete(userId);
}

function getSyncCooldownMs(userId) {
  const cooldownUntil = conversationSyncCooldownUntilByUser.get(userId);
  if (!cooldownUntil) {
    return 0;
  }
  return Math.max(0, cooldownUntil - Date.now());
}

function getMinSyncDelayMs(userId) {
  if (MIN_SYNC_INTERVAL_MS <= 0) {
    return 0;
  }
  const lastSuccessAt = lastSuccessfulConversationSyncAtByUser.get(userId);
  if (!lastSuccessAt) {
    return 0;
  }
  return Math.max(0, lastSuccessAt + MIN_SYNC_INTERVAL_MS - Date.now());
}

function markTransientSyncFailure(userId, error) {
  const failureCount = (conversationSyncFailureCountByUser.get(userId) ?? 0) + 1;
  conversationSyncFailureCountByUser.set(userId, failureCount);

  const delayMs = Math.min(
    FAILURE_COOLDOWN_MAX_MS,
    FAILURE_COOLDOWN_BASE_MS * Math.pow(2, failureCount - 1),
  );
  conversationSyncCooldownUntilByUser.set(userId, Date.now() + delayMs);

  logger.warn('[conversationRecall] Sync failed; entering cooldown', {
    userId,
    failureCount,
    delayMs,
    status: extractUploadStatus(error) || undefined,
  });

  return delayMs;
}

function enqueueConversationSync({ userId, conversationId }) {
  const pending = pendingConversationSyncByUser.get(userId) ?? new Set();
  pending.delete(conversationId);
  pending.add(conversationId);

  while (pending.size > MAX_PENDING_CONVERSATION_SYNCS) {
    const oldest = pending.values().next().value;
    if (!oldest) {
      break;
    }
    pending.delete(oldest);
  }

  pendingConversationSyncByUser.set(userId, pending);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

function extractUploadStatus(error) {
  const directStatus = Number(error?.response?.status || error?.status || 0);
  if (Number.isFinite(directStatus) && directStatus > 0) {
    return directStatus;
  }

  const message = typeof error?.message === 'string' ? error.message : '';
  const statusMatch = message.match(/\bstatus code (\d{3})\b/i);
  if (statusMatch?.[1]) {
    return Number(statusMatch[1]);
  }
  return 0;
}

function isTransientUploadError(error) {
  const status = extractUploadStatus(error);
  if ([429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const code = String(error?.code || '').toUpperCase();
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED', 'EAI_AGAIN'].includes(code);
}

function shouldReduceCorpusOnUploadFailure(error) {
  const status = extractUploadStatus(error);
  if ([413, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = String(error?.code || '').toUpperCase();
  if (code === 'ECONNABORTED') {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('payload too large') ||
    message.includes('request entity too large') ||
    message.includes('timeout')
  );
}

function stringifyErrorData(data) {
  if (!data) {
    return '';
  }
  if (typeof data === 'string') {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return '';
  }
}

function isDuplicateVectorWriteError(error) {
  const combined = [
    typeof error?.message === 'string' ? error.message : '',
    stringifyErrorData(error?.response?.data),
  ]
    .join(' ')
    .toLowerCase();

  return (
    combined.includes('duplicate key') ||
    combined.includes('e11000') ||
    combined.includes('dup key')
  );
}

function trimCorpusToChars(corpus, maxChars) {
  if (typeof corpus !== 'string' || !corpus.length) {
    return '';
  }
  const limit = Math.max(1, maxChars);
  if (corpus.length <= limit) {
    return corpus;
  }
  return corpus.slice(corpus.length - limit);
}

async function uploadVectorsWithRetry({ userId, file_id, file, timeoutMs }) {
  let attempt = 0;
  while (attempt < UPLOAD_MAX_ATTEMPTS) {
    attempt += 1;
    try {
      await uploadVectors({
        req: { user: { id: userId } },
        file,
        file_id,
        timeoutMs,
      });
      return;
    } catch (error) {
      const transient = isTransientUploadError(error);
      const status = extractUploadStatus(error) || undefined;
      if (!transient || attempt >= UPLOAD_MAX_ATTEMPTS) {
        throw error;
      }

      const delayMs = UPLOAD_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `[conversationRecall] uploadVectors transient failure; retrying (attempt ${attempt}/${UPLOAD_MAX_ATTEMPTS})`,
        {
          file_id,
          status,
          delayMs,
        },
      );
      await sleep(delayMs);
    }
  }
}

function computeAdaptiveUploadTimeoutMs(charCount) {
  if (!Number.isFinite(charCount) || charCount <= 0) {
    return UPLOAD_TIMEOUT_MS;
  }

  const chunksOf100k = Math.ceil(charCount / 100000);
  const adaptiveTimeout =
    UPLOAD_TIMEOUT_MS + chunksOf100k * UPLOAD_TIMEOUT_PER_100K_CHARS_MS;

  return Math.min(UPLOAD_TIMEOUT_MAX_MS, adaptiveTimeout);
}

function escapeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttr(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderConversationRecallCorpus({ segments, scope, latestTimestamp }) {
  const semanticLines = [
    '<semantic_context>',
    '<summary>User-owned episodic chat turns for conversation recall retrieval.</summary>',
    `<scope>${escapeXmlText(scope)}</scope>`,
    `<turn_count>${segments.length}</turn_count>`,
    latestTimestamp ? `<latest_timestamp>${escapeXmlText(latestTimestamp)}</latest_timestamp>` : '',
    '</semantic_context>',
  ]
    .filter(Boolean)
    .join('\n');

  return `${semanticLines}\n<episodic_context>\n${segments.join('\n\n')}\n</episodic_context>`;
}

function computeCorpusDigest(corpus) {
  return crypto.createHash('sha256').update(String(corpus || ''), 'utf8').digest('hex');
}

function getMessageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  const text = cleanupText(message.text);
  if (text) {
    return text;
  }

  if (!Array.isArray(message.content)) {
    return '';
  }

  const contentParts = message.content.filter(
    (part) => part && typeof part === 'object' && part.type !== 'think',
  );
  if (!contentParts.length) {
    return '';
  }

  return cleanupText(parseTextParts(contentParts, true));
}

function clipMessageText(text) {
  if (typeof text !== 'string' || !text.length) {
    return '';
  }
  if (text.length <= MAX_MESSAGE_TEXT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_MESSAGE_TEXT_CHARS - 3)}...`;
}

function shouldSkipFromRecallCorpus({
  message,
  messageText,
  isCreatedByUser,
  hasRecallDerivedChild,
}) {
  return shouldSkipRecallMessage({
    message,
    messageText,
    isCreatedByUser,
    hasRecallDerivedChild,
  });
}

/* === VIVENTIUM START ===
 * Feature: Skip assistant recall-echo replies from corpus freshness/content.
 * Purpose: Assistant answers to meta recall prompts are derivative retrieval chatter, not source history.
 * === VIVENTIUM END === */
async function hasRecallDerivedChildMessage({ userId, messageId }) {
  if (!userId || !messageId) {
    return false;
  }

  const childMessages = await Message.find({
    user: userId,
    parentMessageId: messageId,
    isCreatedByUser: false,
    unfinished: { $ne: true },
    error: { $ne: true },
    $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
  })
    .select('attachments parentMessageId')
    .sort({ createdAt: 1 })
    .limit(4)
    .lean();

  return childMessages.some((message) => messageUsesConversationRecallSearch(message));
}

async function getAgentIdForConversation(userId, conversationId) {
  if (!conversationId) {
    return null;
  }

  const conversation = await Conversation.findOne({
    user: userId,
    conversationId,
  })
    .select('agent_id')
    .lean();

  return conversation?.agent_id ?? null;
}

async function getRecallPolicy({ userId, conversationId, agentId: _agentId }) {
  const user = await User.findById(userId).select('personalization').lean();
  const globalEnabled = user?.personalization?.conversation_recall === true;

  const agentId = _agentId ?? (await getAgentIdForConversation(userId, conversationId));
  let agentOnlyEnabled = false;
  if (agentId) {
    const agent = await Agent.findOne({ id: agentId })
      .select('conversation_recall_agent_only')
      .lean();
    agentOnlyEnabled = agent?.conversation_recall_agent_only === true;
  }

  return { globalEnabled, agentOnlyEnabled, agentId };
}

async function buildConversationRecallCorpus({ userId, agentId }) {
  let conversationIdsFilter;

  if (agentId) {
    const conversations = await Conversation.find({
      user: userId,
      agent_id: agentId,
    })
      .select('conversationId')
      .limit(MAX_AGENT_CONVERSATIONS)
      .lean();

    const conversationIds = conversations
      .map((conversation) => conversation?.conversationId)
      .filter(Boolean);

    if (!conversationIds.length) {
      return '';
    }

    conversationIdsFilter = { $in: conversationIds };
  }

  const filter = {
    user: userId,
    ...(conversationIdsFilter != null ? { conversationId: conversationIdsFilter } : {}),
    ...(INCLUDE_ASSISTANT_MESSAGES ? {} : { isCreatedByUser: true }),
    unfinished: { $ne: true },
    error: { $ne: true },
    $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
  };

  const selectFields = CORPUS_TEXT_ONLY
    ? 'messageId parentMessageId conversationId createdAt sender isCreatedByUser text attachments'
    : 'messageId parentMessageId conversationId createdAt sender isCreatedByUser text content attachments';

  const rawMessageLimit = Math.max(
    Math.max(1, MAX_MESSAGES),
    Math.min(RAW_FETCH_MAX_MESSAGES, Math.ceil(Math.max(1, MAX_MESSAGES) * RAW_FETCH_MULTIPLIER)),
  );

  const rawMessages = await Message.find(filter)
    .select(selectFields)
    .sort({ createdAt: -1 })
    .limit(rawMessageLimit)
    .lean();

  if (!rawMessages.length) {
    return '';
  }

  rawMessages.reverse();

  const recallDerivedParentIds = buildRecallDerivedParentIdSet(rawMessages);
  const segments = [];
  let totalChars = 0;
  let latestTimestamp = '';
  for (let i = 0; i < rawMessages.length; i += 1) {
    const message = rawMessages[i];
    const content = clipMessageText(getMessageText(message));
    if (
      shouldSkipFromRecallCorpus({
        message,
        messageText: content,
        isCreatedByUser: message.isCreatedByUser,
        hasRecallDerivedChild: recallDerivedParentIds.has(message?.messageId),
      })
    ) {
      continue;
    }

    const role = message.isCreatedByUser ? 'user' : message.sender || 'assistant';
    const timestamp = message.createdAt
      ? new Date(message.createdAt).toISOString()
      : new Date().toISOString();
    const convoId = message.conversationId || 'unknown';

    latestTimestamp = timestamp;
    const segment =
      `<turn timestamp="${escapeXmlAttr(timestamp)}" conversation="${escapeXmlAttr(
        convoId,
      )}" role="${escapeXmlAttr(role)}">\n` +
      `${escapeXmlText(content)}\n` +
      '</turn>';
    segments.push(segment);
    totalChars += segment.length + 7;

    while (segments.length > 1 && totalChars > MAX_CHARS * CORPUS_PRUNE_MULTIPLIER) {
      const dropped = segments.shift();
      totalChars -= (dropped?.length || 0) + 7;
    }
  }

  if (!segments.length) {
    return '';
  }

  const scope = agentId ? 'agent' : 'all';
  let corpus = renderConversationRecallCorpus({ segments, scope, latestTimestamp });

  while (segments.length > 1 && corpus.length > MAX_CHARS) {
    const dropped = segments.shift();
    totalChars -= (dropped?.length || 0) + 7;
    corpus = renderConversationRecallCorpus({ segments, scope, latestTimestamp });
  }

  if (corpus.length > MAX_CHARS) {
    corpus = trimCorpusToChars(corpus, MAX_CHARS);
  }

  if (CORPUS_DEBUG) {
    logger.info('[conversationRecall] Built corpus window', {
      userId,
      agentId: agentId || null,
      includeAssistant: INCLUDE_ASSISTANT_MESSAGES,
      rawFetchedMessages: rawMessages.length,
      segments: segments.length,
      chars: corpus.length,
      textOnly: CORPUS_TEXT_ONLY,
    });
  }

  return corpus;
}

async function deleteRecallFile({ userId, scope, agentId }) {
  const file_id = buildConversationRecallFileId({
    userId,
    scope,
    agentId,
  });

  const existing = await File.findOne({ user: userId, file_id }).lean();
  if (!existing) {
    return;
  }

  try {
    await deleteVectors({ user: { id: userId } }, existing);
  } catch (error) {
    logger.warn(`[conversationRecall] Failed to delete vectors for ${file_id}`, error);
  }

  await File.deleteOne({ _id: existing._id });
  lastUploadedCorpusDigestByFileId.delete(file_id);
}

async function upsertRecallFile({ userId, scope, agentId, corpus }) {
  if (!corpus) {
    await deleteRecallFile({ userId, scope, agentId });
    return;
  }

  const file_id = buildConversationRecallFileId({
    userId,
    scope,
    agentId,
  });
  const filename = buildConversationRecallFilename({
    scope,
    agentId,
  });
  const sourceDigest = computeCorpusDigest(corpus);

  const existing = await File.findOne({ user: userId, file_id })
    .select('metadata embedded file_id')
    .lean();
  const existingSourceDigest =
    existing?.metadata?.conversationRecallSourceDigest || existing?.metadata?.conversationRecallDigest;
  const existingUploadedDigest = existing?.metadata?.conversationRecallUploadedDigest;
  const lastKnownDigest = lastUploadedCorpusDigestByFileId.get(file_id);

  if (existing && (existingUploadedDigest === sourceDigest || lastKnownDigest === sourceDigest)) {
    lastUploadedCorpusDigestByFileId.set(file_id, sourceDigest);
    logger.debug('[conversationRecall] Skipping unchanged corpus upload', {
      file_id,
      chars: corpus.length,
    });
    return;
  }

  if (existing && existingSourceDigest === sourceDigest && existingUploadedDigest !== sourceDigest) {
    logger.info('[conversationRecall] Rebuilding corpus because prior upload used a reduced window', {
      file_id,
      sourceChars: corpus.length,
      uploadedChars: existing?.metadata?.conversationRecallCharCount ?? null,
    });
  }

  /* === VIVENTIUM START ===
   * Integrity: replace prior vectors before uploading a changed recall corpus.
   *
   * Reason:
   * - The RAG upload path appends new embeddings for the same logical `file_id`.
   * - Without a pre-upload delete, repeated recall refreshes retain stale cohorts and
   *   distort retrieval with duplicate / superseded snippets.
   * === VIVENTIUM END === */
  if (existing) {
    await deleteVectors(
      { user: { id: userId } },
      {
        file_id,
        embedded: existing.embedded !== false,
      },
    );
  }

  let uploadCorpus = corpus;
  const initialCorpus = corpus;
  let reductions = 0;
  let bytes = Buffer.byteLength(uploadCorpus, 'utf8');
  let usedSeedFallback = false;
  let uploadAttempts = 0;
  const uploadStartedAt = Date.now();
  let duplicateRecoveryAttempted = false;

  while (true) {
    uploadAttempts += 1;
    const tempPath = path.join(
      os.tmpdir(),
      `viventium-conversation-recall-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );

    await fs.writeFile(tempPath, uploadCorpus, 'utf8');
    try {
      await uploadVectorsWithRetry({
        userId,
        file_id,
        file: {
          path: tempPath,
          size: bytes,
          originalname: filename,
          mimetype: 'text/plain',
        },
        timeoutMs: computeAdaptiveUploadTimeoutMs(uploadCorpus.length),
      });
      logger.info('[conversationRecall] Corpus upload completed', {
        file_id,
        chars: uploadCorpus.length,
        bytes,
        uploadAttempts,
        reductions,
        usedSeedFallback,
        durationMs: Date.now() - uploadStartedAt,
      });
      break;
    } catch (error) {
      if (!duplicateRecoveryAttempted && isDuplicateVectorWriteError(error)) {
        duplicateRecoveryAttempted = true;
        logger.warn(
          '[conversationRecall] Upload hit duplicate vector IDs; deleting prior vector docs and retrying',
          {
            file_id,
          },
        );

        try {
          await deleteVectors(
            { user: { id: userId } },
            {
              file_id,
              embedded: true,
            },
          );
        } catch (deleteError) {
          logger.warn('[conversationRecall] Failed duplicate-recovery delete before retry', {
            file_id,
            message: deleteError?.message,
          });
          throw error;
        }

        continue;
      }

      const reducibleFailure = shouldReduceCorpusOnUploadFailure(error);
      const canReduce =
        reductions < UPLOAD_MAX_CORPUS_REDUCTIONS &&
        uploadCorpus.length > MIN_CORPUS_CHARS &&
        reducibleFailure;

      if (!canReduce) {
        if (reducibleFailure && !usedSeedFallback) {
          const seedLimit = Math.min(UPLOAD_SEED_CHARS, initialCorpus.length);
          const seedCorpus = trimCorpusToChars(initialCorpus, seedLimit);

          if (seedCorpus && seedCorpus.length < uploadCorpus.length) {
            const status = extractUploadStatus(error) || undefined;
            logger.warn('[conversationRecall] Upload failed; retrying with emergency seed corpus', {
              file_id,
              status,
              previousChars: uploadCorpus.length,
              seedChars: seedCorpus.length,
            });

            uploadCorpus = seedCorpus;
            bytes = Buffer.byteLength(uploadCorpus, 'utf8');
            usedSeedFallback = true;
            continue;
          }
        }
        throw error;
      }

      const nextCharLimit = Math.max(
        MIN_CORPUS_CHARS,
        Math.floor(uploadCorpus.length * UPLOAD_REDUCTION_FACTOR),
      );

      if (nextCharLimit >= uploadCorpus.length) {
        throw error;
      }

      const status = extractUploadStatus(error) || undefined;
      logger.warn('[conversationRecall] Upload failed; retrying with reduced corpus window', {
        file_id,
        status,
        reductionAttempt: reductions + 1,
        previousChars: uploadCorpus.length,
        nextChars: nextCharLimit,
      });

      uploadCorpus = trimCorpusToChars(uploadCorpus, nextCharLimit);
      bytes = Buffer.byteLength(uploadCorpus, 'utf8');
      reductions += 1;
    } finally {
      try {
        await fs.unlink(tempPath);
      } catch {
        // Ignore temp file cleanup failures.
      }
    }
  }

  const uploadedDigest = computeCorpusDigest(uploadCorpus);
  const sourceTurnCount = (corpus.match(/<turn\s/g) || []).length;
  const uploadedTurnCount = (uploadCorpus.match(/<turn\s/g) || []).length;
  const usedReducedUploadWindow = uploadedDigest !== sourceDigest;
  const existingMetadata = existing?.metadata ?? {};
  const nextMetadata = {
    ...(existingMetadata.fileIdentifier ? { fileIdentifier: existingMetadata.fileIdentifier } : {}),
    conversationRecallSourceDigest: sourceDigest,
    conversationRecallUploadedDigest: uploadedDigest,
    conversationRecallDigest: sourceDigest,
    conversationRecallTurnCount: uploadedTurnCount,
    conversationRecallCharCount: uploadCorpus.length,
    conversationRecallSourceTurnCount: sourceTurnCount,
    conversationRecallSourceCharCount: corpus.length,
    conversationRecallUsedReducedUploadWindow: usedReducedUploadWindow,
  };

  await File.findOneAndUpdate(
    { user: userId, file_id },
    {
      $set: {
        user: userId,
        file_id,
        bytes,
        filename,
        filepath: FileSources.vectordb,
        object: 'file',
        embedded: true,
        type: 'text/plain',
        usage: 0,
        source: FileSources.vectordb,
        context: FileContext.conversation_recall,
        metadata: nextMetadata,
      },
      $unset: {
        expiresAt: '',
        temp_file_id: '',
        conversationId: '',
        messageId: '',
        text: '',
      },
    },
    { upsert: true, new: true },
  ).lean();

  if (usedReducedUploadWindow) {
    lastUploadedCorpusDigestByFileId.delete(file_id);
  } else {
    lastUploadedCorpusDigestByFileId.set(file_id, sourceDigest);
  }
}

async function getExistingAgentRecallFiles(userId) {
  const existing = await File.find({
    user: userId,
    context: FileContext.conversation_recall,
    filename: { $regex: /^conversation-recall-agent-/ },
  })
    .select('file_id filename embedded')
    .lean();

  return existing
    .map((file) => {
      const agentId = parseConversationRecallAgentIdFromFilename(file?.filename);
      if (!agentId) {
        return null;
      }
      return { agentId, file };
    })
    .filter(Boolean);
}

async function getEnabledAgentRecallIds(userId) {
  const conversations = await Conversation.find({
    user: userId,
    agent_id: { $exists: true, $ne: null },
  })
    .select('agent_id')
    .lean();

  const uniqueAgentIds = Array.from(
    new Set(
      conversations
        .map((conversation) => conversation?.agent_id)
        .filter((agentId) => typeof agentId === 'string' && agentId),
    ),
  );

  if (!uniqueAgentIds.length) {
    return [];
  }

  const enabledAgents = await Agent.find({
    id: { $in: uniqueAgentIds },
    conversation_recall_agent_only: true,
  })
    .select('id')
    .lean();

  return enabledAgents.map((agent) => agent.id).filter(Boolean);
}

async function refreshConversationRecallForUser({ userId, agentId }) {
  if (!isConversationRecallInfraEnabled()) {
    return;
  }

  const policy = await getRecallPolicy({ userId, agentId });

  if (policy.globalEnabled) {
    const corpus = await buildConversationRecallCorpus({ userId });
    await upsertRecallFile({
      userId,
      scope: ConversationRecallScope.all,
      corpus,
    });
  } else {
    await deleteRecallFile({
      userId,
      scope: ConversationRecallScope.all,
    });
  }

  if (agentId || policy.agentId) {
    const targetAgentId = agentId || policy.agentId;
    if (policy.agentOnlyEnabled && targetAgentId) {
      const corpus = await buildConversationRecallCorpus({ userId, agentId: targetAgentId });
      await upsertRecallFile({
        userId,
        scope: ConversationRecallScope.agent,
        agentId: targetAgentId,
        corpus,
      });
    } else if (targetAgentId) {
      await deleteRecallFile({
        userId,
        scope: ConversationRecallScope.agent,
        agentId: targetAgentId,
      });
    }
    return;
  }

  const enabledAgentIds = await getEnabledAgentRecallIds(userId);
  const enabledAgentSet = new Set(enabledAgentIds);

  for (const enabledAgentId of enabledAgentIds) {
    const corpus = await buildConversationRecallCorpus({ userId, agentId: enabledAgentId });
    await upsertRecallFile({
      userId,
      scope: ConversationRecallScope.agent,
      agentId: enabledAgentId,
      corpus,
    });
  }

  const existingAgentFiles = await getExistingAgentRecallFiles(userId);
  for (const entry of existingAgentFiles) {
    if (enabledAgentSet.has(entry.agentId)) {
      continue;
    }
    await deleteRecallFile({
      userId,
      scope: ConversationRecallScope.agent,
      agentId: entry.agentId,
    });
  }
}

async function syncConversationRecallForConversation({ userId, conversationId }) {
  if (!isConversationRecallInfraEnabled() || !conversationId) {
    return;
  }

  const policy = await getRecallPolicy({ userId, conversationId });

  if (policy.globalEnabled) {
    const corpus = await buildConversationRecallCorpus({ userId });
    await upsertRecallFile({
      userId,
      scope: ConversationRecallScope.all,
      corpus,
    });
  }

  if (policy.agentId) {
    if (policy.agentOnlyEnabled) {
      const corpus = await buildConversationRecallCorpus({ userId, agentId: policy.agentId });
      await upsertRecallFile({
        userId,
        scope: ConversationRecallScope.agent,
        agentId: policy.agentId,
        corpus,
      });
    } else {
      await deleteRecallFile({
        userId,
        scope: ConversationRecallScope.agent,
        agentId: policy.agentId,
      });
    }
  }
}

async function runQueuedConversationSync(userId) {
  if (!userId || !isConversationRecallInfraEnabled()) {
    return;
  }

  if (inFlightConversationSyncUsers.has(userId)) {
    return;
  }

  const pending = pendingConversationSyncByUser.get(userId);
  if (!pending || pending.size === 0) {
    return;
  }

  const cooldownMs = getSyncCooldownMs(userId);
  if (cooldownMs > 0) {
    scheduleTask(getSyncKey(userId), () => runQueuedConversationSync(userId), cooldownMs);
    return;
  }

  const minSyncDelayMs = getMinSyncDelayMs(userId);
  if (minSyncDelayMs > 0) {
    scheduleTask(getSyncKey(userId), () => runQueuedConversationSync(userId), minSyncDelayMs);
    return;
  }

  inFlightConversationSyncUsers.add(userId);
  const queuedConversationIds = Array.from(pending);
  pending.clear();

  try {
    await refreshConversationRecallForUser({ userId });
    lastSuccessfulConversationSyncAtByUser.set(userId, Date.now());
    clearSyncFailureState(userId);
  } catch (error) {
    const isTransient = isTransientUploadError(error);
    if (isTransient) {
      const latestConversationId = queuedConversationIds[queuedConversationIds.length - 1];
      if (latestConversationId) {
        pending.add(latestConversationId);
      }

      const cooldownDelayMs = markTransientSyncFailure(userId, error);
      const failureCount = conversationSyncFailureCountByUser.get(userId) ?? 0;
      if (failureCount >= MAX_TRANSIENT_SYNC_FAILURES) {
        pending.clear();
        logger.warn('[conversationRecall] Pausing proactive sync after repeated transient failures', {
          userId,
          failureCount,
          maxTransientFailures: MAX_TRANSIENT_SYNC_FAILURES,
        });
        return;
      }
      scheduleTask(
        getSyncKey(userId),
        () => runQueuedConversationSync(userId),
        Math.max(cooldownDelayMs, DEBOUNCE_MS),
      );
      return;
    }

    logger.error('[conversationRecall] Sync failed with non-transient error', {
      userId,
      status: extractUploadStatus(error) || undefined,
      message: error?.message,
    });
    clearSyncFailureState(userId);
  } finally {
    inFlightConversationSyncUsers.delete(userId);
  }

  if ((pendingConversationSyncByUser.get(userId)?.size ?? 0) > 0) {
    const followUpDelayMs = Math.max(DEBOUNCE_MS, getMinSyncDelayMs(userId));
    scheduleTask(getSyncKey(userId), () => runQueuedConversationSync(userId), followUpDelayMs);
  }
}

function scheduleConversationRecallSync({ userId, conversationId }) {
  if (!userId || !conversationId || !isConversationRecallInfraEnabled()) {
    return;
  }

  enqueueConversationSync({ userId, conversationId });
  scheduleTask(getSyncKey(userId), () => runQueuedConversationSync(userId));
}

function scheduleConversationRecallRefresh({ userId, agentId }) {
  if (!userId || !isConversationRecallInfraEnabled()) {
    return;
  }

  const key = agentId ? `refresh:${userId}:agent:${agentId}` : `refresh:${userId}:all`;
  scheduleTask(key, () => refreshConversationRecallForUser({ userId, agentId }), 500);
}

module.exports = {
  scheduleConversationRecallSync,
  scheduleConversationRecallRefresh,
  /* exported for testability */
  getMessageText,
  shouldSkipFromRecallCorpus,
  refreshConversationRecallForUser,
  syncConversationRecallForConversation,
};
