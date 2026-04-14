import { ProxyAgent } from 'undici';
import { Providers } from '@librechat/agents';
import { KnownEndpoints, EModelEndpoint } from 'librechat-data-provider';
import type * as t from '~/types';
import { getLLMConfig as getAnthropicLLMConfig } from '~/endpoints/anthropic/llm';
import { getOpenAILLMConfig, extractDefaultParams } from './llm';
import { getGoogleConfig } from '~/endpoints/google/llm';
import { transformToOpenAIConfig } from './transform';
import { constructAzureURL } from '~/utils/azure';
import { createFetch } from '~/utils/generators';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/* === VIVENTIUM START ===
 * Feature: OpenAI Connected Accounts (Codex subscription bridge compatibility).
 * Purpose: Normalize LibreChat OpenAI Responses payloads to Codex backend expectations while
 * preserving streaming behavior and backwards compatibility for non-Codex routes.
 * === VIVENTIUM END === */
const CODEX_RESPONSES_HOST_FRAGMENT = 'chatgpt.com/backend-api/codex';
const CODEX_RESPONSES_PATH_REGEX = /\/responses(?:[/?#]|$)/i;
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';
const CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content';

function isCodexResponsesBaseURL(baseURL?: string | null): boolean {
  if (typeof baseURL !== 'string' || baseURL.trim().length === 0) {
    return false;
  }
  return baseURL.toLowerCase().includes(CODEX_RESPONSES_HOST_FRAGMENT);
}

function getRequestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

function extractInstructionText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const textParts: string[] = [];
  for (let j = 0; j < content.length; j++) {
    const part = content[j];
    if (!part || typeof part !== 'object') {
      continue;
    }
    const type = (part as Record<string, unknown>).type;
    const text = (part as Record<string, unknown>).text;
    if (
      (type === 'input_text' || type === 'text' || type === 'output_text') &&
      typeof text === 'string' &&
      text.trim().length > 0
    ) {
      textParts.push(text.trim());
    }
  }

  return textParts.length > 0 ? textParts.join('\n') : undefined;
}

function extractInstructionsFromResponseInput(input: unknown): string | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }

  const instructionParts: string[] = [];

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (
      !item ||
      typeof item !== 'object' ||
      (item as Record<string, unknown>).type !== 'message'
    ) {
      continue;
    }

    const role = (item as Record<string, unknown>).role;
    if (role !== 'system' && role !== 'developer') {
      continue;
    }

    const instructionText = extractInstructionText((item as Record<string, unknown>).content);
    if (instructionText) {
      instructionParts.push(instructionText);
    }
  }

  return instructionParts.length > 0 ? instructionParts.join('\n\n') : undefined;
}

function parseCodexResponseFromSSE(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }

  let latestResponse: Record<string, unknown> | undefined;
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line || !line.startsWith('data:')) {
      continue;
    }

    const jsonPayload = line.slice('data:'.length).trim();
    if (!jsonPayload || jsonPayload === '[DONE]') {
      continue;
    }

    let eventPayload: Record<string, unknown> | null = null;
    try {
      eventPayload = JSON.parse(jsonPayload) as Record<string, unknown>;
    } catch {
      eventPayload = null;
    }

    if (!eventPayload) {
      continue;
    }

    if (eventPayload.type === 'response.completed') {
      const completedResponse = eventPayload.response;
      if (completedResponse && typeof completedResponse === 'object') {
        return completedResponse as Record<string, unknown>;
      }
    }

    const maybeResponse = eventPayload.response;
    if (maybeResponse && typeof maybeResponse === 'object') {
      latestResponse = maybeResponse as Record<string, unknown>;
    }
  }

  return latestResponse;
}

function parseCodexResponseFromJson(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return undefined;
  }

  if (parsed.object === 'response') {
    return parsed;
  }

  if (parsed.type === 'response.completed') {
    const completedResponse = parsed.response;
    if (completedResponse && typeof completedResponse === 'object') {
      return completedResponse as Record<string, unknown>;
    }
  }

  return undefined;
}

/* === VIVENTIUM START ===
 * Feature: OpenAI Connected Accounts (Codex stateless continuation normalization).
 * Purpose: Codex subscription responses reject provider-side persistence and stored-item
 * references, so normalize follow-up payloads into a stateless shape that can continue tool
 * loops with inline items only.
 * === VIVENTIUM END === */
