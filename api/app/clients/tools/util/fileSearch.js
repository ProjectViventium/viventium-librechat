const axios = require('axios');
const { tool } = require('@langchain/core/tools');
const { logger } = require('@librechat/data-schemas');
const { generateShortLivedToken } = require('@librechat/api');
const { Tools, EToolResources } = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { getFiles } = require('~/models');
/* === VIVENTIUM START ===
 * Feature: Conversation recall exact-literal rescue.
 * Reason:
 * - Conversation recall uses a synthetic file over chat turns, and pure vector retrieval can
 *   miss exact marker-like strings.
 * - The tool now has a bounded source-backed rescue path for recall files only.
 * === VIVENTIUM END === */
const { Message, Conversation } = require('~/db/models');
const {
  getMessageText: getConversationRecallMessageText,
  shouldSkipFromRecallCorpus,
} = require('~/server/services/viventium/conversationRecallService');
const {
  isAssistantMemoryDisclaimer,
  isConversationRecallFileId,
  messageUsesConversationRecallSearch,
} = require('~/server/services/viventium/conversationRecallFilters');
/* === VIVENTIUM START ===
 * Feature: Evidence-oriented file_search fallback output.
 * === VIVENTIUM END === */
const { getFileSearchFailureOutput } = require('./modelFacingToolOutput');

const fileSearchJsonSchema = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        "A natural language query to search for relevant information in the files. Be specific and use keywords related to the information you're looking for. The query will be used for semantic similarity matching against the file contents.",
    },
  },
  required: ['query'],
};

/* === VIVENTIUM START ===
 * Hardening: file_search request/aggregation robustness
 * - Add bounded request timeout per /query call.
 * - Keep file/result mapping stable on partial failures.
 * - Deduplicate merged file resources by file_id.
 * === VIVENTIUM END === */
const DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS = 12000;
const DEFAULT_FILE_SEARCH_QUERY_K = 5;
const DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL = 8000;
const DEFAULT_FILE_SEARCH_QUERY_K_CONVERSATION_RECALL = 60;
/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall query budget
 * Purpose: Local transcript files share the RAG/Ollama path with conversation recall. Give
 * transcript artifacts enough time to survive cold local embeddings without weakening the
 * normal file-search budget.
 * Added: 2026-05-05
 */
const DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS_MEETING_TRANSCRIPT = 30000;
const DEFAULT_FILE_SEARCH_QUERY_K_MEETING_TRANSCRIPT = 8;
/* === VIVENTIUM END === */
const DEFAULT_FILE_SEARCH_MAX_RESULTS = 10;
const DEFAULT_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL = 6;
/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const DEFAULT_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT = 6;
/* === VIVENTIUM END === */
const DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS = 1600;
const DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL = 800;
/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT = 2400;
const DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT_INVENTORY = 12000;
const DEFAULT_FILE_SEARCH_DISTANCE_MEETING_TRANSCRIPT_INVENTORY = 0.65;
/* === VIVENTIUM END === */
const DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS = 20000;
const DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL = 12000;
/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS_MEETING_TRANSCRIPT = 16000;
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Retrieval: widen the bounded candidate pool for conversation recall before reranking.
 * Reason:
 * - Recall corpora are synthetic, compact, and reranked locally.
 * - A larger top-k keeps exact/near-exact chat turns available for reranking without inflating
 *   the model-facing output budget.
 * === VIVENTIUM END === */
const DEFAULT_FILE_SEARCH_LITERAL_FALLBACK_MAX_MATCHES = 4;
const CONVERSATION_RECALL_MODE_SOURCE_ONLY = 'source_only';
const QUOTED_LITERAL_REGEX = /"([^"\n]{4,180})"|“([^”\n]{4,180})”/g;
const CODE_LIKE_LITERAL_REGEX = /\b[A-Za-z0-9][A-Za-z0-9:_./-]{7,}\b/g;
const RECALL_QUERY_STOP_WORDS = new Set([
  'about',
  'again',
  'all',
  'also',
  'and',
  'are',
  'can',
  'did',
  'does',
  'for',
  'from',
  'have',
  'into',
  'just',
  'last',
  'memory',
  'memories',
  'past',
  'please',
  'previous',
  'recall',
  'remember',
  'said',
  'search',
  'tell',
  'that',
  'the',
  'them',
  'this',
  'what',
  'when',
  'where',
  'with',
  'your',
  'you',
]);

const parsePositiveIntEnv = (value, fallbackValue) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallbackValue;
};

