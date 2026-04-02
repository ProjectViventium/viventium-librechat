import { Dispatcher, ProxyAgent } from 'undici';
import { logger } from '@librechat/data-schemas';
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicClientOptions } from '@librechat/agents';
import { anthropicSettings, removeNullishValues, AuthKeys } from 'librechat-data-provider';
import type {
  AnthropicLLMConfigResult,
  AnthropicConfigOptions,
  AnthropicCredentials,
} from '~/types/anthropic';
import {
  supportsAdaptiveThinking,
  checkPromptCacheSupport,
  configureReasoning,
  getClaudeHeaders,
} from './helpers';
import {
  createAnthropicVertexClient,
  isAnthropicVertexCredentials,
  getVertexDeploymentName,
} from './vertex';

/**
 * Parses credentials from string or object format
 * - If a valid JSON string is passed, it parses and returns the object
 * - If a plain API key string is passed, it wraps it in an AnthropicCredentials object
 * - If an object is passed, it returns it directly
 * - If undefined, returns an empty object
 */
function parseCredentials(
  credentials: string | AnthropicCredentials | undefined,
): AnthropicCredentials {
  if (typeof credentials === 'string') {
    try {
      return JSON.parse(credentials);
    } catch {
      // If not valid JSON, treat as a plain API key
      logger.debug('[Anthropic] Credentials not JSON, treating as API key');
      return { [AuthKeys.ANTHROPIC_API_KEY]: credentials };
    }
  }
  return credentials && typeof credentials === 'object' ? credentials : {};
}

/** Known Anthropic parameters that map directly to the client config */
export const knownAnthropicParams = new Set([
  'model',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'maxOutputTokens',
  'stopSequences',
  'stop',
  'stream',
  'apiKey',
  'maxRetries',
  'timeout',
  'anthropicVersion',
  'anthropicApiUrl',
  'defaultHeaders',
]);

/**
 * Applies default parameters to the target object only if the field is undefined
 * @param target - The target object to apply defaults to
 * @param defaults - Record of default parameter values
 */
function applyDefaultParams(target: Record<string, unknown>, defaults: Record<string, unknown>) {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

const OAUTH_REQUIRED_ANTHROPIC_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
].join(',');

const ANTHROPIC_OAUTH_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";

function isAnthropicOAuthToken(apiKey: string | null): boolean {
  return typeof apiKey === 'string' && apiKey.includes('sk-ant-oat');
}

/* === VIVENTIUM START ===
 * Feature: Connected Accounts Anthropic OAuth auth-mode selection.
 * Purpose: Use OAuth bearer auth when credentials originate from connected-account
 * subscription flows, even if token format does not match `sk-ant-oat*`.
 * === VIVENTIUM END === */
function normalizeLowerString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function shouldUseAnthropicOAuthAuth(
  apiKey: string | null,
  options: AnthropicConfigOptions,
): boolean {
  if (isAnthropicOAuthToken(apiKey)) {
    return true;
  }

  const oauthType = normalizeLowerString(options.oauthType);
  if (oauthType === 'subscription') {
    return true;
  }

  return false;
}

function mergeDefaultHeaders(
  existing?: Record<string, string>,
  incoming?: Record<string, string>,
): Record<string, string> | undefined {
  if (!existing && !incoming) {
    return undefined;
  }

  const mergedHeaders: Record<string, string> = {
    ...(existing ?? {}),
    ...(incoming ?? {}),
  };

  const existingBetas = existing?.['anthropic-beta'] ?? '';
  const incomingBetas = incoming?.['anthropic-beta'] ?? '';
  if (existingBetas || incomingBetas) {
    const combinedBetas = [...existingBetas.split(','), ...incomingBetas.split(',')]
      .map((value) => value.trim())
      .filter(Boolean);

    mergedHeaders['anthropic-beta'] = [...new Set(combinedBetas)].join(',');
  }

  return mergedHeaders;
}

function isAnthropicTextBlock(
  value: unknown,
): value is Record<string, unknown> & { type: 'text'; text: string } {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as { type?: unknown }).type === 'text' &&
    typeof (value as { text?: unknown }).text === 'string'
  );
}

function prependAnthropicOAuthSystemBlock(
  blocks: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (blocks.length > 0 && isAnthropicTextBlock(blocks[0])) {
    if (blocks[0].text === ANTHROPIC_OAUTH_SYSTEM_TEXT) {
      return blocks;
    }
  }

  return [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }, ...blocks];
}

