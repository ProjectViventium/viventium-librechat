const { Providers } = require('@librechat/agents');
const { EModelEndpoint, normalizeProviderAlias } = require('librechat-data-provider');
const { getCustomEndpointConfig } = require('@librechat/api');
const initAnthropic = require('~/server/services/Endpoints/anthropic/initialize');
const getBedrockOptions = require('~/server/services/Endpoints/bedrock/options');
const initOpenAI = require('~/server/services/Endpoints/openAI/initialize');
const initCustom = require('~/server/services/Endpoints/custom/initialize');
const initGoogle = require('~/server/services/Endpoints/google/initialize');

/** Check if the provider is a known custom provider
 * @param {string | undefined} [provider] - The provider string
 * @returns {boolean} - True if the provider is a known custom provider, false otherwise
 */
function isKnownCustomProvider(provider) {
  return [Providers.XAI, Providers.DEEPSEEK, Providers.OPENROUTER, Providers.MOONSHOT].includes(
    provider?.toLowerCase() || '',
  );
}

const providerConfigMap = {
  [Providers.XAI]: initCustom,
  [Providers.DEEPSEEK]: initCustom,
  [Providers.MOONSHOT]: initCustom,
  [Providers.OPENROUTER]: initCustom,
  [EModelEndpoint.openAI]: initOpenAI,
  [EModelEndpoint.google]: initGoogle,
  [EModelEndpoint.azureOpenAI]: initOpenAI,
  [EModelEndpoint.anthropic]: initAnthropic,
  [EModelEndpoint.bedrock]: getBedrockOptions,
};

/**
 * Get the provider configuration and override endpoint based on the provider string
 * @param {Object} params
 * @param {string} params.provider - The provider string
 * @param {AppConfig} params.appConfig - The application configuration
 * @returns {{
 * getOptions: (typeof providerConfigMap)[keyof typeof providerConfigMap],
 * overrideProvider: string,
 * initEndpoint: string,
 * customEndpointConfig?: TEndpoint
 * }}
 */
function getProviderConfig({ provider, appConfig }) {
  /* === VIVENTIUM START ===
   * Feature: Shared provider alias normalization for runtime initialization.
   * Added: 2026-04-09
   * === VIVENTIUM END === */
  const normalizedProvider = normalizeProviderAlias(provider);
  let getOptions = providerConfigMap[normalizedProvider];
  let overrideProvider = getOptions ? normalizedProvider : provider;
  let initEndpoint = overrideProvider;
  /** @type {TEndpoint | undefined} */
  let customEndpointConfig;

  if (!getOptions) {
    customEndpointConfig = getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig) {
      throw new Error(
        `Provider ${provider} not supported${
          normalizedProvider !== provider ? ` (normalized: ${normalizedProvider})` : ''
        }`,
      );
    }
    getOptions = initCustom;
    overrideProvider = Providers.OPENAI;
    initEndpoint = provider;
  }

  if (isKnownCustomProvider(overrideProvider) && !customEndpointConfig) {
    customEndpointConfig =
      getCustomEndpointConfig({ endpoint: overrideProvider, appConfig }) ||
      getCustomEndpointConfig({ endpoint: provider, appConfig });
    if (!customEndpointConfig) {
      throw new Error(
        `Provider ${provider} not supported${
          normalizedProvider !== provider ? ` (normalized: ${normalizedProvider})` : ''
        }`,
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

module.exports = {
  getProviderConfig,
};
