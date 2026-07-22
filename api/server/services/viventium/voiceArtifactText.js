'use strict';

/* === VIVENTIUM START ===
 * Feature: Voice artifact text contract.
 *
 * Purpose:
 * - Keep one product-owned source of truth for text artifacts that must not reach
 *   voice-facing display, persistence, or TTS surfaces.
 * - Preserve semantic text while stripping transport/formatting syntax such as Markdown
 *   emphasis markers, citation markers, provider voice-control tags, code fences, and raw links.
 * - Let QA import the same detector/forbidden-key contract that runtime uses.
 *
 * Added: 2026-05-31
 * === VIVENTIUM END === */

const XAI_TTS_CAPABILITIES = require('../../../../shared/voice/xai_tts_capabilities.json');

const ARTIFACT_CONTRACT_VERSION = '2026-07-13.4';

const KNOWN_MISSING_SPACE_JOINS = Object.freeze([]);

const VOICE_CONTROL_NAMES = Object.freeze([
  'emotion',
  'break',
  'speed',
  'volume',
  'spell',
  'speak',
  ...XAI_TTS_CAPABILITIES.speech_tags.inline,
  ...XAI_TTS_CAPABILITIES.speech_tags.wrapping,
]);

const BRACKET_VOICE_MARKERS = Object.freeze([
  'laugh',
  'laughter',
  'giggle',
  'chuckle',
  'sigh',
  'gasp',
  'breath',
  'inhale',
  'exhale',
  'hmm',
  'clears throat',
  'soft laugh',
]);

const ARTIFACT_CONDITIONS = Object.freeze([
  {
    key: 'punctuationOnly',
    description: 'A TTS-bound chunk contains only punctuation or whitespace.',
  },
  {
    key: 'rawUrl',
    description: 'A raw http(s) or www URL reaches speech-facing text.',
  },
  {
    key: 'rawEmail',
    description: 'A raw email address reaches speech-facing text.',
  },
  {
    key: 'sourceLabel',
    description: 'A Sources/References/Citations label reaches speech-facing text.',
  },
  {
    key: 'markdownLink',
    description: 'Markdown link or image syntax reaches speech-facing text.',
  },
  {
    key: 'markdownEmphasis',
    description: 'Markdown emphasis or decorative marker syntax reaches voice-facing text.',
  },
  {
    key: 'codeFence',
    description: 'Backtick code formatting reaches speech-facing text.',
  },
  {
    key: 'unknownAngleTag',
    description: 'Unknown XML/HTML-like tags reach visible or speech-facing text.',
  },
  {
    key: 'voiceControlMarker',
    description:
      'Provider voice-control markup reaches a surface where provider markup is not allowed.',
  },
  {
    key: 'internalTurnId',
    description: 'Internal citation turn IDs such as turn0search4 leak to the user.',
  },
  {
    key: 'numericCitation',
    description: 'Numeric citation markers such as [1] leak to speech-facing text.',
  },
  {
    key: 'privateUseCitationMarker',
    description: 'Private-use citation marker escapes leak to the user.',
  },
  {
    key: 'knownMissingSpaceJoin',
    description: 'Known stream-boundary missing-space joins leak to the user.',
  },
  {
    key: 'internalNoResponseMarker',
    description: 'Exact or malformed internal no-response markers leak to the user.',
  },
  {
    key: 'adjacentDuplicateWord',
    description:
      'Adjacent duplicate words caused by cumulative stream snapshots leak outside protected text.',
  },
]);

const DEFAULT_TTS_FORBIDDEN_ARTIFACT_KEYS = Object.freeze(
  ARTIFACT_CONDITIONS.map((condition) => condition.key),
);

const DEFAULT_VISIBLE_FORBIDDEN_ARTIFACT_KEYS = Object.freeze([
  'unknownAngleTag',
  'voiceControlMarker',
  'internalTurnId',
  'numericCitation',
  'privateUseCitationMarker',
  'knownMissingSpaceJoin',
  'markdownEmphasis',
  'internalNoResponseMarker',
  'adjacentDuplicateWord',
]);

