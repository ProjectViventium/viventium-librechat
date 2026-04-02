/* === VIVENTIUM START ===
 * Feature: Viventium-owned wrapper for the upstream `web_search` tool.
 *
 * Purpose:
 * - Preserve upstream web search behavior while inserting Viventium safety/relevance
 *   sanitization before results are surfaced, scraped, or formatted for the LLM.
 *
 * Why:
 * - Upstream trusted raw provider ordering and allowed explicit/noise results through.
 * - We need a deterministic runtime guardrail, not a prompt workaround.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const path = require('path');
const { tool } = require('@langchain/core/tools');
const { Constants } = require('@librechat/agents');
const {
  DATE_RANGE,
  WebSearchToolDescription,
  WebSearchToolName,
  countrySchema,
  dateSchema,
  imagesSchema,
  newsSchema,
  querySchema,
  videosSchema,
} = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/schema.cjs',
  ),
);
const { createSearchAPI, createSourceProcessor } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/search.cjs',
  ),
);
const { createSerperScraper } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/serper-scraper.cjs',
  ),
);
const { createFirecrawlScraper } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/firecrawl.cjs',
  ),
);
const { createReranker } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/rerankers.cjs',
  ),
);
const { expandHighlights } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/highlights.cjs',
  ),
);
const { createDefaultLogger } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/utils.cjs',
  ),
);
const { formatResultsForLLM } = require(
  path.resolve(
    __dirname,
    '../../../../../node_modules/@librechat/agents/dist/cjs/tools/search/format.cjs',
  ),
);
/* === VIVENTIUM START ===
 * Feature: Evidence-oriented web_search fallback output.
 * === VIVENTIUM END === */
const { getWebSearchFallbackOutput } = require('./modelFacingToolOutput');
const { sanitizeSearchResult, sanitizeSearchResultData } = require('./viventiumWebSearchSafety');
const { createViventiumSearXNGAPI } = require('./viventiumSearxngSearch');
const { planSearchQueries, rerankSearchResultData } = require('./viventiumSearchStrategy');

function normalizeFirecrawlApiUrl(apiUrl) {
  if (typeof apiUrl !== 'string' || apiUrl.trim().length === 0) {
    return apiUrl;
  }

  return apiUrl
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/v[0-9]+$/i, '');
}

function mergeArrayByKey(existing, incoming, keyFn) {
  const merged = [];
  const seen = new Set();

  for (const item of [...(existing ?? []), ...(incoming ?? [])]) {
    const key = keyFn(item);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(item);
  }

  return merged;
}

async function executeSearchPlan({ searchAPI, queries, date, country, safeSearch, logger }) {
  const searchResults = await Promise.all(
    queries.map((plannedQuery) =>
      searchAPI.getSources({
        query: plannedQuery,
        date,
        country,
        safeSearch,
      }),
    ),
  );

  const successful = searchResults.filter((result) => result?.success && result.data);
  if (successful.length === 0) {
    const errorMessage = searchResults.find((result) => result?.error)?.error ?? 'Search failed';
    throw new Error(errorMessage);
  }

  if (successful.length === 1) {
    return successful[0];
  }

  logger.debug(`Merged ${successful.length} focused search queries`);

  const mergedData = successful.reduce(
    (accumulator, result) => ({
      ...accumulator,
      organic: mergeArrayByKey(accumulator.organic, result.data.organic, (item) => item?.link),
      topStories: mergeArrayByKey(
        accumulator.topStories,
        result.data.topStories,
        (item) => item?.link,
      ),
      news: mergeArrayByKey(accumulator.news, result.data.news, (item) => item?.link),
      images: mergeArrayByKey(accumulator.images, result.data.images, (item) => item?.link),
      videos: mergeArrayByKey(accumulator.videos, result.data.videos, (item) => item?.link),
      relatedSearches: mergeArrayByKey(
        accumulator.relatedSearches,
        result.data.relatedSearches,
        (item) => item?.query,
      ),
    }),
    {
      organic: [],
      topStories: [],
      news: [],
      images: [],
      videos: [],
      relatedSearches: [],
    },
  );

  return {
    success: true,
    data: mergedData,
  };
}

