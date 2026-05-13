/* === VIVENTIUM START ===
 * Feature: Local Skyvern provider bridge
 *
 * Purpose:
 * - Give Skyvern a single local OpenAI-compatible endpoint.
 * - Resolve auth through LibreChat's connected-account storage or explicit local provider keys.
 * - Keep local Skyvern aligned with the same credential source of truth used by LibreChat.
 *
 * Endpoints:
 * - POST /api/viventium/skyvern/openai/v1/chat/completions
 * - GET  /api/viventium/skyvern/openai/v1/models
 *
 * Added: 2026-03-09
 * === VIVENTIUM END === */

const express = require('express');
const mongoose = require('mongoose');
const { logger } = require('@librechat/data-schemas');
const { EModelEndpoint } = require('librechat-data-provider');
const { getUserKeyValues, updateUserKey } = require('~/models');

const router = express.Router();

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CONNECTED_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OPENAI_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_CODEX_INSTRUCTIONS = 'You are a helpful assistant.';

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const ANTHROPIC_OAUTH_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'fine-grained-tool-streaming-2025-05-14',
  'interleaved-thinking-2025-05-14',
].join(',');
const ANTHROPIC_OAUTH_SYSTEM_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

function normalizeLowerString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
}

function getBridgeSecret() {
  return (
    process.env.VIVENTIUM_SKYVERN_BRIDGE_API_KEY ||
    process.env.SKYVERN_API_KEY ||
    ''
  ).trim();
}

function getBearerToken(req) {
  const authHeader = req.get('authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  const xApiKey = req.get('x-api-key');
  return typeof xApiKey === 'string' ? xApiKey.trim() : '';
}

function parseJson(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripOuterOpenAIPrefix(model) {
  const trimmed = String(model || '').trim();
  if (trimmed.toLowerCase().startsWith('openai/')) {
    return trimmed.slice('openai/'.length);
  }
  return trimmed;
}

function normalizeRequestedModel(model) {
  const stripped = stripOuterOpenAIPrefix(model);
  return stripped || 'openai/gpt-5.4';
}

function detectProvider(model) {
  const normalized = normalizeRequestedModel(model).toLowerCase();
  if (normalized.startsWith('anthropic/') || normalized.startsWith('claude')) {
    return 'anthropic';
  }
  return 'openai';
}

function removeProviderPrefix(model) {
  const normalized = normalizeRequestedModel(model);
  if (normalized.toLowerCase().startsWith('openai/')) {
    return normalized.slice('openai/'.length);
  }
  if (normalized.toLowerCase().startsWith('anthropic/')) {
    return normalized.slice('anthropic/'.length);
  }
  return normalized;
}

function extractOpenAIAccountId(accessToken) {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    return null;
  }

  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }

  const payload = parts[1]
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(parts[1].length / 4) * 4, '=');

  const parsed = parseJson(Buffer.from(payload, 'base64').toString('utf8'));
  const accountId = parsed?.['https://api.openai.com/auth']?.chatgpt_account_id;
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null;
}

async function resolveAutoUserId(endpointName) {
  const preferred = (process.env.VIVENTIUM_SKYVERN_CONNECTED_ACCOUNT_USER_ID || '').trim();
  if (preferred) {
    return preferred;
  }

  const KeyModel = mongoose.models.Key;
  if (!KeyModel || typeof KeyModel.findOne !== 'function') {
    return '';
  }

  const doc = await KeyModel.findOne({ name: endpointName }).sort({ _id: -1 }).lean();
  if (!doc?.userId) {
    return '';
  }
  return String(doc.userId);
}

async function readUserKeyValues(userId, endpointName) {
  if (!userId) {
    return null;
  }

  try {
    return await getUserKeyValues({ userId, name: endpointName });
  } catch {
    return null;
  }
}

async function persistConnectedAccount(userId, endpointName, value) {
  await updateUserKey({
    userId,
    name: endpointName,
    value: JSON.stringify(value),
    expiresAt: null,
  });
}

