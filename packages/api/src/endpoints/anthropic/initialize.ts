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
/* === VIVENTIUM START === Connected Accounts credential policy === */
import { resolveConnectedAccountCredentialPolicy } from '../connectedAccounts/policy';
/* === VIVENTIUM END === */

/* === VIVENTIUM START ===
 * Feature: Connected-account credential recovery.
 * Purpose: Convert unreadable stored Anthropic credentials into reconnect guidance or safe fallback.
 */
const ANTHROPIC_CONNECTED_ACCOUNT_RECONNECT_MESSAGE =
  'Anthropic connected account needs reconnect in Settings > Account > Connected Accounts.';

type ViventiumConnectedAccountReconnectError = Error & {
  code?: string;
  viventiumConnectedAccountReconnectRequired?: boolean;
  viventiumConnectedAccountProvider?: string;
};

function anthropicConnectedAccountReconnectError(): ViventiumConnectedAccountReconnectError {
  const error = new Error(
    ANTHROPIC_CONNECTED_ACCOUNT_RECONNECT_MESSAGE,
  ) as ViventiumConnectedAccountReconnectError;
  error.code = 'MODEL_AUTHENTICATION';
  error.viventiumConnectedAccountReconnectRequired = true;
  error.viventiumConnectedAccountProvider = 'Anthropic';
  return error;
}

function isTerminalAnthropicConnectedAccountAuthFailure(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: { type?: unknown };
    response?: { status?: unknown };
  };
  const status = Number(candidate.status ?? candidate.statusCode ?? candidate.response?.status);
  const code = String(candidate.code || candidate.error?.type || '').trim().toLowerCase();
  return status === 401 || status === 403 || code === 'invalid_grant' || code === 'authentication_error';
}
/* === VIVENTIUM END === */

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

/* === VIVENTIUM START ===
 * Feature: Connected-account credential recovery.
 * Purpose: Detect keychain/decryption failures so Telegram surfaces reconnect guidance instead of a generic connection error.
 * === VIVENTIUM END === */
const isAnthropicConnectedAccountReadError = (error: unknown): boolean => {
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

const isAnthropicConnectedAccountReconnectFailure = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes('Anthropic connected account needs reconnect');

const isConnectedAccountAuthMode = (): boolean => {
  const values = [
    process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE,
    process.env.VIVENTIUM_PRIMARY_AUTH_MODE,
    process.env.VIVENTIUM_SECONDARY_AUTH_MODE,
  ];

  return values.some((value) => value?.trim().toLowerCase() === 'connected_account');
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
  /* === VIVENTIUM START ===
   * Feature: Per-user connected-account credential policy.
   * Purpose: Resolve the personal-only opt-out before any platform credential can be selected.
   * === VIVENTIUM END === */
  const credentialPolicy = await resolveConnectedAccountCredentialPolicy({
    userId: req.user?.id ?? '',
    provider: 'anthropic',
    db,
  });
  const personalCredentialsRequired = credentialPolicy === 'personal_required';

  let credentials: Record<string, unknown> = {};
  let vertexOptions: { region?: string; projectId?: string } | undefined;
  let userValues: UserKeyValues | null = null;

  /** @type {undefined | import('librechat-data-provider').TVertexAIConfig} */
  const vertexConfig = appConfig?.endpoints?.[EModelEndpoint.anthropic]?.vertexConfig;

  // Check for Vertex AI configuration: YAML config takes priority over env var
  // When vertexConfig exists and enabled is not explicitly false, Vertex AI is enabled
  const useVertexAI =
    (vertexConfig && vertexConfig.enabled !== false) || isEnabled(process.env.ANTHROPIC_USE_VERTEX);

  /* === VIVENTIUM START === Personal-required credential policy === */
  if (useVertexAI && personalCredentialsRequired) {
    throw anthropicConnectedAccountReconnectError();
  }
  /* === VIVENTIUM END === */

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
      /* === VIVENTIUM START ===
       * Feature: Connected-account credential recovery.
       * Purpose: Treat unreadable connected-account secrets as reconnect/fallback cases instead of hard initialization crashes.
       * === VIVENTIUM END === */
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
          if (isAnthropicConnectedAccountReadError(legacyError)) {
            /* === VIVENTIUM START === Personal-required credential policy === */
            if (personalCredentialsRequired || isConnectedAccountAuthMode()) {
              throw anthropicConnectedAccountReconnectError();
            }
            /* === VIVENTIUM END === */
          } else if (!isNoUserKeyError(legacyError)) {
            throw legacyError;
          }
        }
      } else if (isAnthropicConnectedAccountReadError(error)) {
        /* === VIVENTIUM START === Personal-required credential policy === */
        if (personalCredentialsRequired || isConnectedAccountAuthMode()) {
          throw anthropicConnectedAccountReconnectError();
        }
        /* === VIVENTIUM END === */
      } else if (!isNoUserKeyError(error)) {
        throw error;
      }
    }

    /* === VIVENTIUM START === Personal-required credential policy === */
    if (!anthropicApiKey && !personalCredentialsRequired) {
      anthropicApiKey = isUserProvided ? undefined : ANTHROPIC_API_KEY;
    }
    /* === VIVENTIUM END === */

    if (!anthropicApiKey) {
      /* === VIVENTIUM START === Personal-required credential policy === */
      if (personalCredentialsRequired || (isUserProvided && isConnectedAccountAuthMode())) {
        throw anthropicConnectedAccountReconnectError();
      }
      /* === VIVENTIUM END === */
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
    ...(userValues?.oauthProvider === 'anthropic' && userValues?.oauthType === 'subscription'
      ? {
          connectedAccountAuthFailure: async (error: unknown) => {
            if (!isTerminalAnthropicConnectedAccountAuthFailure(error)) {
              return;
            }
            if (db.updateUserKey) {
              await db.updateUserKey({
                userId: req.user?.id ?? '',
                name: EModelEndpoint.anthropic,
                value: JSON.stringify({ ...userValues, oauthReconnectRequired: true }),
                expiresAt: null,
              });
            }
            throw anthropicConnectedAccountReconnectError();
          },
        }
      : {}),
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

export { isTerminalAnthropicConnectedAccountAuthFailure };