function normalizeCodexResponseInput(input: unknown): {
  normalizedInput: unknown;
  removedItemReferenceCount: number;
  removedReasoningReferenceCount: number;
  removedInstructionMessageCount: number;
  extractedInstructions?: string;
} {
  if (!Array.isArray(input)) {
    return {
      normalizedInput: input,
      removedItemReferenceCount: 0,
      removedReasoningReferenceCount: 0,
      removedInstructionMessageCount: 0,
    };
  }

  const normalizedInput: unknown[] = [];
  let removedItemReferenceCount = 0;
  let removedReasoningReferenceCount = 0;
  let removedInstructionMessageCount = 0;
  const extractedInstructions: string[] = [];

  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== 'object') {
      normalizedInput.push(item);
      continue;
    }

    const itemRecord = item as Record<string, unknown>;
    if (
      itemRecord.type === 'message' &&
      (itemRecord.role === 'system' || itemRecord.role === 'developer')
    ) {
      removedInstructionMessageCount++;
      const instructionText = extractInstructionText(itemRecord.content);
      if (instructionText) {
        extractedInstructions.push(instructionText);
      }
      continue;
    }

    if (itemRecord.type === 'item_reference') {
      removedItemReferenceCount++;
      continue;
    }

    if (
      itemRecord.type === 'reasoning' &&
      (typeof itemRecord.encrypted_content !== 'string' ||
        itemRecord.encrypted_content.trim().length === 0)
    ) {
      removedReasoningReferenceCount++;
      continue;
    }

    normalizedInput.push(item);
  }

  return {
    normalizedInput,
    removedItemReferenceCount,
    removedReasoningReferenceCount,
    removedInstructionMessageCount,
    ...(extractedInstructions.length > 0
      ? { extractedInstructions: extractedInstructions.join('\n\n') }
      : {}),
  };
}

function ensureCodexReasoningEncryptedContentInclude(payload: Record<string, unknown>): boolean {
  const include = payload.include;

  if (!Array.isArray(include)) {
    payload.include = [CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE];
    return true;
  }

  if (include.includes(CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE)) {
    return false;
  }

  payload.include = [...include, CODEX_REASONING_ENCRYPTED_CONTENT_INCLUDE];
  return true;
}