async function refreshOpenAIConnectedAccount(userId, userValues) {
  const oauthProvider = normalizeLowerString(userValues?.oauthProvider);
  const refreshToken = typeof userValues?.refreshToken === 'string' ? userValues.refreshToken : '';
  const oauthExpiresAt =
    typeof userValues?.oauthExpiresAt === 'number' ? userValues.oauthExpiresAt : undefined;

  if (oauthProvider !== 'openai-codex') {
    return userValues;
  }
  if (!refreshToken) {
    return userValues;
  }
  if (oauthExpiresAt && oauthExpiresAt > Date.now() + OPENAI_REFRESH_BUFFER_MS) {
    return userValues;
  }

  const response = await fetch(process.env.VIVENTIUM_OPENAI_OAUTH_TOKEN_URL || OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.VIVENTIUM_OPENAI_OAUTH_CLIENT_ID || OPENAI_CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  const rawBody = await response.text();
  const tokenData = parseJson(rawBody);
  if (!response.ok || typeof tokenData?.access_token !== 'string' || tokenData.access_token.length === 0) {
    throw new Error(
      `[Skyvern Bridge] OpenAI connected-account refresh failed: ${rawBody || response.statusText}`,
    );
  }

  const accountId = extractOpenAIAccountId(tokenData.access_token);
  const refreshed = {
    ...userValues,
    apiKey: tokenData.access_token,
    baseURL: process.env.VIVENTIUM_OPENAI_CODEX_BASE_URL || OPENAI_CONNECTED_BASE_URL,
    headers: {
      'OpenAI-Beta': 'responses=experimental',
      originator: process.env.VIVENTIUM_OPENAI_OAUTH_ORIGINATOR || 'pi',
      ...(accountId ? { 'chatgpt-account-id': accountId } : {}),
    },
    accountId: accountId || userValues?.accountId,
    oauthProvider: 'openai-codex',
    oauthType: 'subscription',
    oauthExpiresAt:
      Date.now() +
      (typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in)
        ? tokenData.expires_in
        : 3600) *
        1000,
    refreshToken:
      typeof tokenData.refresh_token === 'string' && tokenData.refresh_token.length > 0
        ? tokenData.refresh_token
        : refreshToken,
  };

  await persistConnectedAccount(userId, EModelEndpoint.openAI, refreshed);
  return refreshed;
}

async function refreshAnthropicConnectedAccount(userId, userValues) {
  const oauthProvider = normalizeLowerString(userValues?.oauthProvider);
  const oauthType = normalizeLowerString(userValues?.oauthType);
  const refreshToken = typeof userValues?.refreshToken === 'string' ? userValues.refreshToken : '';
  const oauthExpiresAt =
    typeof userValues?.oauthExpiresAt === 'number' ? userValues.oauthExpiresAt : undefined;

  if (oauthProvider !== 'anthropic' || oauthType !== 'subscription') {
    return userValues;
  }
  if (!refreshToken) {
    return userValues;
  }
  if (oauthExpiresAt && oauthExpiresAt > Date.now() + ANTHROPIC_REFRESH_BUFFER_MS) {
    return userValues;
  }

  const response = await fetch(process.env.VIVENTIUM_ANTHROPIC_OAUTH_TOKEN_URL || ANTHROPIC_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: process.env.VIVENTIUM_ANTHROPIC_OAUTH_CLIENT_ID || ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  const rawBody = await response.text();
  const tokenData = parseJson(rawBody);
  if (!response.ok || typeof tokenData?.access_token !== 'string' || tokenData.access_token.length === 0) {
    throw new Error(
      `[Skyvern Bridge] Anthropic connected-account refresh failed: ${rawBody || response.statusText}`,
    );
  }

  const refreshed = {
    ...userValues,
    apiKey: tokenData.access_token,
    authToken: tokenData.access_token,
    oauthProvider: 'anthropic',
    oauthType: 'subscription',
    oauthExpiresAt:
      Date.now() +
      (typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in)
        ? tokenData.expires_in
        : 3600) *
        1000,
    refreshToken:
      typeof tokenData.refresh_token === 'string' && tokenData.refresh_token.length > 0
        ? tokenData.refresh_token
        : refreshToken,
  };

  await persistConnectedAccount(userId, EModelEndpoint.anthropic, refreshed);
  return refreshed;
}

