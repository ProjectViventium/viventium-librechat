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

const { normalizeFirecrawlApiUrl } = require('~/app/clients/tools/util/viventiumSearchTool');

describe('viventiumSearchTool', () => {
  test('normalizeFirecrawlApiUrl strips trailing version segments only', () => {
    expect(normalizeFirecrawlApiUrl('http://localhost:3003/v2')).toBe('http://localhost:3003');
    expect(normalizeFirecrawlApiUrl('http://localhost:3003/v2/')).toBe('http://localhost:3003');
    expect(normalizeFirecrawlApiUrl('https://api.firecrawl.dev')).toBe('https://api.firecrawl.dev');
    expect(normalizeFirecrawlApiUrl(undefined)).toBeUndefined();
  });
});
