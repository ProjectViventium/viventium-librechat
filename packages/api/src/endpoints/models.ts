import axios from 'axios';
import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CacheKeys, KnownEndpoints, EModelEndpoint, defaultModels, extractEnvVariable, normalizeEndpointName } from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import {
  processModelData,
  extractBaseURL,
  isUserProvided,
  resolveHeaders,
  deriveBaseURL,
  logAxiosError,
  inputSchema,
} from '~/utils';
import { standardCache } from '~/cache';
import { trustedUploadedFilesFromRequestBody } from '~/glasshive/sourceSelection';
import { GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES, GLASSHIVE_NATIVE_MEDIA_MAX_BYTES,
  GLASSHIVE_NATIVE_MEDIA_MAX_IMAGE_BYTES } from '~/glasshive/nativeMedia';

/** Authenticated discovery metadata only; reads never fetch or delay a conversation turn. */
const nativeHistoryModelCache = standardCache(CacheKeys.CONFIG_STORE);
const nativeHistoryKey = (baseURL: string) =>
  `native-history-admission:${createHash('sha256').update(baseURL.replace(/\/+$/, '')).digest('hex')}`;

export async function getNativeConversationReplayBudget(name: string, baseURL: string, model: string) {
  if (!name || !baseURL || !model) return null;
  const catalog = await nativeHistoryModelCache.get(nativeHistoryKey(baseURL));
  const value = catalog?.[model];
  return Number.isSafeInteger(value) && value > 0 ? Number(value) : null;
}

export async function getNativeConversationReplayBudgetForRoutes(
  routes: Array<{ endpoint?: string; provider?: string; model?: string }>,
  endpoints: Array<{ name?: string; baseURL?: string }> | undefined,
) {
  if (!routes.length || !Array.isArray(endpoints)) return null;
  const values = await Promise.all(routes.map(async route => {
    const name = String(route.endpoint || route.provider || '');
    const endpoint = endpoints.find(item => normalizeEndpointName(String(item.name || '')) === normalizeEndpointName(name));
    const baseURL = extractEnvVariable(String(endpoint?.baseURL || ''));
    if (!baseURL || isUserProvided(baseURL) || baseURL.includes('${')) return null;
    return getNativeConversationReplayBudget(name, baseURL, String(route.model || ''));
  }));
  return values.some(value => value === null) ? null : Math.min(...values as number[]);
}

/** Bound the existing public upload ledger plus its duplicated native workspace paths. */
export function nativeHistoryAttachmentContextBytes(files: Array<Record<string, unknown>>) {
  const selected = trustedUploadedFilesFromRequestBody({ files });
  const ledger = selected.map((file, index) => ({
    file_id: file.file_id,
    // Native sanitization can shorten a name or substitute this fallback. Concatenation bounds
    // both without duplicating that sanitizer or selecting a different workspace filename.
    filename: `${String(file.filename || file.file_id || '')}upload-${index + 1}`,
    source: file.source, type: file.type, bytes: file.bytes, media_group_index: file.media_group_index,
    inputKind: file.source === 'text' ? 'extracted_text' : 'original',
  }));
  return selected.length ? 2 * Buffer.byteLength(JSON.stringify({ selected_uploads: ledger }), 'utf8') +
    Buffer.byteLength(ledger.map((_, index) => `\n${index + 1}. uploads/-${selected.length}`).join(''), 'utf8') : 0;
}

