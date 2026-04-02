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

function sanitizeFollowUpDisplayText(text) {
  if (typeof text !== 'string') {
    return '';
  }
  if (isNoResponseOnly(text)) {
    return text;
  }

  const withoutNoResponseLeak = text.replace(LEADING_NTA_RE, '').replace(TRAILING_NTA_RE, '');
  return stripCitationArtifacts(withoutNoResponseLeak);
}

module.exports = {
  stripCitationArtifacts,
  sanitizeFollowUpDisplayText,
};
