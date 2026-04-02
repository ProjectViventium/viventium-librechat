import { ErrorTypes, EModelEndpoint, mapModelToAzureConfig } from 'librechat-data-provider';
import type {
  BaseInitializeParams,
  InitializeResultBase,
  OpenAIConfigOptions,
  OpenAIModelOptions,
  UserKeyValues,
} from '~/types';
import { getAzureCredentials, resolveHeaders, isUserProvided, checkUserKeyExpiry } from '~/utils';
import { getOpenAIConfig } from './config';

/* === VIVENTIUM START ===
 * Feature: Connected Accounts routing policy.
 * Purpose: Attempt user credential first for OpenAI-family endpoints, then fallback to
 * platform credential when user credential is missing (while preserving invalid/expired failures).
 * === VIVENTIUM END === */
const OPENAI_CONNECTED_ACCOUNT_RECONNECT_MESSAGE =
  'OpenAI connected account needs reconnect in Settings > Account > Connected Accounts.';

const isNoUserKeyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const parsed = JSON.parse(error.message) as { type?: string };
    return parsed.type === ErrorTypes.NO_USER_KEY;
  } catch {
    return false;
  }
};

const isInvalidUserKeyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  try {
    const parsed = JSON.parse(error.message) as { type?: string };
    return parsed.type === ErrorTypes.INVALID_USER_KEY;
  } catch {
    return false;
  }
};

const isOpenAIConnectedAccountReadError = (error: unknown): boolean => {
  if (isInvalidUserKeyError(error)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('operation-specific reason') ||
    message.includes('bad decrypt') ||
    message.includes('invalid key length')
  );
};

const isConnectedAccountAuthMode = (): boolean => {
  const values = [
    process.env.VIVENTIUM_OPENAI_AUTH_MODE,
    process.env.VIVENTIUM_PRIMARY_AUTH_MODE,
  ];

  return values.some((value) => value?.trim().toLowerCase() === 'connected_account');
};

/**
 * Initializes OpenAI options for agent usage. This function always returns configuration
 * options and never creates a client instance (equivalent to optionsOnly=true behavior).
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to OpenAI configuration options
 * @throws Error if API key is missing or user key has expired
 */
