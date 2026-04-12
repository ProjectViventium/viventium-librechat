import { Providers } from '@librechat/agents';
import { EModelEndpoint, normalizeProviderAlias } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { BaseInitializeParams, InitializeResultBase } from '~/types';
import { initializeAnthropic } from './anthropic/initialize';
import { initializeBedrock } from './bedrock/initialize';
import { initializeCustom } from './custom/initialize';
import { initializeGoogle } from './google/initialize';
import { initializeOpenAI } from './openai/initialize';
import { getCustomEndpointConfig } from '~/app/config';

/**
 * Type for initialize functions
 */
export type InitializeFn = (params: BaseInitializeParams) => Promise<InitializeResultBase>;

/**
 * Check if the provider is a known custom provider
 * @param provider - The provider string
 * @returns True if the provider is a known custom provider, false otherwise
 */
export function isKnownCustomProvider(provider?: string): boolean {
  return [Providers.XAI, Providers.DEEPSEEK, Providers.OPENROUTER, Providers.MOONSHOT].includes(
    (provider?.toLowerCase() ?? '') as Providers,
  );
}

/**
 * Provider configuration map mapping providers to their initialization functions
 */
export const providerConfigMap: Partial<Record<string, InitializeFn>> = {
  [Providers.XAI]: initializeCustom,
  [Providers.DEEPSEEK]: initializeCustom,
  [Providers.MOONSHOT]: initializeCustom,
  [Providers.OPENROUTER]: initializeCustom,
  [EModelEndpoint.openAI]: initializeOpenAI,
  [EModelEndpoint.google]: initializeGoogle,
  [EModelEndpoint.bedrock]: initializeBedrock,
  [EModelEndpoint.azureOpenAI]: initializeOpenAI,
  [EModelEndpoint.anthropic]: initializeAnthropic,
};

/**
 * Result from getProviderConfig
 */
export interface ProviderConfigResult {
  /** The initialization function for this provider */
  getOptions: InitializeFn;
  /** The resolved provider name (may be different from input if normalized) */
  overrideProvider: string;
  /** Endpoint name to pass into initialization (preserves custom endpoint identity) */
  initEndpoint: string;
  /** Custom endpoint configuration (if applicable) */
  customEndpointConfig?: Partial<TEndpoint>;
}

/**
 * Get the provider configuration and override endpoint based on the provider string
 *
 * @param params - Configuration parameters
 * @param params.provider - The provider string
 * @param params.appConfig - The application configuration
 * @returns Provider configuration including getOptions function, override provider, and custom config
 * @throws Error if provider is not supported
 */
export function getProviderConfig({
  provider,
  appConfig,
}: {
  provider: string;
  appConfig?: AppConfig;
}): ProviderConfigResult {
  /* === VIVENTIUM START ===
   * Feature: Shared provider alias normalization for runtime initialization.
   *
   * Purpose:
   * - Accept compiler-emitted `openai` and other case/alias variants without changing the compiler
   *   contract.
   *
   * Added: 2026-04-09
   * === VIVENTIUM END === */
  const normalizedProvider = normalizeProviderAlias(provider);
  let getOptions = providerConfigMap[normalizedProvider];
  let overrideProvider = getOptions != null ? normalizedProvider : provider;
  let initEndpoint = overrideProvider;
  let customEndpointConfig: Partial<TEndpoint> | undefined;

  if (!getOptions) {
    customEndpointConfig = getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig) {
      throw new Error(
        `Provider ${provider} not supported${normalizedProvider !== provider ? ` (normalized: ${normalizedProvider})` : ''}`,
      );
    }
    getOptions = initializeCustom;
    overrideProvider = Providers.OPENAI;
    initEndpoint = provider;
  }

  if (isKnownCustomProvider(overrideProvider) && !customEndpointConfig) {
    customEndpointConfig =
      getCustomEndpointConfig({ endpoint: overrideProvider, appConfig }) ??
      getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig) {
      throw new Error(
        `Provider ${provider} not supported${normalizedProvider !== provider ? ` (normalized: ${normalizedProvider})` : ''}`,
      );
    }
  }

  return {
    getOptions,
    overrideProvider,
    initEndpoint,
    customEndpointConfig,
  };
}