function ensureAnthropicOAuthSystemPrompt(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const { system } = request;

  if (Array.isArray(system)) {
    return {
      ...request,
      system: prependAnthropicOAuthSystemBlock(
        system.filter((block): block is Record<string, unknown> => block != null && typeof block === 'object'),
      ),
    };
  }

  if (typeof system === 'string') {
    return {
      ...request,
      system:
        system.trim().length > 0
          ? prependAnthropicOAuthSystemBlock([{ type: 'text', text: system }])
          : [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }],
    };
  }

  if (system != null && typeof system === 'object') {
    const content = (system as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return {
        ...request,
        system: prependAnthropicOAuthSystemBlock(
          content.filter((block): block is Record<string, unknown> => block != null && typeof block === 'object'),
        ),
      };
    }
    if (typeof content === 'string' && content.trim().length > 0) {
      return {
        ...request,
        system: prependAnthropicOAuthSystemBlock([{ type: 'text', text: content }]),
      };
    }
  }

  return {
    ...request,
    system: [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }],
  };
}

function summarizeAnthropicContentBlocks(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, 5).map((block) => {
    if (block == null || typeof block !== 'object') {
      return { type: typeof block };
    }

    const typedBlock = block as Record<string, unknown>;
    const text =
      typeof typedBlock.text === 'string' ? typedBlock.text.slice(0, 120) : undefined;
    const name = typeof typedBlock.name === 'string' ? typedBlock.name : undefined;

    return {
      type: typedBlock.type,
      name,
      text,
      hasInput: typedBlock.input != null,
      hasContent: Array.isArray(typedBlock.content),
    };
  });
}

function summarizeAnthropicMessage(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const message = value as Record<string, unknown>;
  return {
    role: message.role,
    content: summarizeAnthropicContentBlocks(message.content),
  };
}

function summarizeAnthropicOAuthRequest(request: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const system =
    Array.isArray(request.system) || typeof request.system === 'string'
      ? request.system
      : (request.system as { content?: unknown } | undefined)?.content;

  return {
    keys: Object.keys(request).sort(),
    model: request.model,
    max_tokens: request.max_tokens ?? request.maxTokens,
    temperature: request.temperature,
    stream: request.stream,
    thinking: request.thinking,
    tool_choice: request.tool_choice ?? request.toolChoice,
    tool_count: tools.length,
    tool_names: tools
      .slice(0, 10)
      .map((tool) =>
        tool != null && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined,
      )
      .filter((name): name is string => typeof name === 'string'),
    system: typeof system === 'string' ? system.slice(0, 200) : summarizeAnthropicContentBlocks(system),
    message_count: messages.length,
    first_message: summarizeAnthropicMessage(messages[0]),
    last_message: summarizeAnthropicMessage(messages[messages.length - 1]),
  };
}

type AnthropicMessagesCreate = Anthropic['messages']['create'];

function wrapAnthropicOAuthClient(client: Anthropic): Anthropic {
  const originalCreate: AnthropicMessagesCreate = client.messages.create.bind(client.messages);
  const wrappedCreate: AnthropicMessagesCreate = ((request, requestOptions) => {
    const normalizedRequest = ensureAnthropicOAuthSystemPrompt(
      request as unknown as Record<string, unknown>,
    ) as unknown as Parameters<AnthropicMessagesCreate>[0];

    if (process.env.VIVENTIUM_ANTHROPIC_DEBUG === 'true') {
      logger.info(
        `[Anthropic OAuth Request Debug] ${JSON.stringify(
          summarizeAnthropicOAuthRequest(normalizedRequest as unknown as Record<string, unknown>),
        )}`,
      );
    }

    return originalCreate(normalizedRequest, requestOptions);
  }) as AnthropicMessagesCreate;

  Object.defineProperty(client.messages, 'create', {
    configurable: true,
    writable: true,
    value: wrappedCreate,
  });

  return client;
}

/**
 * Generates configuration options for creating an Anthropic language model (LLM) instance.
 * @param credentials - The API key for authentication with Anthropic, or credentials object for Vertex AI.
 * @param options={} - Additional options for configuring the LLM.
 * @returns Configuration options for creating an Anthropic LLM instance, with null and undefined values removed.
 */
