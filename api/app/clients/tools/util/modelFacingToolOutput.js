/* === VIVENTIUM START ===
 * Feature: Model-facing tool failure normalization for search tools.
 *
 * Purpose:
 * - Keep deterministic runtime/tool diagnostics out of the model's working context.
 * - Preserve evidence-level meaning ("no file evidence", "no relevant web evidence")
 *   without teaching the assistant to narrate internal timeouts or transport failures.
 *
 * Why:
 * - `file_search` and `web_search` tool outputs are serialized directly into later
 *   model turns via `formatMessages.js`.
 * - Raw diagnostics like "timed out" and "web results found nothing" were causing
 *   meta assistant replies about broken tools instead of grounded statements about
 *   missing evidence.
 *
 * Added: 2026-03-11
 * === VIVENTIUM END === */

'use strict';

const { Tools } = require('librechat-data-provider');

const FILE_SEARCH_NO_RETRIEVED_EVIDENCE =
  'No file excerpts were retrieved for this query from the currently accessible files.';
const WEB_SEARCH_NO_RETRIEVED_EVIDENCE = 'No web evidence was retrieved for this query.';
const WEB_SEARCH_NO_RELEVANT_EVIDENCE = 'No relevant web evidence was found for this query.';

const LEGACY_TOOL_OUTPUT_NORMALIZERS = [
  {
    toolName: Tools.file_search,
    pattern: /^File search encountered errors or timed out\. Please try again or rephrase your query\.$/i,
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
];

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

function getWebSearchFallbackOutput({ hasError = false } = {}) {
  return hasError ? WEB_SEARCH_NO_RETRIEVED_EVIDENCE : WEB_SEARCH_NO_RELEVANT_EVIDENCE;
}

module.exports = {
  FILE_SEARCH_NO_RETRIEVED_EVIDENCE,
  WEB_SEARCH_NO_RELEVANT_EVIDENCE,
  WEB_SEARCH_NO_RETRIEVED_EVIDENCE,
  getFileSearchFailureOutput,
  getWebSearchFallbackOutput,
  normalizeToolOutputForModel,
};
