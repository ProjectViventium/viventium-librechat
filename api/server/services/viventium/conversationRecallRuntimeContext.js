/* === VIVENTIUM START ===
 * Feature: Conversation Recall runtime fallback context
 *
 * Purpose:
 * - Provide resilient conversation-history retrieval when vector indexing/tool-calls are unavailable.
 * - Keep retrieval scoped to the authenticated user (and optionally current agent scope).
 * - Inject concise, relevant snippets directly into run context so the model can answer recall questions.
 *
 * Added: 2026-02-19
 * === VIVENTIUM END === */

'use strict';

const { parseTextParts } = require('librechat-data-provider');
const { Conversation, Message, User } = require('~/db/models');

const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'all',
  'also',
  'and',
  'are',
  'been',
  'before',
  'both',
  'can',
  'could',
  'did',
  'does',
  'for',
  'from',
  'had',
  'have',
  'here',
  'into',
  'its',
  'just',
  'like',
  'more',
  'need',
  'once',
  'only',
  'our',
  'past',
  'please',
  'recall',
  'remember',
  'said',
  'same',
  'search',
  'share',
  'shared',
  'tell',
  'that',
  'the',
  'them',
  'then',
  'there',
  'they',
  'this',
  'those',
  'tool',
  'tools',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'would',
  'everything',
  'memory',
  'memories',
  'exact',
  'exactly',
  'matching',
  'criteria',
  'system',
  'your',
  'you',
]);
const GENERIC_QUERY_TERMS = new Set([
  'chat',
  'chats',
  'conversation',
  'conversations',
  'history',
  'prior',
  'previous',
  'result',
  'results',
  'mention',
  'mentioned',
  'store',
  'stored',
  'save',
  'saved',
]);
const SHORT_ENTITY_QUERY_GENERIC_TERMS = new Set([
  'any',
  'check',
  'context',
  'email',
  'emails',
  'latest',
  'look',
  'message',
  'messages',
  'new',
  'reply',
  'replies',
  'search',
  'status',
  'still',
  'text',
  'texts',
  'update',
  'updates',
  'yet',
]);

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

const RUNTIME_ENABLED = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_ENABLED,
  true,
);
const RUNTIME_MAX_MESSAGES = Math.max(
  100,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MESSAGES || '1200', 10),
);
const RUNTIME_FETCH_MULTIPLIER = Math.max(
  1,
  Number.parseFloat(process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_FETCH_MULTIPLIER || '4'),
);
const RUNTIME_MAX_SCAN_MESSAGES = Math.max(
  RUNTIME_MAX_MESSAGES,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_SCAN_MESSAGES || '8000',
    10,
  ),
);
const RUNTIME_MAX_MATCHES = Math.max(
  1,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MATCHES || '6', 10),
);
const RUNTIME_MAX_EXCERPT_CHARS = Math.max(
  120,
  Number.parseInt(process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_EXCERPT_CHARS || '320', 10),
);
const RUNTIME_MAX_CONTEXT_CHARS = Math.max(
  1000,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_CONTEXT_CHARS || '4200',
    10,
  ),
);
const RUNTIME_MAX_AGENT_CONVERSATIONS = Math.max(
  50,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_AGENT_CONVERSATIONS || '1500',
    10,
  ),
);
const RUNTIME_MIN_SCORE = Number.parseFloat(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MIN_SCORE || '0.9',
);
const RUNTIME_MAX_MESSAGE_CHARS = Math.max(
  120,
  Number.parseInt(
    process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_MAX_MESSAGE_CHARS || '2400',
    10,
  ),
);
const RUNTIME_INCLUDE_ASSISTANT = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_INCLUDE_ASSISTANT,
  true,
);
const RUNTIME_DEBUG = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_DEBUG,
  false,
);
const RUNTIME_EARLY_TERMINATION = normalizeBooleanEnv(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION,
  false,
);
const RUNTIME_EARLY_TERMINATION_MIN_SCORE = Number.parseFloat(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_EARLY_TERMINATION_MIN_SCORE || '2.5',
);

const RECALL_INTENT_REGEX =
  /\b(remember|recall|previous|earlier|before|last time|past conversation|chat history|you said|i said|shared)\b/i;
const PERSONAL_FACT_RECALL_REGEX =
  /\b(?:my|me|i|am i)\b[\s\S]{0,48}\b(?:name|legal|wife|husband|mom|mother|dad|father|birthday|move|moving|project|lab|blood|results?|shared|mentioned)\b/i;