/** Upper bound for replay text, excluding static native system configuration. */
export function nativeConversationContextBudget(
  messages: Array<Record<string, unknown>>, budgetBytes: number, sourceMetadataBytes = 0,
): number | null {
  if (![budgetBytes, sourceMetadataBytes].every(Number.isSafeInteger) ||
      budgetBytes <= 0 || sourceMetadataBytes < 0) return null;
  try {
    let inlineImageCount = 0;
    let inlineImageBytes = 0;
    const visible = messages.filter(message => !['system', 'developer'].includes(String(message.role)))
      .map(({ role, content, tool_call_id, call_id, name }) => ({ role,
        // The native reader renders these declared content kinds. Other typed display/tool
        // blocks stay unchanged in the actual courier and their existing evidence owners.
        content: Array.isArray(content) ? content.filter(part => part && typeof part === 'object' &&
          ['text', 'input_text', 'output_text', 'image_url', 'input_image', 'file', 'input_file'].includes(String(part.type)))
          .map(part => {
            if (['text', 'input_text', 'output_text'].includes(String(part.type))) return part;
            // _message_text renders a media label; the existing native media/file owner carries
            // its complete original bytes separately. Do not charge inline base64 as replay text.
            if (['image_url', 'input_image'].includes(String(part.type))) {
              const url = typeof part.image_url === 'object' && part.image_url !== null
                ? part.image_url.url : part.image_url;
              if (typeof url === 'string' && url.startsWith('data:')) {
                // Match the existing native inline-image ingress before claiming replay fits.
                // Duplicate images are conservatively counted; the native owner may deduplicate.
                if (url.length > Math.ceil(GLASSHIVE_NATIVE_MEDIA_MAX_IMAGE_BYTES / 3) * 4 + 64)
                  throw new TypeError('native_media_capacity');
                const data = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
                if (!data) throw new TypeError('native_media_unknown');
                const bytes = Buffer.from(data[2], 'base64');
                const signatures: Record<string, boolean> = {
                  'image/png': bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
                  'image/jpeg': bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) &&
                    bytes.subarray(-2).equals(Buffer.from('ffd9', 'hex')),
                  'image/gif': ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')),
                  'image/webp': bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
                    bytes.subarray(8, 12).toString('ascii') === 'WEBP',
                };
                inlineImageCount += 1;
                inlineImageBytes += bytes.length;
                if (!bytes.length || bytes.length > GLASSHIVE_NATIVE_MEDIA_MAX_IMAGE_BYTES ||
                    bytes.toString('base64') !== data[2] || !signatures[data[1]] ||
                    inlineImageCount > GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES ||
                    inlineImageBytes > GLASSHIVE_NATIVE_MEDIA_MAX_BYTES)
                  throw new TypeError('native_media_capacity');
              }
            }
            const label = part.name || part.filename || part.type;
            if (typeof label !== 'string') throw new TypeError('native_media_label_unknown');
            return { type: 'text', text: `[Attached ${label}]` };
          }) : content,
        tool_call_id, call_id, name }));
    // JSON bounds the original text, media labels and tool descriptor values. The additional
    // per-row allowance bounds message headings; source metadata bounds delivery/source labels.
    const bytes = Buffer.byteLength(JSON.stringify(visible), 'utf8') +
      visible.length * 128 + 4096 + sourceMetadataBytes;
    return budgetBytes - bytes;
  } catch { return null; }
}

export function nativeConversationHistoryFits(
  messages: Array<Record<string, unknown>>, budgetBytes: number,
  reservedContextBytes: number, sourceMetadataBytes = 0,
) {
  if (!Number.isSafeInteger(reservedContextBytes) || reservedContextBytes < 0) return false;
  const remaining = nativeConversationContextBudget(messages, budgetBytes, sourceMetadataBytes);
  return remaining !== null && remaining >= reservedContextBytes;
}

export interface FetchModelsParams {
  /** User ID for API requests */
  user?: string;
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseURL?: string;
  /** Endpoint name (defaults to 'openAI') */
  name?: string;
  /** Whether directEndpoint was configured */
  direct?: boolean;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to send user ID as query parameter */
  userIdQuery?: boolean;
  /** Whether to create token configuration from API response */
  createTokenConfig?: boolean;
  /** Cache key for token configuration (uses name if omitted) */
  tokenKey?: string;
  /** Optional headers for the request */
  headers?: Record<string, string> | null;
  /** Optional user object for header resolution */
  userObject?: Partial<IUser>;
}

/* === VIVENTIUM START === Recover only missing native discovery, without changing model menus. === */
const nativeCatalogDiscovery = new Map<string, Promise<string[]>>();

export async function ensureNativeConversationModelCatalog(
  params: FetchModelsParams,
): Promise<string[]> {
  const baseURL = params.direct ? extractBaseURL(params.baseURL ?? '') : params.baseURL;
  if (!baseURL || !params.apiKey || isUserProvided(baseURL) || isUserProvided(params.apiKey))
    return [];
  // A successful catalog with no replay-floor declarations is still discovered. Its routes stay
  // unknown for admission, but it must not cause a fetch on every healthy conversation turn.
  if ((await nativeHistoryModelCache.get(nativeHistoryKey(baseURL))) !== undefined) return [];
  // Scope concurrent discovery to the exact authenticated request. Only a digest is retained,
  // and the in-flight entry is removed after either outcome; failures remain retryable.
  const key = createHash('sha256').update(JSON.stringify(params)).digest('hex');
  const existing = nativeCatalogDiscovery.get(key);
  if (existing) return existing;
  const pending = fetchModels(params).finally(() => nativeCatalogDiscovery.delete(key));
  nativeCatalogDiscovery.set(key, pending);
  return pending;
}
/* === VIVENTIUM END === */

/**
 * Fetches Ollama models from the specified base API path.
 * @param baseURL - The Ollama server URL
 * @param options - Optional configuration
 * @returns Promise resolving to array of model names
 */