async function resolveOpenAICredentials() {
  const userId = await resolveAutoUserId(EModelEndpoint.openAI);
  let userValues = await readUserKeyValues(userId, EModelEndpoint.openAI);
  if (normalizeLowerString(userValues?.oauthProvider) === 'openai-codex') {
    userValues = await refreshOpenAIConnectedAccount(userId, userValues);
  }

  if (typeof userValues?.apiKey === 'string' && userValues.apiKey.length > 0) {
    return {
      mode: normalizeLowerString(userValues?.oauthProvider) === 'openai-codex' ? 'connected' : 'user_key',
      apiKey: userValues.apiKey,
      baseURL:
        typeof userValues?.baseURL === 'string' && userValues.baseURL.length > 0
          ? userValues.baseURL
          : OPENAI_CONNECTED_BASE_URL,
      headers:
        userValues?.headers && typeof userValues.headers === 'object' ? userValues.headers : {},
      userId,
      oauthProvider: userValues?.oauthProvider || null,
      oauthExpiresAt: userValues?.oauthExpiresAt || null,
    };
  }

  const directApiKey = (process.env.OPENAI_API_KEY || '').trim();
  if (directApiKey && directApiKey !== 'user_provided') {
    return {
      mode: 'server_key',
      apiKey: directApiKey,
      baseURL: (process.env.OPENAI_REVERSE_PROXY || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      headers: {},
      userId: '',
      oauthProvider: null,
      oauthExpiresAt: null,
    };
  }

  throw new Error('No OpenAI connected account or direct API key is available for the Skyvern bridge.');
}

async function resolveAnthropicCredentials() {
  const userId = await resolveAutoUserId(EModelEndpoint.anthropic);
  let userValues = await readUserKeyValues(userId, EModelEndpoint.anthropic);
  if (
    normalizeLowerString(userValues?.oauthProvider) === 'anthropic' &&
    normalizeLowerString(userValues?.oauthType) === 'subscription'
  ) {
    userValues = await refreshAnthropicConnectedAccount(userId, userValues);
  }

  const connectedToken =
    typeof userValues?.authToken === 'string' && userValues.authToken.length > 0
      ? userValues.authToken
      : typeof userValues?.apiKey === 'string' && userValues.apiKey.length > 0
        ? userValues.apiKey
        : '';

  if (connectedToken) {
    return {
      mode:
        normalizeLowerString(userValues?.oauthProvider) === 'anthropic' &&
        normalizeLowerString(userValues?.oauthType) === 'subscription'
          ? 'connected'
          : 'user_key',
      apiKey: connectedToken,
      userId,
      oauthProvider: userValues?.oauthProvider || null,
      oauthType: userValues?.oauthType || null,
      oauthExpiresAt: userValues?.oauthExpiresAt || null,
    };
  }

  const directApiKey = (
    process.env.VIVENTIUM_ANTHROPIC_DIRECT_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    ''
  ).trim();

  if (directApiKey && directApiKey !== 'user_provided') {
    return {
      mode: 'server_key',
      apiKey: directApiKey,
      userId: '',
      oauthProvider: null,
      oauthType: null,
      oauthExpiresAt: null,
    };
  }

  throw new Error(
    'No Anthropic connected account or direct API key is available for the Skyvern bridge.',
  );
}

function normalizeOpenAICompatibleTextPart(part) {
  if (!part || typeof part !== 'object') {
    return null;
  }

  if (part.type === 'text' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'input_text' && typeof part.text === 'string') {
    return part.text;
  }
  if (part.type === 'output_text' && typeof part.text === 'string') {
    return part.text;
  }
  return null;
}

function extractTextFromOpenAICompatibleContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => normalizeOpenAICompatibleTextPart(part))
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

function normalizeResponsesContent(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return [{ type: 'input_text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const normalized = [];
  for (const part of content) {
    const text = normalizeOpenAICompatibleTextPart(part);
    if (typeof text === 'string') {
      normalized.push({ type: 'input_text', text });
      continue;
    }

    const imageUrl =
      typeof part?.image_url === 'string'
        ? part.image_url
        : typeof part?.image_url?.url === 'string'
          ? part.image_url.url
          : null;
    if (part?.type === 'image_url' && imageUrl) {
      normalized.push({ type: 'input_image', image_url: imageUrl });
    }
  }

  return normalized;
}

function buildCodexResponsesPayload(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const instructions = [];
  const input = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const role = typeof message.role === 'string' ? message.role : 'user';
    const normalizedContent = normalizeResponsesContent(message);
    if ((role === 'system' || role === 'developer') && normalizedContent.length > 0) {
      instructions.push(
        normalizedContent
          .map((part) => (typeof part?.text === 'string' ? part.text : ''))
          .filter(Boolean)
          .join('\n'),
      );
      continue;
    }

    input.push({
      type: 'message',
      role: role === 'assistant' ? 'assistant' : 'user',
      content: normalizedContent,
    });
  }

  return {
    model: removeProviderPrefix(body?.model),
    instructions: instructions.filter(Boolean).join('\n\n') || DEFAULT_CODEX_INSTRUCTIONS,
    input,
    stream: true,
    store: false,
  };
}

function parseAnthropicImagePart(imageUrl) {
  if (typeof imageUrl !== 'string') {
    return null;
  }
  const match = imageUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) {
    return null;
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: match[1],
      data: match[2],
    },
  };
}