const PAST_DISCUSSION_QUERY_REGEX =
  /\b(?:what|which|when|where|who)\b[\s\S]{0,48}\b(?:did|do)\b[\s\S]{0,24}\b(?:we|i)\b[\s\S]{0,56}\b(?:discuss|talk|look(?:ed)?|share(?:d)?|mention(?:ed)?|say|said)\b/i;
const LAB_KEYWORD_REGEX =
  /\b(lab|blood|bloodwork|panel|cholesterol|ldl|hdl|triglycerides|ferritin|glucose|a1c|hemoglobin)\b/i;
const NAME_QUERY_REGEX = /\b(name|call me|who am i|who i am)\b/;
const NAME_IDENTITY_REGEX = /\b(my name is|i am|i'm|call me)\b/;
const SHORT_ENTITY_LOOKUP_QUERY_REGEX =
  /^(?:who|what|when|where|which|did|do|does|has|have|had|is|are|was|were|any|check|look|find|search|tell)\b/i;
const META_MEMORY_TEXT_REGEX =
  /(<memory_search>|<\/memory_search>|<query>|<\/query>|\bno memories found\b|\bsearch criteria\b|\bmemory tool\b|\bmemory system\b|\bexact results from memory tool\b)/i;
const INTERNAL_CONTROL_TEXT_REGEX =
  /<!--\s*viv_internal:|##\s*background processing\s*\(brewing\)|scheduled self-prompt|wake\.\s*check date,\s*time,\s*timezone|conversation_policy|output:\s*\{nta\}|^#\s*current chat:/i;
const NTA_ONLY_REGEX = /^\{NTA\}\.?$/i;
const ASSISTANT_LOW_SIGNAL_REGEX =
  /^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|sure|sounds good|what's up)\b[!.?]*$/i;
const ASSISTANT_MEMORY_DISCLAIMER_REGEX =
  /(?:\b(?:i\s+(?:don't|do not|can't|cannot)\s+(?:have|see|find|access|recall|remember)|i\s+have\s+no\s+(?:specific\s+)?(?:memory|memories|record|records|information|mentions?)|no\s+memories?\s+found)\b[\s\S]{0,180}\b(?:memory|memories|conversation|chat history|past chats|history|name|details?|mention|criteria)\b|\bi\s+don't\s+think\s+you(?:'ve| have)\s+told\s+me\s+that\s+yet\b|\bi\s+don't\s+know\s+(?:your|the)\s+name\b)/i;
const ASSISTANT_RECALL_SUMMARY_REGEX =
  /(?:\bbased on (?:my|our) (?:search|scan|review)\b|\b(?:from|in) (?:our|your) (?:conversation|chat) history\b|\bin (?:our|your) previous (?:conversation|chats)\b|\byes[, ]+i (?:remember|do)\b|\bi (?:remember|recall) (?:you|that|when)\b|\bi (?:have|can see) (?:a )?(?:record|records)\b)/i;

function cleanupText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  return text.split('\0').join(' ').replace(/\s+/g, ' ').trim();
}

function extractMessageText(message) {
  const direct = cleanupText(message?.text);
  if (direct) {
    return direct;
  }
  if (Array.isArray(message?.content)) {
    const contentParts = message.content.filter(
      (part) => part && typeof part === 'object' && part.type !== 'think',
    );
    if (!contentParts.length) {
      return '';
    }
    return cleanupText(parseTextParts(contentParts, true));
  }
  return '';
}

function hasRecallIntent(queryText) {
  if (!queryText) {
    return false;
  }
  return RECALL_INTENT_REGEX.test(queryText);
}

function isPersonalFactQuery(queryText) {
  if (!queryText) {
    return false;
  }
  return PERSONAL_FACT_RECALL_REGEX.test(queryText);
}

function tokenizeQuery(queryText) {
  const tokens = String(queryText || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));

  const expanded = new Set();
  for (const token of tokens) {
    expanded.add(token);
    if (token.endsWith('ies') && token.length >= 5) {
      expanded.add(`${token.slice(0, -3)}y`);
    } else if (token.endsWith('es') && token.length >= 5) {
      expanded.add(token.slice(0, -2));
    } else if (token.endsWith('s') && token.length >= 4) {
      expanded.add(token.slice(0, -1));
    }
  }

  if (expanded.has('lab') || expanded.has('test') || expanded.has('cholesterol')) {
    [
      'blood',
      'bloodwork',
      'panel',
      'ldl',
      'hdl',
      'triglycerides',
      'ferritin',
      'glucose',
      'a1c',
    ].forEach((token) => expanded.add(token));
  }

  if (expanded.has('name') || expanded.has('call') || expanded.has('called')) {
    ['my name is', 'i am', "i'm", 'call me'].forEach((token) => expanded.add(token));
  }

  return Array.from(expanded).slice(0, 18);
}

