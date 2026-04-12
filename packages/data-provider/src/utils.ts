import { EModelEndpoint, Providers } from './schemas';

export const envVarRegex = /^\${(.+)}$/;

const caseInsensitiveKnownEndpoints = new Set([
  'ollama',
  'cohere',
  'deepseek',
  'fireworks',
  'groq',
  'helicone',
  'huggingface',
  'mistral',
  'moonshot',
  'openrouter',
  'perplexity',
  'shuttleai',
  'together.ai',
  'unify',
  'vercel',
  'xai',
]);

/** Extracts the environment variable name from a template literal string */
export function extractVariableName(value: string): string | null {
  if (!value) {
    return null;
  }

  const match = value.trim().match(envVarRegex);
  return match ? match[1] : null;
}

/** Extracts the value of an environment variable from a string. */
export function extractEnvVariable(value: string) {
  if (!value) {
    return value;
  }

  // Trim the input
  const trimmed = value.trim();

  // Special case: if it's just a single environment variable
  const singleMatch = trimmed.match(envVarRegex);
  if (singleMatch) {
    const varName = singleMatch[1];
    return process.env[varName] || trimmed;
  }

  // For multiple variables, process them using a regex loop
  const regex = /\${([^}]+)}/g;
  let result = trimmed;

  // First collect all matches and their positions
  const matches = [];
  let match;
  while ((match = regex.exec(trimmed)) !== null) {
    matches.push({
      fullMatch: match[0],
      varName: match[1],
      index: match.index,
    });
  }

  // Process matches in reverse order to avoid position shifts
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, varName, index } = matches[i];
    const envValue = process.env[varName] || fullMatch;

    // Replace at exact position
    result = result.substring(0, index) + envValue + result.substring(index + fullMatch.length);
  }

  return result;
}

/**
 * Normalize the endpoint name to system-expected value.
 * @param name
 */
export function normalizeEndpointName(name = ''): string {
  const trimmed = name.trim();
  const lowered = trimmed.toLowerCase();
  return caseInsensitiveKnownEndpoints.has(lowered) ? lowered : trimmed;
}

/* === VIVENTIUM START ===
 * Feature: Shared runtime provider alias normalization.
 *
 * Purpose:
 * - Accept compiler-emitted canonical provider strings such as `openai`.
 * - Normalize only known provider aliases while preserving unknown custom endpoint names.
 *
 * Added: 2026-04-09
 * === VIVENTIUM END === */
const canonicalProviderAliases: Record<string, string> = {
  openai: EModelEndpoint.openAI,
  azureopenai: EModelEndpoint.azureOpenAI,
  azure_openai: EModelEndpoint.azureOpenAI,
  anthropic: EModelEndpoint.anthropic,
  google: EModelEndpoint.google,
  bedrock: EModelEndpoint.bedrock,
  openrouter: Providers.OPENROUTER,
  moonshot: Providers.MOONSHOT,
  deepseek: Providers.DEEPSEEK,
  xai: Providers.XAI,
  x_ai: Providers.XAI,
};

export function normalizeProviderAlias(provider = ''): string {
  const trimmed = String(provider ?? '').trim();
  if (!trimmed) {
    return '';
  }

  return canonicalProviderAliases[trimmed.toLowerCase()] ?? trimmed;
}
