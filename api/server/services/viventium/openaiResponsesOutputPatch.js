/* === VIVENTIUM START ===
 * Feature: OpenAI Responses API streaming-converter guard.
 * Purpose:
 * - Older `@librechat/agents` releases handled Responses events through
 *   `_convertOpenAIResponsesDeltaToBaseMessageChunk`; current releases delegate to
 *   `@langchain/openai`'s `convertResponsesDeltaToChatGenerationChunk`. Both converter
 *   generations iterate `response.output` for a completed event.
 * - For some OpenAI Responses models (observed on `gpt-5.4`) the `response.completed` event arrives
 *   with `response.output` undefined, throwing `TypeError: response.output is not iterable` AFTER
 *   the assistant text already streamed. The agent client catches it post-stream and surfaces a
 *   spurious "The model provider could not complete this request." bubble even though the answer is
 *   fine. This also broke gpt-5.4 specialist agents (e.g. during handoff), which is why an
 *   anthropic-routed agent worked while gpt-5.4 did not.
 * - Guard whichever live converter architecture is installed so a missing `response.output` is
 *   normalized to an empty array before iteration. The visible answer comes from the streamed text
 *   deltas, so an empty completed-event output array loses nothing; usage/response metadata on the
 *   event is still processed by the original converter.
 * - Patch the runtime from this tracked repo file instead of editing node_modules, mirroring
 *   anthropicThinkingPatch.js / anthropicOAuthPatch.js.
 * Added: 2026-05-28
 * === VIVENTIUM END === */
'use strict';

const path = require('path');

const { logger } = require('@librechat/data-schemas');

const PATCH_FLAG = Symbol.for('viventium.openai.responses.output.patch.v2');
const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));

const requireAgentsCjsModule = (relativePath) => require(path.join(AGENTS_CJS_DIR, relativePath));
const tryRequire = (load) => {
  try {
    return load();
  } catch {
    return null;
  }
};

function normalizeResponsesOutput(data) {
  if (
    data &&
    typeof data === 'object' &&
    data.response &&
    typeof data.response === 'object' &&
    !Array.isArray(data.response.output)
  ) {
    data.response.output = [];
  }
}

function patchConverter(moduleExports, exportName) {
  if (!moduleExports || typeof moduleExports[exportName] !== 'function') {
    return false;
  }

  if (moduleExports[PATCH_FLAG]) {
    return true;
  }

  const original = moduleExports[exportName];

  Object.defineProperty(moduleExports, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  moduleExports[exportName] = function openAIResponsesConverterPatched(data, ...rest) {
    normalizeResponsesOutput(data);
    return original.call(this, data, ...rest);
  };

  return true;
}

function applyOpenAIResponsesOutputPatch() {
  const patchedTargets = [];

  const legacyUtilsModule = tryRequire(() => requireAgentsCjsModule('llm/openai/utils/index.cjs'));
  if (patchConverter(legacyUtilsModule, '_convertOpenAIResponsesDeltaToBaseMessageChunk')) {
    patchedTargets.push('agents');
  }

  const langchainResponsesModule = tryRequire(() => {
    const langchainOpenAIDir = path.dirname(
      require.resolve('@langchain/openai', { paths: [AGENTS_CJS_DIR] }),
    );
    return require(path.join(langchainOpenAIDir, 'converters/responses.cjs'));
  });
  if (patchConverter(langchainResponsesModule, 'convertResponsesDeltaToChatGenerationChunk')) {
    patchedTargets.push('langchain');
  }

  if (patchedTargets.length === 0) {
    logger.warn('[OpenAI Responses Patch] No supported Responses converter found; skipping');
    return false;
  }

  logger.info(
    `[OpenAI Responses Patch] Installed response.output guard (${patchedTargets.join(', ')})`,
  );
  return true;
}

try {
  applyOpenAIResponsesOutputPatch();
} catch (error) {
  logger.error(
    `[OpenAI Responses Patch] Failed to install: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

module.exports = { applyOpenAIResponsesOutputPatch };
