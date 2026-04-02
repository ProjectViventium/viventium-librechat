/* === VIVENTIUM START ===
 * Feature: Telegram Tool Guard (fast-path)
 *
 * Purpose:
 * - Avoid long MCP/tool stalls on trivial Telegram messages (e.g., "hi").
 * - Preserve tool access when the user explicitly requests live data or scheduling.
 *
 * Behavior:
 * - Only applies to Telegram surface (req._viventiumTelegram).
 * - Skips tool loading for short messages without tool-intent keywords.
 * - Fully configurable via environment variables.
 * === VIVENTIUM END === */

const DEFAULT_KEYWORDS = [
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
  'search',
  'web',
  'weather',
  'news',
  'stock',
  'price',
  'time',
  'timezone',
  'today',
  'tomorrow',
  'tonight',
  'next',
  'week',
  'weekend',
  'month',
  'year',
  'availability',
  'free',
  'busy',
  'appointment',
];

const parseBoolEnv = (name, fallback) => {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseIntEnv = (name, fallback) => {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getGuardConfig = () => {
  const enabled = parseBoolEnv('VIVENTIUM_TELEGRAM_TOOL_GUARD_ENABLED', true);
  const maxLen = parseIntEnv('VIVENTIUM_TELEGRAM_TOOL_GUARD_MAX_LEN', 12);
  const maxWords = parseIntEnv('VIVENTIUM_TELEGRAM_TOOL_GUARD_MAX_WORDS', 6);
  const keywordEnv = (process.env.VIVENTIUM_TELEGRAM_TOOL_GUARD_KEYWORDS || '').trim();
  const keywords = keywordEnv
    ? keywordEnv
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_KEYWORDS;
  return { enabled, maxLen, maxWords, keywords };
};

const hasToolIntentKeyword = (text, keywords) => {
  if (!text) return false;
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return false;
  const wordSet = new Set(words);
  return keywords.some((keyword) => keyword && wordSet.has(keyword));
};

const shouldSkipTelegramTools = (req) => {
  if (!req || !req._viventiumTelegram) return false;
  const { enabled, maxLen, maxWords, keywords } = getGuardConfig();
  if (!enabled) return false;

  const text = typeof req.body?.text === 'string' ? req.body.text.trim().toLowerCase() : '';
  if (!text) return false;
  if (Array.isArray(req.body?.files) && req.body.files.length > 0) return false;
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  /* === VIVENTIUM START ===
   * Root-cause fix: only apply Telegram fast-path skip to truly tiny chatter.
   *
   * Why:
   * - Prior logic skipped tools whenever either length OR word-count was "short-ish",
   *   which incorrectly skipped actionable requests like:
   *   "Check Outlook has Lisa been scheduled".
   * - For parity, tool access must remain enabled for normal actionable requests.
   *
   * Behavior:
   * - Skip only when BOTH constraints indicate tiny chatter (<= maxLen AND <= maxWords),
   *   and no tool-intent keywords/files are present.
   * === VIVENTIUM END === */
  const isTinyMessage = text.length <= maxLen && words.length <= maxWords;
  if (!isTinyMessage) return false;
  if (hasToolIntentKeyword(text, keywords)) return false;
  return true;
};

module.exports = {
  shouldSkipTelegramTools,
};
