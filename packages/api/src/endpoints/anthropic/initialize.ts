import { EModelEndpoint, AuthKeys, ErrorTypes } from 'librechat-data-provider';
import type {
  BaseInitializeParams,
  InitializeResultBase,
  AnthropicConfigOptions,
  UserKeyValues,
} from '~/types';
import { checkUserKeyExpiry, isEnabled } from '~/utils';
import { loadAnthropicVertexCredentials, getVertexCredentialOptions } from './vertex';
import { getLLMConfig } from './llm';
import { resolveAnthropicSubscriptionUserValues } from './oauthSubscription';

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

/**
 * Initializes Anthropic endpoint configuration.
 * Supports both direct API key authentication and Google Cloud Vertex AI.
 *
 * @param params - Configuration parameters
 * @returns Promise resolving to Anthropic configuration options
 * @throws Error if API key is not provided (when not using Vertex AI)
 */
export async function initializeAnthropic({
  req,
  endpoint,
  model_parameters,
  db,
}: BaseInitializeParams): Promise<InitializeResultBase> {
  void endpoint;
  const appConfig = req.config;
  const { ANTHROPIC_API_KEY, ANTHROPIC_REVERSE_PROXY, PROXY } = process.env;
  const { key: expiresAt } = req.body;

  let credentials: Record<string, unknown> = {};
  let vertexOptions: { region?: string; projectId?: string } | undefined;
  let userValues: UserKeyValues | null = null;

  /** @type {undefined | import('librechat-data-provider').TVertexAIConfig} */
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

  // Check for Vertex AI configuration: YAML config takes priority over env var
  // When vertexConfig exists and enabled is not explicitly false, Vertex AI is enabled
  const useVertexAI =
    (vertexConfig && vertexConfig.enabled !== false) || isEnabled(process.env.ANTHROPIC_USE_VERTEX);

  if (useVertexAI) {
    // Load credentials with optional YAML config overrides
    const credentialOptions = vertexConfig ? getVertexCredentialOptions(vertexConfig) : undefined;
    credentials = await loadAnthropicVertexCredentials(credentialOptions);

    // Store vertex options for client creation
    if (vertexConfig) {
      vertexOptions = {
        region: vertexConfig.region,
        projectId: vertexConfig.projectId,
      };
    }
  } else {
    const isUserProvided = ANTHROPIC_API_KEY === 'user_provided';
    let anthropicApiKey: string | undefined;
    try {
      userValues = await db.getUserKeyValues({
        userId: req.user?.id ?? '',
        name: EModelEndpoint.anthropic,
      });
      userValues = await resolveAnthropicSubscriptionUserValues(req.user?.id ?? '', userValues, db);
      anthropicApiKey = userValues?.authToken || userValues?.apiKey;
      if (expiresAt && anthropicApiKey && userValues?.oauthProvider !== 'anthropic') {
        checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
      }
    } catch (error) {
      if (isInvalidUserKeyError(error)) {
        /** Backward compatibility for older plain-string Anthropic keys */
        try {
          anthropicApiKey = await db.getUserKey({
            userId: req.user?.id ?? '',
            name: EModelEndpoint.anthropic,
          });
          if (expiresAt) {
            checkUserKeyExpiry(expiresAt, EModelEndpoint.anthropic);
          }
        } catch (legacyError) {
          if (!isNoUserKeyError(legacyError)) {
            throw legacyError;
          }
        }
      } else if (!isNoUserKeyError(error)) {
        throw error;
      }
    }

    if (!anthropicApiKey) {
      anthropicApiKey = isUserProvided ? undefined : ANTHROPIC_API_KEY;
    }

    if (!anthropicApiKey) {
      if (isUserProvided) {
        throw new Error(
          JSON.stringify({
            type: ErrorTypes.NO_USER_KEY,
          }),
        );
      }
      throw new Error('Anthropic API key not provided. Please provide it again.');
    }

    credentials[AuthKeys.ANTHROPIC_API_KEY] = anthropicApiKey;
  }

  const clientOptions: AnthropicConfigOptions = {
    proxy: PROXY ?? undefined,
    reverseProxyUrl: ANTHROPIC_REVERSE_PROXY ?? undefined,
    ...(userValues?.oauthType ? { oauthType: userValues.oauthType } : {}),
    ...(userValues?.oauthProvider ? { oauthProvider: userValues.oauthProvider } : {}),
    modelOptions: {
      ...(model_parameters ?? {}),
      user: req.user?.id,
    },
    // Pass Vertex AI options if configured
    ...(vertexOptions && { vertexOptions }),
    // Pass full Vertex AI config including model mappings
    ...(vertexConfig && { vertexConfig }),
  };

  const anthropicConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic];
  const allConfig = appConfig?.endpoints?.all;

  const result = getLLMConfig(credentials, clientOptions);

  if (anthropicConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = anthropicConfig.streamRate;
  }

  if (allConfig?.streamRate) {
    (result.llmConfig as Record<string, unknown>)._lc_stream_delay = allConfig.streamRate;
  }

  return result;
}
