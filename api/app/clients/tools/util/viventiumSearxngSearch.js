/* === VIVENTIUM START ===
 * Feature: Viventium-owned SearXNG adapter for web_search.
 *
 * Purpose:
 * - Preserve LibreChat's result shape while avoiding hardcoded upstream request parameters
 *   that degrade relevance on our self-hosted SearXNG instance.
 * - Respect the instance defaults for engine selection and language unless the operator
 *   explicitly configures overrides.
 *
 * Why:
 * - Official SearXNG search parameters support optional `engines` and `language`.
 * - Our self-hosted instance is already the source of truth for engine curation; forcing
 *   `language=all` and a fixed engine list bypasses that curation and produced multilingual
 *   junk results for normal English startup research queries.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const axios = require('axios');

function normalizeSearxngInstanceUrl(instanceUrl) {
  if (typeof instanceUrl !== 'string' || instanceUrl.trim().length === 0) {
    return '';
  }

  const normalized = instanceUrl.trim().replace(/\/+$/, '');
  return normalized.endsWith('/search') ? normalized : `${normalized}/search`;
}

function normalizeSearxngLanguage(language) {
  if (typeof language !== 'string') {
    return undefined;
  }

  const normalized = language.trim().split(',')[0].replace(/_/g, '-');
  if (!normalized || normalized.toLowerCase() === 'all' || normalized.toLowerCase() === 'auto') {
    return undefined;
  }

  return normalized;
}

function normalizeSearxngEngines(engines) {
  if (Array.isArray(engines)) {
    const normalized = engines
      .map((engine) => (typeof engine === 'string' ? engine.trim() : ''))
      .filter(Boolean);
    return normalized.length > 0 ? normalized.join(',') : undefined;
  }

  if (typeof engines !== 'string') {
    return undefined;
  }

  const normalized = engines
    .split(',')
    .map((engine) => engine.trim())
    .filter(Boolean)
    .join(',');

  return normalized || undefined;
}

function getCategory(type) {
  if (type === 'images') {
    return 'images';
  }

  if (type === 'videos') {
    return 'videos';
  }

  if (type === 'news') {
    return 'news';
  }

  return 'general';
}

function buildSearxngParams({ query, safeSearch, type, language, engines }) {
  const params = {
    q: query,
    format: 'json',
    pageno: 1,
    categories: getCategory(type),
    safesearch: safeSearch,
  };

  const normalizedLanguage = normalizeSearxngLanguage(language);
  if (normalizedLanguage) {
    params.language = normalizedLanguage;
  }

  const normalizedEngines = normalizeSearxngEngines(engines);
  if (normalizedEngines) {
    params.engines = normalizedEngines;
  }

  return params;
}

function mapAttribution(url) {
  try {
    return new URL(url ?? '').hostname;
  } catch {
    return '';
  }
}

function isNewsResult(result) {
  const url = result?.url?.toLowerCase() ?? '';
  const title = result?.title?.toLowerCase() ?? '';
  const newsKeywords = [
    'breaking news',
    'latest news',
    'top stories',
    'news today',
    'developing story',
    'trending news',
    'news',
  ];

  const hasNewsKeywords = newsKeywords.some((keyword) => title.includes(keyword));
  const hasNewsPath =
    url.includes('/news/') ||
    url.includes('/world/') ||
    url.includes('/politics/') ||
    url.includes('/breaking/');

  return hasNewsKeywords || hasNewsPath;
}

function transformSearxngResponse(data, numResults = 8) {
  const results = Array.isArray(data?.results) ? data.results : [];

  const organic = results.slice(0, numResults).map((result, index) => ({
    position: index + 1,
    title: result?.title ?? '',
    link: result?.url ?? '',
    snippet: result?.content ?? '',
    date: result?.publishedDate ?? '',
    attribution: mapAttribution(result?.url),
  }));

  const images = results
    .filter((result) => result?.img_src)
    .slice(0, 6)
    .map((result, index) => ({
      title: result?.title ?? '',
      imageUrl: result?.img_src ?? '',
      position: index + 1,
      source: mapAttribution(result?.url),
      domain: mapAttribution(result?.url),
      link: result?.url ?? '',
    }));

  const news = results.filter(isNewsResult).map((result, index) => ({
    title: result?.title ?? '',
    link: result?.url ?? '',
    snippet: result?.content ?? '',
    date: result?.publishedDate ?? '',
    source: mapAttribution(result?.url),
    imageUrl: result?.img_src ?? '',
    position: index + 1,
  }));

  return {
    organic,
    images,
    topStories: news.slice(0, 5),
    relatedSearches: Array.isArray(data?.suggestions)
      ? data.suggestions.map((suggestion) => ({ query: suggestion }))
      : [],
    videos: [],
    news,
    places: [],
    shopping: [],
    peopleAlsoAsk: [],
    knowledgeGraph: undefined,
    answerBox: undefined,
  };
}

function createViventiumSearXNGAPI(instanceUrl, apiKey, options = {}) {
  const config = {
    instanceUrl: instanceUrl ?? process.env.SEARXNG_INSTANCE_URL,
    apiKey: apiKey ?? process.env.SEARXNG_API_KEY,
    timeout: options.timeout ?? 10000,
    language: options.language ?? process.env.SEARXNG_LANGUAGE,
    engines: options.engines ?? process.env.SEARXNG_ENGINES,
  };

  if (!config.instanceUrl) {
    throw new Error('SEARXNG_INSTANCE_URL is required for SearXNG API');
  }

  const searchUrl = normalizeSearxngInstanceUrl(config.instanceUrl);

  const getSources = async ({ query, numResults = 8, safeSearch, type }) => {
    if (!query?.trim()) {
      return { success: false, error: 'Query cannot be empty' };
    }

    try {
      const headers = {
        'Content-Type': 'application/json',
      };

      if (config.apiKey) {
        headers['X-API-Key'] = config.apiKey;
      }

      const response = await axios.get(searchUrl, {
        headers,
        params: buildSearxngParams({
          query,
          safeSearch,
          type,
          language: config.language,
          engines: config.engines,
        }),
        timeout: config.timeout,
      });

      return {
        success: true,
        data: transformSearxngResponse(response.data, numResults),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `SearXNG API request failed: ${errorMessage}`,
      };
    }
  };

  return { getSources };
}

module.exports = {
  buildSearxngParams,
  createViventiumSearXNGAPI,
  normalizeSearxngEngines,
  normalizeSearxngInstanceUrl,
  normalizeSearxngLanguage,
  transformSearxngResponse,
};