function normalizeAnthropicContent(message) {
  const content = message?.content;
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const normalized = [];
  for (const part of content) {
    const text = normalizeOpenAICompatibleTextPart(part);
    if (typeof text === 'string') {
      normalized.push({ type: 'text', text });
      continue;
    }

    const imageUrl =
      typeof part?.image_url === 'string'
        ? part.image_url
        : typeof part?.image_url?.url === 'string'
          ? part.image_url.url
          : null;
    if (part?.type === 'image_url' && imageUrl) {
      const imagePart = parseAnthropicImagePart(imageUrl);
      if (imagePart) {
        normalized.push(imagePart);
      }
    }
  }

  return normalized;
}

function buildAnthropicPayload(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const systemBlocks = [];
  const anthropicMessages = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    const role = typeof message.role === 'string' ? message.role : 'user';
    const normalizedContent = normalizeAnthropicContent(message);
    if ((role === 'system' || role === 'developer') && normalizedContent.length > 0) {
      systemBlocks.push(...normalizedContent);
      continue;
    }
    anthropicMessages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: normalizedContent,
    });
  }

  return {
    model: removeProviderPrefix(body?.model),
    messages: anthropicMessages,
    max_tokens: body?.max_completion_tokens ?? body?.max_tokens ?? 4096,
    ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
    ...(body?.temperature != null ? { temperature: body.temperature } : {}),
  };
}

function ensureAnthropicOAuthSystemBlocks(system) {
  const blocks = Array.isArray(system) ? system.filter((block) => block && typeof block === 'object') : [];
  if (
    blocks.length > 0 &&
    blocks[0]?.type === 'text' &&
    typeof blocks[0]?.text === 'string' &&
    blocks[0].text === ANTHROPIC_OAUTH_SYSTEM_TEXT
  ) {
    return blocks;
  }

  return [{ type: 'text', text: ANTHROPIC_OAUTH_SYSTEM_TEXT }, ...blocks];
}

function extractCodexResponseObject(raw) {
  const lines = String(raw || '').split('\n');
  let latestResponse = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) {
      continue;
    }
    const payload = parseJson(line.slice('data:'.length).trim());
    if (!payload) {
      continue;
    }
    if (payload.type === 'response.completed' && payload.response && typeof payload.response === 'object') {
      return payload.response;
    }
    if (payload.response && typeof payload.response === 'object') {
      latestResponse = payload.response;
    }
  }
  return latestResponse;
}

function extractTextFromCodexResponse(responseObject) {
  if (!responseObject || typeof responseObject !== 'object') {
    return '';
  }

  if (typeof responseObject.output_text === 'string' && responseObject.output_text.length > 0) {
    return responseObject.output_text;
  }

  const output = Array.isArray(responseObject.output) ? responseObject.output : [];
  const textParts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = normalizeOpenAICompatibleTextPart(part);
      if (typeof text === 'string' && text.length > 0) {
        textParts.push(text);
      }
    }
  }

  return textParts.join('');
}

function buildChatCompletionResponse({ model, content, usage }) {
  const created = Math.floor(Date.now() / 1000);
  const normalizedUsage =
    usage && typeof usage === 'object'
      ? {
          prompt_tokens:
            usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0,
          completion_tokens:
            usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0,
        }
      : { prompt_tokens: 0, completion_tokens: 0 };

  return {
    id: `chatcmpl_skyvern_${Date.now()}`,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      ...normalizedUsage,
      total_tokens:
        Number(normalizedUsage.prompt_tokens || 0) + Number(normalizedUsage.completion_tokens || 0),
    },
  };
}

