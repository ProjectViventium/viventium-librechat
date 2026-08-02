/* === VIVENTIUM START ===
 * Feature: Capability-owned Agent Builder model labels.
 * Purpose: Persist exact provider model IDs while rendering the friendly label declared by the
 * provider capability registry on both the picker and the collapsed Builder field.
 * === VIVENTIUM END === */
export function resolveAgentModelDisplayLabel({
  provider,
  model,
  providerCapabilities,
}: {
  provider: string;
  model: string;
  providerCapabilities: Record<
    string,
    { models?: Array<{ id: string; label?: string }> } | undefined
  >;
}): string {
  return (
    providerCapabilities[provider]?.models?.find((candidate) => candidate.id === model)?.label ??
    model
  );
}

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
 * Feature: capability-declared model effort.
 * Purpose: Preserve a supported explicit effort and repair only missing/stale values from the
 * provider registry instead of parsing model names or provider labels.
 * === VIVENTIUM END === */
export function resolveCapabilityEffort(
  currentEffort: unknown,
  modelCapability: { effortChoices?: string[]; recommendedEffort?: string } | null | undefined,
): string | undefined {
  const choices = modelCapability?.effortChoices ?? [];
  if (choices.length === 0) {
    return undefined;
  }
  const current = String(currentEffort ?? '').trim();
  if (current && choices.includes(current)) {
    return current;
  }
  const recommended = String(modelCapability?.recommendedEffort ?? '').trim();
  return recommended && choices.includes(recommended) ? recommended : choices[0];
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
