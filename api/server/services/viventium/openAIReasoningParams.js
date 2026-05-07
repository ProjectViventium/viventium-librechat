/* === VIVENTIUM START ===
 * Feature: OpenAI reasoning-model runtime parameter guard.
 *
 * Purpose:
 * - Keep background and follow-up OpenAI reasoning-style runs from carrying sampling parameters
 *   that provider runtimes reject.
 * - Stay model/provider compatibility driven, not agent-name driven.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */

const OPENAI_REASONING_SAMPLING_PARAMS = Object.freeze([
  'frequencyPenalty',
  'frequency_penalty',
  'presencePenalty',
  'presence_penalty',
  'temperature',
  'topP',
  'top_p',
  'logitBias',
  'logit_bias',
  'n',
  'logprobs',
  'topLogprobs',
  'top_logprobs',
]);

const OPENAI_REASONING_MODEL_IDS_WITHOUT_SAMPLING = Object.freeze(new Set([
  // Runtime evidence: the configured Viventium OpenAI reasoning endpoint rejected this model bag
  // with sampling controls during background cortex execution.
  'gpt-5.4',
]));

function isOpenAIReasoningModelWithoutSampling(model) {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/^o[13](?:[-.]|$)/.test(normalized)) {
    return true;
  }
  if (/^gpt-5(?!\.|-chat)(?:-|$)/.test(normalized)) {
    return true;
  }
  return OPENAI_REASONING_MODEL_IDS_WITHOUT_SAMPLING.has(normalized);
}

function sanitizeOpenAIReasoningSamplingParams(target, { model } = {}) {
  if (!target || typeof target !== 'object') {
    return [];
  }
  if (!isOpenAIReasoningModelWithoutSampling(model || target.model || target.modelName)) {
    return [];
  }

  const removed = [];
  for (const key of OPENAI_REASONING_SAMPLING_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      delete target[key];
      removed.push(key);
    }
  }
  return removed;
}

module.exports = {
  OPENAI_REASONING_MODEL_IDS_WITHOUT_SAMPLING,
  OPENAI_REASONING_SAMPLING_PARAMS,
  isOpenAIReasoningModelWithoutSampling,
  sanitizeOpenAIReasoningSamplingParams,
};
