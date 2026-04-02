const {
  extractQueryTerms,
  hasAdultSignals,
  sanitizeSearchResultData,
} = require('~/app/clients/tools/util/viventiumWebSearchSafety');

describe('viventiumWebSearchSafety', () => {
  test('extractQueryTerms keeps high-signal terms only', () => {
    expect(extractQueryTerms('Attuned software company AI survey processor')).toEqual([
      'attuned',
      'survey',
    ]);
  });

  test('hasAdultSignals flags explicit domains and titles', () => {
    expect(
      hasAdultSignals({
        link: 'https://pornhub000.com/',
        title: 'Free Porn Videos',
      }),
    ).toBe(true);

    expect(
      hasAdultSignals({
        link: 'https://www.attuned.ai/',
        title: 'Attuned AI - Give Your Managers Superpowers',
      }),
    ).toBe(false);
  });

  test('sanitizeSearchResultData removes adult and irrelevant searxng hits', () => {
    const sanitized = sanitizeSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'Attuned AI - Give Your Managers Superpowers',
            link: 'https://www.attuned.ai/',
            snippet: 'AI-powered employee motivation surveys.',
            attribution: 'attuned.ai',
          },
          {
            position: 2,
            title: 'Free Porn Videos & Sex Movies',
            link: 'https://www.pornhub.com/',
            snippet: 'Unlimited free porn videos.',
            attribution: 'pornhub.com',
          },
          {
            position: 3,
            title: 'The Workout Plan to Build Your V Taper',
            link: 'https://www.muscleandfitness.com/workouts/v-taper/',
            snippet: 'Add width to your shoulders.',
            attribution: 'muscleandfitness.com',
          },
          {
            position: 4,
            title: 'Attuned | LinkedIn',
            link: 'https://www.linkedin.com/company/attunedai/',
            snippet: 'Attuned helps companies build happier workplaces.',
            attribution: 'linkedin.com',
          },
        ],
        topStories: [],
        news: [],
        references: [{ link: 'https://www.attuned.ai/' }, { link: 'https://www.pornhub.com/' }],
      },
      {
        query: 'Attuned software company AI survey processor',
        searchProvider: 'searxng',
      },
    );

    expect(sanitized.organic.map((result) => result.link)).toEqual([
      'https://www.attuned.ai/',
      'https://www.linkedin.com/company/attunedai/',
    ]);
    expect(sanitized.organic.map((result) => result.position)).toEqual([1, 2]);
    expect(sanitized.references).toEqual([{ link: 'https://www.attuned.ai/' }]);
  });

  test('sanitizeSearchResultData drops irrelevant references when no safe links survive', () => {
    const sanitized = sanitizeSearchResultData(
      {
        organic: [],
        topStories: [],
        news: [],
        references: [
          {
            link: 'https://kmc.up.nic.in/',
            title: 'UP - कानपुर नगर निगम',
          },
          {
            link: 'https://example.com/cerebral-valley',
            title: 'Cerebral Valley neighborhood guide',
            snippet: 'Hayes Valley and SoMa for AI founders in San Francisco.',
          },
        ],
      },
      {
        query: 'where do ai founders live san francisco hayes valley soma',
        searchProvider: 'searxng',
      },
    );

    expect(sanitized.references).toEqual([
      {
        link: 'https://example.com/cerebral-valley',
        title: 'Cerebral Valley neighborhood guide',
        snippet: 'Hayes Valley and SoMa for AI founders in San Francisco.',
      },
    ]);
  });

  test('sanitizeSearchResultData drops low-value raw export sources for normal web research', () => {
    const sanitized = sanitizeSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'than born became states including american - Stanford University',
            link: 'https://downloads.cs.stanford.edu/nlp/data/jiwei/data/vocab_wiki.txt',
            snippet: '... district county them album north against series ...',
            attribution: 'downloads.cs.stanford.edu',
          },
          {
            position: 2,
            title: "The Insider's Guide to San Francisco's A.I. Boom",
            link: 'https://www.nytimes.com/2025/08/04/technology/ai-boom-san-francisco.html',
            snippet: 'Hayes Valley has been coined Cerebral Valley by tech insiders.',
            attribution: 'nytimes.com',
          },
          {
            position: 3,
            title: 'https://clinton.presidentiallibraries.us/items/show/47359?output ...',
            link: 'https://clinton.presidentiallibraries.us/items/show/47359?output=omeka-xml',
            snippet: 'mission district founders san francisco',
            attribution: 'clinton.presidentiallibraries.us',
          },
        ],
        topStories: [],
        news: [],
        references: [
          {
            link: 'https://downloads.cs.stanford.edu/nlp/data/jiwei/data/vocab_wiki.txt',
            title: 'than born became states including american - Stanford University',
            snippet: '... district county them album north against series ...',
          },
          {
            link: 'https://www.nytimes.com/2025/08/04/technology/ai-boom-san-francisco.html',
            title: "The Insider's Guide to San Francisco's A.I. Boom",
            snippet: 'Hayes Valley has been coined Cerebral Valley by tech insiders.',
          },
        ],
      },
      {
        query: 'where do ai founders live san francisco hayes valley mission district march 2026',
        searchProvider: 'searxng',
      },
    );

    expect(sanitized.organic.map((result) => result.link)).toEqual([
      'https://www.nytimes.com/2025/08/04/technology/ai-boom-san-francisco.html',
    ]);
    expect(sanitized.references).toEqual([
      {
        link: 'https://www.nytimes.com/2025/08/04/technology/ai-boom-san-francisco.html',
        title: "The Insider's Guide to San Francisco's A.I. Boom",
        snippet: 'Hayes Valley has been coined Cerebral Valley by tech insiders.',
      },
    ]);
  });

  test('sanitizeSearchResultData keeps file-like results when the query explicitly asks for them', () => {
    const sanitized = sanitizeSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'San Francisco startup dataset',
            link: 'https://example.com/sf-startups.csv',
            snippet: 'Download startup dataset for San Francisco founders.',
            attribution: 'example.com',
          },
        ],
        topStories: [],
        news: [],
        references: [{ link: 'https://example.com/sf-startups.csv' }],
      },
      {
        query: 'download san francisco startup dataset csv',
        searchProvider: 'searxng',
      },
    );

    expect(sanitized.organic.map((result) => result.link)).toEqual([
      'https://example.com/sf-startups.csv',
    ]);
    expect(sanitized.references).toEqual([{ link: 'https://example.com/sf-startups.csv' }]);
  });

  test('sanitizeSearchResultData drops weak single-term overlaps like mission-critical noise', () => {
    const sanitized = sanitizeSearchResultData(
      {
        organic: [
          {
            position: 1,
            title: 'AI firms gobbling up SF space outside Cerebral Valley',
            link: 'https://www.sfexaminer.com/news/technology/ai-firms-gobbling-up-sf-space-outside-cerebral-valley/article_0aa610de-d82e-11ee-82b7-27b605ae6f40.html',
            snippet:
              'OpenAI signed another one in the Mission, and Adept inked one in Potrero Hill. AI companies in San Francisco are in either FiDi or SoMa.',
            attribution: 'sfexaminer.com',
          },
          {
            position: 2,
            title: 'AI agents are starting to eat SaaS | Hacker News',
            link: 'https://news.ycombinator.com/item?id=46268452',
            snippet:
              'Especially when things are mission critical, you kind of want to know stuff works properly.',
            attribution: 'news.ycombinator.com',
          },
        ],
        topStories: [],
        news: [],
        references: [],
      },
      {
        query: 'where are AI founders clustering in San Francisco Mission SoMa Potrero March 2026',
        searchProvider: 'searxng',
      },
    );

    expect(sanitized.organic.map((result) => result.link)).toEqual([
      'https://www.sfexaminer.com/news/technology/ai-firms-gobbling-up-sf-space-outside-cerebral-valley/article_0aa610de-d82e-11ee-82b7-27b605ae6f40.html',
    ]);
  });
});
