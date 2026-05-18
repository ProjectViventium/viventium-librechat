/* === VIVENTIUM START ===
 * Feature: Model-facing tool failure normalization for search tools.
 *
 * Purpose:
 * - Keep deterministic runtime/tool diagnostics out of the model's working context.
 * - Preserve evidence-level meaning while still distinguishing an inconclusive retrieval
 *   failure from a genuine "nothing found" outcome.
 *
 * Why:
 * - `file_search` and `web_search` tool outputs are serialized directly into later
 *   model turns via `formatMessages.js`.
 * - Raw diagnostics like "timed out" were causing meta assistant replies about broken
 *   tools, but flattening every failure into "nothing found" also teaches the assistant
 *   the wrong lesson when retrieval was simply unavailable in that run.
 *
 * Added: 2026-03-11
 * === VIVENTIUM END === */

'use strict';

const { Tools } = require('librechat-data-provider');

const FILE_SEARCH_NO_RETRIEVED_EVIDENCE =
  'No file excerpts were retrieved for this query in the current run. Treat this as inconclusive, not proof that the information is absent.';
const WEB_SEARCH_NO_RETRIEVED_EVIDENCE =
  'No web evidence was retrieved because the web-search tool failed in this run for an unknown provider/runtime reason. Treat this as inconclusive, not proof that no results exist. If this is a current factual lookup and a browser/local-delegation fallback is available, use that path instead of stopping.';
const WEB_SEARCH_NO_RELEVANT_EVIDENCE = 'No relevant web evidence was found for this query.';
const WEB_SEARCH_PROVIDER_UNAVAILABLE =
  'No web evidence was retrieved because the configured web-search provider was unavailable in this run. Treat this as a retryable service/setup failure, not proof that no results exist. If this is a named-entity, contact, date, or current factual lookup and a browser/local-delegation fallback is available, use that path instead of stopping.';
const WEB_SEARCH_TIMEOUT =
  'No web evidence was retrieved because the configured web-search provider timed out in this run. Treat this as retryable and inconclusive, not proof that no results exist. Retry once or use an available browser/local-delegation fallback for current factual lookup.';
const WEB_SEARCH_RATE_LIMITED =
  'No web evidence was retrieved because the configured web-search provider was rate limited in this run. Treat this as temporary provider unavailability, not proof that no results exist. Use an available browser/local-delegation fallback for urgent current factual lookup.';
const WEB_SEARCH_AUTH_FAILED =
  'No web evidence was retrieved because the configured web-search provider needs authentication or a valid API key. Say that search is not currently authenticated; do not present this as no results.';
const WEB_SEARCH_REQUEST_REJECTED =
  'No web evidence was retrieved because the web-search request was rejected by the provider. Reformulate the query once, then use an available browser/local-delegation fallback for current factual lookup.';

const WEB_SEARCH_FAILURE_OUTPUTS = {
  auth_failed: WEB_SEARCH_AUTH_FAILED,
  provider_unavailable: WEB_SEARCH_PROVIDER_UNAVAILABLE,
  rate_limited: WEB_SEARCH_RATE_LIMITED,
  request_rejected: WEB_SEARCH_REQUEST_REJECTED,
  timeout: WEB_SEARCH_TIMEOUT,
  unknown: WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
};

const LEGACY_TOOL_OUTPUT_NORMALIZERS = [
  {
    toolName: Tools.file_search,
    pattern:
      /^File search encountered errors or timed out\. Please try again or rephrase your query\.$/i,
    replacement: FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  },
  {
    toolName: Tools.file_search,
    pattern: /^No results found or errors occurred while searching the files\.$/i,
    replacement: FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  },
  {
    toolName: Tools.file_search,
    pattern: /^There was an error authenticating the file search request\.$/i,
    replacement: FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  },
  {
    toolName: Tools.web_search,
    pattern: /^No safe relevant web results found for this query\.?$/i,
    replacement: WEB_SEARCH_NO_RELEVANT_EVIDENCE,
  },
  {
    toolName: Tools.web_search,
    pattern: /^No web evidence was retrieved for this query\.?$/i,
    replacement: WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
  },
];

function classifyWebSearchFailure(error) {
  const text = String(error || '')
    .trim()
    .toLowerCase();
  if (!text) {
    return 'unknown';
  }
  if (
    /\b(?:401|403|unauthorized|forbidden|authentication|api key|api token|invalid key|missing key|credentials? not provided|missing credentials|invalid credentials)\b/.test(
      text,
    )
  ) {
    return 'auth_failed';
  }
  if (
    /\b(?:402|429|rate limit|rate-limited|too many requests|quota exceeded|insufficient credits)\b/.test(
      text,
    )
  ) {
    return 'rate_limited';
  }
  if (/\b(?:timeout|timed out|etimedout|econnaborted|deadline|504)\b/.test(text)) {
    return 'timeout';
  }
  if (
    /\b(?:econnrefused|connection refused|connect refused|econnreset|socket hang up|enotfound|eai_again|host unreachable|network error|failed to fetch|service unavailable|bad gateway|502|503)\b/.test(
      text,
    )
  ) {
    return 'provider_unavailable';
  }
  if (
    /\b(?:400|bad request|invalid request|query rejected|request rejected|unsupported|invalid query)\b/.test(
      text,
    )
  ) {
    return 'request_rejected';
  }
  return 'unknown';
}

function normalizeToolOutputForModel({ toolName, output }) {
  if (typeof output !== 'string') {
    return output ?? '';
  }

  const trimmed = output.trim();
  if (!trimmed) {
    return '';
  }

  for (const normalizer of LEGACY_TOOL_OUTPUT_NORMALIZERS) {
    if (normalizer.toolName === toolName && normalizer.pattern.test(trimmed)) {
      return normalizer.replacement;
    }
  }

  return output;
}

function getFileSearchFailureOutput() {
  return FILE_SEARCH_NO_RETRIEVED_EVIDENCE;
}

function getWebSearchFallbackOutput({ hasError = false, error, failureClass } = {}) {
  if (!hasError && !error && !failureClass) {
    return WEB_SEARCH_NO_RELEVANT_EVIDENCE;
  }
  const normalizedFailureClass = WEB_SEARCH_FAILURE_OUTPUTS[failureClass]
    ? failureClass
    : classifyWebSearchFailure(error);
  return WEB_SEARCH_FAILURE_OUTPUTS[normalizedFailureClass] || WEB_SEARCH_NO_RETRIEVED_EVIDENCE;
}

module.exports = {
  WEB_SEARCH_AUTH_FAILED,
  WEB_SEARCH_FAILURE_OUTPUTS,
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_NO_RELEVANT_EVIDENCE,
  WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_PROVIDER_UNAVAILABLE,
  WEB_SEARCH_RATE_LIMITED,
  WEB_SEARCH_REQUEST_REJECTED,
  WEB_SEARCH_TIMEOUT,
  classifyWebSearchFailure,
  getFileSearchFailureOutput,
  getWebSearchFallbackOutput,
  normalizeToolOutputForModel,
};
