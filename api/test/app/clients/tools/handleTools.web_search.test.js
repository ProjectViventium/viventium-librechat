/* === VIVENTIUM START ===
 * Regression test: `web_search` tool must load successfully.
 *
 * Why:
 * - Viventium overrides `buildWebSearchContext()` in:
 *   `api/app/clients/tools/util/handleTools.js`
 * - During the 0.8.2 migration we missed importing `replaceSpecialVars()`, causing:
 *     "Error loading tool web_search: replaceSpecialVars is not defined"
 *   which broke Deep Research / background cortices and left the UI stuck on "Analyzing...".
 *
 * Added: 2026-02-10
 * === VIVENTIUM END === */

const { Tools } = require('librechat-data-provider');
const { loadTools } = require('~/app/clients/tools/util/handleTools');

describe('handleTools - web_search', () => {
  test('loadTools builds tool context (replaceSpecialVars is available)', async () => {
    // Keep this test hermetic: provide a minimal, non-networking config for tool construction.
    // (No actual web search is executed in this unit test.)
    process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || 'test-key';

    const req = {
      body: {},
      headers: {},
      user: { id: 'test-user' },
    };

    const { loadedTools, toolContextMap } = await loadTools({
      user: 'test-user',
      tools: [Tools.web_search],
      webSearch: {
        searchProvider: 'serper',
        serperApiKey: 'test-key',
      },
      options: { req },
    });

    expect(Array.isArray(loadedTools)).toBe(true);
    expect(loadedTools.length).toBeGreaterThan(0);

    const ctx = toolContextMap[Tools.web_search];
    expect(typeof ctx).toBe('string');
    expect(ctx).toContain('Current Date & Time:');
    expect(ctx).not.toContain('{{iso_datetime}}');
    expect(ctx).toMatch(/Current Date & Time: .+\n\n\*\*Execute immediately without preface\.\*\*/);
  });

  test('keeps invocation-fresh time out of stable tool authority for a native conversation session', async () => {
    process.env.SERPER_API_KEY = process.env.SERPER_API_KEY || 'test-key';

    const req = {
      body: {},
      headers: {},
      user: { id: 'test-user' },
      viventiumTimeContextDelivery: 'per_turn_header',
    };

    const { toolContextMap } = await loadTools({
      user: 'test-user',
      tools: [Tools.web_search],
      webSearch: {
        searchProvider: 'serper',
        serperApiKey: 'test-key',
      },
      options: { req },
    });

    const ctx = toolContextMap[Tools.web_search];
    expect(ctx).not.toContain('Current Date & Time:');
    expect(ctx).toContain('Execute immediately without preface.');
  });
});
