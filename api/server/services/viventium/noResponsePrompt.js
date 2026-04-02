/* === VIVENTIUM START ===
 * Feature: No Response Tag ({NTA}) prompt injection (env-gated)
 *
 * Purpose:
 * - Provide a single, shared prompt block for instructing any LLM run to output `{NTA}`
 *   when it intentionally has nothing to add.
 * - Gate the injection behind an env var so behavior can be rolled out safely.
 * - Make the injected prompt editable via `librechat.yaml` to keep all injection sites aligned.
 *
 * Config (librechat.yaml):
 * - viventium.no_response.prompt: string (supports YAML multiline blocks)
 *
 * Env:
 * - VIVENTIUM_NO_RESPONSE_ENABLED=1 enables prompt injection (default: off)
 *
 * Added: 2026-02-07
 * === VIVENTIUM END === */

const { NO_RESPONSE_TAG } = require('./noResponseTag');

const NO_RESPONSE_ENABLED_ENV = 'VIVENTIUM_NO_RESPONSE_ENABLED';

function _parseBool(value) {
  const raw = (value ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isNoResponsePromptEnabled() {
  return _parseBool(process.env[NO_RESPONSE_ENABLED_ENV]);
}

function _defaultNoResponsePrompt() {
  return [
    'NO RESPONSE TAG:',
    `- If you have nothing meaningful to add, respond with exactly: ${NO_RESPONSE_TAG}`,
    `- When you use ${NO_RESPONSE_TAG}, output ONLY that token and nothing else.`,
    `- Never use ${NO_RESPONSE_TAG} to hide errors/tool failures; explain the issue briefly instead.`,
  ].join('\n');
}

function resolveNoResponsePromptText(req) {
  const fromConfig = req?.config?.viventium?.no_response?.prompt;
  if (typeof fromConfig === 'string' && fromConfig.trim().length > 0) {
    return fromConfig.trim();
  }
  return _defaultNoResponsePrompt();
}

/**
 * Build the instruction block to inject into an agent's system prompt.
 *
 * @param {import('express').Request | any} req
 * @returns {string} Prompt block or empty string when disabled
 */
function buildNoResponseInstructions(req) {
  if (!isNoResponsePromptEnabled()) {
    return '';
  }
  return resolveNoResponsePromptText(req);
}

module.exports = {
  NO_RESPONSE_ENABLED_ENV,
  isNoResponsePromptEnabled,
  resolveNoResponsePromptText,
  buildNoResponseInstructions,
};
