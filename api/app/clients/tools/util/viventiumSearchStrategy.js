/* === VIVENTIUM START ===
 * Feature: Search query planning + source ranking for web_search.
 *
 * Purpose:
 * - Break broad research prompts into a few focused search queries when the provider is noisy.
 * - Prefer trustworthy, directly relevant source types while demoting social/video/syndication
 *   unless the user explicitly asked for them.
 *
 * Why:
 * - SearXNG quality depends heavily on query specificity and engine mix.
 * - We need deterministic runtime ranking, aligned with source quality, not prompt-only hope.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const {
  extractQueryPhrases,
  extractQueryTerms,
  getMeaningfulOverlapScore,
} = require('./viventiumWebSearchSafety');

const SEARCH_PLANNING_STOP_TERMS = new Set([
  'also',
  'book',
  'check',
  'connecting',
  'deep',
  'dont',
  'early',
  'live',
  'losers',
  'need',
  'newbie',
  'only',
  'open',
  'other',
  'research',
  'russian',
  'sam',
  'stay',
  'there',
  'today',
  'want',
  'where',
  'working',
  'would',
]);

const QUERY_VARIANT_STOP_TERMS = new Set(['current', 'sources', 'hacker', 'news']);

const HIGH_TRUST_HOST_PATTERNS = [
  /(^|\.)news\.ycombinator\.com$/i,
  /(^|\.)linen\.cerebralvalley\.ai$/i,
  /(^|\.)sfexaminer\.com$/i,
  /(^|\.)sfstandard\.com$/i,
  /(^|\.)missionlocal\.org$/i,
  /(^|\.)sfchronicle\.com$/i,
  /(^|\.)nytimes\.com$/i,
  /(^|\.)reuters\.com$/i,
  /(^|\.)theinformation\.com$/i,
  /(^|\.)techcrunch\.com$/i,
  /(^|\.)fortune\.com$/i,
  /(^|\.)geekwire\.com$/i,
  /(^|\.)lemonde\.fr$/i,
];

const COMMUNITY_HOST_PATTERNS = [
  /(^|\.)news\.ycombinator\.com$/i,
  /(^|\.)reddit\.com$/i,
  /(^|\.)linen\.cerebralvalley\.ai$/i,
];

const SOCIAL_HOST_PATTERNS = [
  /(^|\.)instagram\.com$/i,
  /(^|\.)youtube\.com$/i,
  /(^|\.)tiktok\.com$/i,
  /(^|\.)facebook\.com$/i,
  /(^|\.)x\.com$/i,
  /(^|\.)twitter\.com$/i,
  /(^|\.)linkedin\.com$/i,
];

const SYNDICATION_HOST_PATTERNS = [
  /^finance\.yahoo\.com$/i,
  /(^|\.)msn\.com$/i,
  /(^|\.)briefly\.co$/i,
];

const LOW_SIGNAL_TITLE_PATTERNS = [
  /\bpress archives?\b/i,
  /\bcategory archive\b/i,
  /\btag archive\b/i,
  /\bbest startups?\b/i,
  /\btop \d+\b/i,
];

const DIRECTORY_HOST_PATTERNS = [
  /(^|\.)startupsavant\.com$/i,
  /(^|\.)seedtable\.com$/i,
  /(^|\.)wikipedia\.org$/i,
  /(^|\.)sfyimby\.com$/i,
  /(^|\.)builtinsf\.com$/i,
  /(^|\.)getrecall\.ai$/i,
];

const AI_INTENT_PATTERN = /\b(ai|artificial intelligence|machine learning|llm|openai|anthropic)\b/i;
const STARTUP_INTENT_PATTERN =
  /\b(founder|founders|startup|startups|seed|pre-seed|preseed|accelerator|incubator|venture|yc|y combinator)\b/i;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeQuerySpacing(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function normalizeHostname(link) {
  if (typeof link !== 'string' || link.length === 0) {
    return '';
  }

  try {
    return new URL(link).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function matchesAnyPattern(value, patterns) {
  return patterns.some((pattern) => pattern.test(value));
}

function hasStructuredSearchSyntax(query) {
  return (
    /(^|\s)site:/i.test(query ?? '') ||
    /["']/.test(query ?? '') ||
    /(?:^|\s)(?:OR|AND)(?:\s|$)/.test(query ?? '')
  );
}

function parseQueryIntent(query) {
  const lower = typeof query === 'string' ? query.toLowerCase() : '';

  return {
    wantsCurrent: /\b(current|currently|today|latest|up to date|as of|march 2026|2026)\b/i.test(
      query ?? '',
    ),
    wantsHackerNews: /\b(hn|hacker news)\b/i.test(lower),
    wantsSocialVideo:
      /\b(instagram|youtube|tiktok|twitter|x\.com|linkedin|video|videos|reel|tweet|post)\b/i.test(
        lower,
      ),
  };
}

function buildCondensedQuery(query) {
  const normalized = normalizeQuerySpacing(query);
  if (!normalized) {
    return normalized;
  }

  if (hasStructuredSearchSyntax(normalized)) {
    return normalized;
  }

  const phrases = extractQueryPhrases(query);
  const phraseTerms = new Set(
    phrases.flatMap((phrase) =>
      phrase
        .split(/\s+/)
        .map((term) => term.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  const filteredPhrases = phrases.filter(
    (phrase) => !/\b(hacker news|current sources)\b/i.test(phrase),
  );
  const filteredTerms = extractQueryTerms(query).filter(
    (term) =>
      !SEARCH_PLANNING_STOP_TERMS.has(term) &&
      !QUERY_VARIANT_STOP_TERMS.has(term) &&
      !phraseTerms.has(term),
  );
  const condensedParts = unique([...filteredPhrases, ...filteredTerms]).slice(0, 12);
  return condensedParts.length > 0 ? condensedParts.join(' ') : normalized;
}

function buildFocusedVariant(query, suffix) {
  const normalizedBase = normalizeQuerySpacing(query);
  const normalizedSuffix = normalizeQuerySpacing(suffix);
  if (!normalizedBase) {
    return '';
  }
  if (!normalizedSuffix) {
    return normalizedBase;
  }

  const lowerBase = normalizedBase.toLowerCase();
  const lowerSuffix = normalizedSuffix.toLowerCase();
  if (lowerBase.includes(lowerSuffix)) {
    return normalizedBase;
  }

  return `${normalizedBase} ${normalizedSuffix}`.trim();
}

function planSearchQueries(query) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }

  const normalized = normalizeQuerySpacing(query);
  const tokenCount = normalized.split(/\s+/).length;
  const intent = parseQueryIntent(normalized);
  const condensed = buildCondensedQuery(normalized);
  const structured = hasStructuredSearchSyntax(normalized);

  if ((normalized.length < 110 && tokenCount < 20) || structured) {
    const directQueries = [normalized];
    if (intent.wantsHackerNews) {
      directQueries.push(
        buildFocusedVariant(
          `site:news.ycombinator.com ${buildCondensedQuery(normalized)}`.trim(),
          'Hacker News',
        ),
      );
    }
    if (intent.wantsCurrent) {
      directQueries.push(buildFocusedVariant(normalized, 'current sources'));
    }

    return unique(directQueries).slice(0, 3);
  }

  if (normalized.length < 90 && tokenCount < 16) {
    return [normalized];
  }

  const planned = [condensed];

  if (intent.wantsHackerNews) {
    planned.push(`site:news.ycombinator.com ${condensed}`.trim());
  }

  if (intent.wantsCurrent) {
    planned.push(buildFocusedVariant(condensed, '2026 current sources'));
  }

  if (/\b(founder|founders|startup|startups|ai)\b/i.test(normalized)) {
    planned.push(buildFocusedVariant(condensed, 'founders community'));
  }

  return unique(planned.map((value) => normalizeQuerySpacing(value))).slice(0, 3);
}

function getRequestedPhraseMatches(query, result) {
  const requestedPhrases = extractQueryPhrases(query).filter((phrase) => {
    if (phrase.split(/\s+/).length < 2) {
      return false;
    }

    return !/\b(hacker news|current sources)\b/i.test(phrase);
  });

  if (requestedPhrases.length === 0) {
    return { requestedPhrases, matchedCount: 0 };
  }

  const haystack = `${result?.title ?? ''} ${result?.snippet ?? ''} ${
    result?.link ?? ''
  }`.toLowerCase();
  const matchedCount = requestedPhrases.filter((phrase) =>
    haystack.includes(phrase.toLowerCase()),
  ).length;

  return { requestedPhrases, matchedCount };
}

function buildResultHaystack(result) {
  return `${result?.title ?? ''} ${result?.snippet ?? ''} ${result?.link ?? ''}`.toLowerCase();
}

function getIntentCoverageScore(query, result) {
  const haystack = buildResultHaystack(result);
  const requestedFamilies = [
    AI_INTENT_PATTERN.test(query ?? ''),
    STARTUP_INTENT_PATTERN.test(query ?? ''),
  ].filter(Boolean).length;

  if (requestedFamilies === 0) {
    return 0;
  }

  const matchedFamilies = [
    AI_INTENT_PATTERN.test(query ?? '') && AI_INTENT_PATTERN.test(haystack),
    STARTUP_INTENT_PATTERN.test(query ?? '') && STARTUP_INTENT_PATTERN.test(haystack),
  ].filter(Boolean).length;

  if (matchedFamilies === 0) {
    return -4.5;
  }

  if (matchedFamilies === requestedFamilies) {
    return 2.25;
  }

  return 0.75;
}

function scoreSource(result, { query, sourceType }) {
  const hostname = normalizeHostname(result?.link);
  const title = typeof result?.title === 'string' ? result.title : '';
  const intent = parseQueryIntent(query);
  const { requestedPhrases, matchedCount } = getRequestedPhraseMatches(query, result);
  let score = getMeaningfulOverlapScore(result, extractQueryTerms(query), query);

  score += getIntentCoverageScore(query, result);

  if (matchesAnyPattern(hostname, HIGH_TRUST_HOST_PATTERNS)) {
    score += 2.5;
  }

  if (intent.wantsHackerNews && /(^|\.)news\.ycombinator\.com$/i.test(hostname)) {
    score += 2;
  }

  if (matchesAnyPattern(hostname, COMMUNITY_HOST_PATTERNS)) {
    score += 1;
  }

  if (!intent.wantsSocialVideo && matchesAnyPattern(hostname, SOCIAL_HOST_PATTERNS)) {
    score -= 4;
  }

  if (matchesAnyPattern(hostname, SYNDICATION_HOST_PATTERNS)) {
    score -= 2;
  }

  if (matchesAnyPattern(hostname, DIRECTORY_HOST_PATTERNS)) {
    score -= 3;
  }

  if (LOW_SIGNAL_TITLE_PATTERNS.some((pattern) => pattern.test(title))) {
    score -= 3;
  }

  if (requestedPhrases.length > 0) {
    if (matchedCount > 0) {
      score += 1.25 + (matchedCount - 1) * 0.25;
    } else {
      score -= 1.25;
    }
  }

  const date = typeof result?.date === 'string' ? result.date : '';
  if (intent.wantsCurrent && /\b202[45]\b/.test(date)) {
    score += 0.75;
  }

  if (sourceType === 'topStories') {
    score += 0.5;
  }

  return score;
}

function rankSourceList(results, options) {
  if (!Array.isArray(results)) {
    return [];
  }

  const maxPerHost = 2;
  const intent = parseQueryIntent(options.query);
  const ranked = results
    .map((result, index) => ({
      result,
      originalIndex: index,
      hostname: normalizeHostname(result?.link),
      score: scoreSource(result, options),
    }))
    .filter(
      (entry) =>
        intent.wantsSocialVideo || !matchesAnyPattern(entry.hostname, SOCIAL_HOST_PATTERNS),
    )
    .filter((entry) => entry.score >= 1)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.originalIndex - b.originalIndex;
    });

  const hostCounts = new Map();
  const filtered = [];

  for (const entry of ranked) {
    const count = hostCounts.get(entry.hostname) ?? 0;
    if (entry.hostname && count >= maxPerHost) {
      continue;
    }
    if (entry.hostname) {
      hostCounts.set(entry.hostname, count + 1);
    }
    filtered.push({
      ...entry.result,
      position: filtered.length + 1,
    });
  }

  return filtered;
}

function rerankSearchResultData(data, { query, searchProvider } = {}) {
  if (!data || typeof data !== 'object' || searchProvider !== 'searxng') {
    return data;
  }

  const organic = rankSourceList(data.organic, { query, sourceType: 'organic' });
  const topStories = rankSourceList(data.topStories, { query, sourceType: 'topStories' });
  const allowedLinks = new Set([
    ...organic.map((result) => result.link),
    ...topStories.map((result) => result.link),
  ]);

  const references = Array.isArray(data.references)
    ? data.references.filter((reference) => reference?.link && allowedLinks.has(reference.link))
    : data.references;

  return {
    ...data,
    organic,
    topStories,
    references,
  };
}

module.exports = {
  buildCondensedQuery,
  parseQueryIntent,
  planSearchQueries,
  rerankSearchResultData,
  scoreSource,
};
