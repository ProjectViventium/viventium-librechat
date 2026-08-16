export function resolveAgentModelForProvider({
  provider,
  model,
  availableModels,
  previousProvider,
}: {
  provider: string;
  model: string;
  availableModels: string[];
  previousProvider?: string;
}): string {
  if (!provider) {
    return model;
  }

  if (!model) {
    return availableModels[0] ?? '';
  }

  if (availableModels.includes(model)) {
    return model;
  }

  const providerChanged =
    typeof previousProvider === 'string' &&
    previousProvider.length > 0 &&
    previousProvider !== provider;

  if (providerChanged) {
    return availableModels[0] ?? model;
  }

  return model;
}

/* === VIVENTIUM START ===
 * Feature: Optional-route provider parameter isolation.
 * Purpose: Provider-specific settings such as OpenAI Responses must not survive a real provider
 * change and contaminate an xAI, Anthropic, or other optional agent route.
 * === VIVENTIUM END === */
export function didAgentProviderChange({
  provider,
  previousProvider,
}: {
  provider: string;
  previousProvider?: string;
}): boolean {
  return Boolean(previousProvider) && previousProvider !== provider;
}

/* === VIVENTIUM START ===
 * Feature: GPT-5.6 Agent Builder Responses default.
 * Purpose: GPT-5.6 agent workflows should use the existing Responses path by default, while an
 * explicit operator choice remains authoritative.
 * Source: https://developers.openai.com/api/docs/guides/latest-model
 * === VIVENTIUM END === */
const OPENAI_GPT_56_AGENT_MODELS = new Set([
  'gpt-5.6',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

export function shouldDefaultOpenAIGPT56AgentToResponses({
  provider,
  model,
  useResponsesApi,
}: {
  provider: string;
  model: string;
  useResponsesApi?: boolean;
}): boolean {
  return (
    provider.trim().toLowerCase() === 'openai' &&
    OPENAI_GPT_56_AGENT_MODELS.has(model.trim().toLowerCase()) &&
    useResponsesApi == null
  );
}
/* === VIVENTIUM END === */