function createCodexResponsesFetch(baseFetch: Fetch): Fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = getRequestUrl(input);
    const method = init?.method?.toUpperCase() ?? 'GET';
    const isResponsesRequest = method === 'POST' && CODEX_RESPONSES_PATH_REGEX.test(requestUrl);

    let nextInit = init;
    let originalStore: unknown;
    let normalizedStore: unknown;
    let originalStream: unknown;
    let normalizedStream: unknown;
    let removedUserParam = false;
    let injectedInstructions = false;
    let removedPreviousResponseId = false;
    let injectedReasoningEncryptedContentInclude = false;
    let removedItemReferenceCount = 0;
    let removedReasoningReferenceCount = 0;
    let removedInstructionMessageCount = 0;

    if (isResponsesRequest && typeof init?.body === 'string' && init.body.trim().length > 0) {
      try {
        const payload = JSON.parse(init.body) as Record<string, unknown>;
        originalStore = payload.store;
        payload.store = false;

        originalStream = payload.stream;
        if (payload.stream !== true) {
          payload.stream = true;
        }

        if (Object.prototype.hasOwnProperty.call(payload, 'previous_response_id')) {
          removedPreviousResponseId = true;
          delete payload.previous_response_id;
        }

        const normalizedInput = normalizeCodexResponseInput(payload.input);
        payload.input = normalizedInput.normalizedInput;
        removedItemReferenceCount = normalizedInput.removedItemReferenceCount;
        removedReasoningReferenceCount = normalizedInput.removedReasoningReferenceCount;
        removedInstructionMessageCount = normalizedInput.removedInstructionMessageCount;

        if (Object.prototype.hasOwnProperty.call(payload, 'user')) {
          removedUserParam = true;
          delete payload.user;
        }

        const instructionsValue = payload.instructions;
        const hasInstructions =
          typeof instructionsValue === 'string' && instructionsValue.trim().length > 0;
        if (!hasInstructions) {
          injectedInstructions = true;
          payload.instructions =
            normalizedInput.extractedInstructions ??
            extractInstructionsFromResponseInput(payload.input) ??
            DEFAULT_CODEX_INSTRUCTIONS;
        }

        injectedReasoningEncryptedContentInclude =
          ensureCodexReasoningEncryptedContentInclude(payload);

        normalizedStore = payload.store;
        normalizedStream = payload.stream;
        nextInit = {
          ...init,
          body: JSON.stringify(payload),
        };
      } catch {
        // If payload parsing fails, preserve original request body.
      }
    }

    let response = await baseFetch(input, nextInit);

    if (isResponsesRequest && originalStream === false && response.ok) {
      const rawBody = await response.text();
      const parsedResponse = parseCodexResponseFromJson(rawBody) ?? parseCodexResponseFromSSE(rawBody);
      if (parsedResponse) {
        const normalizedHeaders = new Headers(response.headers);
        normalizedHeaders.set('content-type', 'application/json');
        response = new Response(JSON.stringify(parsedResponse), {
          status: response.status,
          statusText: response.statusText,
          headers: normalizedHeaders,
        });
      } else {
        const normalizedHeaders = new Headers(response.headers);
        normalizedHeaders.set('content-type', 'text/plain; charset=utf-8');
        response = new Response(rawBody, {
          status: response.status,
          statusText: response.statusText,
          headers: normalizedHeaders,
        });
      }
    }

    if (
      process.env.VIVENTIUM_OPENAI_CODEX_DEBUG === 'true' &&
      isResponsesRequest &&
      (!response.ok ||
        originalStore !== normalizedStore ||
        originalStream !== normalizedStream ||
        removedUserParam ||
        injectedInstructions ||
        removedPreviousResponseId ||
        injectedReasoningEncryptedContentInclude ||
        removedInstructionMessageCount > 0 ||
        removedItemReferenceCount > 0 ||
        removedReasoningReferenceCount > 0)
    ) {
      const shouldSkipPreviewForSuccessfulStreamingResponse =
        response.ok && normalizedStream === true;
      let responsePreview = '[skipped for streaming response]';
      if (!shouldSkipPreviewForSuccessfulStreamingResponse) {
        try {
          responsePreview = (await response.clone().text()).slice(0, 1000);
        } catch {
          responsePreview = '[unavailable]';
        }
      }

      console.info(
        '[OpenAI Codex] responses request debug',
        JSON.stringify({
          requestUrl,
          status: response.status,
          originalStore,
          normalizedStore,
          originalStream,
          normalizedStream,
          removedUserParam,
          injectedInstructions,
          removedPreviousResponseId,
          injectedReasoningEncryptedContentInclude,
          removedInstructionMessageCount,
          removedItemReferenceCount,
          removedReasoningReferenceCount,
          responsePreview,
        }),
      );
    }

    return response;
  };
}

/**
 * Generates configuration options for creating a language model (LLM) instance.
 * @param apiKey - The API key for authentication.
 * @param options - Additional options for configuring the LLM.
 * @param endpoint - The endpoint name
 * @returns Configuration options for creating an LLM instance.
 */
