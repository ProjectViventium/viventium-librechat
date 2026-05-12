/* === VIVENTIUM START ===
 * Feature: Prompt registry runtime lookup.
 * Purpose:
 * - Load the compiled Viventium prompt bundle once.
 * - Let code-owned prompt surfaces use registry prompts with inline fallbacks.
 * - Avoid reading Markdown prompt files during request handling.
 * Added: 2026-05-09
 * === VIVENTIUM END === */

'use strict';

const fs = require('fs');
const { logger } = require('@librechat/data-schemas');

const PROMPT_BUNDLE_ENV = 'VIVENTIUM_PROMPT_BUNDLE_PATH';
const VARIABLE_RE = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
const KNOWN_RUNTIME_PLACEHOLDERS = new Set([
  'current_user',
  'current_date',
  'current_datetime',
  'iso_datetime',
]);

let cachedBundle = undefined;
let cachedBundlePath = '';
let cachedLoadError = null;
const warnedFallbackKeys = new Set();

function loadPromptBundle() {
  const nextBundlePath = (process.env[PROMPT_BUNDLE_ENV] || '').trim();
  if (cachedBundle !== undefined && nextBundlePath === cachedBundlePath) {
    return cachedBundle;
  }

  if (nextBundlePath !== cachedBundlePath) {
    warnedFallbackKeys.clear();
  }
  cachedBundlePath = nextBundlePath;
  if (!cachedBundlePath) {
    cachedBundle = null;
    cachedLoadError = null;
    return cachedBundle;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachedBundlePath, 'utf8'));
    cachedBundle = parsed && typeof parsed === 'object' ? parsed : null;
    cachedLoadError = null;
  } catch (error) {
    cachedBundle = null;
    cachedLoadError = error;
  }
  return cachedBundle;
}

function getPromptBundleStatus() {
  loadPromptBundle();
  return {
    loaded: Boolean(cachedBundle && cachedBundle.prompts),
    path: cachedBundlePath,
    error: cachedLoadError ? cachedLoadError.message : '',
    promptCount: cachedBundle?.prompt_count || 0,
  };
}

function lookupVariable(variables, key) {
  let current = variables || {};
  for (const segment of String(key).split('.')) {
    if (
      current &&
      typeof current === 'object' &&
      Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      current = current[segment];
      continue;
    }
    throw new Error(`Missing prompt variable: ${key}`);
  }
  if (Array.isArray(current)) {
    return current.map((item) => String(item)).join(', ');
  }
  if (current == null) {
    throw new Error(`Prompt variable is null: ${key}`);
  }
  return String(current);
}

function substituteVariables(text, variables, { strict = false } = {}) {
  return String(text || '').replace(VARIABLE_RE, (match, key) => {
    try {
      return lookupVariable(variables, key);
    } catch (error) {
      if (strict) {
        throw error;
      }
      if (!KNOWN_RUNTIME_PLACEHOLDERS.has(String(key))) {
        throw new Error(
          `Unknown unfilled prompt variable ${key}; add promptVars or an allowed runtime placeholder`,
        );
      }
      return match;
    }
  });
}

function renderPromptFromBundle(promptId, bundle, variables = {}, stack = []) {
  if (stack.includes(promptId)) {
    throw new Error(`Prompt include cycle detected: ${[...stack, promptId].join(' -> ')}`);
  }
  const prompt = bundle?.prompts?.[promptId];
  if (!prompt) {
    throw new Error(`Unknown prompt id: ${promptId}`);
  }

  const includes = Array.isArray(prompt.metadata?.includes) ? prompt.metadata.includes : [];
  const parts = includes.map((includeId) =>
    renderPromptFromBundle(String(includeId), bundle, variables, [...stack, promptId]).trim(),
  );
  parts.push(String(prompt.body || '').trim());
  return substituteVariables(parts.filter(Boolean).join('\n\n').trim(), variables, {
    strict: prompt.metadata?.strict_variables === true,
  });
}

function warnPromptFallback(promptId, error) {
  const key = `${promptId}:${error?.message || 'unknown'}`;
  if (warnedFallbackKeys.has(key)) {
    return;
  }
  warnedFallbackKeys.add(key);
  if (logger && typeof logger.warn === 'function') {
    logger.warn(
      `[VIVENTIUM][prompt-registry] Falling back to inline prompt for ${promptId}: ${error?.message || error}`,
    );
  }
}

function getPromptText(promptId, fallback = '', variables = {}) {
  const bundle = loadPromptBundle();
  if (!bundle?.prompts) {
    return fallback;
  }
  try {
    return renderPromptFromBundle(promptId, bundle, variables).trim() || fallback;
  } catch (error) {
    warnPromptFallback(promptId, error);
    return fallback;
  }
}

function resetPromptRegistryForTests() {
  cachedBundle = undefined;
  cachedBundlePath = '';
  cachedLoadError = null;
  warnedFallbackKeys.clear();
}

module.exports = {
  PROMPT_BUNDLE_ENV,
  KNOWN_RUNTIME_PLACEHOLDERS,
  getPromptBundleStatus,
  getPromptText,
  resetPromptRegistryForTests,
};