async function invokeOpenAIConnected(body, credentials) {
  const upstreamBody = buildCodexResponsesPayload(body);
  const response = await fetch(`${credentials.baseURL.replace(/\/+$/, '')}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(credentials.headers || {}),
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(rawBody || `OpenAI connected-account request failed with ${response.status}`);
  }

  const responseObject = extractCodexResponseObject(rawBody);
  const content = extractTextFromCodexResponse(responseObject);
  return buildChatCompletionResponse({
    model: normalizeRequestedModel(body?.model),
    content,
    usage: responseObject?.usage,
  });
}

async function invokeOpenAIDirect(body, credentials) {
  const upstreamBody = {
    ...body,
    model: removeProviderPrefix(body?.model),
    stream: false,
  };

  const response = await fetch(`${credentials.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credentials.apiKey}`,
    },
    body: JSON.stringify(upstreamBody),
  });

  const rawBody = await response.text();
  const parsed = parseJson(rawBody);
  if (!response.ok || !parsed) {
    throw new Error(rawBody || `OpenAI API request failed with ${response.status}`);
  }
  return parsed;
}

async function invokeAnthropic(body, credentials) {
  const upstreamBody = buildAnthropicPayload(body);
  const usingConnectedAccount =
    normalizeLowerString(credentials.oauthProvider) === 'anthropic' &&
    normalizeLowerString(credentials.oauthType) === 'subscription';

  const headers = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (usingConnectedAccount) {
    headers.authorization = `Bearer ${credentials.apiKey}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETAS;
    upstreamBody.system = ensureAnthropicOAuthSystemBlocks(upstreamBody.system);
  } else {
    headers['x-api-key'] = credentials.apiKey;
  }

  const response = await fetch(process.env.VIVENTIUM_SKYVERN_ANTHROPIC_MESSAGES_URL || ANTHROPIC_MESSAGES_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(upstreamBody),
  });

  const rawBody = await response.text();
  const parsed = parseJson(rawBody);
  if (!response.ok || !parsed) {
    throw new Error(rawBody || `Anthropic request failed with ${response.status}`);
  }

  const content = Array.isArray(parsed.content)
    ? parsed.content
        .filter((part) => part?.type === 'text' && typeof part?.text === 'string')
        .map((part) => part.text)
        .join('\n')
    : '';

  return buildChatCompletionResponse({
    model: normalizeRequestedModel(body?.model),
    content,
    usage: parsed.usage,
  });
}

function sendError(res, status, message, details) {
  return res.status(status).json({
    error: {
      message,
      details,
    },
  });
}

router.use((req, res, next) => {
  const expectedSecret = getBridgeSecret();
  if (!expectedSecret) {
    return sendError(
      res,
      503,
      'Skyvern bridge is not configured.',
      'Set SKYVERN_API_KEY or VIVENTIUM_SKYVERN_BRIDGE_API_KEY in the local environment.',
    );
  }

  const providedSecret = getBearerToken(req);
  if (!providedSecret || providedSecret !== expectedSecret) {
    return sendError(res, 401, 'Unauthorized', 'Invalid or missing Skyvern bridge credential.');
  }

  return next();
});

router.get('/openai/v1/models', (_req, res) => {
  const defaults = [
    'openai/gpt-5.4',
    'openai/gpt-4o',
    'anthropic/claude-sonnet-4-5',
    'anthropic/claude-opus-4-7',
  ];

  res.json({
    object: 'list',
    data: defaults.map((id) => ({
      id,
      object: 'model',
      owned_by: 'viventium-local',
    })),
  });
});

router.post('/openai/v1/chat/completions', async (req, res) => {
  const requestedModel = normalizeRequestedModel(req.body?.model);
  const provider = detectProvider(requestedModel);

  try {
    if (provider === 'anthropic') {
      const credentials = await resolveAnthropicCredentials();
      const completion = await invokeAnthropic({ ...req.body, model: requestedModel }, credentials);
      return res.json(completion);
    }

    const credentials = await resolveOpenAICredentials();
    const completion =
      credentials.mode === 'connected'
        ? await invokeOpenAIConnected({ ...req.body, model: requestedModel }, credentials)
        : await invokeOpenAIDirect({ ...req.body, model: requestedModel }, credentials);
    return res.json(completion);
  } catch (error) {
    logger.error('[Skyvern Bridge] Upstream request failed', error);
    const message = error instanceof Error ? error.message : 'Unknown Skyvern bridge failure';
    const status = /Unauthorized|401|invalid_grant|expired/i.test(message) ? 401 : 502;
    return sendError(res, status, 'Skyvern bridge request failed.', message);
  }
});

module.exports = router;