export function getOpenAIConfig(
  apiKey: string,
  options: t.OpenAIConfigOptions = {},
  endpoint?: string | null,
): t.OpenAIConfigResult {
  const {
    proxy,
    addParams,
    dropParams,
    defaultQuery,
    directEndpoint,
    streaming = true,
    modelOptions = {},
    reverseProxyUrl: baseURL,
  } = options;

  /** Extract default params from customParams.paramDefinitions */
  const defaultParams = extractDefaultParams(options.customParams?.paramDefinitions);

  let llmConfig: t.OAIClientOptions;
  let tools: t.LLMConfigResult['tools'];
  const isAnthropic = options.customParams?.defaultParamsEndpoint === EModelEndpoint.anthropic;
  const isGoogle = options.customParams?.defaultParamsEndpoint === EModelEndpoint.google;

  const useOpenRouter =
    !isAnthropic &&
    !isGoogle &&
    ((baseURL && baseURL.includes(KnownEndpoints.openrouter)) ||
      (endpoint != null && endpoint.toLowerCase().includes(KnownEndpoints.openrouter)));
  const isVercel =
    !isAnthropic &&
    !isGoogle &&
    ((baseURL && baseURL.includes('ai-gateway.vercel.sh')) ||
      (endpoint != null && endpoint.toLowerCase().includes(KnownEndpoints.vercel)));

  let azure = options.azure;
  let headers = options.headers;
  if (isAnthropic) {
    const anthropicResult = getAnthropicLLMConfig(apiKey, {
      modelOptions,
      proxy: options.proxy,
      reverseProxyUrl: baseURL,
      addParams,
      dropParams,
      defaultParams,
    });
    /** Transform handles addParams/dropParams - it knows about OpenAI params */
    const transformed = transformToOpenAIConfig({
      addParams,
      dropParams,
      llmConfig: anthropicResult.llmConfig,
      fromEndpoint: EModelEndpoint.anthropic,
    });
    llmConfig = transformed.llmConfig;
    tools = anthropicResult.tools;
    if (transformed.configOptions?.defaultHeaders) {
      headers = Object.assign(headers ?? {}, transformed.configOptions?.defaultHeaders);
    }
  } else if (isGoogle) {
    const googleResult = getGoogleConfig(
      apiKey,
      {
        modelOptions,
        reverseProxyUrl: baseURL ?? undefined,
        authHeader: true,
        addParams,
        dropParams,
        defaultParams,
      },
      true,
    );
    /** Transform handles addParams/dropParams - it knows about OpenAI params */
    const transformed = transformToOpenAIConfig({
      addParams,
      dropParams,
      defaultParams,
      tools: googleResult.tools,
      llmConfig: googleResult.llmConfig,
      fromEndpoint: EModelEndpoint.google,
    });
    llmConfig = transformed.llmConfig;
    tools = transformed.tools;
  } else {
    const openaiResult = getOpenAILLMConfig({
      azure,
      apiKey,
      baseURL,
      endpoint,
      streaming,
      addParams,
      dropParams,
      defaultParams,
      modelOptions,
      useOpenRouter,
    });
    llmConfig = openaiResult.llmConfig;
    azure = openaiResult.azure;
    tools = openaiResult.tools;
  }

  const configOptions: t.OpenAIConfiguration = {};
  if (baseURL) {
    configOptions.baseURL = baseURL;
  }
  if (useOpenRouter || isVercel) {
    configOptions.defaultHeaders = Object.assign(
      {
        'HTTP-Referer': 'https://librechat.ai',
        'X-Title': 'LibreChat',
        'X-OpenRouter-Title': 'LibreChat',
        'X-OpenRouter-Categories': 'general-chat,personal-agent',
      },
      headers,
    );
  } else if (headers) {
    configOptions.defaultHeaders = headers;
  }

  if (defaultQuery) {
    configOptions.defaultQuery = defaultQuery;
  }

  if (proxy) {
    const proxyAgent = new ProxyAgent(proxy);
    configOptions.fetchOptions = {
      dispatcher: proxyAgent,
    };
  }

  if (azure && !isAnthropic) {
    const constructAzureResponsesApi = () => {
      if (!llmConfig.useResponsesApi || !azure) {
        return;
      }

      const updatedUrl = configOptions.baseURL?.replace(/\/deployments(?:\/.*)?$/, '/v1');

      configOptions.baseURL = constructAzureURL({
        baseURL: updatedUrl || 'https://${INSTANCE_NAME}.openai.azure.com/openai/v1',
        azureOptions: azure,
      });

      configOptions.defaultHeaders = {
        ...configOptions.defaultHeaders,
        'api-key': apiKey,
      };
      configOptions.defaultQuery = {
        ...configOptions.defaultQuery,
        'api-version': configOptions.defaultQuery?.['api-version'] ?? 'preview',
      };
    };

    constructAzureResponsesApi();
  }

  if (process.env.OPENAI_ORGANIZATION && !isAnthropic) {
    configOptions.organization = process.env.OPENAI_ORGANIZATION;
  }

  if (directEndpoint === true && configOptions?.baseURL != null) {
    configOptions.fetch = createFetch({
      directEndpoint: directEndpoint,
      reverseProxyUrl: configOptions?.baseURL,
    }) as unknown as Fetch;
  }

  /* === VIVENTIUM START ===
   * Feature: OpenAI Connected Accounts (Codex route adapter activation).
   * Purpose: Apply Codex-compatible request/response normalization only for Codex base URLs
   * so other OpenAI-compatible providers remain unaffected.
   * === VIVENTIUM END === */
  if (isCodexResponsesBaseURL(configOptions.baseURL)) {
    const baseFetch = (configOptions.fetch as Fetch | undefined) ?? (fetch as Fetch);
    configOptions.fetch = createCodexResponsesFetch(baseFetch);
  }

  const result: t.OpenAIConfigResult = {
    llmConfig,
    configOptions,
    tools,
  };
  if (useOpenRouter) {
    result.provider = Providers.OPENROUTER;
  }
  return result;
}