export async function initializeOpenAI({
  req,
  endpoint,
  model_parameters,
  db,
}: BaseInitializeParams): Promise<InitializeResultBase> {
  const codexDebugEnabled = process.env.VIVENTIUM_OPENAI_CODEX_DEBUG === 'true';
  const appConfig = req.config;
  const { PROXY, OPENAI_API_KEY, AZURE_API_KEY, OPENAI_REVERSE_PROXY, AZURE_OPENAI_BASEURL } =
    process.env;

  const { key: expiresAt } = req.body;
  const modelName = model_parameters?.model as string | undefined;

  const credentials = {
    [EModelEndpoint.openAI]: OPENAI_API_KEY,
    [EModelEndpoint.azureOpenAI]: AZURE_API_KEY,
  };

  const baseURLOptions = {
    [EModelEndpoint.openAI]: OPENAI_REVERSE_PROXY,
    [EModelEndpoint.azureOpenAI]: AZURE_OPENAI_BASEURL,
  };

  const userProvidesKey = isUserProvided(credentials[endpoint as keyof typeof credentials]);
  const userProvidesURL = isUserProvided(baseURLOptions[endpoint as keyof typeof baseURLOptions]);

  let userValues: UserKeyValues | null = null;
  try {
    userValues = await db.getUserKeyValues({ userId: req.user?.id ?? '', name: endpoint });
    if (expiresAt) {
      checkUserKeyExpiry(expiresAt, endpoint);
    }
  } catch (error) {
    if (isNoUserKeyError(error)) {
      userValues = null;
    } else if (isOpenAIConnectedAccountReadError(error)) {
      if (isConnectedAccountAuthMode()) {
        throw new Error(OPENAI_CONNECTED_ACCOUNT_RECONNECT_MESSAGE);
      }
      userValues = null;
    } else {
      throw error;
    }
  }

  const hasUserApiKey = Boolean(userValues?.apiKey);
  const hasUserBaseURL = Boolean(userValues?.baseURL);
  const hasUserHeaders = Boolean(userValues?.headers && Object.keys(userValues.headers).length > 0);
  const isOpenAIOAuthSubscription = userValues?.oauthProvider === 'openai-codex';

  let apiKey = credentials[endpoint as keyof typeof credentials];
  if (userProvidesKey) {
    apiKey = undefined;
  }
  if (hasUserApiKey) {
    apiKey = userValues?.apiKey;
  }

  let baseURL = baseURLOptions[endpoint as keyof typeof baseURLOptions];
  if (userProvidesURL) {
    baseURL = undefined;
  }
  if (hasUserBaseURL) {
    baseURL = userValues?.baseURL;
  }

  const clientOptions: OpenAIConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: baseURL || undefined,
    streaming: true,
  };

  if (hasUserHeaders) {
    clientOptions.headers = resolveHeaders({
      headers: {
        ...(clientOptions.headers ?? {}),
        ...(userValues?.headers ?? {}),
      },
      user: req.user,
    });
  }

  const isAzureOpenAI = endpoint === EModelEndpoint.azureOpenAI;
  const azureConfig = isAzureOpenAI && appConfig?.endpoints?.[EModelEndpoint.azureOpenAI];
  let isServerless = false;

  if (isAzureOpenAI && azureConfig) {
    const { modelGroupMap, groupMap } = azureConfig;
    const {
      azureOptions,
      baseURL: configBaseURL,
      headers = {},
      serverless,
    } = mapModelToAzureConfig({
      modelName: modelName || '',
      modelGroupMap,
      groupMap,
    });
    isServerless = serverless === true;

    clientOptions.reverseProxyUrl = configBaseURL ?? clientOptions.reverseProxyUrl;
    clientOptions.headers = resolveHeaders({
      headers: { ...headers, ...(clientOptions.headers ?? {}) },
      user: req.user,
    });

    const groupName = modelGroupMap[modelName || '']?.group;
    if (groupName && groupMap[groupName]) {
      clientOptions.addParams = groupMap[groupName]?.addParams;
      clientOptions.dropParams = groupMap[groupName]?.dropParams;
    }

    apiKey = azureOptions.azureOpenAIApiKey;
    clientOptions.azure = !isServerless ? azureOptions : undefined;

    if (isServerless) {
      clientOptions.defaultQuery = azureOptions.azureOpenAIApiVersion
        ? { 'api-version': azureOptions.azureOpenAIApiVersion }
        : undefined;

      if (!clientOptions.headers) {
        clientOptions.headers = {};
      }
      clientOptions.headers['api-key'] = apiKey;
    }
  } else if (isAzureOpenAI) {
    clientOptions.azure =
      hasUserApiKey && userValues?.apiKey ? JSON.parse(userValues.apiKey) : getAzureCredentials();
    apiKey = clientOptions.azure ? clientOptions.azure.azureOpenAIApiKey : undefined;
  }

  if (userProvidesKey && !apiKey) {
    throw new Error(
      JSON.stringify({
        type: ErrorTypes.NO_USER_KEY,
      }),
    );
  }

  if (!apiKey) {
    throw new Error(`${endpoint} API Key not provided.`);
  }

  const modelOptions: OpenAIModelOptions & { user?: string } = {
    ...(model_parameters as OpenAIModelOptions),
    model: modelName,
    user: req.user?.id,
  };

  if (isOpenAIOAuthSubscription && modelOptions.useResponsesApi == null) {
    modelOptions.useResponsesApi = true;
  }

  if (codexDebugEnabled && endpoint === EModelEndpoint.openAI) {
    console.info(
      '[OpenAI Init Debug]',
      JSON.stringify({
        endpoint,
        userId: req.user?.id ?? null,
        model: modelName ?? null,
        hasUserApiKey,
        hasUserBaseURL,
        oauthProvider: userValues?.oauthProvider ?? null,
        oauthType: userValues?.oauthType ?? null,
        resolvedBaseURL: baseURL ?? null,
        useResponsesApi:
          (typeof modelOptions.useResponsesApi === 'boolean' ? modelOptions.useResponsesApi : null) ??
          null,
      }),
    );
  }

  const finalClientOptions: OpenAIConfigOptions = {
    ...clientOptions,
    modelOptions,
  };

  const options = getOpenAIConfig(apiKey, finalClientOptions, endpoint);

  /** Set useLegacyContent for Azure serverless deployments */
  if (isServerless) {
    (options as InitializeResultBase).useLegacyContent = true;
  }

  const openAIConfig = appConfig?.endpoints?.[EModelEndpoint.openAI];
  const allConfig = appConfig?.endpoints?.all;
  const azureRate = modelName?.includes('gpt-4') ? 30 : 17;

  let streamRate: number | undefined;

  if (isAzureOpenAI && azureConfig) {
    streamRate = azureConfig.streamRate ?? azureRate;
  } else if (!isAzureOpenAI && openAIConfig) {
    streamRate = openAIConfig.streamRate;
  }

  if (allConfig?.streamRate) {
    streamRate = allConfig.streamRate;
  }

  if (streamRate) {
    options.llmConfig._lc_stream_delay = streamRate;
  }

  return options;
}
