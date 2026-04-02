/* === VIVENTIUM START ===
 * Regression tests: Viventium-owned SearXNG adapter.
 *
 * Why:
 * - The upstream LibreChat adapter hardcoded `language=all` and a fixed engines list,
 *   which bypassed our instance defaults and produced noisy multilingual results.
 * - The Viventium adapter must preserve result parity while respecting instance defaults
 *   unless explicit overrides are provided.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const {
  buildSearxngParams,
  normalizeSearxngEngines,
  normalizeSearxngInstanceUrl,
  normalizeSearxngLanguage,
  transformSearxngResponse,
} = require('~/app/clients/tools/util/viventiumSearxngSearch');

describe('viventiumSearxngSearch', () => {
  test('normalizes instance URL and optional overrides', () => {
    expect(normalizeSearxngInstanceUrl('http://localhost:8082')).toBe(
      'http://localhost:8082/search',
    );
    expect(normalizeSearxngInstanceUrl('http://localhost:8082/search/')).toBe(
      'http://localhost:8082/search',
    );
    expect(normalizeSearxngLanguage('en-US,en;q=0.9')).toBe('en-US');
    expect(normalizeSearxngLanguage('all')).toBeUndefined();
    expect(normalizeSearxngEngines(['google', ' bing ', ''])).toBe('google,bing');
    expect(normalizeSearxngEngines('google, bing,')).toBe('google,bing');
  });

  test('buildSearxngParams respects instance defaults unless overrides are configured', () => {
    expect(
      buildSearxngParams({
        query: 'hayes valley founders',
        safeSearch: 1,
        type: undefined,
      }),
    ).toEqual({
      q: 'hayes valley founders',
      format: 'json',
      pageno: 1,
      categories: 'general',
      safesearch: 1,
    });

    expect(
      buildSearxngParams({
        query: 'hayes valley founders',
        safeSearch: 1,
        type: 'news',
        language: 'en-US',
        engines: 'google,bing',
      }),
    ).toEqual({
      q: 'hayes valley founders',
      format: 'json',
      pageno: 1,
      categories: 'news',
      safesearch: 1,
      language: 'en-US',
      engines: 'google,bing',
    });
  });

  test('transformSearxngResponse preserves LibreChat result shape', () => {
    const transformed = transformSearxngResponse({
      results: [
        {
          title: 'What is Cerebral Valley?',
          url: 'https://sfstandard.com/cerebral-valley',
          content: 'Hayes Valley AI founders.',
          publishedDate: '2023-01-13T00:00:00',
        },
        {
          title: 'Top startup news in SF',
          url: 'https://example.com/news/startups',
          content: 'Latest news from SoMa.',
          publishedDate: '2026-03-09T00:00:00',
          img_src: 'https://example.com/news.png',
        },
      ],
      suggestions: ['hayes valley ai'],
    });

    expect(transformed.organic).toHaveLength(2);
    expect(transformed.organic[0]).toMatchObject({
      position: 1,
      title: 'What is Cerebral Valley?',
      link: 'https://sfstandard.com/cerebral-valley',
      attribution: 'sfstandard.com',
    });
    expect(transformed.news).toHaveLength(1);
    expect(transformed.topStories).toHaveLength(1);
    expect(transformed.relatedSearches).toEqual([{ query: 'hayes valley ai' }]);
  });
});
