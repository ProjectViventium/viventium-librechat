'use strict';

/* === VIVENTIUM START ===
 * Feature: TypeScript-owned visible-content projection compatibility adapter.
 * Purpose: Keep the legacy API import stable while packages/api owns the implementation.
 * === VIVENTIUM END === */

const {
  VISIBLE_CONTENT_SEPARATOR,
  projectVisibleTextFromContentParts,
  textFromVisibleContentPart,
  visibleTextSegmentsFromContentParts,
} = require('@librechat/api');

module.exports = {
  VISIBLE_CONTENT_SEPARATOR,
  projectVisibleTextFromContentParts,
  textFromVisibleContentPart,
  visibleTextSegmentsFromContentParts,
};