function countTermMatches(candidateLower, terms) {
  if (!candidateLower || !terms?.length) {
    return 0;
  }

  let matchCount = 0;
  for (const term of terms) {
    if (candidateLower.includes(term)) {
      matchCount += 1;
    }
  }
  return matchCount;
}

function getSignalTerms(terms) {
  if (!Array.isArray(terms) || terms.length === 0) {
    return [];
  }

  return terms.filter((term) => term.length >= 3 && !GENERIC_QUERY_TERMS.has(term)).slice(0, 12);
}

function getSpecificEntityTerms(terms) {
  return getSignalTerms(terms).filter((term) => !SHORT_ENTITY_QUERY_GENERIC_TERMS.has(term));
}

function isShortSpecificEntityRecallQuery(queryText, terms) {
  const cleaned = cleanupText(queryText);
  if (!cleaned || !SHORT_ENTITY_LOOKUP_QUERY_REGEX.test(cleaned)) {
    return false;
  }

  const tokenCount = cleaned.split(/\s+/).filter(Boolean).length;
  if (tokenCount < 2 || tokenCount > 12) {
    return false;
  }

  return getSpecificEntityTerms(terms).length > 0;
}

function scoreCandidate({ queryLower, terms, signalMatchCount, messageText, messageIndex }) {
  const candidateLower = messageText.toLowerCase();
  let score = countTermMatches(candidateLower, terms);

  if (signalMatchCount > 0) {
    score += Math.min(1.8, signalMatchCount * 0.6);
  }

  if (queryLower.length >= 8 && candidateLower.includes(queryLower)) {
    score += 2.25;
  }

  if (hasRecallIntent(candidateLower)) {
    score -= 0.9;
  }

  if (LAB_KEYWORD_REGEX.test(candidateLower)) {
    score += 0.7;
  }

  if (NAME_QUERY_REGEX.test(queryLower) && NAME_IDENTITY_REGEX.test(candidateLower)) {
    score += 1.2;
  }

  const numericSignals = messageText.match(/\b\d{1,4}(?:\.\d+)?\b/g)?.length ?? 0;
  if (numericSignals > 0) {
    score += Math.min(1.25, numericSignals * 0.18);
  }

  score += Math.max(0, 0.25 - messageIndex * 0.0004);
  return score;
}

function buildExcerpt(messageText) {
  if (messageText.length <= RUNTIME_MAX_EXCERPT_CHARS) {
    return messageText;
  }
  return `${messageText.slice(0, RUNTIME_MAX_EXCERPT_CHARS - 3)}...`;
}

function truncateMessageText(messageText) {
  if (messageText.length <= RUNTIME_MAX_MESSAGE_CHARS) {
    return messageText;
  }
  return messageText.slice(0, RUNTIME_MAX_MESSAGE_CHARS);
}

function isLikelyMetaRecallPrompt(messageText) {
  const cleaned = cleanupText(messageText);
  if (!cleaned) {
    return false;
  }

  if (META_MEMORY_TEXT_REGEX.test(cleaned)) {
    return true;
  }

  if (!hasRecallIntent(cleaned)) {
    return false;
  }

  const tokenCount = cleaned.split(/\s+/).filter(Boolean).length;
  const numericSignals = cleaned.match(/\b\d{1,4}(?:\.\d+)?\b/g)?.length ?? 0;
  return tokenCount <= 28 && numericSignals === 0;
}

function shouldSkipRuntimeCandidate({ messageText, isCreatedByUser }) {
  const cleaned = cleanupText(messageText);
  if (!cleaned) {
    return true;
  }
  if (isLikelyMetaRecallPrompt(cleaned)) {
    return true;
  }
  if (INTERNAL_CONTROL_TEXT_REGEX.test(cleaned)) {
    return true;
  }
  if (NTA_ONLY_REGEX.test(cleaned)) {
    return true;
  }
  if (!isCreatedByUser && ASSISTANT_MEMORY_DISCLAIMER_REGEX.test(cleaned)) {
    return true;
  }
  if (!isCreatedByUser && ASSISTANT_RECALL_SUMMARY_REGEX.test(cleaned)) {
    return true;
  }
  if (!isCreatedByUser && ASSISTANT_LOW_SIGNAL_REGEX.test(cleaned)) {
    return true;
  }
  return false;
}