const SYNTHETIC_FORBIDDEN_ARTIFACT_CASES = Object.freeze([
  { key: 'punctuationOnly', text: '...' },
  { key: 'rawUrl', text: 'Open https://example.com/report now.' },
  { key: 'rawEmail', text: 'Email qa@example.com now.' },
  { key: 'sourceLabel', text: 'Sources: link available.' },
  { key: 'markdownLink', text: 'Read [brief](https://example.com/brief).' },
  { key: 'markdownLink', text: 'Look ![chart](https://example.com/chart.png).' },
  { key: 'markdownEmphasis', text: 'Use **bold** now.' },
  { key: 'markdownEmphasis', text: 'Try _italic_ wording.' },
  { key: 'markdownEmphasis', text: '*** rule ***' },
  { key: 'markdownEmphasis', text: '*' },
  { key: 'codeFence', text: 'Use `literal literal` for the command.' },
  { key: 'codeFence', text: ['```', 'literal literal', '```'].join('\n') },
  { key: 'unknownAngleTag', text: "Hello <custom data='x'>there</custom>." },
  { key: 'voiceControlMarker', text: '<emotion value="calm"/>Hello.' },
  { key: 'voiceControlMarker', text: 'Hello [laughter] there.' },
  { key: 'internalTurnId', text: 'Answer turn0search4 continues.' },
  { key: 'numericCitation', text: 'Answer [12]. Next.' },
  { key: 'privateUseCitationMarker', text: 'Answer \\ue202turn0search4 continues.' },
  { key: 'privateUseCitationMarker', text: 'Answer \uE202turn0search4 continues.' },
  { key: 'knownMissingSpaceJoin', text: 'Nice, invoiceCleared is done.' },
  { key: 'knownMissingSpaceJoin', text: "Tell me what'sNext." },
  { key: 'internalNoResponseMarker', text: 'The marker {NTA} leaked.' },
  { key: 'internalNoResponseMarker', text: 'The marker {N{NTATA}} leaked.' },
  { key: 'internalNoResponseMarker', text: 'The marker {NTA leaked.' },
  { key: 'internalNoResponseMarker', text: 'The marker {N{NTA leaked.' },
  { key: 'internalNoResponseMarker', text: 'The marker {N{N{NTA}}} leaked.' },
  { key: 'adjacentDuplicateWord', text: 'Tell Tell me me what what happened happened.' },
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectProtectedTextRanges(text) {
  const value = String(text || '');
  const ranges = [];
  const addRegexRanges = (regex) => {
    let match;
    while ((match = regex.exec(value))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  };

  addRegexRanges(/```[\s\S]*?```/g);
  addRegexRanges(/`[^`\n]+`/g);
  addRegexRanges(/"(?:\\.|[^"\\])*"/g);
  addRegexRanges(/“[^”]*”/g);
  addRegexRanges(/‘[^’]*’/g);
  addRegexRanges(/(^|\n)[ \t]*>[^\n]*/g);

  return ranges
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0])
    .reduce((merged, range) => {
      const last = merged[merged.length - 1];
      if (!last || range[0] > last[1]) {
        merged.push(range);
        return merged;
      }
      last[1] = Math.max(last[1], range[1]);
      return merged;
    }, []);
}

function stripProtectedTextRanges(text) {
  const value = String(text || '');
  let out = value;
  for (const [start, end] of collectProtectedTextRanges(value).sort((a, b) => b[0] - a[0])) {
    out = `${out.slice(0, start)}${' '.repeat(end - start)}${out.slice(end)}`;
  }
  return out;
}

function createVoiceControlMarkerRegex() {
  const angleNames = VOICE_CONTROL_NAMES.map(escapeRegExp).join('|');
  const bracketNames = BRACKET_VOICE_MARKERS.map(escapeRegExp).join('|');
  return new RegExp(
    `(?:<\\/?(?:${angleNames})(?:\\s+[^<>]*)?\\/?>|\\[\\s*(?:\\/?\\s*)?(?:${bracketNames})\\s*\\])`,
    'i',
  );
}

const VOICE_CONTROL_MARKER_RE = createVoiceControlMarkerRegex();
const CAMELCASE_MISSING_SPACE_JOIN_RE =
  /\b(?:[a-z]{3,}[A-Z][A-Za-z]{2,}|[a-z]+['’][a-z]{1,}[A-Z][a-z]{2,})\b/;
const INLINE_MARKDOWN_EMPHASIS_RE =
  /(^|[^\w])(?:\*{1,3}|_{1,3}|~~)(?=\S)[^\n]*?\S(?:\*{1,3}|_{1,3}|~~)(?!\w)/;
const SPACED_MARKDOWN_DECORATION_RE =
  /(^|[^\w])(?:\*{3}|_{3}|~{3})\s+[^*_~\n]+?\s+(?:\*{3}|_{3}|~{3})(?!\w)/;
const MARKDOWN_MARKER_ONLY_RE = /^\s*(?:[*_~]\s*)+\s*$/;
const LEGITIMATE_ADJACENT_DUPLICATE_WORDS = new Set(['had had', 'is is', 'that that']);

const MARKDOWN_SPACED_DECORATION_STRIP_RE =
  /(^|[^\w])(?:\*{3}|_{3}|~{3})\s+([^*_~\n]+?)\s+(?:\*{3}|_{3}|~{3})(?!\w)/g;
const MARKDOWN_EMPHASIS_STRIP_RE =
  /(^|[^\w])(?:\*{1,3}|_{1,3}|~~)(?=\S)([^\n]*?\S)(?:\*{1,3}|_{1,3}|~~)(?!\w)/g;
const MARKDOWN_MARKER_ONLY_LINE_RE = /(^|\n)\s*(?:[*_~]\s*)+\s*(?=\n|$)/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;
const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const REFERENCE_DEF_RE = /^\s*\[[^\]]+\]:\s+\S+.*$/gm;
const SOURCE_REFERENCE_LINK_LINE_RE =
  /^\s*(?:sources?|references?|citations?)\s*:\s*(?:(?:https?:\/\/\S+|\[[^\]]+\]\([^)]+\)|\S+\.\S+)(?:\s*,?\s*)?)+\s*$\n?/gim;
const SOURCE_REFERENCE_LABEL_RE = /\b(?:sources?|references?|citations?)\s*:/gi;
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const GENERIC_ANGLE_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^<>]*)?>/g;
const NUMERIC_CITATION_RE = /\[(?:\d{1,3})\](?=\s|[.,;:!?)]|$)/g;
const PRIVATE_USE_CITATION_RE =
  /(?:\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\uE200-\uE206])/gi;
const INTERNAL_TURN_ID_RE = /\bturn\d+[A-Za-z]+\d+\b/gi;
const INTERNAL_NO_RESPONSE_RE =
  /(^|[^$])\{(?:[NTA{}]*)N(?:[NTA{}]*)T(?:[NTA{}]*)A(?:[NTA{}]*)\}?/gi;
const WHITESPACE_BEFORE_PUNCT_RE = /\s+([.,!?;:])/g;
const SENTENCE_SPACE_RE = /([.!?])([A-Z])/g;

function countAdjacentDuplicateWords(text) {
  const value = String(text || '');
  const regex = /\b([A-Za-z][A-Za-z']{1,})\b[\s.,!?;:]+\1\b/gi;
  let count = 0;
  let match;
  while ((match = regex.exec(value))) {
    const pair = `${match[1]} ${match[1]}`.toLowerCase();
    if (!LEGITIMATE_ADJACENT_DUPLICATE_WORDS.has(pair)) {
      count += 1;
    }
  }
  return count;
}

function artifactCounts(text) {
  const value = String(text || '');
  const unprotectedValue = stripProtectedTextRanges(value);
  return {
    punctuationOnly: /^[\s.,!?;:…]+$/.test(value.trim()) && value.trim().length > 0 ? 1 : 0,
    rawUrl: /\bhttps?:\/\/|\bwww\./i.test(value) ? 1 : 0,
    rawEmail: /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(value) ? 1 : 0,
    sourceLabel: /\b(?:sources?|references?|citations?)\s*:/i.test(value) ? 1 : 0,
    markdownLink: /!?\[[^\]]+\]\([^)]+\)/.test(value) ? 1 : 0,
    markdownEmphasis:
      INLINE_MARKDOWN_EMPHASIS_RE.test(unprotectedValue) ||
      SPACED_MARKDOWN_DECORATION_RE.test(unprotectedValue) ||
      MARKDOWN_MARKER_ONLY_RE.test(unprotectedValue)
        ? 1
        : 0,
    codeFence: /```|`[^`]+`/.test(value) ? 1 : 0,
    unknownAngleTag: /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^<>]*)?>/.test(value) ? 1 : 0,
    voiceControlMarker: VOICE_CONTROL_MARKER_RE.test(value) ? 1 : 0,
    internalTurnId: /turn\d+[A-Za-z]+\d+/i.test(value) ? 1 : 0,
    numericCitation: /\[(?:\d{1,3})\](?=\s|[.,;:!?)]|$)/.test(value) ? 1 : 0,
    privateUseCitationMarker:
      /(?:\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\uE200-\uE206])/i.test(value)
        ? 1
        : 0,
    knownMissingSpaceJoin: CAMELCASE_MISSING_SPACE_JOIN_RE.test(unprotectedValue) ? 1 : 0,
    internalNoResponseMarker: /(^|[^$])\{(?:[NTA{}]*)N(?:[NTA{}]*)T(?:[NTA{}]*)A/i.test(value)
      ? 1
      : 0,
    adjacentDuplicateWord: countAdjacentDuplicateWords(unprotectedValue) > 0 ? 1 : 0,
  };
}

function addCounts(target, source) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] || 0) + Number(value || 0);
  }
}

function sumForbiddenArtifacts(counts, keys = DEFAULT_TTS_FORBIDDEN_ARTIFACT_KEYS) {
  return keys.reduce((sum, key) => sum + Number((counts || {})[key] || 0), 0);
}

function isDisplayStageDirectionBoundary(ch) {
  return !ch || /\s/.test(ch) || '.,!?;:(){}<>"\''.includes(ch);
}

function isBracketStageDirection(content) {
  const candidate = typeof content === 'string' ? content.trim() : '';
  if (!candidate || candidate !== candidate.toLowerCase()) {
    return false;
  }
  if (/\d/.test(candidate)) {
    return false;
  }
  if (!/^[a-z' -]+$/.test(candidate)) {
    return false;
  }

  const alphaCount = (candidate.match(/[a-z]/g) || []).length;
  if (alphaCount < 3 || alphaCount > 24) {
    return false;
  }

  const words = candidate.replace(/-/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) {
    return false;
  }
  return words.every((word) => /^[a-z']+$/.test(word));
}

function stripBracketStageDirections(text) {
  if (!text) {
    return '';
  }

  let out = '';
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '[') {
      out += text[index];
      index += 1;
      continue;
    }

    const closing = text.indexOf(']', index + 1);
    if (closing < 0) {
      out += text[index];
      index += 1;
      continue;
    }

    const content = text.slice(index + 1, closing);
    const left = index > 0 ? text[index - 1] : '';
    const right = closing + 1 < text.length ? text[closing + 1] : '';
    if (
      isBracketStageDirection(content) &&
      isDisplayStageDirectionBoundary(left) &&
      isDisplayStageDirectionBoundary(right)
    ) {
      index = closing + 1;
      continue;
    }

    out += text.slice(index, closing + 1);
    index = closing + 1;
  }

  return out;
}

function stripMarkdownEmphasisSyntax(text) {
  let cleaned = String(text || '');
  cleaned = cleaned.replace(
    MARKDOWN_SPACED_DECORATION_STRIP_RE,
    (_match, prefix, inner) => `${prefix}${inner || ''}`,
  );
  for (let pass = 0; pass < 4; pass += 1) {
    const updated = cleaned.replace(
      MARKDOWN_EMPHASIS_STRIP_RE,
      (_match, prefix, inner) => `${prefix}${inner || ''}`,
    );
    if (updated === cleaned) {
      break;
    }
    cleaned = updated;
  }
  cleaned = cleaned.replace(MARKDOWN_MARKER_ONLY_LINE_RE, '$1 ');
  return cleaned;
}

function stripVoiceControlTags(text) {
  let cleaned = String(text || '');
  const angleNames = VOICE_CONTROL_NAMES.map(escapeRegExp).join('|');
  const angleTagRe = new RegExp(`</?(?:${angleNames})(?:\\s+[^<>]*)?\\/?>`, 'gi');
  const bracketTagRe = new RegExp(`\\[\\s*/?\\s*(?:${angleNames})\\s*\\]`, 'gi');
  const wrappingNames = XAI_TTS_CAPABILITIES.speech_tags.wrapping.map(escapeRegExp).join('|');
  const wrappingRe = new RegExp(`<(${wrappingNames})(?:\\s+[^<>]*)?>(.*?)</\\1>`, 'gis');
  let previous;
  do {
    previous = cleaned;
    cleaned = cleaned.replace(wrappingRe, '$2');
  } while (cleaned !== previous);
  cleaned = cleaned.replace(angleTagRe, '');
  cleaned = cleaned.replace(bracketTagRe, '');
  cleaned = cleaned.replace(VOICE_CONTROL_MARKER_RE, '');
  return stripBracketStageDirections(cleaned);
}

function normalizeVoiceSurfaceWhitespace(text) {
  return String(text || '')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(WHITESPACE_BEFORE_PUNCT_RE, (match, punct, offset, value) => {
      if (punct === '.') {
        const next = value[offset + match.length] || '';
        const afterNext = value[offset + match.length + 1] || '';
        if (/[A-Z]/.test(next) && /[A-Z]/.test(afterNext)) {
          return match;
        }
      }
      return punct;
    })
    .replace(SENTENCE_SPACE_RE, (match, punct, next, offset, value) => {
      if (punct !== '.') {
        return `${punct} ${next}`;
      }
      const previous = offset > 0 ? value[offset - 1] : '';
      const afterNext = offset + 2 < value.length ? value[offset + 2] : '';
      if (/\d/.test(previous)) {
        return match;
      }
      if (/[A-Z]/.test(previous) && (!afterNext || /[A-Z.]/.test(afterNext))) {
        return match;
      }
      if (/[A-Z]/.test(next) && /[A-Z]/.test(afterNext)) {
        return match;
      }
      return `${punct} ${next}`;
    })
    .trim();
}

function sanitizeVoiceSurfaceTextForDisplay(text) {
  if (typeof text !== 'string' || !text) {
    return '';
  }

  let cleaned = text.replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  cleaned = cleaned.replace(INTERNAL_NO_RESPONSE_RE, '$1');
  cleaned = cleaned.replace(CODE_BLOCK_RE, (match) =>
    match.replace(/```[A-Za-z0-9_-]*\s*/g, '').replace(/```/g, ' '),
  );
  cleaned = cleaned.replace(INLINE_CODE_RE, '$1');
  cleaned = cleaned.replace(REFERENCE_DEF_RE, ' ');
  cleaned = cleaned.replace(SOURCE_REFERENCE_LINK_LINE_RE, ' ');
  cleaned = cleaned.replace(SOURCE_REFERENCE_LABEL_RE, '');
  cleaned = cleaned.replace(MARKDOWN_IMAGE_RE, (_match, label) => label || 'image available');
  cleaned = cleaned.replace(MARKDOWN_LINK_RE, '$1');
  cleaned = stripMarkdownEmphasisSyntax(cleaned);
  cleaned = stripVoiceControlTags(cleaned);
  cleaned = cleaned.replace(PRIVATE_USE_CITATION_RE, '');
  cleaned = cleaned.replace(INTERNAL_TURN_ID_RE, '');
  cleaned = cleaned.replace(NUMERIC_CITATION_RE, '');
  cleaned = cleaned.replace(EMAIL_RE, 'address available');
  cleaned = cleaned.replace(URL_RE, 'link available');
  cleaned = cleaned.replace(GENERIC_ANGLE_TAG_RE, '');
  cleaned = normalizeVoiceSurfaceWhitespace(cleaned);
  return cleaned;
}

function extractVoiceTextFromContentParts(contentParts = []) {
  if (!Array.isArray(contentParts) || contentParts.length === 0) {
    return '';
  }
  return contentParts
    .filter((part) => part?.type === 'text')
    .map((part) => {
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.text?.value === 'string') {
        return part.text.value;
      }
      if (typeof part?.text?.text === 'string') {
        return part.text.text;
      }
      return '';
    })
    .join('');
}

function sanitizeVoiceContentPartsForPersistence(contentParts = []) {
  if (!Array.isArray(contentParts)) {
    return contentParts;
  }

  let changed = false;
  const sanitized = [];
  for (const part of contentParts) {
    if (!part || typeof part !== 'object') {
      sanitized.push(part);
      continue;
    }

    if (part.type === 'think' || part.type === 'reasoning') {
      changed = true;
      continue;
    }

    if (part.type !== 'text') {
      sanitized.push(part);
      continue;
    }

    const rawText =
      typeof part.text === 'string'
        ? part.text
        : typeof part.text?.value === 'string'
          ? part.text.value
          : typeof part.text?.text === 'string'
            ? part.text.text
            : '';
    const cleanedText = sanitizeVoiceSurfaceTextForDisplay(rawText);
    if (cleanedText === rawText) {
      sanitized.push(part);
      continue;
    }

    changed = true;
    if (typeof part.text === 'string') {
      sanitized.push({
        ...part,
        text: cleanedText,
      });
      continue;
    }
    if (part.text && typeof part.text === 'object') {
      sanitized.push({
        ...part,
        text: {
          ...part.text,
          value:
            typeof part.text.value === 'string' || typeof part.text.text !== 'string'
              ? cleanedText
              : part.text.value,
          text: typeof part.text.text === 'string' ? cleanedText : part.text.text,
        },
      });
      continue;
    }
    sanitized.push({
      ...part,
      text: cleanedText,
    });
  }

  return changed ? sanitized : contentParts;
}

function sanitizeVoiceAssistantMessageForPersistence(req, message) {
  if (req?.body?.voiceMode !== true || message?.isCreatedByUser === true) {
    return message;
  }

  const out = { ...message };
  if (Array.isArray(out.content)) {
    out.content = sanitizeVoiceContentPartsForPersistence(out.content);
  }

  const currentText = typeof out.text === 'string' ? out.text : '';
  const sanitizedText = sanitizeVoiceSurfaceTextForDisplay(currentText);
  const contentText = sanitizeVoiceSurfaceTextForDisplay(
    extractVoiceTextFromContentParts(out.content),
  );
  out.text = sanitizedText || contentText;
  return out;
}

module.exports = {
  ARTIFACT_CONDITIONS,
  ARTIFACT_CONTRACT_VERSION,
  BRACKET_VOICE_MARKERS,
  DEFAULT_TTS_FORBIDDEN_ARTIFACT_KEYS,
  DEFAULT_VISIBLE_FORBIDDEN_ARTIFACT_KEYS,
  KNOWN_MISSING_SPACE_JOINS,
  SYNTHETIC_FORBIDDEN_ARTIFACT_CASES,
  VOICE_CONTROL_NAMES,
  addCounts,
  artifactCounts,
  collectProtectedTextRanges,
  extractVoiceTextFromContentParts,
  sanitizeVoiceAssistantMessageForPersistence,
  sanitizeVoiceContentPartsForPersistence,
  sanitizeVoiceSurfaceTextForDisplay,
  stripProtectedTextRanges,
  sumForbiddenArtifacts,
};
