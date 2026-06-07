/* === VIVENTIUM START ===
 * Feature: OpenAI Responses API streaming-converter guard.
 * Purpose:
 * - `@librechat/agents` `_convertOpenAIResponsesDeltaToBaseMessageChunk` calls
 *   `_convertOpenAIResponsesMessageToBaseMessage(chunk.response)` on the `response.completed`
 *   stream event, which does `for (const item of response.output)`
 *   (node_modules/@librechat/agents/dist/cjs/llm/openai/utils/index.cjs:549).
 * - For some OpenAI Responses models (observed on `gpt-5.4`) the `response.completed` event arrives
 *   with `response.output` undefined, throwing `TypeError: response.output is not iterable` AFTER
 *   the assistant text already streamed. The agent client catches it post-stream and surfaces a
 *   spurious "The model provider could not complete this request." bubble even though the answer is
 *   fine. This also broke gpt-5.4 specialist agents (e.g. during handoff), which is why an
 *   anthropic-routed agent worked while gpt-5.4 did not.
 * - Guard the exported converter (which `llm/openai/index.cjs` calls via the live module reference
 *   `index._convertOpenAIResponsesDeltaToBaseMessageChunk`) so a missing `response.output` is
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

const PATCH_FLAG = Symbol.for('viventium.openai.responses.output.patch.v1');
const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));

const requireAgentsCjsModule = (relativePath) => require(path.join(AGENTS_CJS_DIR, relativePath));

function applyOpenAIResponsesOutputPatch() {
  const utilsModule = requireAgentsCjsModule('llm/openai/utils/index.cjs');
  if (
    !utilsModule ||
    typeof utilsModule._convertOpenAIResponsesDeltaToBaseMessageChunk !== 'function'
  ) {
    logger.warn(
      '[OpenAI Responses Patch] _convertOpenAIResponsesDeltaToBaseMessageChunk unavailable; skipping',
    );
    return false;
  }

  if (utilsModule[PATCH_FLAG]) {
    return true;
  }

  const original = utilsModule._convertOpenAIResponsesDeltaToBaseMessageChunk;

  Object.defineProperty(utilsModule, PATCH_FLAG, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: true,
  });

  utilsModule._convertOpenAIResponsesDeltaToBaseMessageChunk =
    function _convertOpenAIResponsesDeltaToBaseMessageChunkPatched(data, ...rest) {
      // The completed-event converter iterates `response.output`; some Responses models (gpt-5.4)
      // omit it. Normalize a missing/non-array output to [] so it never throws after the answer
      // has already streamed. Only fills when absent — a real output array is left untouched.
      if (
        data &&
        typeof data === 'object' &&
        data.response &&
        typeof data.response === 'object' &&
        !Array.isArray(data.response.output)
      ) {
        data.response.output = [];
      }
      return original.call(this, data, ...rest);
    };

  logger.info('[OpenAI Responses Patch] Installed response.output stream-converter guard');
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