/* TTL cache for resolveRuntimeScope to avoid repeated User.findById calls within a short window.
 * Key: userId, Value: { result: { scope, agentId }, expiresAt: number }
 * The agent-scoped override is evaluated per-call since it depends on the agent argument,
 * but the DB lookup for global recall is cached. */
const _scopeCache = new Map();
const SCOPE_CACHE_TTL_MS = Number.parseInt(
  process.env.VIVENTIUM_CONVERSATION_RECALL_RUNTIME_SCOPE_CACHE_TTL_MS || '60000',
  10,
);

async function resolveRuntimeScope({ user, agent }) {
  if (!user?.id) {
    return { scope: 'none', agentId: null };
  }

  // Agent-scoped override does not depend on the DB lookup — fast path.
  if (agent?.conversation_recall_agent_only === true && typeof agent?.id === 'string' && agent.id) {
    return { scope: 'agent', agentId: agent.id };
  }

  // Check cache for the global-recall DB lookup.
  const now = Date.now();
  const cached = _scopeCache.get(user.id);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const userFromDb = await User.findById(user.id).select('personalization').lean();
  const globalEnabled = userFromDb?.personalization?.conversation_recall === true;

  const result = globalEnabled
    ? { scope: 'all', agentId: null }
    : { scope: 'none', agentId: null };

  _scopeCache.set(user.id, { result, expiresAt: now + SCOPE_CACHE_TTL_MS });

  // Evict stale entries lazily (max 500 entries before forced cleanup).
  if (_scopeCache.size > 500) {
    for (const [key, entry] of _scopeCache) {
      if (entry.expiresAt <= now) {
        _scopeCache.delete(key);
      }
    }
  }

  return result;
}

async function getAgentConversationIds({ userId, agentId }) {
  const conversations = await Conversation.find({
    user: userId,
    agent_id: agentId,
  })
    .select('conversationId')
    .limit(RUNTIME_MAX_AGENT_CONVERSATIONS)
    .lean();

  return conversations.map((convo) => convo?.conversationId).filter(Boolean);
}

function shouldAttemptRuntimeRecall({ queryText, terms }) {
  if (!queryText) {
    return false;
  }
  if (hasRecallIntent(queryText)) {
    return true;
  }
  if (isPersonalFactQuery(queryText)) {
    return true;
  }
  if (PAST_DISCUSSION_QUERY_REGEX.test(queryText)) {
    return true;
  }
  return isShortSpecificEntityRecallQuery(queryText, terms);
}

function getUserAccountDisplayName(user) {
  const candidates = [user?.name, user?.username, user?.displayName, user?.fullName];
  for (const candidate of candidates) {
    const cleaned = cleanupText(candidate);
    if (cleaned) {
      return cleaned.slice(0, 120);
    }
  }
  return '';
}

function buildNameFallbackContext(displayName) {
  if (!displayName) {
    return '';
  }
  return (
    'Conversation Recall Context (auto-retrieved from prior user chats):\n' +
    '- Use only if relevant to the current request.\n' +
    '- Do not claim you lack access to past chats when relevant snippets are provided below.\n\n' +
    '[1] [timestamp=unknown] [conversation=user_profile] [role=system]\n' +
    `Account profile display name: ${displayName}`
  );
}