const getFileSearchQueryTimeoutMs = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS,
    DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS,
  );

const getConversationRecallFileSearchQueryTimeoutMs = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL,
    DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS_CONVERSATION_RECALL,
  );

const getFileSearchTopK = () =>
  parsePositiveIntEnv(process.env.VIVENTIUM_FILE_SEARCH_TOP_K, DEFAULT_FILE_SEARCH_QUERY_K);

const getConversationRecallFileSearchTopK = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_TOP_K_CONVERSATION_RECALL,
    DEFAULT_FILE_SEARCH_QUERY_K_CONVERSATION_RECALL,
  );

/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall query budget
 * Added: 2026-05-05
 */
const getMeetingTranscriptFileSearchTopK = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_TOP_K_MEETING_TRANSCRIPT,
    DEFAULT_FILE_SEARCH_QUERY_K_MEETING_TRANSCRIPT,
  );
/* === VIVENTIUM END === */

const getFileSearchMaxResults = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS,
    DEFAULT_FILE_SEARCH_MAX_RESULTS,
  );

const getConversationRecallFileSearchMaxResults = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL,
    DEFAULT_FILE_SEARCH_MAX_RESULTS_CONVERSATION_RECALL,
  );

/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const getMeetingTranscriptFileSearchMaxResults = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT,
    DEFAULT_FILE_SEARCH_MAX_RESULTS_MEETING_TRANSCRIPT,
  );
/* === VIVENTIUM END === */

const getFileSearchResultMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS,
    DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS,
  );

const getConversationRecallFileSearchResultMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL,
    DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_CONVERSATION_RECALL,
  );

/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const getMeetingTranscriptFileSearchResultMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT,
    DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT,
  );

const getMeetingTranscriptInventoryFileSearchResultMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT_INVENTORY,
    DEFAULT_FILE_SEARCH_RESULT_MAX_CHARS_MEETING_TRANSCRIPT_INVENTORY,
  );
/* === VIVENTIUM END === */

const getFileSearchOutputMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS,
    DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS,
  );

const getConversationRecallFileSearchOutputMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL,
    DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS_CONVERSATION_RECALL,
  );

/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall result budget
 * Added: 2026-05-05
 */
const getMeetingTranscriptFileSearchOutputMaxChars = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_OUTPUT_MAX_CHARS_MEETING_TRANSCRIPT,
    DEFAULT_FILE_SEARCH_OUTPUT_MAX_CHARS_MEETING_TRANSCRIPT,
  );
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Meeting transcript recall query budget
 * Added: 2026-05-05
 */
const getMeetingTranscriptFileSearchQueryTimeoutMs = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_QUERY_TIMEOUT_MS_MEETING_TRANSCRIPT,
    DEFAULT_FILE_SEARCH_QUERY_TIMEOUT_MS_MEETING_TRANSCRIPT,
  );

const isMeetingTranscriptFileId = (fileId) => {
  const value = String(fileId || '');
  return (
    value.startsWith('meeting_transcript:') ||
    value.startsWith('meeting_summary:') ||
    value.startsWith('meeting_inventory:')
  );
};

const isMeetingTranscriptInventoryFile = (file) =>
  String(file?.file_id || '').startsWith('meeting_inventory:') ||
  file?.metadata?.meetingTranscriptKind === 'inventory';

