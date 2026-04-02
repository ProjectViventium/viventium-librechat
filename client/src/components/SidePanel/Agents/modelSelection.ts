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
    typeof previousProvider === 'string' && previousProvider.length > 0 && previousProvider !== provider;

  if (providerChanged) {
    return availableModels[0] ?? model;
  }

  return model;
}