function getLLMConfig(
  credentials: string | AnthropicCredentials | undefined,
  options: AnthropicConfigOptions = {},
): AnthropicLLMConfigResult {
  const systemOptions = {
    thinking: options.modelOptions?.thinking ?? anthropicSettings.thinking.default,
    promptCache: options.modelOptions?.promptCache ?? anthropicSettings.promptCache.default,
    thinkingBudget:
      options.modelOptions?.thinkingBudget ?? anthropicSettings.thinkingBudget.default,
    effort: options.modelOptions?.effort ?? anthropicSettings.effort.default,
  };

  if (options.modelOptions) {
    delete options.modelOptions.thinking;
    delete options.modelOptions.promptCache;
    delete options.modelOptions.thinkingBudget;
    delete options.modelOptions.effort;
  } else {
    throw new Error('No modelOptions provided');
  }

  const defaultOptions = {
    model: anthropicSettings.model.default,
    stream: true,
  };

  const mergedOptions = Object.assign(defaultOptions, options.modelOptions);

  let enableWebSearch = mergedOptions.web_search;

  let requestOptions: AnthropicClientOptions & { stream?: boolean } = {
    model: mergedOptions.model,
    stream: mergedOptions.stream,
    temperature: mergedOptions.temperature,
    stopSequences: mergedOptions.stop,
    maxTokens:
      mergedOptions.maxOutputTokens || anthropicSettings.maxOutputTokens.reset(mergedOptions.model),
    clientOptions: {},
    invocationKwargs: {
      metadata: {
        user_id: mergedOptions.user,
      },
    },
  };

  const creds = parseCredentials(credentials);
  const apiKey = creds[AuthKeys.ANTHROPIC_API_KEY] ?? null;
  const oauthToken = shouldUseAnthropicOAuthAuth(apiKey, options);

  if (process.env.VIVENTIUM_ANTHROPIC_DEBUG === 'true') {
    logger.info(
      `[Anthropic Auth Debug] ${JSON.stringify({
        oauthType: normalizeLowerString(options.oauthType),
        oauthProvider: normalizeLowerString(options.oauthProvider),
        oauthToken,
        apiKeyPrefix: typeof apiKey === 'string' ? apiKey.slice(0, 12) : null,
        requestApiKeySet: (requestOptions as Record<string, unknown>).apiKey != null,
        clientAuthTokenSet:
          (requestOptions.clientOptions as Record<string, unknown> | undefined)?.authToken != null,
      })}`,
    );
  }

  if (isAnthropicVertexCredentials(creds)) {
    // Vertex AI configuration - use custom client with optional YAML config
    // Map the visible model name to the actual deployment name for Vertex AI
    const deploymentName = getVertexDeploymentName(
      requestOptions.model ?? '',
      options.vertexConfig,
    );
    requestOptions.model = deploymentName;

    requestOptions.createClient = () =>
      createAnthropicVertexClient(creds, requestOptions.clientOptions, options.vertexOptions);
  } else if (apiKey) {
    // Direct API configuration
    if (oauthToken) {
      requestOptions.clientOptions = {
        ...(requestOptions.clientOptions ?? {}),
        authToken: apiKey,
      };
      requestOptions.createClient = (options) => {
        if (process.env.VIVENTIUM_ANTHROPIC_DEBUG === 'true') {
          logger.info('[Anthropic OAuth Request Debug] createClient invoked');
        }

        const incomingDefaultHeaders =
          options != null && typeof options === 'object'
            ? (options as { defaultHeaders?: Record<string, string> }).defaultHeaders
            : undefined;

        return wrapAnthropicOAuthClient(
          new Anthropic({
            ...(options ?? {}),
            defaultHeaders: mergeDefaultHeaders(incomingDefaultHeaders, {
              'anthropic-beta': OAUTH_REQUIRED_ANTHROPIC_BETAS,
            }),
            apiKey: null,
            authToken: apiKey,
          }),
        );
      };
      requestOptions.clientOptions.defaultHeaders = mergeDefaultHeaders(
        requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined,
        {
          'anthropic-beta': OAUTH_REQUIRED_ANTHROPIC_BETAS,
        },
      );
    } else {
      requestOptions.apiKey = apiKey;
    }
  } else {
    throw new Error(
      'Invalid credentials provided. Please provide either a valid Anthropic API key or service account credentials for Vertex AI.',
    );
  }

  requestOptions = configureReasoning(requestOptions, systemOptions);

  if (supportsAdaptiveThinking(mergedOptions.model)) {
    if (
      systemOptions.effort &&
      (systemOptions.effort as string) !== '' &&
      !requestOptions.invocationKwargs?.output_config
    ) {
      requestOptions.invocationKwargs = {
        ...requestOptions.invocationKwargs,
        output_config: { effort: systemOptions.effort },
      };
    }
  } else {
    if (
      requestOptions.thinking != null &&
      (requestOptions.thinking as unknown as { type: string }).type === 'adaptive'
    ) {
      delete requestOptions.thinking;
    }
    if (requestOptions.invocationKwargs?.output_config) {
      delete requestOptions.invocationKwargs.output_config;
    }
  }

  const hasActiveThinking = requestOptions.thinking != null;
  const isThinkingModel =
    /claude-3[-.]7/.test(mergedOptions.model) || supportsAdaptiveThinking(mergedOptions.model);
  if (!isThinkingModel || !hasActiveThinking) {
    requestOptions.topP = mergedOptions.topP;
    requestOptions.topK = mergedOptions.topK;
  }

  const supportsCacheControl =
    systemOptions.promptCache === true && checkPromptCacheSupport(requestOptions.model ?? '');

  /** Pass promptCache boolean for downstream cache_control application */
  if (supportsCacheControl) {
    (requestOptions as Record<string, unknown>).promptCache = true;
  }

  const headers = getClaudeHeaders(requestOptions.model ?? '', supportsCacheControl, oauthToken);
  if (headers && requestOptions.clientOptions) {
    requestOptions.clientOptions.defaultHeaders = mergeDefaultHeaders(
      requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined,
      headers,
    );
  }

  if (options.proxy && requestOptions.clientOptions) {
    const proxyAgent = new ProxyAgent(options.proxy);
    requestOptions.clientOptions.fetchOptions = {
      dispatcher: proxyAgent,
    };
  }

  if (options.reverseProxyUrl && requestOptions.clientOptions) {
    requestOptions.clientOptions.baseURL = options.reverseProxyUrl;
    requestOptions.anthropicApiUrl = options.reverseProxyUrl;
  }

  /** Handle defaultParams first - only process Anthropic-native params if undefined */
  if (options.defaultParams && typeof options.defaultParams === 'object') {
    for (const [key, value] of Object.entries(options.defaultParams)) {
      /** Handle web_search separately - don't add to config */
      if (key === 'web_search') {
        if (enableWebSearch === undefined && typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }

      if (knownAnthropicParams.has(key)) {
        /** Route known Anthropic params to requestOptions only if undefined */
        applyDefaultParams(requestOptions as Record<string, unknown>, { [key]: value });
      }
      /** Leave other params for transform to handle - they might be OpenAI params */
    }
  }

  /** Handle addParams - can override defaultParams */
  if (options.addParams && typeof options.addParams === 'object') {
    for (const [key, value] of Object.entries(options.addParams)) {
      /** Handle web_search separately - don't add to config */
      if (key === 'web_search') {
        if (typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }

      if (knownAnthropicParams.has(key)) {
        /** Route known Anthropic params to requestOptions */
        (requestOptions as Record<string, unknown>)[key] = value;
      }
      /** Leave other params for transform to handle - they might be OpenAI params */
    }
  }

  /** Handle dropParams - only drop from Anthropic config */
  if (options.dropParams && Array.isArray(options.dropParams)) {
    options.dropParams.forEach((param) => {
      if (param === 'web_search') {
        enableWebSearch = false;
        return;
      }

      if (param in requestOptions) {
        delete requestOptions[param as keyof AnthropicClientOptions];
      }
      if (requestOptions.invocationKwargs && param in requestOptions.invocationKwargs) {
        delete (requestOptions.invocationKwargs as Record<string, unknown>)[param];
      }
    });
  }

  const tools = [];

  if (enableWebSearch) {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
    });

    if (isAnthropicVertexCredentials(creds)) {
      if (!requestOptions.clientOptions) {
        requestOptions.clientOptions = {};
      }

      requestOptions.clientOptions.defaultHeaders = {
        ...(requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined),
        'anthropic-beta': 'web-search-2025-03-05',
      };
    }
  }

  if (process.env.VIVENTIUM_ANTHROPIC_DEBUG === 'true') {
    logger.info(
      `[Anthropic Auth Final] ${JSON.stringify({
        finalApiKeySet: (requestOptions as Record<string, unknown>).apiKey != null,
        hasCreateClient: typeof (requestOptions as Record<string, unknown>).createClient === 'function',
        finalClientAuthTokenSet:
          (requestOptions.clientOptions as Record<string, unknown> | undefined)?.authToken != null,
        finalDefaultHeaders:
          (requestOptions.clientOptions as Record<string, unknown> | undefined)?.defaultHeaders ??
          null,
      })}`,
    );
  }

  return {
    tools,
    llmConfig: removeNullishValues(
      requestOptions as Record<string, unknown>,
    ) as AnthropicClientOptions & { clientOptions?: { fetchOptions?: { dispatcher: Dispatcher } } },
  };
}

export { getLLMConfig, ensureAnthropicOAuthSystemPrompt, ANTHROPIC_OAUTH_SYSTEM_TEXT };
