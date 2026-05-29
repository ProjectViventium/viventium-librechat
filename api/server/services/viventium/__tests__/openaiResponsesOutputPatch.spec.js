/* === VIVENTIUM START ===
 * Regression: gpt-5.4 (OpenAI Responses API) `response.completed` stream events can arrive without
 * `response.output`, which made @librechat/agents throw `TypeError: response.output is not iterable`
 * AFTER the answer streamed, surfacing a spurious "model provider could not complete" bubble.
 * openaiResponsesOutputPatch guards the exported streaming converter; this proves the real library
 * converter no longer throws, and that a real output array is left untouched.
 * === VIVENTIUM END === */
const path = require('path');

// Installs the runtime guard on the @librechat/agents OpenAI Responses converter export.
require('../openaiResponsesOutputPatch');

const AGENTS_CJS_DIR = path.dirname(require.resolve('@librechat/agents'));
const agentsUtils = require(path.join(AGENTS_CJS_DIR, 'llm/openai/utils/index.cjs'));

describe('openaiResponsesOutputPatch', () => {
  test('response.completed without response.output does not throw (gpt-5.4 shape)', () => {
    const chunk = {
      type: 'response.completed',
      response: { id: 'resp_1', model: 'gpt-5.4', status: 'completed', usage: { output_tokens: 3 } },
    };
    expect(() =>
      agentsUtils._convertOpenAIResponsesDeltaToBaseMessageChunk(chunk),
    ).not.toThrow();
    // The guard normalizes the missing field to an empty array.
    expect(Array.isArray(chunk.response.output)).toBe(true);
  });

  test('a real response.output array is preserved (guard only fills when absent)', () => {
    const realOutput = [
      { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'hello' }] },
    ];
    const chunk = {
      type: 'response.completed',
      response: { id: 'resp_2', model: 'gpt-5.4', status: 'completed', output: realOutput, usage: {} },
    };
    expect(() =>
      agentsUtils._convertOpenAIResponsesDeltaToBaseMessageChunk(chunk),
    ).not.toThrow();
    expect(chunk.response.output).toBe(realOutput);
  });
});
