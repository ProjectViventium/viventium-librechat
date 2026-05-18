/* === VIVENTIUM START ===
 * Regression tests: Viventium web_search wrapper helpers.
 *
 * Why:
 * - Firecrawl's official self-hosted API expects a base URL; the upstream scraper appends
 *   the versioned `/vN/scrape` path itself.
 * - Passing a versioned base URL here silently creates `/v2/v2/scrape`.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const { z } = require('zod');
const { Constants } = require('@librechat/agents');
const {
  WEB_SEARCH_PROVIDER_UNAVAILABLE,
} = require('~/app/clients/tools/util/modelFacingToolOutput');
const {
  createTool,
  normalizeFirecrawlApiUrl,
} = require('~/app/clients/tools/util/viventiumSearchTool');

describe('viventiumSearchTool', () => {
  test('normalizeFirecrawlApiUrl strips trailing version segments only', () => {
    expect(normalizeFirecrawlApiUrl('http://localhost:3003/v2')).toBe('http://localhost:3003');
    expect(normalizeFirecrawlApiUrl('http://localhost:3003/v2/')).toBe('http://localhost:3003');
    expect(normalizeFirecrawlApiUrl('https://api.firecrawl.dev')).toBe('https://api.firecrawl.dev');
    expect(normalizeFirecrawlApiUrl(undefined)).toBeUndefined();
  });

  test('tool artifacts expose failureClass without raw provider details', async () => {
    const webSearchTool = createTool({
      schema: z.object({
        query: z.string(),
      }),
      search: async () => ({
        organic: [],
        topStories: [],
        images: [],
        videos: [],
        news: [],
        relatedSearches: [],
        error: 'SearXNG API request failed: connect ECONNREFUSED 127.0.0.1:8082',
      }),
    });

    const result = await webSearchTool.func({ query: 'synthetic current fact lookup' }, undefined, {
      toolCall: { turn: 1 },
    });
    const [output, artifact] = result;
    const webSearchArtifact = artifact[Constants.WEB_SEARCH];

    expect(output).toBe(WEB_SEARCH_PROVIDER_UNAVAILABLE);
    expect(webSearchArtifact.error).toBe(WEB_SEARCH_PROVIDER_UNAVAILABLE);
    expect(webSearchArtifact.failureClass).toBe('provider_unavailable');
    expect(JSON.stringify(webSearchArtifact)).not.toContain('127.0.0.1');
    expect(JSON.stringify(webSearchArtifact)).not.toContain('8082');
  });
});
