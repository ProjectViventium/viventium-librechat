/* === VIVENTIUM START ===
 * Feature: MCP OAuth wait policy (surface + intent aware)
 *
 * Purpose:
 * - Keep non-tool turns fast by avoiding OAuth wait loops and removing OAuth-pending MCP tools
 *   from the current turn's toolset.
 * - Preserve tool-driven behavior when the user clearly requests tool operations.
 *
 * Notes:
 * - Telegram/gateway surfaces never wait for OAuth in-turn (no interactive OAuth UX parity).
 * - Web/voice wait behavior is controlled by VIVENTIUM_MCP_OAUTH_WAIT_POLICY:
 *   - intent (default): wait only when tool intent is detected
 *   - always: always wait on web/voice
 *   - never: never wait
 * === VIVENTIUM END === */

const { Constants } = require('librechat-data-provider');

const DEFAULT_TOOL_INTENT_KEYWORDS = [
  'email',
  'inbox',
  'calendar',
  'meeting',
  'meetings',
  'agenda',
  'schedule',
  'scheduling',
  'task',
  'tasks',
  'todo',
  'reminder',
  'remind',
  'file',
  'files',
  'doc',
  'docs',
  'document',
  'drive',
  'spreadsheet',
  'sheets',
  'slides',
  'gmail',
  'outlook',
  'search',
  'web',
  'weather',
  'news',
  'stock',
  'price',
  'timezone',
  'availability',
  'appointment',
];

const parseKeywordEnv = (raw, fallback) => {
  const value = String(raw || '').trim();
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
};

const getToolIntentKeywords = () =>
  parseKeywordEnv(process.env.VIVENTIUM_TOOL_INTENT_KEYWORDS, DEFAULT_TOOL_INTENT_KEYWORDS);

const extractTextFromContent = (content) => {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }

  if (content && typeof content.text === 'string') {
    return content.text;
  }

  return '';
};

const extractTurnText = (req) => {
  const body = req?.body ?? {};

  if (typeof body.text === 'string' && body.text.trim()) {
    return body.text.trim();
  }

  if (typeof body.prompt === 'string' && body.prompt.trim()) {
    return body.prompt.trim();
  }

  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }

  if (Array.isArray(body.messages)) {
    for (let i = body.messages.length - 1; i >= 0; i -= 1) {
      const message = body.messages[i];
      if (!message || message.role !== 'user') {
        continue;
      }
      const text = extractTextFromContent(message.content).trim();
      if (text) {
        return text;
      }
    }
  }

  return '';
};

const hasToolIntentKeyword = (text, keywords) => {
  if (!text) {
    return false;
  }

  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) {
    return false;
  }

  const wordSet = new Set(words);
  return keywords.some((keyword) => keyword && wordSet.has(keyword));
};

const hasLikelyToolIntent = (req) => {
  if (Array.isArray(req?.body?.files) && req.body.files.length > 0) {
    return true;
  }

  const text = extractTurnText(req).toLowerCase();
  if (!text) {
    return false;
  }

  return hasToolIntentKeyword(text, getToolIntentKeywords());
};

const normalizeWaitPolicy = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'always' || normalized === 'never' || normalized === 'intent') {
    return normalized;
  }
  return 'intent';
};

const getSurface = (req) => {
  if (req?._viventiumTelegram) {
    return 'telegram';
  }
  if (req?._viventiumGateway) {
    return 'gateway';
  }
  if (req?.viventiumCallSession) {
    return 'voice';
  }
  return 'web';
};

const getMcpOAuthWaitDecision = (req) => {
  const surface = getSurface(req);
  const hasToolIntent = hasLikelyToolIntent(req);
  const mode = normalizeWaitPolicy(process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY);

  let waitForOAuth = false;
  if (surface === 'telegram' || surface === 'gateway') {
    waitForOAuth = false;
  } else if (mode === 'always') {
    waitForOAuth = true;
  } else if (mode === 'never') {
    waitForOAuth = false;
  } else {
    waitForOAuth = hasToolIntent;
  }

  return {
    mode,
    surface,
    hasToolIntent,
    waitForOAuth,
  };
};

const isOAuthPendingMcpTool = (toolName, serverNames) =>
  typeof toolName === 'string' &&
  serverNames.some((serverName) => toolName.endsWith(`${Constants.mcp_delimiter}${serverName}`));

const stripOAuthPendingMcpTools = ({ toolDefinitions, toolRegistry, pendingOAuthServers }) => {
  const serverNames = Array.from(pendingOAuthServers ?? []).filter(Boolean);
  if (serverNames.length === 0) {
    return {
      toolDefinitions,
      toolRegistry,
      removedToolNames: [],
    };
  }

  /** @type {Set<string>} */
  const removed = new Set();

  let nextToolDefinitions = toolDefinitions;
  if (Array.isArray(toolDefinitions)) {
    nextToolDefinitions = toolDefinitions.filter((definition) => {
      const name = definition?.name;
      const shouldRemove = isOAuthPendingMcpTool(name, serverNames);
      if (shouldRemove && name) {
        removed.add(name);
      }
      return !shouldRemove;
    });
  }

  let nextToolRegistry = toolRegistry;
  if (toolRegistry instanceof Map) {
    nextToolRegistry = new Map();
    for (const [name, value] of toolRegistry.entries()) {
      if (isOAuthPendingMcpTool(name, serverNames)) {
        removed.add(name);
        continue;
      }
      nextToolRegistry.set(name, value);
    }
  }

  return {
    toolDefinitions: nextToolDefinitions,
    toolRegistry: nextToolRegistry,
    removedToolNames: Array.from(removed),
  };
};

module.exports = {
  extractTurnText,
  hasLikelyToolIntent,
  getMcpOAuthWaitDecision,
  stripOAuthPendingMcpTools,
};
