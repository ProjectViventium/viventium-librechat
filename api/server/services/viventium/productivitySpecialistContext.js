/* === VIVENTIUM START ===
 * File: api/server/services/viventium/productivitySpecialistContext.js
 *
 * Purpose:
 * - Keep Google Workspace / MS365 specialist agents grounded on the current request instead of
 *   stale assistant claims or long-term memory.
 * - Surface direct Google file IDs from pasted links so specialists prefer deterministic file
 *   retrieval over brittle search-by-ID guesses.
 *
 * Why:
 * - Productivity specialists are operational tool agents, not broad conversational memory agents.
 * - Replaying stale assistant/tool-failure text into these agents causes them to repeat old
 *   "can't access" claims even when the MCP tools work in the current run.
 *
 * Added: 2026-03-11
 * === VIVENTIUM END === */

'use strict';

const {
  resolveClarifiedLiveEmailProviderIntent,
  resolveLiveEmailProviderIntent,
} = require('~/server/services/viventium/liveEmailIntent');

const PRODUCTIVITY_PROVIDER_PATTERN =
  /\b(?:gmail|google(?:\s+workspace)?|google\s+(?:drive|docs?|sheets?|calendar)|outlook|microsoft(?:\s*365)?|ms365|office\s*365|onedrive|teams|planner|onenote)\b/i;
const PRODUCTIVITY_ACTION_SCOPE_PATTERN =
  /\b(?:calendar|meeting|meetings|event|events|drive|docs?|document|documents|sheets?|spreadsheet|spreadsheets|emails?|mail|inbox|reply|replies|response|responses|onedrive|teams|planner|onenote)\b/i;
const PRODUCTIVITY_ACTION_VERB_PATTERN =
  /\b(?:check|scan|search|read|review|summari[sz]e|get|pull|find|open|show|list|draft|write|create|schedule|share|sync)\b/i;
const PRODUCTIVITY_STATUS_PATTERNS = [
  /\bwhat\b[\s\S]{0,24}\b(?:meetings|events|calendar|emails?|inbox)\b/i,
  /\bdo i have\b[\s\S]{0,24}\b(?:meetings|events|emails?|mail|calendar)\b/i,
  /\bwhat(?:'s| is)\b[\s\S]{0,24}\b(?:on|in)\b[\s\S]{0,16}\b(?:calendar|inbox)\b/i,
];
const PRODUCTIVITY_SCOPE_KEYS = new Set(['google_workspace', 'ms365']);

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) {
          return '';
        }
        if (typeof part === 'string') {
          return part;
        }
        if (part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        if (typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') {
      return content.text;
    }
    if (typeof content.content === 'string') {
      return content.content;
    }
    if (content.text && typeof content.text === 'object' && typeof content.text.value === 'string') {
      return content.text.value;
    }
  }

  return '';
}

function getMessageRole(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }

  if (typeof message.getType === 'function') {
    try {
      const type = String(message.getType() || '').toLowerCase();
      if (type === 'human') {
        return 'user';
      }
      if (type === 'ai') {
        return 'assistant';
      }
      return type;
    } catch {
      // Fall through to persisted-message heuristics.
    }
  }

  const role = String(message.role || '').toLowerCase();
  if (role === 'human') {
    return 'user';
  }
  if (role === 'ai') {
    return 'assistant';
  }
  if (role) {
    return role;
  }

  const sender = String(message.sender || '').toLowerCase();
  if (sender === 'user') {
    return 'user';
  }
  if (sender) {
    return 'assistant';
  }

  if (message.isCreatedByUser === true) {
    return 'user';
  }

  return '';
}

function getLatestUserText(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  for (let i = safeMessages.length - 1; i >= 0; i -= 1) {
    const message = safeMessages[i];
    if (getMessageRole(message) !== 'user') {
      continue;
    }

    const text = normalizeText(
      extractTextFromContent(message.content ?? message.text ?? message.message ?? ''),
    );
    if (text) {
      return text;
    }
  }

  return '';
}

function hasExplicitProductivityRequest(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return false;
  }

  if (resolveLiveEmailProviderIntent(normalized) !== 'none') {
    return true;
  }

  if (resolveClarifiedLiveEmailProviderIntent(normalized) !== 'none') {
    return true;
  }

  if (PRODUCTIVITY_STATUS_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return (
    PRODUCTIVITY_ACTION_VERB_PATTERN.test(normalized) &&
    (PRODUCTIVITY_ACTION_SCOPE_PATTERN.test(normalized) ||
      PRODUCTIVITY_PROVIDER_PATTERN.test(normalized))
  );
}

function isProviderOnlyProductivityClarification(text) {
  const normalized = normalizeText(text);
  if (!normalized || !PRODUCTIVITY_PROVIDER_PATTERN.test(normalized)) {
    return false;
  }

  return !hasExplicitProductivityRequest(normalized);
}

