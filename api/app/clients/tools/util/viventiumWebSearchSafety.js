/* === VIVENTIUM START ===
 * Feature: Web search result safety + relevance sanitization.
 *
 * Purpose:
 * - Prevent explicit/adult domains from reaching the model context or UI attachments.
 * - For noisy SearXNG results, drop obviously irrelevant links that share no meaningful
 *   overlap with the user's query.
 *
 * Why:
 * - The upstream search tool trusts raw provider ordering and scrapes/displays those hits.
 * - In local runtime, SearXNG occasionally surfaced adult or unrelated domains for normal
 *   business queries, which then leaked into "Search results and sources".
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const GENERIC_QUERY_TERMS = new Set([
  'about',
  'after',
  'before',
  'best',
  'business',
  'check',
  'company',
  'details',
  'find',
  'for',
  'from',
  'good',
  'help',
  'latest',
  'more',
  'need',
  'news',
  'online',
  'official',
  'page',
  'processor',
  'product',
  'products',
  'service',
  'services',
  'site',
  'software',
  'summary',
  'their',
  'them',
  'this',
  'tool',
  'tools',
  'what',
  'when',
  'where',
  'which',
  'with',
]);

const FILE_INTENT_TERMS = new Set([
  'api',
  'csv',
  'data',
  'dataset',
  'datasets',
  'download',
  'downloads',
  'file',
  'files',
  'json',
  'schema',
  'schemas',
  'spec',
  'specification',
  'specifications',
  'text',
  'tsv',
  'txt',
  'xml',
  'yaml',
  'yml',
  'zip',
]);

const AMBIGUOUS_QUERY_TERMS = new Set([
  '2025',
  '2026',
  '2027',
  'area',
  'areas',
  'bay',
  'community',
  'connect',
  'connecting',
  'current',
  'district',
  'dogpatch',
  'founder',
  'founders',
  'francisco',
  'hn',
  'latest',
  'live',
  'march',
  'mission',
  'network',
  'neighborhood',
  'neighborhoods',
  'news',
  'potrero',
  'seed',
  'seedstage',
  'soma',
  'sources',
  'stage',
  'stages',
  'startup',
  'startups',
  'today',
]);

const PREFERRED_QUERY_PHRASES = [
  'bay area',
  'current sources',
  'dogpatch',
  'hacker news',
  'hayes valley',
  'mission district',
  'mission bay',
  'potrero hill',
  'san francisco',
];

const ADULT_HOST_PATTERNS = [
  /(^|\.)porn/i,
  /(^|\.)xxx(\.|$)/i,
  /(^|\.)xvideos?(\.|$)/i,
  /(^|\.)xnxx(\.|$)/i,
  /(^|\.)xhamster(\.|$)/i,
  /(^|\.)youporn(\.|$)/i,
  /(^|\.)redtube(\.|$)/i,
  /(^|\.)tube8(\.|$)/i,
  /(^|\.)spankbang(\.|$)/i,
  /(^|\.)beeg(\.|$)/i,
  /(^|\.)brazzers(\.|$)/i,
  /(^|\.)adultfriendfinder(\.|$)/i,
  /(^|\.)fap(\.|$)/i,
  /(^|\.)hentai(\.|$)/i,
  /(^|\.)sex(\.|$)/i,
];

const ADULT_TEXT_PATTERN =
  /\b(?:porn|xxx|adult\s+website|adult\s+content|sex\s+movies?|explicit|nudity|hardcore|camgirl|cams?\b|lesbian|milf|nsfw|hentai)\b/i;
const RAW_EXPORT_URL_PATTERN = /\.(?:txt|csv|tsv|json|xml)(?:$|[?#])/i;
const RAW_EXPORT_QUERY_PATTERN = /(?:[?&](?:output|format)=omeka-xml\b|\/omeka-xml(?:$|[/?#]))/i;
const URL_TITLE_PATTERN = /^(?:https?:\/\/|www\.)/i;

function safeLower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function safeUrlHostname(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return '';
  }

  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function extractQueryTerms(query) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 4 && !GENERIC_QUERY_TERMS.has(term));

  return [...new Set(terms)];
}

function hasFileIntent(query) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return false;
  }

  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter(Boolean);

  return terms.some((term) => FILE_INTENT_TERMS.has(term));
}

function hasAdultSignals(result) {
  const hostname = safeUrlHostname(result?.link);
  if (hostname && ADULT_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return true;
  }

  const haystack = [
    result?.title,
    result?.snippet,
    result?.content,
    result?.source,
    result?.attribution,
    result?.link,
  ]
    .map(safeLower)
    .join(' ');

  return ADULT_TEXT_PATTERN.test(haystack);
}

function hasLowValueSourceSignals(result, { allowFileLikeResults = false } = {}) {
  const link = typeof result?.link === 'string' ? result.link.trim() : '';
  const title = typeof result?.title === 'string' ? result.title.trim() : '';

  if (URL_TITLE_PATTERN.test(title)) {
    return true;
  }

  if (!allowFileLikeResults) {
    if (RAW_EXPORT_URL_PATTERN.test(link) || RAW_EXPORT_QUERY_PATTERN.test(link)) {
      return true;
    }
  }

  const normalizedTitle = safeLower(title)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!normalizedTitle) {
    return false;
  }

  const titleTokens = normalizedTitle.split(/\s+/).filter(Boolean);
  const meaningfulTokens = titleTokens.filter(
    (token) => token.length >= 4 && !GENERIC_QUERY_TERMS.has(token),
  );
  const digitCount = (title.match(/\d/g) ?? []).length;

  if (digitCount >= 12 && meaningfulTokens.length <= 1) {
    return true;
  }

  return false;
}

function extractQueryPhrases(query) {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return [];
  }

  const lower = query.toLowerCase();
  return PREFERRED_QUERY_PHRASES.filter((phrase) => lower.includes(phrase));
}

function getMeaningfulOverlapScore(result, queryTerms, query) {
  if (!Array.isArray(queryTerms) || queryTerms.length === 0) {
    return 1;
  }

  const haystack = [
    result?.title,
    result?.snippet,
    result?.content,
    result?.source,
    result?.attribution,
    result?.link,
  ]
    .map(safeLower)
    .join(' ');

  let score = 0;

  for (const phrase of extractQueryPhrases(query)) {
    if (haystack.includes(phrase)) {
      score += phrase === 'hacker news' ? 1.5 : 1.25;
    }
  }

  for (const term of queryTerms) {
    if (!haystack.includes(term)) {
      continue;
    }

    score += AMBIGUOUS_QUERY_TERMS.has(term) ? 0.35 : 1;
  }

  return score;
}

function hasMeaningfulOverlap(result, queryTerms, query) {
  return getMeaningfulOverlapScore(result, queryTerms, query) >= 1;
}

function normalizeResults(
  results,
  queryTerms,
  { applyRelevanceFilter, allowFileLikeResults, query },
) {
  if (!Array.isArray(results)) {
    return [];
  }

  const filtered = [];
  const seenLinks = new Set();

  for (const result of results) {
    const link = typeof result?.link === 'string' ? result.link : '';
    if (!link || seenLinks.has(link)) {
      continue;
    }

    if (hasAdultSignals(result)) {
      continue;
    }

    if (hasLowValueSourceSignals(result, { allowFileLikeResults })) {
      continue;
    }

    if (applyRelevanceFilter && !hasMeaningfulOverlap(result, queryTerms, query)) {
      continue;
    }

    seenLinks.add(link);
    filtered.push({
      ...result,
      position: filtered.length + 1,
    });
  }

  return filtered;
}

function sanitizeSearchResultData(data, { query, searchProvider } = {}) {
  if (!data || typeof data !== 'object') {
    return data;
  }

  const queryTerms = extractQueryTerms(query);
  const applyRelevanceFilter = searchProvider === 'searxng';
  const allowFileLikeResults = hasFileIntent(query);

  const organic = normalizeResults(data.organic, queryTerms, {
    applyRelevanceFilter,
    allowFileLikeResults,
    query,
  });
  const topStories = normalizeResults(data.topStories, queryTerms, {
    applyRelevanceFilter,
    allowFileLikeResults,
    query,
  });
  const news = normalizeResults(data.news, queryTerms, {
    applyRelevanceFilter,
    allowFileLikeResults,
    query,
  });

  const allowedLinks = new Set([
    ...organic.map((result) => result.link),
    ...topStories.map((result) => result.link),
    ...news.map((result) => result.link),
  ]);

  const references = Array.isArray(data.references)
    ? data.references.filter((reference) => {
        if (!reference?.link) {
          return false;
        }
        if (hasAdultSignals(reference)) {
          return false;
        }
        if (hasLowValueSourceSignals(reference, { allowFileLikeResults })) {
          return false;
        }
        if (allowedLinks.size > 0) {
          return allowedLinks.has(reference.link);
        }
        if (applyRelevanceFilter && !hasMeaningfulOverlap(reference, queryTerms, query)) {
          return false;
        }
        return true;
      })
    : data.references;

  return {
    ...data,
    organic,
    topStories,
    news,
    references,
  };
}

function sanitizeSearchResult(result, { query, searchProvider } = {}) {
  if (!result || typeof result !== 'object' || result.success !== true || !result.data) {
    return result;
  }

  return {
    ...result,
    data: sanitizeSearchResultData(result.data, { query, searchProvider }),
  };
}

module.exports = {
  extractQueryTerms,
  extractQueryPhrases,
  getMeaningfulOverlapScore,
  hasFileIntent,
  hasAdultSignals,
  hasLowValueSourceSignals,
  sanitizeSearchResult,
  sanitizeSearchResultData,
};
