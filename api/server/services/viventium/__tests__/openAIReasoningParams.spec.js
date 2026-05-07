/* === VIVENTIUM START ===
 * Tests: OpenAI reasoning-model runtime parameter guard.
 * Added: 2026-05-06
 * === VIVENTIUM END === */

const {
  isOpenAIReasoningModelWithoutSampling,
  sanitizeOpenAIReasoningSamplingParams,
} = require('../openAIReasoningParams');

describe('openAIReasoningParams', () => {
  test('matches OpenAI reasoning families that must not receive sampling params', () => {
    expect(isOpenAIReasoningModelWithoutSampling('o1')).toBe(true);
    expect(isOpenAIReasoningModelWithoutSampling('o3-mini')).toBe(true);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5')).toBe(true);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5-pro')).toBe(true);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5.4')).toBe(true);
  });

  test('does not generalize the gpt-5.4 runtime evidence to every dotted gpt-5 version', () => {
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5.1')).toBe(false);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5.2')).toBe(false);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5.5-preview')).toBe(false);
    expect(isOpenAIReasoningModelWithoutSampling('gpt-5-chat')).toBe(false);
  });

  test('removes sampling fields only for no-sampling reasoning models', () => {
    const guarded = { model: 'gpt-5.4', temperature: 1, topP: 0.8, max_output_tokens: 2000 };
    expect(sanitizeOpenAIReasoningSamplingParams(guarded)).toEqual(['temperature', 'topP']);
    expect(guarded).toEqual({ model: 'gpt-5.4', max_output_tokens: 2000 });

    const samplingCapable = { model: 'gpt-5.2', temperature: 0.4, topP: 0.9 };
    expect(sanitizeOpenAIReasoningSamplingParams(samplingCapable)).toEqual([]);
    expect(samplingCapable).toEqual({ model: 'gpt-5.2', temperature: 0.4, topP: 0.9 });
  });
});