function normalizeProductivityScopeOverride(scope) {
  const normalized = normalizeText(scope)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) {
    return null;
  }
  if (normalized.startsWith('productivity_')) {
    const stripped = normalized.slice('productivity_'.length);
    return PRODUCTIVITY_SCOPE_KEYS.has(stripped) ? stripped : null;
  }
  return PRODUCTIVITY_SCOPE_KEYS.has(normalized) ? normalized : null;
}

function extractLegacyProductivityScopeHeader(agent) {
  const sources = [agent?.activation?.prompt, agent?.instructions];
  const scopeHeaderPattern = /(?:^|\n)\s*scope\s*:\s*([^\n]+)/i;

  for (const source of sources) {
    const text = normalizeText(source);
    if (!text) {
      continue;
    }
    const match = String(source).match(scopeHeaderPattern);
    if (!match) {
      continue;
    }
    const normalized = normalizeProductivityScopeOverride(match[1]);
    if (normalized) {
      return normalized;
    }
  }

  return null;
}

function resolveStructuredProductivityScope(agent) {
  const runtimeScope =
    agent?.activation?.intent_scope ?? agent?.activationScope ?? agent?.activation_scope ?? null;
  return normalizeProductivityScopeOverride(runtimeScope);
}

function resolveProductivitySpecialistScope(agent, { scope = null } = {}) {
  const scopeOverride =
    normalizeProductivityScopeOverride(scope) ?? resolveStructuredProductivityScope(agent);
  if (scopeOverride) {
    return scopeOverride;
  }

  return extractLegacyProductivityScopeHeader(agent);
}

function shouldIsolateProductivitySpecialistContext(agent, { scope = null } = {}) {
  return resolveProductivitySpecialistScope(agent, { scope }) !== null;
}

function extractGoogleFileIds(text) {
  const normalized = String(text || '');
  const ids = new Set();
  const patterns = [
    /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]{20,})/gi,
    /https?:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{20,})/gi,
    /[?&]id=([A-Za-z0-9_-]{20,})/gi,
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(normalized);
    while (match) {
      ids.add(match[1]);
      match = pattern.exec(normalized);
    }
  }

  return Array.from(ids);
}

function buildProductivitySpecialistRuntimeInstructions({ agent, latestUserText, scope = null }) {
  const resolvedScope = resolveProductivitySpecialistScope(agent, { scope });
  if (!resolvedScope) {
    return '';
  }

  const sections = [
    '# Productivity Specialist Runtime Context',
    'Treat the latest user request in this run as the authoritative task request.',
    'Do not rely on prior assistant claims about tool failures, stale access issues, or old results. Re-check with tools in this run.',
  ];

  const normalizedLatestUserText = normalizeText(latestUserText);
  if (normalizedLatestUserText) {
    sections.push(`Latest user request: ${normalizedLatestUserText}`);
  }

  if (resolvedScope === 'google_workspace') {
    const googleFileIds = extractGoogleFileIds(normalizedLatestUserText);
    if (googleFileIds.length > 0) {
      sections.push(`Detected Google file IDs: ${googleFileIds.join(', ')}`);
      sections.push(
        'When Google file IDs are present, prefer direct Google Workspace retrieval tools for those IDs before search-by-name or search-by-ID queries.',
      );
      sections.push(
        'Use Drive or Docs search only as a fallback when direct retrieval for a provided ID fails.',
      );
    }
  }

  return sections.join('\n');
}

function reduceMessagesForProductivitySpecialist(messages) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  const latestUserText = getLatestUserText(safeMessages);
  if (!latestUserText) {
    return messages;
  }

  const { HumanMessage } = require('@langchain/core/messages');
  const reducedMessages = [];

  if (isProviderOnlyProductivityClarification(latestUserText)) {
    for (let i = safeMessages.length - 1; i >= 0; i -= 1) {
      const message = safeMessages[i];
      if (getMessageRole(message) !== 'user') {
        continue;
      }
      const text = normalizeText(
        extractTextFromContent(message.content ?? message.text ?? message.message ?? ''),
      );
      if (!text || text === latestUserText) {
        continue;
      }
      if (hasExplicitProductivityRequest(text)) {
        reducedMessages.push(new HumanMessage(text));
        break;
      }
    }
  }

  reducedMessages.push(new HumanMessage(latestUserText));
  return reducedMessages;
}

module.exports = {
  buildProductivitySpecialistRuntimeInstructions,
  extractGoogleFileIds,
  getLatestUserText,
  hasExplicitProductivityRequest,
  reduceMessagesForProductivitySpecialist,
  resolveProductivitySpecialistScope,
  shouldIsolateProductivitySpecialistContext,
};
