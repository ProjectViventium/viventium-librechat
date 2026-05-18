const { Tools } = require('librechat-data-provider');
const {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_AUTH_FAILED,
  WEB_SEARCH_NO_RELEVANT_EVIDENCE,
  WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_PROVIDER_UNAVAILABLE,
  WEB_SEARCH_RATE_LIMITED,
  WEB_SEARCH_REQUEST_REJECTED,
  WEB_SEARCH_TIMEOUT,
  classifyWebSearchFailure,
  getWebSearchFallbackOutput,
  normalizeToolOutputForModel,
} = require('~/app/clients/tools/util/modelFacingToolOutput');

describe('modelFacingToolOutput', () => {
  test('normalizes legacy file_search diagnostics to evidence wording', () => {
    expect(
      normalizeToolOutputForModel({
        toolName: Tools.file_search,
        output:
          'File search encountered errors or timed out. Please try again or rephrase your query.',
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

    expect(
      normalizeToolOutputForModel({
        toolName: Tools.web_search,
        output: 'No web evidence was retrieved for this query.',
      }),
    ).toBe(WEB_SEARCH_NO_RETRIEVED_EVIDENCE);
  });

  test('keeps ordinary tool output untouched', () => {
    const output = 'File: memo.txt\nRelevance: 0.9\nContent: Evidence here';
    expect(normalizeToolOutputForModel({ toolName: Tools.file_search, output })).toBe(output);
  });

  test('returns web fallback text based on runtime error presence', () => {
    expect(getWebSearchFallbackOutput({ hasError: true })).toBe(WEB_SEARCH_NO_RETRIEVED_EVIDENCE);
    expect(getWebSearchFallbackOutput({ hasError: false })).toBe(WEB_SEARCH_NO_RELEVANT_EVIDENCE);
  });

  test('classifies web search failures without leaking raw provider details to the model', () => {
    expect(
      classifyWebSearchFailure('SearXNG API request failed: connect ECONNREFUSED 127.0.0.1:8082'),
    ).toBe('provider_unavailable');
    expect(classifyWebSearchFailure('Request timed out after 10000ms')).toBe('timeout');
    expect(classifyWebSearchFailure('429 Too Many Requests from provider')).toBe('rate_limited');
    expect(classifyWebSearchFailure('401 Unauthorized: invalid API key')).toBe('auth_failed');
    expect(classifyWebSearchFailure('400 Bad request: invalid query')).toBe('request_rejected');
    expect(classifyWebSearchFailure('{"error":"credentials not provided"}')).toBe('auth_failed');
    expect(classifyWebSearchFailure('{"code":402,"error":"insufficient credits"}')).toBe(
      'rate_limited',
    );
    expect(classifyWebSearchFailure('{"error":"invalid request"}')).toBe('request_rejected');

    const unavailable = getWebSearchFallbackOutput({
      error: 'SearXNG API request failed: connect ECONNREFUSED 127.0.0.1:8082',
      hasError: true,
    });

    expect(unavailable).toBe(WEB_SEARCH_PROVIDER_UNAVAILABLE);
    expect(unavailable).not.toContain('127.0.0.1');
    expect(unavailable).not.toContain('8082');
    expect(unavailable).toContain('retryable service/setup failure');
  });

  test('returns actionable web fallback text for distinct failure classes', () => {
    expect(getWebSearchFallbackOutput({ error: 'Request timed out', hasError: true })).toBe(
      WEB_SEARCH_TIMEOUT,
    );
    expect(getWebSearchFallbackOutput({ error: '429 rate limit', hasError: true })).toBe(
      WEB_SEARCH_RATE_LIMITED,
    );
    expect(getWebSearchFallbackOutput({ error: 'Forbidden API key', hasError: true })).toBe(
      WEB_SEARCH_AUTH_FAILED,
    );
    expect(
      getWebSearchFallbackOutput({ error: 'Bad request: invalid query', hasError: true }),
    ).toBe(WEB_SEARCH_REQUEST_REJECTED);
  });
});
