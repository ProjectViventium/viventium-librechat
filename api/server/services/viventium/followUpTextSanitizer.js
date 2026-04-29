/* === VIVENTIUM START ===
 * Feature: Follow-up text sanitization.
 * Purpose:
 * - Strip leaked `{NTA}` tags when a follow-up also contains real content.
 * - Remove LibreChat citation artifacts before persistence so web + Telegram
 *   follow-up text stays clean and surface-parity remains intact.
 * Added: 2026-03-08
 * === VIVENTIUM END === */

const { isNoResponseOnly } = require('~/server/services/viventium/noResponseTag');

const LEADING_NTA_RE = /^\s*\{\s*NTA\s*\}\s*/i;
const TRAILING_NTA_RE = /\s*\{\s*NTA\s*\}\s*$/i;
const CITATION_COMPOSITE_RE = /(?:\\ue200|ue200|\ue200).*?(?:\\ue201|ue201|\ue201)/gi;
const CITATION_STANDALONE_RE = /(?:\\ue202|ue202|\ue202)turn\d+[A-Za-z]+\d+/gi;
const CITATION_CLEANUP_RE = /(?:\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\ue200-\ue206])/gi;
const BRACKET_CITATION_RE = /\[(\d{1,3})\](?=\s|$)/g;
const LEADING_THINKING_MODE_REASONING_RE =
  /^\s*<thinking_mode\b[^>]*>[\s\S]*?<\/thinking_mode>\s*[\s\S]*?<\/thinking>\s*/i;
const LEADING_THINKING_MODE_RE = /^\s*<thinking_mode\b[^>]*>[\s\S]*?<\/thinking_mode>\s*/i;
const LEADING_REASONING_BLOCK_RES = [
  /^\s*<thinking\b[^>]*>[\s\S]*?<\/thinking>\s*/i,
  /^\s*<think\b[^>]*>[\s\S]*?<\/think>\s*/i,
  /^\s*:::thinking\s*[\r\n]*[\s\S]*?:::\s*/i,
];
const TOOL_TRANSCRIPT_LINE_RE = /^\s*Tool:\s+.*_mcp_[A-Za-z0-9_.-]+.*(?:\r?\n|$)/gim;

function stripCitationArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  return text
    .replace(CITATION_COMPOSITE_RE, ' ')
    .replace(CITATION_STANDALONE_RE, ' ')
    .replace(CITATION_CLEANUP_RE, ' ')
    .replace(BRACKET_CITATION_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/* === VIVENTIUM START ===
 * Feature: Strip leaked reasoning wrappers from Phase B follow-up text.
 * Purpose:
 * - `cortex_followup` messages are plain user-visible assistant turns, not structured reasoning
 *   payloads. If an upstream/provider path leaks reasoning wrappers into this string surface, the
 *   follow-up must persist only the visible answer so LibreChat keeps its native thinking UI for
 *   real structured turns.
 * - This stays scoped to follow-up display sanitization instead of touching the shared renderer.
 * Added: 2026-04-21
 * === VIVENTIUM END === */
function stripLeadingReasoningArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  let cleaned = text;
  let changed = false;

  do {
    changed = false;

    const withoutMalformedThinkingLeak = cleaned.replace(LEADING_THINKING_MODE_REASONING_RE, '');
    if (withoutMalformedThinkingLeak !== cleaned) {
      cleaned = withoutMalformedThinkingLeak;
      changed = true;
    }

    const withoutThinkingMode = cleaned.replace(LEADING_THINKING_MODE_RE, '');
    if (withoutThinkingMode !== cleaned) {
      cleaned = withoutThinkingMode;
      changed = true;
    }

    for (const pattern of LEADING_REASONING_BLOCK_RES) {
      const withoutReasoning = cleaned.replace(pattern, '');
      if (withoutReasoning !== cleaned) {
        cleaned = withoutReasoning;
        changed = true;
        break;
      }
    }
  } while (changed);

  return cleaned.trim();
}

function stripToolTranscriptArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }
  return text.replace(TOOL_TRANSCRIPT_LINE_RE, '').trim();
}

function sanitizeFollowUpDisplayText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  if (isNoResponseOnly(text)) {
    return text;
  }

  const withoutNoResponseLeak = text.replace(LEADING_NTA_RE, '').replace(TRAILING_NTA_RE, '');
  const withoutReasoningLeak = stripLeadingReasoningArtifacts(withoutNoResponseLeak);
  const withoutToolTranscript = stripToolTranscriptArtifacts(withoutReasoningLeak);
  return stripCitationArtifacts(withoutToolTranscript);
}

module.exports = {
  stripLeadingReasoningArtifacts,
  stripToolTranscriptArtifacts,
  stripCitationArtifacts,
  sanitizeFollowUpDisplayText,
};