async function executeParallelSearches({
  searchAPI,
  query,
  date,
  country,
  safeSearch,
  images,
  videos,
  news,
  searchProvider,
  logger,
}) {
  const mainQueries = searchProvider === 'searxng' ? planSearchQueries(query) : [query];
  const searchTasks = [
    executeSearchPlan({
      searchAPI,
      queries: mainQueries,
      date,
      country,
      safeSearch,
      logger,
    }),
  ];

  if (images) {
    searchTasks.push(
      searchAPI
        .getSources({
          query,
          date,
          country,
          safeSearch,
          type: 'images',
        })
        .catch((error) => {
          logger.error('Error fetching images:', error);
          return {
            success: false,
            error: `Images search failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }),
    );
  }

  if (videos) {
    searchTasks.push(
      searchAPI
        .getSources({
          query,
          date,
          country,
          safeSearch,
          type: 'videos',
        })
        .catch((error) => {
          logger.error('Error fetching videos:', error);
          return {
            success: false,
            error: `Videos search failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }),
    );
  }

  if (news) {
    searchTasks.push(
      searchAPI
        .getSources({
          query,
          date,
          country,
          safeSearch,
          type: 'news',
        })
        .catch((error) => {
          logger.error('Error fetching news:', error);
          return {
            success: false,
            error: `News search failed: ${error instanceof Error ? error.message : String(error)}`,
          };
        }),
    );
  }

  const results = await Promise.all(searchTasks);
  const mainResult = results[0];
  if (!mainResult.success) {
    throw new Error(mainResult.error ?? 'Search failed');
  }

  const mergedResults = { ...mainResult.data };

  if (Array.isArray(mergedResults.news) && mergedResults.news.length > 0) {
    const existingNewsAsTopStories = mergedResults.news
      .filter((newsItem) => newsItem.link)
      .map((newsItem) => ({
        title: newsItem.title ?? '',
        link: newsItem.link ?? '',
        source: newsItem.source ?? '',
        date: newsItem.date ?? '',
        imageUrl: newsItem.imageUrl ?? '',
        processed: false,
      }));
    mergedResults.topStories = [...(mergedResults.topStories ?? []), ...existingNewsAsTopStories];
    delete mergedResults.news;
  }

  results.slice(1).forEach((result) => {
    if (!result.success || result.data == null) {
      return;
    }

    if (Array.isArray(result.data.images) && result.data.images.length > 0) {
      mergedResults.images = [...(mergedResults.images ?? []), ...result.data.images];
    }
    if (Array.isArray(result.data.videos) && result.data.videos.length > 0) {
      mergedResults.videos = [...(mergedResults.videos ?? []), ...result.data.videos];
    }
    if (Array.isArray(result.data.news) && result.data.news.length > 0) {
      const newsAsTopStories = result.data.news.map((newsItem) => ({
        ...newsItem,
        link: newsItem.link ?? '',
      }));
      mergedResults.topStories = [...(mergedResults.topStories ?? []), ...newsAsTopStories];
    }
  });

  return { success: true, data: mergedResults };
}

function createOnSearchResults({ runnableConfig, onSearchResults }) {
  return function onSearchResultsWrapper(results) {
    if (!onSearchResults) {
      return;
    }
    onSearchResults(results, runnableConfig);
  };
}

function createSearchProcessor({
  searchAPI,
  safeSearch,
  sourceProcessor,
  onGetHighlights,
  onSearchResults,
  searchProvider,
  logger,
}) {
  return async function search({
    query,
    date,
    country,
    proMode = true,
    maxSources = 5,
    images = false,
    videos = false,
    news = false,
    runnableConfig,
  }) {
    try {
      const rawSearchResult = await executeParallelSearches({
        searchAPI,
        query,
        date,
        country,
        safeSearch,
        images,
        videos,
        news,
        searchProvider,
        logger,
      });

      const sanitizedSearchResult = sanitizeSearchResult(rawSearchResult, {
        query,
        searchProvider,
      });

      const rankedSearchResult =
        sanitizedSearchResult?.success === true && sanitizedSearchResult.data
          ? {
              ...sanitizedSearchResult,
              data: rerankSearchResultData(sanitizedSearchResult.data, {
                query,
                searchProvider,
              }),
            }
          : sanitizedSearchResult;

      onSearchResults?.(rankedSearchResult, runnableConfig);

      const processedSources = await sourceProcessor.processSources({
        query,
        news,
        result: rankedSearchResult,
        proMode,
        onGetHighlights,
        numElements: maxSources,
      });

      const sanitizedProcessedSources = sanitizeSearchResultData(
        expandHighlights(processedSources),
        {
          query,
          searchProvider,
        },
      );
      return rerankSearchResultData(sanitizedProcessedSources, {
        query,
        searchProvider,
      });
    } catch (error) {
      logger.error('Error in search:', error);
      return {
        organic: [],
        topStories: [],
        images: [],
        videos: [],
        news: [],
        relatedSearches: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

function createTool({ schema, search }) {
  return tool(
    async (rawParams, runnableConfig) => {
      const params = rawParams ?? {};
      const query = typeof params.query === 'string' ? params.query : '';
      const country =
        typeof params.country === 'string' && params.country ? params.country : undefined;

      const searchResult = await search({
        query,
        date: params.date,
        country,
        images: params.images,
        videos: params.videos,
        news: params.news,
        runnableConfig,
      });

      const turn = runnableConfig?.toolCall?.turn ?? 0;
      const formatInput = structuredClone(searchResult);
      const { output, references } = formatResultsForLLM(turn, formatInput);
      const data = {
        turn,
        ...formatInput,
        references,
      };

      return [
        output || getWebSearchFallbackOutput({ hasError: Boolean(searchResult?.error) }),
        { [Constants.WEB_SEARCH]: data },
      ];
    },
    {
      name: WebSearchToolName,
      description: WebSearchToolDescription,
      schema,
      responseFormat: Constants.CONTENT_AND_ARTIFACT,
    },
  );
}

function createViventiumSearchTool(config = {}) {
  const {
    searchProvider = 'serper',
    serperApiKey,
    searxngInstanceUrl,
    searxngApiKey,
    rerankerType = 'cohere',
    topResults = 5,
    strategies = ['no_extraction'],
    filterContent = true,
    safeSearch = 1,
    scraperProvider = 'firecrawl',
    firecrawlApiKey,
    firecrawlApiUrl,
    firecrawlVersion,
    firecrawlOptions,
    serperScraperOptions,
    scraperTimeout,
    jinaApiKey,
    jinaApiUrl,
    cohereApiKey,
    onSearchResults,
    onGetHighlights,
  } = config;

  const logger = config.logger || createDefaultLogger();

  const schemaProperties = {
    query: querySchema,
    date: dateSchema,
    images: imagesSchema,
    videos: videosSchema,
    news: newsSchema,
  };

  if (searchProvider === 'serper') {
    schemaProperties.country = countrySchema;
  }

  const toolSchema = {
    type: 'object',
    properties: schemaProperties,
    required: ['query'],
  };

  const searchAPI =
    searchProvider === 'searxng'
      ? createViventiumSearXNGAPI(searxngInstanceUrl, searxngApiKey)
      : createSearchAPI({
          searchProvider,
          serperApiKey,
          searxngInstanceUrl,
          searxngApiKey,
        });

  let scraperInstance;
  if (scraperProvider === 'serper') {
    scraperInstance = createSerperScraper({
      ...serperScraperOptions,
      apiKey: serperApiKey,
      timeout: scraperTimeout ?? serperScraperOptions?.timeout,
      logger,
    });
  } else {
    scraperInstance = createFirecrawlScraper({
      ...firecrawlOptions,
      apiKey: firecrawlApiKey ?? process.env.FIRECRAWL_API_KEY,
      apiUrl: normalizeFirecrawlApiUrl(firecrawlApiUrl),
      version: firecrawlVersion,
      timeout: scraperTimeout ?? firecrawlOptions?.timeout,
      formats: firecrawlOptions?.formats ?? ['markdown', 'rawHtml'],
      logger,
    });
  }

  const selectedReranker = createReranker({
    rerankerType,
    jinaApiKey,
    jinaApiUrl,
    cohereApiKey,
    logger,
  });

  if (!selectedReranker) {
    logger.warn('No reranker selected. Using default ranking.');
  }

  const sourceProcessor = createSourceProcessor(
    {
      reranker: selectedReranker,
      topResults,
      strategies,
      filterContent,
      logger,
    },
    scraperInstance,
  );

  const search = createSearchProcessor({
    searchAPI,
    safeSearch,
    sourceProcessor,
    onGetHighlights,
    onSearchResults: (results, runnableConfig) => {
      if (!onSearchResults) {
        return;
      }

      const sanitizedForAttachment = sanitizeSearchResult(results, {
        searchProvider,
      });
      const handler = createOnSearchResults({
        runnableConfig,
        onSearchResults,
      });
      handler(sanitizedForAttachment);
    },
    searchProvider,
    logger,
  });

  return createTool({
    search,
    schema: toolSchema,
  });
}

module.exports = {
  DATE_RANGE,
  createViventiumSearchTool,
  normalizeFirecrawlApiUrl,
};
