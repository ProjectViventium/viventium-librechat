import { ProxyAgent } from 'undici';
import { createHash } from 'node:crypto';
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

function headersForRequest(input: string | URL | Request, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  return headers;
}

function glassHiveDeveloperAuthority(
  payload: Record<string, unknown>,
  headers: Headers,
): string {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const instructionParts: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const record = message as Record<string, unknown>;
    const role = String(record.role || '').trim().toLowerCase();
    if (role !== 'system' && role !== 'developer') continue;
    const text = extractInstructionText(record.content)?.trim() ?? '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    instructionParts.push(text);
  }
  const snapshot = instructionParts.join('\n\n');
  let tail = '';
  const encodedTail = String(headers.get('x-glasshive-developer-instruction-tail-b64') || '').trim();
  if (encodedTail) {
    try {
      tail = Buffer.from(encodedTail, 'base64').toString('utf8').trim();
    } catch {
      tail = '';
    }
  }
  if (!tail) {
    const metadata = payload.metadata;
    if (metadata && typeof metadata === 'object') {
      tail = String(
        (metadata as Record<string, unknown>).developer_instruction_tail || '',
      ).trim();
    }
  }
  if (!tail || !snapshot.includes(tail)) return snapshot;
  const withoutTail = snapshot
    .split(tail)
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n');
  return [withoutTail, tail].filter(Boolean).join('\n\n');
}

function createGlassHiveNativeReceiptFetch(
  baseFetch: Fetch,
  nativeProviderRequestAccepted: NonNullable<
    t.OpenAIConfigOptions['nativeProviderRequestAccepted']
  >,
): Fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const requestUrl = getRequestUrl(input);
    const method = init?.method?.toUpperCase() ?? (input instanceof Request ? input.method : 'GET');
    const headers = headersForRequest(input, init);
    const isGlassHiveRequest =
      method === 'POST' && /\/chat\/completions(?:[/?#]|$)/i.test(requestUrl);
    if (!isGlassHiveRequest) return baseFetch(input, init);

    let requestBody = '';
    if (typeof init?.body === 'string') {
      requestBody = init.body;
    } else if (input instanceof Request) {
      try {
        requestBody = await input.clone().text();
      } catch {
        requestBody = '';
      }
    }
    let requestPayload: Record<string, unknown> = {};
    try {
      requestPayload = JSON.parse(requestBody) as Record<string, unknown>;
    } catch {
      requestPayload = {};
    }
    const instructionAuthority = glassHiveDeveloperAuthority(requestPayload, headers);
    const nativeRequestSha256 = createHash('sha256').update(requestBody, 'utf8').digest('hex');
    const response = await baseFetch(input, init);
    if (!response.ok) return response;

    let emitted = false;
    const inspectPayload = (value: unknown) => {
      if (emitted || !value || typeof value !== 'object') return;
      const glasshive = (value as Record<string, unknown>).glasshive;
      if (!glasshive || typeof glasshive !== 'object') return;
      const authorityReceipt = (glasshive as Record<string, unknown>)
        .native_provider_authority_receipt;
      if (!authorityReceipt || typeof authorityReceipt !== 'object') return;
      emitted = true;
      const receipt = authorityReceipt as NonNullable<
        Parameters<typeof nativeProviderRequestAccepted>[0]['authorityReceipt']
      >;
      try {
        nativeProviderRequestAccepted({
          provider: 'glasshive',
          model: String(receipt.model || requestPayload.model || ''),
          status: response.status,
          instructionAuthority,
          nativeRequestSha256,
          authorityReceipt: receipt,
        });
      } catch {
        // Telemetry must never alter provider output or fallback behavior.
      }
    };

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream') || !response.body) {
      try {
        inspectPayload(await response.clone().json());
      } catch {
        // A successful non-JSON response has no structured GlassHive receipt.
      }
      return response;
    }

    const decoder = new TextDecoder();
    let pending = '';
    const inspectLines = (flush = false) => {
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = pending.slice(0, newlineIndex).trim();
        pending = pending.slice(newlineIndex + 1);
        if (line.startsWith('data:')) {
          const data = line.slice('data:'.length).trim();
          if (data && data !== '[DONE]') {
            try {
              inspectPayload(JSON.parse(data));
            } catch {
              // Preserve malformed provider data for the owning OpenAI parser.
            }
          }
        }
        newlineIndex = pending.indexOf('\n');
      }
      if (flush && pending.trim().startsWith('data:')) {
        const data = pending.trim().slice('data:'.length).trim();
        if (data && data !== '[DONE]') {
          try {
            inspectPayload(JSON.parse(data));
          } catch {
            // Preserve malformed provider data for the owning OpenAI parser.
          }
        }
      }
    };
    const monitoredBody = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          pending += decoder.decode(chunk, { stream: true });
          inspectLines();
        },
        flush() {
          pending += decoder.decode();
          inspectLines(true);
        },
      }),
    );
    return new Response(monitoredBody, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function cloneCodexEventItem(item: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>;
}

function mergeCodexOutputItem(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  if (existing == null) {
    return cloneCodexEventItem(incoming);
  }

  const merged = {
    ...existing,
    ...cloneCodexEventItem(incoming),
  };

  if (Array.isArray(existing.content)) {
    const incomingContent = Array.isArray(incoming.content) ? incoming.content : undefined;
    if (incomingContent == null || incomingContent.length === 0) {
      merged.content = existing.content;
    }
  }

  if (typeof existing.arguments === 'string') {
    const incomingArguments = incoming.arguments;
    if (typeof incomingArguments !== 'string' || incomingArguments.length === 0) {
      merged.arguments = existing.arguments;
    }
  }

  if (typeof existing.output === 'string') {
    const incomingOutput = incoming.output;
    if (typeof incomingOutput !== 'string' || incomingOutput.length === 0) {
      merged.output = existing.output;
    }
  }

  return merged;
}

function getCodexOutputIndexForEvent(
  eventPayload: Record<string, unknown>,
  itemIndexById: Map<string, number>,
): number | undefined {
  const directOutputIndex = eventPayload.output_index;
  if (typeof directOutputIndex === 'number' && Number.isFinite(directOutputIndex)) {
    return directOutputIndex;
  }

  const itemId = eventPayload.item_id;
  if (typeof itemId === 'string') {
    return itemIndexById.get(itemId);
  }

  return undefined;
}

function ensureCodexOutputTextPart(item: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(item.content) ? [...item.content] : [];
  item.content = content;

  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (
      part &&
      typeof part === 'object' &&
      (((part as Record<string, unknown>).type === 'output_text') ||
        (part as Record<string, unknown>).type === 'text')
    ) {
      return part as Record<string, unknown>;
    }
  }

  const nextPart: Record<string, unknown> = {
    type: 'output_text',
    text: '',
  };
  content.push(nextPart);
  return nextPart;
}