async function fetchOllamaModels(
  baseURL: string,
  options: { headers?: Record<string, string> | null; user?: Partial<IUser> } = {},
): Promise<string[]> {
  if (!baseURL) {
    return [];
  }

  const ollamaEndpoint = deriveBaseURL(baseURL);

  const resolvedHeaders = resolveHeaders({
    headers: options.headers ?? undefined,
    user: options.user,
  });

  const response = await axios.get<{ models: Array<{ name: string }> }>(
    `${ollamaEndpoint}/api/tags`,
    {
      headers: resolvedHeaders,
      timeout: 5000,
    },
  );

  return response.data.models.map((tag) => tag.name);
}

/**
 * Splits a string by commas and trims each resulting value.
 * @param input - The input string to split.
 * @returns An array of trimmed values.
 */
export function splitAndTrim(input: string | null | undefined): string[] {
  if (!input || typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Fetches models from the specified base API path or Azure, based on the provided configuration.
 *
 * @param params - The parameters for fetching the models.
 * @returns A promise that resolves to an array of model identifiers.
 */
export async function fetchModels({
  user,
  apiKey,
  baseURL: _baseURL,
  name = EModelEndpoint.openAI,
  direct = false,
  azure = false,
  userIdQuery = false,
  createTokenConfig = true,
  tokenKey,
  headers,
  userObject,
}: FetchModelsParams): Promise<string[]> {
  let models: string[] = [];
  const baseURL = direct ? extractBaseURL(_baseURL ?? '') : _baseURL;

  if (!baseURL && !azure) {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  if (name && name.toLowerCase().startsWith(KnownEndpoints.ollama)) {
    try {
      return await fetchOllamaModels(baseURL ?? '', { headers, user: userObject });
    } catch (ollamaError) {
      const logMessage =
        'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.';
      logAxiosError({ message: logMessage, error: ollamaError as Error });
    }
  }

  try {
    const options: {
      headers: Record<string, string>;
      timeout: number;
      httpsAgent?: HttpsProxyAgent<string>;
    } = {
      headers: {
        ...(headers ?? {}),
      },
      timeout: 5000,
    };

    if (name === EModelEndpoint.anthropic) {
      options.headers = {
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      };
    } else {
      options.headers.Authorization = `Bearer ${apiKey}`;
    }

    if (process.env.PROXY) {
      options.httpsAgent = new HttpsProxyAgent(process.env.PROXY);
    }

    if (process.env.OPENAI_ORGANIZATION && baseURL?.includes('openai')) {
      options.headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
    }

    const url = new URL(`${(baseURL ?? '').replace(/\/+$/, '')}${azure ? '' : '/models'}`);
    if (user && userIdQuery) {
      url.searchParams.append('user', user);
    }
    const res = await axios.get(url.toString(), options);

    const input = res.data;
    if (!Array.isArray(input?.data)) throw new Error('Invalid model catalog');
    const nativeBudgets: Record<string, number> = {};
    for (const item of Array.isArray(input?.data) ? input.data : []) {
      const floor = item?.native_history_admission_v1?.replay_budget_floor_bytes;
      if (typeof item?.id === 'string' && Number.isSafeInteger(floor) && floor > 0)
        nativeBudgets[item.id] = floor;
    }
    // Replace the whole discovery projection: a removed or invalid declaration cannot retain
    // an older optimistic floor. Credentials and provider response prose never enter this cache.
    await nativeHistoryModelCache.set(nativeHistoryKey(baseURL ?? ''), nativeBudgets);

    const validationResult = inputSchema.safeParse(input);
    if (validationResult.success && createTokenConfig) {
      const endpointTokenConfig = processModelData(input);
      const cache = standardCache(CacheKeys.TOKEN_CONFIG);
      await cache.set(tokenKey ?? name, endpointTokenConfig);
    }
    models = input.data.map((item: { id: string }) => item.id);
  } catch (error) {
    const logMessage = `Failed to fetch models from ${azure ? 'Azure ' : ''}${name} API`;
    logAxiosError({ message: logMessage, error: error as Error });
  }

  return models;
}

/** Options for fetching OpenAI models */
export interface GetOpenAIModelsOptions {
  /** User ID for API requests */
  user?: string;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to fetch models for the Assistants endpoint */
  assistants?: boolean;
  /** OpenAI API key (if not using environment variable) */
  openAIApiKey?: string;
  /** Whether user provides their own API key */
  userProvidedOpenAI?: boolean;
}

/**
 * Fetches models from OpenAI or Azure based on the provided options.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchOpenAIModels(
  opts: GetOpenAIModelsOptions,
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = opts.openAIApiKey ?? process.env.OPENAI_API_KEY;
  const openaiBaseURL = 'https://api.openai.com/v1';
  let baseURL = openaiBaseURL;
  let reverseProxyUrl = process.env.OPENAI_REVERSE_PROXY;

  if (opts.assistants && process.env.ASSISTANTS_BASE_URL) {
    reverseProxyUrl = process.env.ASSISTANTS_BASE_URL;
  } else if (opts.azure) {
    return models;
  }

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? openaiBaseURL;
  }

  const modelsCache = standardCache(CacheKeys.MODEL_QUERIES);

  const cachedModels = await modelsCache.get(baseURL);
  if (cachedModels) {
    return cachedModels as string[];
  }

  if (baseURL || opts.azure) {
    models = await fetchModels({
      apiKey: apiKey ?? '',
      baseURL,
      azure: opts.azure,
      user: opts.user,
      name: EModelEndpoint.openAI,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  if (baseURL === openaiBaseURL) {
    const regex = /(text-davinci-003|gpt-|o\d+)/;
    const excludeRegex = /audio|realtime/;
    models = models.filter((model) => regex.test(model) && !excludeRegex.test(model));
    const instructModels = models.filter((model) => model.includes('instruct'));
    const otherModels = models.filter((model) => !model.includes('instruct'));
    models = otherModels.concat(instructModels);
  }

  await modelsCache.set(baseURL, models);
  return models;
}

/**
 * Loads the default models for OpenAI or Azure.
 * @param opts - Options for getting models
 * @returns Promise resolving to array of model IDs
 */
export async function getOpenAIModels(opts: GetOpenAIModelsOptions = {}): Promise<string[]> {
  let models = defaultModels[EModelEndpoint.openAI];

  if (opts.assistants) {
    models = defaultModels[EModelEndpoint.assistants];
  } else if (opts.azure) {
    models = defaultModels[EModelEndpoint.azureAssistants];
  }

  let key: string;
  if (opts.assistants) {
    key = 'ASSISTANTS_MODELS';
  } else if (opts.azure) {
    key = 'AZURE_OPENAI_MODELS';
  } else {
    key = 'OPENAI_MODELS';
  }

  if (process.env[key]) {
    return splitAndTrim(process.env[key]);
  }

  // === VIVENTIUM START ===
  // Feature: First-run provider readiness must differ from provider configuration.
  // Purpose: `user_provided` enables the account UI but is never a credential for outbound egress.
  if (opts.userProvidedOpenAI || isUserProvided(process.env.OPENAI_API_KEY)) {
    return models;
  }
  // === VIVENTIUM END ===

  return await fetchOpenAIModels(opts, models);
}

/**
 * Fetches models from the Anthropic API.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchAnthropicModels(
  opts: { user?: string } = {},
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseURL = 'https://api.anthropic.com/v1';
  let baseURL = anthropicBaseURL;
  const reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? anthropicBaseURL;
  }

  if (!apiKey) {
    return models;
  }

  const modelsCache = standardCache(CacheKeys.MODEL_QUERIES);

  const cachedModels = await modelsCache.get(baseURL);
  if (cachedModels) {
    return cachedModels as string[];
  }

  if (baseURL) {
    models = await fetchModels({
      apiKey,
      baseURL,
      user: opts.user,
      name: EModelEndpoint.anthropic,
      tokenKey: EModelEndpoint.anthropic,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  await modelsCache.set(baseURL, models);
  return models;
}

/**
 * Gets Anthropic models from environment or API.
 * @param opts - Options for fetching models
 * @returns Promise resolving to array of model IDs
 */
export async function getAnthropicModels(
  opts: { user?: string; vertexModels?: string[] } = {},
): Promise<string[]> {
  const models = defaultModels[EModelEndpoint.anthropic];

  // Vertex AI models from YAML config take priority
  if (opts.vertexModels && opts.vertexModels.length > 0) {
    return opts.vertexModels;
  }

  if (process.env.ANTHROPIC_MODELS) {
    return splitAndTrim(process.env.ANTHROPIC_MODELS);
  }

  if (isUserProvided(process.env.ANTHROPIC_API_KEY)) {
    return models;
  }

  try {
    return await fetchAnthropicModels(opts, models);
  } catch (error) {
    logger.error('Error fetching Anthropic models:', error);
    return models;
  }
}

/**
 * Gets Google models from environment or defaults.
 * @returns Array of model IDs
 */
export function getGoogleModels(): string[] {
  let models = defaultModels[EModelEndpoint.google];
  if (process.env.GOOGLE_MODELS) {
    models = splitAndTrim(process.env.GOOGLE_MODELS);
  }
  return models;
}

/**
 * Gets Bedrock models from environment or defaults.
 * @returns Array of model IDs
 */
export function getBedrockModels(): string[] {
  let models = defaultModels[EModelEndpoint.bedrock];
  if (process.env.BEDROCK_AWS_MODELS) {
    models = splitAndTrim(process.env.BEDROCK_AWS_MODELS);
  }
  return models;
}
