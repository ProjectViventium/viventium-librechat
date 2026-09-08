'use strict';

const { filterMalformedContentParts } = require('@librechat/api');
const { normalizeTextContentParts } = require('./normalizeTextContentParts');

/* === VIVENTIUM START ===
 * Feature: Aggregated content-part sanitization
 *
 * Purpose:
 * - Keep streamed aggregate content structurally valid before downstream tool/follow-up
 *   requests reuse it.
 * - Preserve the shared normalized-content pipeline without teaching downstream code
 *   complaint-shaped one-off filters.
 * === VIVENTIUM END === */

/**
 * Mutate a live aggregated content-parts array in place so downstream tool-follow-up
 * requests never inherit empty/malformed parts from streaming aggregation.
 *
 * @param {unknown} contentParts
 * @returns {unknown}
 */
function sanitizeAggregatedContentParts(contentParts, { preserveIndices = false } = {}) {
  if (!Array.isArray(contentParts)) {
    return contentParts;
  }

  // The streaming SDK keeps a run-step -> array-index map. Compact only after
  // streaming ends; removing a suppressed/empty slot mid-stream splits later text.
  if (preserveIndices) {
    for (let index = 0; index < contentParts.length; index += 1) {
      const normalized = normalizeTextContentParts(filterMalformedContentParts([contentParts[index]]));
      contentParts[index] = normalized[0];
    }
    return contentParts;
  }

  const filtered = filterMalformedContentParts(contentParts);
  const normalized = normalizeTextContentParts(filtered);

  if (normalized === contentParts) {
    return contentParts;
  }

  contentParts.splice(0, contentParts.length, ...normalized);
  return contentParts;
}

module.exports = {
  sanitizeAggregatedContentParts,
};