function parseCodexResponseFromSSE(raw: string): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return undefined;
  }

  let latestResponse: Record<string, unknown> | undefined;
  const outputItems = new Map<number, Record<string, unknown>>();
  const itemIndexById = new Map<string, number>();
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
        latestResponse = completedResponse as Record<string, unknown>;
      }
    } else if (
      eventPayload.type === 'response.output_item.added' ||
      eventPayload.type === 'response.output_item.done'
    ) {
      const outputIndex = getCodexOutputIndexForEvent(eventPayload, itemIndexById);
      const item = eventPayload.item;
      if (
        typeof outputIndex === 'number' &&
        item &&
        typeof item === 'object' &&
        Number.isFinite(outputIndex)
      ) {
        const merged = mergeCodexOutputItem(
          outputItems.get(outputIndex),
          item as Record<string, unknown>,
        );
        outputItems.set(outputIndex, merged);
        if (typeof merged.id === 'string') {
          itemIndexById.set(merged.id, outputIndex);
        }
      }
    } else if (
      eventPayload.type === 'response.function_call_arguments.delta' ||
      eventPayload.type === 'response.function_call_arguments.done'
    ) {
      const outputIndex = getCodexOutputIndexForEvent(eventPayload, itemIndexById);
      if (typeof outputIndex === 'number' && Number.isFinite(outputIndex)) {
        const item = outputItems.get(outputIndex);
        if (item) {
          if (eventPayload.type === 'response.function_call_arguments.delta') {
            const delta = typeof eventPayload.delta === 'string' ? eventPayload.delta : '';
            item.arguments = `${typeof item.arguments === 'string' ? item.arguments : ''}${delta}`;
          } else if (typeof eventPayload.arguments === 'string') {
            item.arguments = eventPayload.arguments;
          }
        }
      }
    } else if (
      eventPayload.type === 'response.output_text.delta' ||
      eventPayload.type === 'response.output_text.done'
    ) {
      const outputIndex = getCodexOutputIndexForEvent(eventPayload, itemIndexById);
      if (typeof outputIndex === 'number' && Number.isFinite(outputIndex)) {
        const item = outputItems.get(outputIndex);
        if (item) {
          const textPart = ensureCodexOutputTextPart(item);
          if (eventPayload.type === 'response.output_text.delta') {
            const delta = typeof eventPayload.delta === 'string' ? eventPayload.delta : '';
            textPart.text = `${typeof textPart.text === 'string' ? textPart.text : ''}${delta}`;
          } else if (typeof eventPayload.text === 'string') {
            textPart.text = eventPayload.text;
          }
        }
      }
    }

    const maybeResponse = eventPayload.response;
    if (maybeResponse && typeof maybeResponse === 'object') {
      latestResponse = maybeResponse as Record<string, unknown>;
    }
  }

  if (latestResponse && outputItems.size > 0) {
    const output = [...outputItems.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item);
    if (!Array.isArray(latestResponse.output) || latestResponse.output.length === 0) {
      latestResponse.output = output;
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

function createCodexResponsesFetch(
  baseFetch: Fetch,
  connectedAccountAuthRefresh?: t.OpenAIConfigOptions['connectedAccountAuthRefresh'],
  nativeProviderRequestAccepted?: t.OpenAIConfigOptions['nativeProviderRequestAccepted'],
): Fetch {
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
    let normalizedRequestPayload: Record<string, unknown> | null = null;

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
        normalizedRequestPayload = payload;
      } catch {
        // If payload parsing fails, preserve original request body.
      }
    }

    /* === VIVENTIUM START ===
     * Feature: Connected-account early-401 recovery
     * Purpose: A provider can invalidate an otherwise unexpired access token. Refresh and replay
     * once, then preserve the existing fallback/error path if recovery cannot complete.
     */
    const retryInput = input instanceof Request ? input.clone() : input;
    let response = await baseFetch(input, nextInit);

    if (isResponsesRequest && response.status === 401 && connectedAccountAuthRefresh) {
      try {
        const refreshedAuth = await connectedAccountAuthRefresh();
        const retryHeaders = new Headers(input instanceof Request ? input.headers : undefined);
        const nextHeaders = new Headers(nextInit?.headers);
        nextHeaders.forEach((value, name) => retryHeaders.set(name, value));
        retryHeaders.set('authorization', `Bearer ${refreshedAuth.apiKey}`);
        Object.entries(refreshedAuth.headers ?? {}).forEach(([name, value]) => {
          retryHeaders.set(name, value);
        });
        response = await baseFetch(retryInput, {
          ...nextInit,
          headers: retryHeaders,
        });
      } catch {
        // Preserve the original 401 so existing provider fallback and error classification still run.
      }
    }
    /* === VIVENTIUM END === */

    if (isResponsesRequest && response.ok && normalizedRequestPayload) {
      try {
        nativeProviderRequestAccepted?.({
          provider: 'openai',
          model: String(normalizedRequestPayload.model || ''),
          status: response.status,
          request: normalizedRequestPayload,
        });
      } catch {
        // Telemetry must never alter provider output or fallback behavior.
      }
    }

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
  let configuredFetch = (configOptions.fetch as Fetch | undefined) ?? (fetch as Fetch);
  let customFetchInstalled = configOptions.fetch != null;
  if (isCodexResponsesBaseURL(configOptions.baseURL)) {
    configuredFetch = createCodexResponsesFetch(
      configuredFetch,
      options.connectedAccountAuthRefresh,
      options.nativeProviderRequestAccepted,
    );
    customFetchInstalled = true;
  }
  if (options.nativeProviderRequestAccepted) {
    configuredFetch = createGlassHiveNativeReceiptFetch(
      configuredFetch,
      options.nativeProviderRequestAccepted,
    );
    customFetchInstalled = true;
  }
  if (customFetchInstalled) {
    configOptions.fetch = configuredFetch;
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
