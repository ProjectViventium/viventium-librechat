/* === VIVENTIUM START ===
 * Regression tests: Search query planning + source ranking.
 *
 * Why:
 * - Broad research prompts need focused query variants to avoid noisy provider results.
 * - Trustworthy current/community sources should outrank social/video/syndication noise.
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const {
  buildCondensedQuery,
  planSearchQueries,
  rerankSearchResultData,
} = require('~/app/clients/tools/util/viventiumSearchStrategy');

describe('viventiumSearchStrategy', () => {
  test('planSearchQueries condenses broad prompts into focused variants', () => {
    const planned = planSearchQueries(
      'yo check HN and other up to date places to see where most Founders live in Bay Area. I need to find out as of TODAY MARCH 2026 where founders in my stage are concentrated so I book my stay there. deep research',
    );

    expect(planned[0]).toContain('bay area');
    expect(planned).toContainEqual(expect.stringContaining('site:news.ycombinator.com'));
    expect(planned).toContainEqual(expect.stringContaining('current sources'));
    expect(planned).toHaveLength(3);
  });

  test('buildCondensedQuery removes broad prompt filler while preserving signal', () => {
    const condensed = buildCondensedQuery(
      'As of March 2026, where in San Francisco are AI founders at pre-seed or seed stage clustering: Hayes Valley, SoMa, Mission, Dogpatch, or Potrero? Use Hacker News and current sources.',
    );

    expect(condensed).toContain('san francisco');
    expect(condensed.match(/francisco/g)?.length ?? 0).toBe(1);
    expect(condensed.toLowerCase()).not.toContain('hacker news');
    expect(condensed.toLowerCase()).not.toContain('current sources');
  });

  test('rerankSearchResultData prefers trusted relevant sources over social and syndication', () => {
    const reranked = rerankSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'Interesting fact: Driven by the current AI boom, San Francisco has ...',
            link: 'https://www.instagram.com/reel/DVUUz84Fm5r/',
            snippet:
              'Hayes Valley was unofficially rebranded as Cerebral Valley due to AI hacker houses.',
          },
          {
            position: 2,
            title: 'Hi I m planning to move to San Francisco starting from next Cerebral ...',
            link: 'https://linen.cerebralvalley.ai/t/16156694/hi-i-m-planning-to-move-to-san-francisco-starting-from-next-',
            snippet:
              'Probably Hayes Valley, the Mission, or SOMA for peer AI startup founders and engineers.',
          },
          {
            position: 3,
            title: "AI firms gobbling up SF space outside 'Cerebral Valley' | Technology",
            link: 'https://www.sfexaminer.com/news/technology/ai-firms-gobbling-up-sf-space-outside-cerebral-valley/article_0aa610de-d82e-11ee-82b7-27b605ae6f40.html',
            snippet:
              'OpenAI signed another one in the Mission, and Adept inked one in Potrero Hill. AI companies in San Francisco are in either FiDi or SoMa.',
          },
          {
            position: 4,
            title: 'This Cool San Francisco Neighborhood Is Ground Zero For AI Startups',
            link: 'https://finance.yahoo.com/news/cool-san-francisco-neighborhood-ground-215032940.html',
            snippet: 'As AI startups proliferate, Hayes Valley becomes Cerebral Valley.',
          },
        ],
        topStories: [],
      },
      {
        query:
          'As of March 2026, where in San Francisco are AI founders at pre-seed or seed stage clustering: Hayes Valley, SoMa, Mission, Dogpatch, or Potrero? Use Hacker News and current sources.',
        searchProvider: 'searxng',
      },
    );

    expect(reranked.organic.map((result) => result.link)).toEqual([
      'https://linen.cerebralvalley.ai/t/16156694/hi-i-m-planning-to-move-to-san-francisco-starting-from-next-',
      'https://www.sfexaminer.com/news/technology/ai-firms-gobbling-up-sf-space-outside-cerebral-valley/article_0aa610de-d82e-11ee-82b7-27b605ae6f40.html',
      'https://finance.yahoo.com/news/cool-san-francisco-neighborhood-ground-215032940.html',
    ]);
  });

  test('planSearchQueries preserves structured search queries and adds a focused HN variant', () => {
    const query =
      'Hacker News SF AI startups "Hayes Valley" OR SoMa OR Mission founders living neighborhood 2025';
    const planned = planSearchQueries(query);

    expect(planned[0]).toBe(query);
    expect(planned).toContain(
      'site:news.ycombinator.com Hacker News SF AI startups "Hayes Valley" OR SoMa OR Mission founders living neighborhood 2025',
    );
  });

  test('rerankSearchResultData boosts requested neighborhoods and demotes directory noise', () => {
    const reranked = rerankSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'Jamestown forms a new AI neighborhood in SF’s North Waterfront',
            link: 'https://sfstandard.com/2025/07/19/jamestown-tackles-northern-waterfront-office-market/',
            snippet: 'North Waterfront offices are being repositioned for AI companies.',
          },
          {
            position: 2,
            title: "San Francisco's Hayes Valley is now 'Cerebral Valley,' the tech ...",
            link: 'https://fortune.com/2023/01/31/cerebral-valley-artificial-intelligence-ai-hayes-san-francisco/',
            snippet: 'Hayes Valley is turning into an AI founder cluster in San Francisco.',
          },
          {
            position: 3,
            title: '17 Top San Francisco Startups 2026 | TRUiC',
            link: 'https://startupsavant.com/startups-to-watch/san-francisco',
            snippet: 'A directory of startups in San Francisco.',
          },
        ],
        topStories: [],
      },
      {
        query:
          'As of March 2026, where in San Francisco are AI founders clustering in Hayes Valley, SoMa, Mission, Dogpatch, or Potrero?',
        searchProvider: 'searxng',
      },
    );

    expect(reranked.organic.map((result) => result.link)).toEqual([
      'https://fortune.com/2023/01/31/cerebral-valley-artificial-intelligence-ai-hayes-san-francisco/',
      'https://sfstandard.com/2025/07/19/jamestown-tackles-northern-waterfront-office-market/',
    ]);
  });

  test('rerankSearchResultData demotes geography-only pages that miss the founder and AI intent', () => {
    const reranked = rerankSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: '10 Best San Francisco Neighborhoods for Young Professionals (2025)',
            link: 'https://janiceleehomes.com/2025/08/18/san-francisco-neighborhoods-young-professionals',
            snippet: 'A real-estate guide to where to live in San Francisco.',
          },
          {
            position: 2,
            title: 'Tech Spaces - Google Sites',
            link: 'https://sites.google.com/popnest.org/tech-professional-coworking/home',
            snippet: 'Coworking spaces for technology professionals in San Francisco.',
          },
          {
            position: 3,
            title: 'Y Combinator Draws Techies to Dogpatch',
            link: 'https://www.potreroview.net/y-combinator-draws-techies-to-dogpatch/',
            snippet: 'Y Combinator moved to Dogpatch and founders are renting nearby.',
          },
          {
            position: 4,
            title: 'San Francisco is home to the AI boom. But where exactly are these companies?',
            link: 'https://sfstandard.com/2026/01/22/san-francisco-ai-boom-office-footprint/',
            snippet: 'SF Standard maps the AI cluster from SoMa through Dogpatch and Mission Bay.',
          },
        ],
        topStories: [],
      },
      {
        query:
          'As of March 2026, where in San Francisco are AI founders at pre-seed or seed stage clustering: Hayes Valley, SoMa, Mission, Dogpatch, or Potrero? Use Hacker News and current sources.',
        searchProvider: 'searxng',
      },
    );

    expect(reranked.organic.map((result) => result.link)).toEqual([
      'https://sfstandard.com/2026/01/22/san-francisco-ai-boom-office-footprint/',
      'https://www.potreroview.net/y-combinator-draws-techies-to-dogpatch/',
    ]);
  });
});