async function buildConversationRecallRuntimeContext({ user, agent, latestMessage }) {
  if (!RUNTIME_ENABLED || !user?.id) {
    return '';
  }

  const queryText = extractMessageText(latestMessage);
  const currentConversationId =
    typeof latestMessage?.conversationId === 'string' ? latestMessage.conversationId : null;
  const queryLower = queryText.toLowerCase();
  const recallIntentQuery = hasRecallIntent(queryText);
  const personalFactQuery = isPersonalFactQuery(queryText);
  const isNameQuery = NAME_QUERY_REGEX.test(queryLower);
  const accountDisplayName = isNameQuery ? getUserAccountDisplayName(user) : '';
  const terms = tokenizeQuery(queryText);
  const signalTerms = getSignalTerms(terms);
  if (!shouldAttemptRuntimeRecall({ queryText, terms })) {
    return '';
  }

  const policy = await resolveRuntimeScope({ user, agent });
  if (policy.scope === 'none') {
    return '';
  }

  let conversationIdFilter;
  if (policy.scope === 'agent' && policy.agentId) {
    const conversationIds = await getAgentConversationIds({
      userId: user.id,
      agentId: policy.agentId,
    });
    if (!conversationIds.length) {
      return '';
    }
    conversationIdFilter = { $in: conversationIds };
  }

  const messageFilter = {
    user: user.id,
    ...(conversationIdFilter != null ? { conversationId: conversationIdFilter } : {}),
    ...(RUNTIME_INCLUDE_ASSISTANT ? {} : { isCreatedByUser: true }),
    unfinished: { $ne: true },
    error: { $ne: true },
    $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
  };

  const messageSelect = RUNTIME_INCLUDE_ASSISTANT
    ? 'conversationId createdAt sender isCreatedByUser text content'
    : 'conversationId createdAt sender isCreatedByUser text';

  const rawMessageLimit = Math.max(
    RUNTIME_MAX_MESSAGES,
    Math.min(RUNTIME_MAX_SCAN_MESSAGES, Math.ceil(RUNTIME_MAX_MESSAGES * RUNTIME_FETCH_MULTIPLIER)),
  );

  const messages = await Message.find(messageFilter)
    .select(messageSelect)
    .sort({ createdAt: -1 })
    .limit(rawMessageLimit)
    .lean();

  if (!messages.length) {
    if (accountDisplayName) {
      return buildNameFallbackContext(accountDisplayName);
    }
    return '';
  }

  const allowBroadRecallWithoutSignals = recallIntentQuery && signalTerms.length === 0;
  const effectiveMinScore = allowBroadRecallWithoutSignals
    ? Math.min(RUNTIME_MIN_SCORE, 0.15)
    : personalFactQuery
      ? Math.min(RUNTIME_MIN_SCORE, 0.55)
      : RUNTIME_MIN_SCORE;

  const preparedCandidates = [];
  const conversationSignalMatchCount = new Map();
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (currentConversationId && message?.conversationId === currentConversationId) {
      continue;
    }
    const messageText = truncateMessageText(extractMessageText(message));
    if (shouldSkipRuntimeCandidate({ messageText, isCreatedByUser: message?.isCreatedByUser })) {
      continue;
    }

    const candidateLower = messageText.toLowerCase();
    const signalMatchCount = countTermMatches(candidateLower, signalTerms);
    const hasIdentitySignal = isNameQuery && NAME_IDENTITY_REGEX.test(candidateLower);

    if (signalMatchCount > 0 || hasIdentitySignal) {
      const conversationId = message?.conversationId || 'unknown';
      const existingCount = conversationSignalMatchCount.get(conversationId) ?? 0;
      conversationSignalMatchCount.set(conversationId, existingCount + 1);
    }

    preparedCandidates.push({
      message,
      messageText,
      candidateLower,
      signalMatchCount,
      hasIdentitySignal,
      messageIndex: i,
    });
  }

  if (!preparedCandidates.length) {
    if (accountDisplayName) {
      return buildNameFallbackContext(accountDisplayName);
    }
    return '';
  }

  const seenContent = new Set();
  const scored = [];
  let earlyTerminated = false;
  for (const prepared of preparedCandidates) {
    const {
      message,
      messageText,
      candidateLower,
      signalMatchCount,
      hasIdentitySignal,
      messageIndex,
    } = prepared;

    const conversationId = message?.conversationId || 'unknown';
    const conversationHasSignal = (conversationSignalMatchCount.get(conversationId) ?? 0) > 0;
    const hasDirectSignal = signalMatchCount > 0 || hasIdentitySignal;

    if (!allowBroadRecallWithoutSignals && signalTerms.length > 0 && !hasDirectSignal) {
      const allowAssistantCarryover =
        personalFactQuery && conversationHasSignal && message?.isCreatedByUser === false;
      if (!allowAssistantCarryover) {
        continue;
      }
    }

    const dedupeKey = `${conversationId}::${messageText.slice(0, 180)}`;
    if (seenContent.has(dedupeKey)) {
      continue;
    }
    seenContent.add(dedupeKey);

    let score = scoreCandidate({
      queryLower,
      terms,
      signalMatchCount,
      messageText,
      messageIndex,
    });

    if (personalFactQuery && conversationHasSignal && !hasDirectSignal) {
      // Keep high-signal assistant follow-ups from matched conversations (e.g. a direct identity confirmation)
      // even when the reply does not repeat the original query terms verbatim.
      score += 0.95;
    }

    if (score < effectiveMinScore) {
      continue;
    }

    scored.push({
      score,
      conversationId: message?.conversationId || 'unknown',
      createdAt: message?.createdAt ? new Date(message.createdAt).toISOString() : 'unknown',
      role: message?.isCreatedByUser ? 'user' : message?.sender || 'assistant',
      excerpt: buildExcerpt(messageText),
    });

    // Early termination: when enabled and we have enough high-confidence matches,
    // stop scanning older candidates. Candidates arrive in reverse chronological order,
    // so recent (higher-quality) messages are processed first.
    // Default OFF — full scan is preserved unless explicitly opted in via env var.
    if (
      RUNTIME_EARLY_TERMINATION &&
      scored.length >= RUNTIME_MAX_MATCHES * 2 &&
      scored.every((s) => s.score >= RUNTIME_EARLY_TERMINATION_MIN_SCORE)
    ) {
      earlyTerminated = true;
      break;
    }
  }

  if (!scored.length) {
    if (accountDisplayName) {
      return buildNameFallbackContext(accountDisplayName);
    }
    return '';
  }

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  const conversationCounts = new Map();
  for (const candidate of scored) {
    if (selected.length >= RUNTIME_MAX_MATCHES) {
      break;
    }
    const perConversationCount = conversationCounts.get(candidate.conversationId) ?? 0;
    if (perConversationCount >= 2) {
      continue;
    }
    selected.push(candidate);
    conversationCounts.set(candidate.conversationId, perConversationCount + 1);
  }

  if (!selected.length) {
    if (accountDisplayName) {
      return buildNameFallbackContext(accountDisplayName);
    }
    return '';
  }

  if (RUNTIME_DEBUG) {
    try {
      const { logger } = require('@librechat/data-schemas');
      logger.info('[conversationRecallRuntime] Selected runtime recall snippets', {
        userId: user.id,
        scope: policy.scope,
        rawFetched: messages.length,
        preparedCandidates: preparedCandidates.length,
        matched: scored.length,
        selected: selected.length,
        earlyTerminated,
        includeAssistant: RUNTIME_INCLUDE_ASSISTANT,
        queryTerms: terms.slice(0, 8),
        signalTerms: signalTerms.slice(0, 8),
      });
    } catch {
      // Avoid hard-failing runtime recall on debug logger import issues.
    }
  }

  const lines = [];
  let usedChars = 0;
  for (let i = 0; i < selected.length; i += 1) {
    const entry = selected[i];
    const line =
      `[${i + 1}] [timestamp=${entry.createdAt}] [conversation=${entry.conversationId}] [role=${entry.role}]\n` +
      `${entry.excerpt}`;
    if (usedChars + line.length > RUNTIME_MAX_CONTEXT_CHARS) {
      break;
    }
    lines.push(line);
    usedChars += line.length;
  }

  if (!lines.length) {
    if (accountDisplayName) {
      return buildNameFallbackContext(accountDisplayName);
    }
    return '';
  }

  if (accountDisplayName) {
    const profileLine =
      '[account] [timestamp=unknown] [conversation=user_profile] [role=system]\n' +
      `Account profile display name: ${accountDisplayName}`;
    if (usedChars + profileLine.length <= RUNTIME_MAX_CONTEXT_CHARS) {
      lines.unshift(profileLine);
      usedChars += profileLine.length;
    }
  }

  return (
    'Conversation Recall Context (auto-retrieved from prior user chats):\n' +
    '- Use only if relevant to the current request.\n' +
    '- Do not claim you lack access to past chats when relevant snippets are provided below.\n\n' +
    lines.join('\n\n')
  );
}

module.exports = {
  buildConversationRecallRuntimeContext,
  /* exported for testability */
  __internal: {
    tokenizeQuery,
    getSignalTerms,
    countTermMatches,
    hasRecallIntent,
    scoreCandidate,
    cleanupText,
    extractMessageText,
    getSpecificEntityTerms,
    isShortSpecificEntityRecallQuery,
    shouldAttemptRuntimeRecall,
    resolveRuntimeScope,
    _scopeCache,
  },
};
