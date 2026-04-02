const { Tools } = require('librechat-data-provider');
const {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_NO_RELEVANT_EVIDENCE,
  WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
  getWebSearchFallbackOutput,
  normalizeToolOutputForModel,
} = require('~/app/clients/tools/util/modelFacingToolOutput');

describe('modelFacingToolOutput', () => {
  test('normalizes legacy file_search diagnostics to evidence wording', () => {
    expect(
      normalizeToolOutputForModel({
        toolName: Tools.file_search,
        output: 'File search encountered errors or timed out. Please try again or rephrase your query.',
      }),
    ).toBe(FILE_SEARCH_NO_RETRIEVED_EVIDENCE);

    expect(
      normalizeToolOutputForModel({
        toolName: Tools.file_search,
        output: 'There was an error authenticating the file search request.',
      }),
    ).toBe(FILE_SEARCH_NO_RETRIEVED_EVIDENCE);
  });

  test('normalizes legacy web_search diagnostics to evidence wording', () => {
    expect(
      normalizeToolOutputForModel({
        toolName: Tools.web_search,
        output: 'No safe relevant web results found for this query.',
      }),
    ).toBe(WEB_SEARCH_NO_RELEVANT_EVIDENCE);
  });

  test('keeps ordinary tool output untouched', () => {
    const output = 'File: memo.txt\nRelevance: 0.9\nContent: Evidence here';
    expect(normalizeToolOutputForModel({ toolName: Tools.file_search, output })).toBe(output);
  });

  test('returns web fallback text based on runtime error presence', () => {
    expect(getWebSearchFallbackOutput({ hasError: true })).toBe(WEB_SEARCH_NO_RETRIEVED_EVIDENCE);
    expect(getWebSearchFallbackOutput({ hasError: false })).toBe(WEB_SEARCH_NO_RELEVANT_EVIDENCE);
  });
});