const formatTranscriptMetadataValue = (value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim() || null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const buildMeetingTranscriptResultHeader = (result) => {
  if (!isMeetingTranscriptFileId(result?.file_id)) {
    return '';
  }
  const metadata = result?.fileMetadata || {};
  const rows = [
    ['Transcript artifact ID', metadata.meetingTranscriptArtifactId],
    ['Transcript artifact kind', metadata.meetingTranscriptKind],
    ['Display title', metadata.meetingTranscriptDisplayTitle],
    ['One-line summary', metadata.meetingTranscriptOneLineSummary],
    ['Participants', metadata.meetingTranscriptParticipants],
    ['Original filename', metadata.meetingTranscriptOriginalFilename || result.filename],
    ['File mtime', metadata.meetingTranscriptFileMtime],
    ['Source status', metadata.meetingTranscriptSourceStatus],
    ['Calendar match', metadata.meetingTranscriptCalendarMatch],
  ];
  return rows
    .map(([label, value]) => {
      const formatted = formatTranscriptMetadataValue(value);
      return formatted ? `${label}: ${formatted}` : null;
    })
    .filter(Boolean)
    .join('\n');
};

const withMeetingTranscriptHeader = (result, content) => {
  const header = buildMeetingTranscriptResultHeader(result);
  return header ? `${header}\n${content}` : content;
};

const getMeetingTranscriptInventoryText = (file) => {
  const text = file?.metadata?.meetingTranscriptInventoryText;
  return typeof text === 'string' ? text.trim() : '';
};

const getNoMatchingContentOutput = ({ files = [], recallFiles = [] }) => {
  const hasMeetingTranscriptResource = files.some((file) =>
    isMeetingTranscriptFileId(file?.file_id),
  );
  const hasConversationRecallResource = recallFiles.length > 0;
  if (hasMeetingTranscriptResource && hasConversationRecallResource) {
    return 'No matching content found in conversation history or meeting transcripts for this query.';
  }
  if (hasMeetingTranscriptResource) {
    return 'No matching content found in meeting transcripts for this query.';
  }
  if (hasConversationRecallResource) {
    return 'No matching content found in conversation history for this query.';
  }
  return 'No matching content found in attached files for this query.';
};
/* === VIVENTIUM END === */

const getConversationRecallLiteralFallbackMaxMatches = () =>
  parsePositiveIntEnv(
    process.env.VIVENTIUM_FILE_SEARCH_LITERAL_FALLBACK_MAX_MATCHES,
    DEFAULT_FILE_SEARCH_LITERAL_FALLBACK_MAX_MATCHES,
  );

const getFileSearchTopKForFile = (file) => {
  if (isConversationRecallFileId(file?.file_id)) {
    return getConversationRecallFileSearchTopK();
  }
  if (isMeetingTranscriptFileId(file?.file_id)) {
    return getMeetingTranscriptFileSearchTopK();
  }
  return getFileSearchTopK();
};

const getFileSearchQueryTimeoutMsForFile = (file) => {
  if (isConversationRecallFileId(file?.file_id)) {
    return getConversationRecallFileSearchQueryTimeoutMs();
  }
  if (isMeetingTranscriptFileId(file?.file_id)) {
    return getMeetingTranscriptFileSearchQueryTimeoutMs();
  }
  return getFileSearchQueryTimeoutMs();
};

const clipContent = (content, maxChars) => {
  if (typeof content !== 'string') {
    return '';
  }
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, Math.max(0, maxChars - 3))}...`;
};

const clipInventoryContent = (content, maxChars) => {
  if (typeof content !== 'string') return '';
  if (content.length <= maxChars) return content;
  const omitted = content.length - maxChars;
  const marker = `\n[... clipped ${omitted} chars from transcript inventory output ...]`;
  return `${content.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dedupeFilesById = (files = []) => {
  const seen = new Set();
  const uniqueFiles = [];
  for (const file of files) {
    const fileId = file?.file_id;
    if (!file || !fileId || seen.has(fileId)) {
      continue;
    }
    seen.add(fileId);
    uniqueFiles.push(file);
  }
  return uniqueFiles;
};

const isSourceOnlyConversationRecallFile = (file) =>
  isConversationRecallFileId(file?.file_id) &&
  file?.viventiumConversationRecallMode === CONVERSATION_RECALL_MODE_SOURCE_ONLY;

const dedupeRecallResults = (results = []) => {
  const seen = new Set();
  return results.filter((result) => {
    const key = `${result?.file_id || ''}::${result?.content || ''}`;
    if (!result || !result.content || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const tokenizeRecallQuery = (query) => {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !RECALL_QUERY_STOP_WORDS.has(token));

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

  return Array.from(expanded).slice(0, 14);
};

const countTermMatches = (contentLower, terms) => {
  if (!contentLower || !terms?.length) {
    return 0;
  }

  let matchCount = 0;
  for (const term of terms) {
    if (contentLower.includes(term)) {
      matchCount += 1;
    }
  }
  return matchCount;
};

const isCodeLikeLiteralCandidate = (token) => {
  if (typeof token !== 'string') {
    return false;
  }
  const trimmed = token.trim();
  if (trimmed.length < 8) {
    return false;
  }
  return (
    /\d/.test(trimmed) ||
    trimmed.includes('-') ||
    trimmed.includes('_') ||
    trimmed.includes(':') ||
    trimmed.includes('/') ||
    trimmed.includes('@') ||
    /[A-Z]{2,}/.test(trimmed)
  );
};

const extractRecallLiteralCandidates = (query) => {
  const text = String(query || '');
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.length < 4) {
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(trimmed);
  };

  for (const match of text.matchAll(QUOTED_LITERAL_REGEX)) {
    pushCandidate(match[1] || match[2]);
  }

  for (const match of text.matchAll(CODE_LIKE_LITERAL_REGEX)) {
    const token = match[0];
    if (isCodeLikeLiteralCandidate(token)) {
      pushCandidate(token);
    }
  }

  return candidates.slice(0, 4);
};

const contentContainsLiteralCandidate = (content, literalCandidates) => {
  const contentLower = String(content || '').toLowerCase();
  return literalCandidates.some((candidate) => contentLower.includes(candidate.toLowerCase()));
};

const parseConversationRecallAgentIdFromFileId = (fileId) => {
  const match = /^conversation_recall:[^:]+:agent:(.+)$/.exec(String(fileId || ''));
  return match?.[1] || null;
};

const buildConversationRecallSnippet = ({ message, content }) => {
  const role = message?.isCreatedByUser ? 'user' : message?.sender || 'assistant';
  const timestamp = message?.createdAt
    ? new Date(message.createdAt).toISOString()
    : new Date().toISOString();
  const conversation = message?.conversationId || 'unknown';
  return `<turn timestamp="${timestamp}" conversation="${conversation}" role="${role}">\n${content}\n</turn>`;
};

const buildScopedConversationIds = async ({ userId, recallFileId, currentConversationId }) => {
  const agentId = parseConversationRecallAgentIdFromFileId(recallFileId);
  if (!agentId) {
    return currentConversationId ? { $ne: currentConversationId } : undefined;
  }

  const conversations = await Conversation.find({
    user: userId,
    agent_id: agentId,
  })
    .select('conversationId')
    .lean();

  const conversationIds = conversations
    .map((conversation) => conversation?.conversationId)
    .filter((conversationId) => conversationId && conversationId !== currentConversationId);

  if (!conversationIds.length) {
    return { $in: [] };
  }

  return { $in: conversationIds };
};

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

async function searchConversationRecallSourceMatches({
  userId,
  conversationId,
  recallFiles,
  query,
  literalCandidates,
}) {
  if (!userId || !Array.isArray(recallFiles) || !recallFiles.length) {
    return [];
  }

  const queryTerms = tokenizeRecallQuery(query).slice(0, 6);
  const searchTerms = Array.from(new Set([...literalCandidates, ...queryTerms])).filter(Boolean);
  if (!searchTerms.length) {
    return [];
  }

  const queryLower = String(query || '').toLowerCase();
  const regexes = searchTerms.map((candidate) => new RegExp(escapeRegex(candidate), 'i'));
  const maxMatches = getConversationRecallLiteralFallbackMaxMatches();
  const results = [];

  for (const file of recallFiles) {
    const scopedConversationIds = await buildScopedConversationIds({
      userId,
      recallFileId: file.file_id,
      currentConversationId: conversationId,
    });

    const messages = await Message.find({
      user: userId,
      unfinished: { $ne: true },
      error: { $ne: true },
      'metadata.viventium.type': { $ne: 'listen_only_transcript' },
      'metadata.viventium.mode': { $ne: 'listen_only' },
      ...(scopedConversationIds ? { conversationId: scopedConversationIds } : {}),
      $or: [{ expiredAt: { $exists: false } }, { expiredAt: null }],
      $and: [
        {
          $or: regexes.map((regex) => ({
            text: regex,
          })),
        },
      ],
    })
      .select(
        'messageId parentMessageId conversationId createdAt sender isCreatedByUser text content attachments metadata',
      )
      .sort({ createdAt: -1 })
      .limit(maxMatches * 6)
      .lean();

    for (const message of messages) {
      const content = getConversationRecallMessageText(message);
      const contentLower = content.toLowerCase();
      const hasRecallDerivedChild =
        message?.isCreatedByUser === true
          ? await hasRecallDerivedChildMessage({ userId, messageId: message?.messageId })
          : false;
      if (
        shouldSkipFromRecallCorpus({
          message,
          messageText: content,
          isCreatedByUser: message?.isCreatedByUser,
          hasRecallDerivedChild,
        })
      ) {
        continue;
      }
      const termMatches = countTermMatches(contentLower, queryTerms);
      const literalMatchCount = literalCandidates.filter((candidate) =>
        contentLower.includes(candidate.toLowerCase()),
      ).length;
      if (termMatches === 0 && literalMatchCount === 0) {
        continue;
      }

      results.push({
        filename: file.filename || 'conversation-recall-all.txt',
        content: buildConversationRecallSnippet({ message, content }),
        distance: 0,
        file_id: file.file_id,
        page: null,
        sourceKind: 'raw_message',
        sourceRecallScore:
          literalMatchCount * 4 +
          termMatches +
          (queryLower.length >= 8 && contentLower.includes(queryLower) ? 2 : 0),
        createdAt: message?.createdAt ? new Date(message.createdAt).getTime() : 0,
      });

      if (results.length >= maxMatches * 3) {
        break;
      }
    }
  }

  return dedupeRecallResults(results)
    .sort((a, b) => {
      if ((b.sourceRecallScore || 0) !== (a.sourceRecallScore || 0)) {
        return (b.sourceRecallScore || 0) - (a.sourceRecallScore || 0);
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    })
    .slice(0, maxMatches)
    .map(({ sourceRecallScore, createdAt, ...result }) => result);
}

const getConversationRecallRerankScore = ({ query, result, queryTerms }) => {
  const content = typeof result?.content === 'string' ? result.content : '';
  const contentLower = content.toLowerCase();
  const queryLower = String(query || '').toLowerCase();

  let score = 1.0 - Number(result?.distance || 0);
  const termMatches = countTermMatches(contentLower, queryTerms);
  score += Math.min(0.9, termMatches * 0.18);

  if (queryLower.length >= 8 && contentLower.includes(queryLower)) {
    score += 0.45;
  }

  if (Number.isFinite(result?.sourceRecallScore)) {
    score += Math.min(1.4, Number(result.sourceRecallScore) * 0.22);
  }

  if (result?.sourceKind === 'raw_message') {
    score += 0.9;
  }

  if (isAssistantMemoryDisclaimer(contentLower)) {
    score -= 1.25;
  }

  return score;
};

const rerankConversationRecallResults = ({ query, results }) => {
  if (!Array.isArray(results) || !results.length) {
    return [];
  }

  const queryTerms = tokenizeRecallQuery(query);

  return results
    .map((result) => {
      const rerankScore = getConversationRecallRerankScore({
        query,
        result,
        queryTerms,
      });
      return {
        ...result,
        recallRerankScore: rerankScore,
      };
    })
    .sort((a, b) => {
      if (b.recallRerankScore !== a.recallRerankScore) {
        return b.recallRerankScore - a.recallRerankScore;
      }
      return a.distance - b.distance;
    });
};

/**
 *
 * @param {Object} options
 * @param {ServerRequest} options.req
 * @param {Agent['tool_resources']} options.tool_resources
 * @param {string} [options.agentId] - The agent ID for file access control
 * @returns {Promise<{
 *   files: Array<{ file_id: string; filename: string }>,
 *   toolContext: string
 * }>}
 */
const primeFiles = async (options) => {
  const { tool_resources, req, agentId } = options;
  const file_ids = tool_resources?.[EToolResources.file_search]?.file_ids ?? [];
  const agentResourceIds = new Set(file_ids);
  const resourceFiles = tool_resources?.[EToolResources.file_search]?.files ?? [];

  // Get all files first
  const allFiles = (await getFiles({ file_id: { $in: file_ids } }, null, { text: 0 })) ?? [];

  // Filter by access if user and agent are provided
  let dbFiles;
  if (req?.user?.id && agentId) {
    dbFiles = await filterFilesByAgentAccess({
      files: allFiles,
      userId: req.user.id,
      role: req.user.role,
      agentId,
    });
  } else {
    dbFiles = allFiles;
  }

  dbFiles = dedupeFilesById(dbFiles.concat(resourceFiles));

  let toolContext = `- Note: Semantic search is available through the ${Tools.file_search} tool but no files are currently loaded. Request the user to upload documents to search through.`;

  const files = [];
  for (let i = 0; i < dbFiles.length; i++) {
    const file = dbFiles[i];
    if (!file) {
      continue;
    }
    if (i === 0) {
      toolContext = `- Note: Use the ${Tools.file_search} tool to find relevant information within:`;
    }
    toolContext += `\n\t- ${file.filename}${
      agentResourceIds.has(file.file_id) ? '' : ' (just attached by user)'
    }`;
    files.push({
      file_id: file.file_id,
      filename: file.filename,
      /* === VIVENTIUM START ===
       * Feature: Meeting transcript retrieval provenance
       * Reason: The file_search tool needs DB metadata to show transcript artifact headers.
       */
      context: file.context,
      metadata: file.metadata,
      /* === VIVENTIUM END === */
      viventiumConversationRecallMode: file?.viventiumConversationRecallMode,
      /* === VIVENTIUM START ===
       * Feature: Meeting transcript retrieval provenance
       */
      viventiumMeetingTranscriptRecall: file?.viventiumMeetingTranscriptRecall,
      /* === VIVENTIUM END === */
    });
  }

  return { files, toolContext };
};

/**
 *
 * @param {Object} options
 * @param {string} options.userId
 * @param {Array<{ file_id: string; filename: string }>} options.files
 * @param {string} [options.entity_id]
 * @param {boolean} [options.fileCitations=false] - Whether to include citation instructions
 * @returns
 */
const createFileSearchTool = async ({
  userId,
  files,
  entity_id,
  conversationId,
  fileCitations = false,
}) => {
  const hasMeetingTranscriptResources = files.some((file) => isMeetingTranscriptFileId(file?.file_id));
  const meetingTranscriptDescription = hasMeetingTranscriptResources
    ? '\n\nWhen meeting transcript recall is attached, a meeting transcript inventory/TOC may be returned as source-backed evidence. Use it to orient broad questions about what transcript meetings exist, then use individual detailed transcript summaries for the actual meeting details. Treat transcript evidence as softer than direct chat/saved memory.'
    : '';
  return tool(
    async ({ query }) => {
      if (files.length === 0) {
        return ['No files to search. Instruct the user to add files for the search.', undefined];
      }
      const jwtToken = generateShortLivedToken(userId);
      if (!jwtToken) {
        return [getFileSearchFailureOutput(), undefined];
      }

      /**
       * @param {import('librechat-data-provider').TFile} file
       * @returns {{ file_id: string, query: string, k: number, entity_id?: string }}
       */
      const createQueryBody = (file) => {
        const body = {
          file_id: file.file_id,
          query,
          k: getFileSearchTopKForFile(file),
        };
        if (!entity_id) {
          return body;
        }
        body.entity_id = entity_id;
        logger.debug(`[${Tools.file_search}] RAG API /query body`, body);
        return body;
      };

      const literalCandidates = extractRecallLiteralCandidates(query);
      const recallFiles = files.filter((file) => isConversationRecallFileId(file?.file_id));
      const recallFilesNeedSourceFallback = recallFiles.some((file) =>
        isSourceOnlyConversationRecallFile(file),
      );

      /* === VIVENTIUM START ===
       * Feature: Structured file_search query observability + error differentiation
       *
       * Purpose:
       * - Emit per-query structured logs (latencyMs, isRecall, timedOut, resultCount)
       *   so failure modes (timeout vs empty hit vs auth error) are distinguishable.
       * - Return distinct user-facing messages for timeout/error vs genuinely empty results.
       * - Add low-intent guard: skip recall files when query has no substantive content
       *   (e.g. "yo", "hi") to avoid unnecessary RAG calls, while keeping regular file
       *   search fully intact.
       *
       * Added: 2026-02-20
       * === VIVENTIUM END === */
      let queryErrorCount = 0;

      const queryFiles = async (targetFiles) => {
        const queryPromises = targetFiles.map(async (file) => {
          const isRecall = isConversationRecallFileId(file?.file_id);
          if (isMeetingTranscriptInventoryFile(file)) {
            const inventoryText = getMeetingTranscriptInventoryText(file);
            logger.debug(`[${Tools.file_search}] using source-backed meeting transcript inventory`, {
              fileId: file.file_id,
              hasInventoryText: Boolean(inventoryText),
            });
            return inventoryText
              ? {
                  file,
                  response: {
                    data: [
                      [
                        {
                          page_content: inventoryText,
                          metadata: { source: file.filename || 'meeting-transcript-inventory.txt' },
                        },
                        DEFAULT_FILE_SEARCH_DISTANCE_MEETING_TRANSCRIPT_INVENTORY,
                      ],
                    ],
                  },
                }
              : { file, response: { data: [] } };
          }
          if (isSourceOnlyConversationRecallFile(file)) {
            logger.debug(
              `[${Tools.file_search}] skipping vector query for source-only recall file`,
              {
                fileId: file.file_id,
              },
            );
            return { file, response: { data: [] } };
          }
          const queryStart = Date.now();
          try {
            const fileSearchQueryTimeoutMs = getFileSearchQueryTimeoutMsForFile(file);
            const response = await axios.post(
              `${process.env.RAG_API_URL}/query`,
              createQueryBody(file),
              {
                headers: {
                  Authorization: `Bearer ${jwtToken}`,
                  'Content-Type': 'application/json',
                },
                timeout: fileSearchQueryTimeoutMs,
              },
            );
            const resultCount = Array.isArray(response?.data) ? response.data.length : 0;
            logger.debug(`[${Tools.file_search}] query ok`, {
              fileId: file.file_id,
              isRecall,
              latencyMs: Date.now() - queryStart,
              resultCount,
            });
            return { file, response };
          } catch (error) {
            const latencyMs = Date.now() - queryStart;
            const timedOut = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT';
            queryErrorCount += 1;
            logger.error(`[${Tools.file_search}] query failed`, {
              fileId: file.file_id,
              isRecall,
              latencyMs,
              timedOut,
              code: error?.code,
              status: error?.response?.status,
              message: error?.message,
            });
            return null;
          }
        });

        const results = await Promise.all(queryPromises);
        return results.filter(
          (result) => result?.response && Array.isArray(result?.response?.data),
        );
      };

      const hasAnyMatches = (results) =>
        Array.isArray(results) &&
        results.some(
          (result) => Array.isArray(result?.response?.data) && result.response.data.length > 0,
        );

      const validResults = await queryFiles(files);

      let formattedResults = validResults
        .flatMap(({ file, response }) =>
          response.data.map(([docInfo, distance]) => {
            const source = isMeetingTranscriptFileId(file?.file_id)
              ? file.filename || docInfo?.metadata?.source || 'unknown'
              : docInfo?.metadata?.source || file.filename || 'unknown';
            return {
              filename: source.split('/').pop(),
              content: docInfo?.page_content,
              distance,
              file_id: file.file_id,
              page: docInfo?.metadata?.page || null,
              fileMetadata: file.metadata,
            };
          }),
        )
        .filter(
          (result) =>
            Number.isFinite(result?.distance) &&
            typeof result?.content === 'string' &&
            result.content.trim().length > 0,
        );

      let hasConversationRecallResults = formattedResults.some((result) =>
        isConversationRecallFileId(result.file_id),
      );
      let hasMeetingTranscriptResults = formattedResults.some((result) =>
        isMeetingTranscriptFileId(result.file_id),
      );

      if (hasConversationRecallResults) {
        formattedResults = rerankConversationRecallResults({ query, results: formattedResults });
      }

      const shouldAttemptSourceRescue = recallFiles.length > 0;

      if (recallFiles.length > 0 && shouldAttemptSourceRescue) {
        const sourceRescueResults = await searchConversationRecallSourceMatches({
          userId,
          conversationId,
          recallFiles,
          query,
          literalCandidates,
        });

        if (sourceRescueResults.length > 0) {
          logger.info(`[${Tools.file_search}] conversation recall source rescue hit`, {
            recallFileCount: recallFiles.length,
            rescueCount: sourceRescueResults.length,
          });
          formattedResults = dedupeRecallResults(formattedResults.concat(sourceRescueResults));
          hasConversationRecallResults = formattedResults.some((result) =>
            isConversationRecallFileId(result.file_id),
          );
          hasMeetingTranscriptResults = formattedResults.some((result) =>
            isMeetingTranscriptFileId(result.file_id),
          );
          if (hasConversationRecallResults) {
            formattedResults = rerankConversationRecallResults({
              query,
              results: formattedResults,
            });
          }
        }
      }

      if (formattedResults.length === 0) {
        const msg =
          queryErrorCount > 0
            ? getFileSearchFailureOutput()
            : getNoMatchingContentOutput({ files, recallFiles });
        return [msg, undefined];
      }

      if (!hasConversationRecallResults) {
        formattedResults.sort((a, b) => a.distance - b.distance);
      }

      if (formattedResults.length === 0) {
        return [
          'No content found in the files. The files may not have been processed correctly or you may need to refine your query.',
          undefined,
        ];
      }

      const maxResults = Math.max(
        hasConversationRecallResults ? getConversationRecallFileSearchMaxResults() : 0,
        hasMeetingTranscriptResults ? getMeetingTranscriptFileSearchMaxResults() : 0,
        !hasConversationRecallResults && !hasMeetingTranscriptResults
          ? getFileSearchMaxResults()
          : 0,
      );
      const outputMaxChars = Math.max(
        hasConversationRecallResults ? getConversationRecallFileSearchOutputMaxChars() : 0,
        hasMeetingTranscriptResults ? getMeetingTranscriptFileSearchOutputMaxChars() : 0,
        !hasConversationRecallResults && !hasMeetingTranscriptResults
          ? getFileSearchOutputMaxChars()
          : 0,
      );

      const limitedResults = formattedResults.slice(0, maxResults);
      const includedResults = [];
      let usedOutputChars = 0;

      for (let index = 0; index < limitedResults.length; index += 1) {
        const result = limitedResults[index];
        const resultMaxChars = isConversationRecallFileId(result.file_id)
          ? getConversationRecallFileSearchResultMaxChars()
          : isMeetingTranscriptInventoryFile({ file_id: result.file_id, metadata: result.fileMetadata })
            ? getMeetingTranscriptInventoryFileSearchResultMaxChars()
            : isMeetingTranscriptFileId(result.file_id)
              ? getMeetingTranscriptFileSearchResultMaxChars()
              : getFileSearchResultMaxChars();
        const content = isMeetingTranscriptInventoryFile({
          file_id: result.file_id,
          metadata: result.fileMetadata,
        })
          ? clipInventoryContent(result.content, resultMaxChars)
          : clipContent(result.content, resultMaxChars);
        const modelContent = withMeetingTranscriptHeader(result, content);
        const displayRelevance = Number.isFinite(result?.recallRerankScore)
          ? result.recallRerankScore
          : 1.0 - result.distance;
        const block = `File: ${result.filename}${
          fileCitations ? `\nAnchor: \\ue202turn0file${index} (${result.filename})` : ''
        }\nRelevance: ${displayRelevance.toFixed(4)}\nContent: ${modelContent}\n`;
        const separator = includedResults.length ? '\n---\n' : '';
        if (usedOutputChars + separator.length + block.length > outputMaxChars) {
          break;
        }
        includedResults.push({ ...result, content, modelContent });
        usedOutputChars += separator.length + block.length;
      }

      if (!includedResults.length) {
        return [
          'Search results were too large to return safely. Please refine your query for a narrower answer.',
          undefined,
        ];
      }

      const formattedString = includedResults
        .map((result, index) => {
          const displayRelevance = Number.isFinite(result?.recallRerankScore)
            ? result.recallRerankScore
            : 1.0 - result.distance;
          return `File: ${result.filename}${
            fileCitations ? `\nAnchor: \\ue202turn0file${index} (${result.filename})` : ''
          }\nRelevance: ${displayRelevance.toFixed(4)}\nContent: ${
            result.modelContent || result.content
          }\n`;
        })
        .join('\n---\n');

      const sources = includedResults.map((result) => ({
        relevance: Number.isFinite(result?.recallRerankScore)
          ? result.recallRerankScore
          : 1.0 - result.distance,
        type: 'file',
        fileId: result.file_id,
        content: result.modelContent || result.content,
        fileName: result.filename,
        pages: result.page ? [result.page] : [],
        pageRelevance: result.page
          ? {
              [result.page]: Number.isFinite(result?.recallRerankScore)
                ? result.recallRerankScore
                : 1.0 - result.distance,
            }
          : {},
      }));

      return [formattedString, { [Tools.file_search]: { sources, fileCitations } }];
    },
    {
      name: Tools.file_search,
      responseFormat: 'content_and_artifact',
      description: `Performs semantic search across attached "${Tools.file_search}" documents using natural language queries. This tool analyzes the content of uploaded files to find relevant information, quotes, and passages that best match your query. Use this to extract specific information or find relevant sections within the available documents.${meetingTranscriptDescription}${'\n\nPreserve distinctive exact strings from the user when they matter, such as IDs, codes, quoted phrases, names, and email addresses. Do not paraphrase them away in the query.'}${
        fileCitations
          ? `

**CITE FILE SEARCH RESULTS:**
Use the EXACT anchor markers shown below (copy them verbatim) immediately after statements derived from file content. Reference the filename in your text:
- File citation: "The document.pdf states that... \\ue202turn0file0"  
- Page reference: "According to report.docx... \\ue202turn0file1"
- Multi-file: "Multiple sources confirm... \\ue200\\ue202turn0file0\\ue202turn0file1\\ue201"

**CRITICAL:** Output these escape sequences EXACTLY as shown (e.g., \\ue202turn0file0). Do NOT substitute with other characters like † or similar symbols.
**ALWAYS mention the filename in your text before the citation marker. NEVER use markdown links or footnotes.**`
          : ''
      }`,
      schema: fileSearchJsonSchema,
    },
  );
};

module.exports = { createFileSearchTool, primeFiles, fileSearchJsonSchema };
