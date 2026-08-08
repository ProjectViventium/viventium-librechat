/* === VIVENTIUM START ===
 * Feature: GlassHive per-user inference broker.
 * Purpose: Keep connected-account and enterprise credentials inside LibreChat while issuing only
 * short-lived, run-bound grants to an allowlisted OpenAI-compatible worker adapter.
 * === VIVENTIUM END === */
import crypto from 'node:crypto';
import express from 'express';
import { once } from 'node:events';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import type { ConnectedAccountCredentialPolicy } from 'librechat-data-provider';

const ISSUER_AUDIENCE = 'glasshive-inference-grant-issuer';
const GRANT_AUDIENCE = 'glasshive-inference-proxy';
const PERSONAL_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ISSUER_TTL_SECONDS = 60;
const GRANT_TTL_SECONDS = 10 * 60;
const MIN_BROKER_SECRET_BYTES = 32;
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_RESPONSE_IDLE_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const SCOPE_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_RESPONSE_HEADERS = [
  'content-type',
  'openai-processing-ms',
  'retry-after',
  'x-request-id',
] as const;
const SAFE_PERSONAL_HEADERS = ['OpenAI-Organization', 'OpenAI-Project'] as const;
const HOSTED_RESPONSE_TOOL_TYPES = new Set([
  'code_interpreter',
  'computer_use',
  'computer_use_preview',
  'file_search',
  'image_generation',
  'mcp',
  'web_search',
  'web_search_preview',
]);

export type InferenceProvider = 'openai';
export type InferenceRoute = 'personal_api_key' | 'enterprise_route';
export type InferenceAdapter = 'openai_chat_completions_v1' | 'openai_responses_v1';
export type InferenceAssertionAction = 'issue' | 'revoke';

type InferenceAdapterPath = '/chat/completions' | '/responses';

interface SignedClaims {
  aud: string;
  iat: number;
  exp: number;
  nonce: string;
  sig: string;
}

export interface InferenceIssuerClaims extends SignedClaims {
  tenant_id: string;
  user_id: string;
  worker_id: string;
  run_id: string;
  provider: InferenceProvider;
  route: InferenceRoute;
  adapter: InferenceAdapter;
  models: string[];
  action: InferenceAssertionAction;
}

export interface InferenceGrantClaims extends SignedClaims {
  grant_id: string;
  tenant_id: string;
  user_id: string;
  worker_id: string;
  run_id: string;
  provider: InferenceProvider;
  route: InferenceRoute;
  adapter: InferenceAdapter;
  models: string[];
}

export interface InferenceIssuerAssertionInput {
  secret: string;
  tenantId: string;
  userId: string;
  workerId: string;
  runId: string;
  provider: InferenceProvider;
  route: InferenceRoute;
  adapter: InferenceAdapter;
  models: string[];
  action: InferenceAssertionAction;
  nowMs?: number;
}

interface UserKeyValues {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  oauthProvider?: string;
}

interface EnterpriseRoute {
  apiKey: string;
  baseUrl: string;
}

interface GrantRateLimitResult {
  accepted: boolean;
  remaining?: number;
  retryAfterMs?: number;
}

type SafeLogValue = string | number | boolean;
type InferenceFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface InferenceBrokerDependencies {
  secret: string;
  tenantId: string;
  proxyBaseUrl: string;
  now?: () => number;
  isUserActive: (userId: string) => Promise<boolean>;
  getCredentialPolicy: (userId: string) => Promise<ConnectedAccountCredentialPolicy>;
  getUserKeyValues: (params: { userId: string; name: EModelEndpoint }) => Promise<UserKeyValues>;
  getEnterpriseRoute: () => EnterpriseRoute | null;
  assertGrantActive: (grant: InferenceGrantClaims) => Promise<void>;
  revokeGrant: (grant: InferenceGrantClaims) => Promise<void>;
  rememberGrantRequest: (grant: InferenceGrantClaims) => Promise<GrantRateLimitResult>;
  fetch: InferenceFetch;
  log: (event: string, context: Record<string, SafeLogValue>) => void;
  upstreamTimeoutMs?: number;
  responseIdleTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface ProxyInferenceInput {
  grantToken: string;
  workerId: string;
  runId: string;
  body: object;
}

export type ProxyChatCompletionsInput = ProxyInferenceInput;
export type ProxyResponsesInput = ProxyInferenceInput;

export interface ProxyChatCompletionsResult {
  status: number;
  headers: Record<string, string>;
  response: Response;
  rateLimitRemaining?: number;
  responseIdleTimeoutMs: number;
  maxResponseBytes: number;
  dispose: () => void;
}

export interface IssuedInferenceGrant {
  grantToken: string;
  grantId: string;
  provider: InferenceProvider;
  route: InferenceRoute;
  expiresAt: string;
  adapter: {
    id: InferenceAdapter;
    baseUrl: string;
    auth: 'bearer_grant';
    paths: [InferenceAdapterPath];
    supportsStreaming: true;
  };
}

export class InferenceBrokerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: string, message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'InferenceBrokerError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function stableJson(value: object | string[] | string | number | boolean | null): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, object | string[] | string | number | boolean | null>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function derivedSecret(secret: string, purpose: 'issuer' | 'grant'): Buffer {
  const cleanSecret = secret.trim();
  if (Buffer.byteLength(cleanSecret, 'utf8') < MIN_BROKER_SECRET_BYTES) {
    throw new InferenceBrokerError(
      'broker_unavailable',
      'GlassHive inference broker is unavailable',
      503,
    );
  }
  return crypto
    .createHmac('sha256', cleanSecret)
    .update(`viventium-glasshive-inference:${purpose}:v1`)
    .digest();
}

function signClaims(
  claims: Omit<InferenceIssuerClaims, 'sig'> | Omit<InferenceGrantClaims, 'sig'>,
  secret: string,
  purpose: 'issuer' | 'grant',
): string {
  return crypto
    .createHmac('sha256', derivedSecret(secret, purpose))
    .update(stableJson(claims))
    .digest('base64url');
}

function timingSafeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function normalizeScope(value: string, field: string): string {
  const normalized = value.trim();
  if (!SCOPE_PATTERN.test(normalized)) {
    throw new InferenceBrokerError('invalid_scope', `Invalid GlassHive inference ${field}`, 400);
  }
  return normalized;
}

function normalizeModels(models: string[]): string[] {
  const normalized = Array.from(
    new Set(models.map((model) => model.trim()).filter((model) => MODEL_PATTERN.test(model))),
  ).sort();
  if (normalized.length === 0 || normalized.length !== models.length || normalized.length > 32) {
    throw new InferenceBrokerError('invalid_models', 'GlassHive inference models are invalid', 400);
  }
  return normalized;
}

function parseSignedToken<T extends SignedClaims>(token: string): T {
  if (!token || token.length > 8192) {
    throw new Error('invalid token');
  }
  const parsed = JSON.parse(base64urlDecode(token)) as T;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid token');
  }
  return parsed;
}

function validateCommonClaims(
  claims: SignedClaims,
  audience: string,
  nowMs: number,
  maxLifetimeSeconds: number,
): void {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (claims.aud !== audience) {
    throw new Error('audience mismatch');
  }
  if (
    !Number.isInteger(claims.iat) ||
    !Number.isInteger(claims.exp) ||
    claims.iat > nowSeconds + 30 ||
    claims.exp <= nowSeconds ||
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > maxLifetimeSeconds
  ) {
    throw new Error('expired');
  }
  if (!/^[a-f0-9]{32}$/.test(claims.nonce)) {
    throw new Error('invalid nonce');
  }
}

function validateInferenceScope(
  claims: InferenceIssuerClaims | InferenceGrantClaims,
  tenantId: string,
): void {
  if (claims.tenant_id !== normalizeScope(tenantId, 'tenant')) {
    throw new Error('tenant mismatch');
  }
  normalizeScope(claims.user_id, 'user');
  normalizeScope(claims.worker_id, 'worker');
  normalizeScope(claims.run_id, 'run');
  if (claims.provider !== 'openai') {
    throw new Error('provider mismatch');
  }
  if (claims.route !== 'personal_api_key' && claims.route !== 'enterprise_route') {
    throw new Error('route mismatch');
  }
  if (claims.adapter !== 'openai_chat_completions_v1' && claims.adapter !== 'openai_responses_v1') {
    throw new Error('adapter mismatch');
  }
  normalizeModels(claims.models);
}

export function mintInferenceIssuerAssertion(input: InferenceIssuerAssertionInput): {
  token: string;
  claims: InferenceIssuerClaims;
} {
  const issuedAt = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const unsigned: Omit<InferenceIssuerClaims, 'sig'> = {
    aud: ISSUER_AUDIENCE,
    tenant_id: normalizeScope(input.tenantId, 'tenant'),
    user_id: normalizeScope(input.userId, 'user'),
    worker_id: normalizeScope(input.workerId, 'worker'),
    run_id: normalizeScope(input.runId, 'run'),
    provider: input.provider,
    route: input.route,
    adapter: input.adapter,
    models: normalizeModels(input.models),
    action: input.action,
    iat: issuedAt,
    exp: issuedAt + ISSUER_TTL_SECONDS,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  validateInferenceScope({ ...unsigned, sig: '' }, input.tenantId);
  if (input.action !== 'issue' && input.action !== 'revoke') {
    throw new InferenceBrokerError(
      'invalid_action',
      'GlassHive inference assertion action is invalid',
      400,
    );
  }
  const claims = { ...unsigned, sig: signClaims(unsigned, input.secret, 'issuer') };
  return { token: base64urlEncode(JSON.stringify(claims)), claims };
}

export function verifyInferenceIssuerAssertion(
  token: string,
  options: { secret: string; tenantId: string; nowMs?: number },
): InferenceIssuerClaims {
  let claims: InferenceIssuerClaims;
  try {
    claims = parseSignedToken<InferenceIssuerClaims>(token);
    const { sig, ...unsigned } = claims;
    const expected = signClaims(unsigned, options.secret, 'issuer');
    if (!sig || !timingSafeEqual(sig, expected)) {
      throw new Error('signature mismatch');
    }
    validateCommonClaims(claims, ISSUER_AUDIENCE, options.nowMs ?? Date.now(), ISSUER_TTL_SECONDS);
    validateInferenceScope(claims, options.tenantId);
    if (claims.action !== 'issue' && claims.action !== 'revoke') {
      throw new Error('action mismatch');
    }
    return claims;
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'tenant mismatch' || reason === 'expired') {
      throw new InferenceBrokerError(
        'invalid_issuer_assertion',
        `GlassHive inference issuer assertion ${reason}`,
        401,
      );
    }
    throw new InferenceBrokerError(
      'invalid_issuer_assertion',
      'Invalid GlassHive inference issuer assertion',
      401,
    );
  }
}

function deterministicGrantId(claims: InferenceIssuerClaims, secret: string): string {
  const scope = [
    claims.tenant_id,
    claims.user_id,
    claims.worker_id,
    claims.run_id,
    claims.provider,
    claims.route,
    claims.adapter,
    stableJson(claims.models),
    claims.nonce,
  ].join('\u0000');
  return `ghcb_infer_${crypto
    .createHmac('sha256', derivedSecret(secret, 'grant'))
    .update(scope)
    .digest('hex')}`;
}

function mintInferenceGrant(
  assertion: InferenceIssuerClaims,
  secret: string,
): { token: string; claims: InferenceGrantClaims } {
  const unsigned: Omit<InferenceGrantClaims, 'sig'> = {
    aud: GRANT_AUDIENCE,
    grant_id: deterministicGrantId(assertion, secret),
    tenant_id: assertion.tenant_id,
    user_id: assertion.user_id,
    worker_id: assertion.worker_id,
    run_id: assertion.run_id,
    provider: assertion.provider,
    route: assertion.route,
    adapter: assertion.adapter,
    models: assertion.models,
    iat: assertion.iat,
    exp: assertion.iat + GRANT_TTL_SECONDS,
    nonce: assertion.nonce,
  };
  const claims = { ...unsigned, sig: signClaims(unsigned, secret, 'grant') };
  return { token: base64urlEncode(JSON.stringify(claims)), claims };
}

export function verifyInferenceGrant(
  token: string,
  options: { secret: string; tenantId: string; nowMs?: number },
): InferenceGrantClaims {
  try {
    const claims = parseSignedToken<InferenceGrantClaims>(token);
    const { sig, ...unsigned } = claims;
    const expected = signClaims(unsigned, options.secret, 'grant');
    if (!sig || !timingSafeEqual(sig, expected)) {
      throw new Error('signature mismatch');
    }
    validateCommonClaims(claims, GRANT_AUDIENCE, options.nowMs ?? Date.now(), GRANT_TTL_SECONDS);
    validateInferenceScope(claims, options.tenantId);
    if (!/^ghcb_infer_[a-f0-9]{64}$/.test(claims.grant_id)) {
      throw new Error('grant id mismatch');
    }
    return claims;
  } catch {
    throw new InferenceBrokerError('invalid_grant', 'Invalid GlassHive inference grant', 401);
  }
}

function normalizedHttpsBaseUrl(rawUrl: string, code: string): string {
  try {
    const parsed = new URL(rawUrl.trim());
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('unsafe URL');
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new InferenceBrokerError(code, 'GlassHive inference route is unavailable', 503);
  }
}

function adapterPath(adapter: InferenceAdapter): InferenceAdapterPath {
  return adapter === 'openai_responses_v1' ? '/responses' : '/chat/completions';
}

function openAiAdapterUrl(baseUrl: string, adapter: InferenceAdapter, errorCode: string): string {
  const normalized = normalizedHttpsBaseUrl(baseUrl, errorCode);
  const versionedBaseUrl = normalized.endsWith('/v1') ? normalized : `${normalized}/v1`;
  return `${versionedBaseUrl}${adapterPath(adapter)}`;
}

function safePersonalHeaders(values: UserKeyValues): Record<string, string> {
  const headers = values.headers ?? {};
  return Object.fromEntries(
    SAFE_PERSONAL_HEADERS.flatMap((name) => {
      const value = headers[name];
      return typeof value === 'string' && value.trim() ? [[name, value.trim()]] : [];
    }),
  );
}

function sanitizedRequestBody(body: object, adapter: InferenceAdapter): object {
  if (!body || Array.isArray(body)) {
    throw new InferenceBrokerError(
      'invalid_request',
      'OpenAI inference request must be an object',
      400,
    );
  }
  const record = { ...(body as Record<string, object | string | number | boolean | null>) };
  [
    'user',
    'apiKey',
    'api_key',
    'openai_api_key',
    'baseURL',
    'base_url',
    'openaiBaseUrl',
    'openai_base_url',
    'apiBase',
    'api_base',
    'url',
    'endpoint',
    'headers',
    'Authorization',
    'authorization',
  ].forEach((field) => delete record[field]);
  const encoded = JSON.stringify(record);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
    throw new InferenceBrokerError(
      'request_too_large',
      'OpenAI inference request is too large',
      413,
    );
  }
  if (typeof record.model !== 'string' || !MODEL_PATTERN.test(record.model)) {
    throw new InferenceBrokerError('invalid_model', 'OpenAI inference model is invalid', 400);
  }
  if (adapter === 'openai_chat_completions_v1') {
    if (
      Array.isArray(record.messages) &&
      record.messages.length > 0 &&
      record.messages.length <= 200
    ) {
      return record;
    }
    throw new InferenceBrokerError(
      'invalid_messages',
      'OpenAI chat completion messages are invalid',
      400,
    );
  }

  const hasStringInput = typeof record.input === 'string' && record.input.trim().length > 0;
  const hasArrayInput =
    Array.isArray(record.input) && record.input.length > 0 && record.input.length <= 200;
  if (!hasStringInput && !hasArrayInput) {
    throw new InferenceBrokerError('invalid_input', 'OpenAI response input is invalid', 400);
  }
  if (
    Array.isArray(record.tools) &&
    record.tools.some((tool) => {
      if (!isPlainObject(tool)) {
        return false;
      }
      const toolType = (tool as Record<string, unknown>)['type'];
      return typeof toolType === 'string' && HOSTED_RESPONSE_TOOL_TYPES.has(toolType);
    })
  ) {
    throw new InferenceBrokerError(
      'hosted_tool_not_allowed',
      'Hosted OpenAI tools are not allowed through a GlassHive inference grant',
      400,
    );
  }
  return record;
}

function safeResponseHeaders(response: Response, secret: string): Record<string, string> {
  return Object.fromEntries(
    SAFE_RESPONSE_HEADERS.flatMap((name) => {
      const value = response.headers.get(name);
      return value ? [[name, replaceSecret(value, secret)]] : [];
    }),
  );
}

function replaceSecret(value: string, secret: string): string {
  return value.split(secret).join('[REDACTED]');
}

function redactedUpstreamResponse(response: Response, secret: string): Response {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('json') && !contentType.startsWith('text/event-stream')) {
    void response.body?.cancel().catch(() => undefined);
    throw new InferenceBrokerError(
      'upstream_content_rejected',
      'OpenAI-compatible inference route returned unsupported content',
      502,
    );
  }
  if (!response.body) {
    return response;
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const carryLength = Math.max(0, secret.length - 1);
  let carry = '';
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const text = carry + decoder.decode(chunk, { stream: true });
        const redacted = replaceSecret(text, secret);
        const emitLength = Math.max(0, redacted.length - carryLength);
        const emitted = redacted.slice(0, emitLength);
        carry = redacted.slice(emitLength);
        if (emitted) {
          controller.enqueue(encoder.encode(replaceSecret(emitted, secret)));
        }
      },
      flush(controller) {
        const emitted = carry + decoder.decode();
        if (emitted) {
          controller.enqueue(encoder.encode(replaceSecret(emitted, secret)));
        }
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function matchingScope(assertion: InferenceIssuerClaims, grant: InferenceGrantClaims): boolean {
  return (
    assertion.tenant_id === grant.tenant_id &&
    assertion.user_id === grant.user_id &&
    assertion.worker_id === grant.worker_id &&
    assertion.run_id === grant.run_id &&
    assertion.provider === grant.provider &&
    assertion.route === grant.route &&
    assertion.adapter === grant.adapter &&
    stableJson(assertion.models) === stableJson(grant.models)
  );
}

export function createGlassHiveInferenceBroker(dependencies: InferenceBrokerDependencies) {
  const now = dependencies.now ?? Date.now;

  async function requireActiveUser(userId: string): Promise<void> {
    if (!(await dependencies.isUserActive(userId))) {
      throw new InferenceBrokerError(
        'user_unavailable',
        'GlassHive inference user is unavailable',
        401,
      );
    }
  }

  async function resolveRouteCredential(
    claims: InferenceIssuerClaims | InferenceGrantClaims,
  ): Promise<{ url: string; apiKey: string; headers: Record<string, string> }> {
    const policy = await dependencies.getCredentialPolicy(claims.user_id);
    if (claims.route === 'enterprise_route') {
      if (policy === 'personal_required') {
        throw new InferenceBrokerError(
          'personal_credentials_required',
          'This user requires a personal connected account',
          409,
        );
      }
      const route = dependencies.getEnterpriseRoute();
      if (!route?.apiKey.trim() || route.apiKey.length < 8 || route.apiKey.length > 8192) {
        throw new InferenceBrokerError(
          'enterprise_route_unavailable',
          'Enterprise OpenAI route is unavailable',
          503,
        );
      }
      return {
        url: openAiAdapterUrl(route.baseUrl, claims.adapter, 'enterprise_route_unavailable'),
        apiKey: route.apiKey,
        headers: {},
      };
    }

    try {
      const values = await dependencies.getUserKeyValues({
        userId: claims.user_id,
        name: EModelEndpoint.openAI,
      });
      if (
        !values.apiKey?.trim() ||
        values.apiKey.length < 8 ||
        values.apiKey.length > 8192 ||
        values.oauthProvider
      ) {
        throw new Error('personal API key is not ready');
      }
      const storedBaseUrl = String(values.baseURL || '').trim();
      if (
        storedBaseUrl &&
        normalizedHttpsBaseUrl(storedBaseUrl, 'personal_route_unavailable') !==
          PERSONAL_OPENAI_BASE_URL
      ) {
        throw new Error('personal API key belongs to a different upstream route');
      }
      return {
        url: openAiAdapterUrl(
          PERSONAL_OPENAI_BASE_URL,
          claims.adapter,
          'personal_route_unavailable',
        ),
        apiKey: values.apiKey,
        headers: safePersonalHeaders(values),
      };
    } catch {
      throw new InferenceBrokerError(
        'credential_action_required',
        'Personal OpenAI API key must be connected again',
        409,
      );
    }
  }

  async function issueGrant(issuerToken: string): Promise<IssuedInferenceGrant> {
    const proxyBaseUrl = normalizedHttpsBaseUrl(
      dependencies.proxyBaseUrl,
      'proxy_route_unavailable',
    );
    const assertion = verifyInferenceIssuerAssertion(issuerToken, {
      secret: dependencies.secret,
      tenantId: dependencies.tenantId,
      nowMs: now(),
    });
    if (assertion.action !== 'issue') {
      throw new InferenceBrokerError(
        'invalid_assertion_action',
        'GlassHive inference assertion cannot issue a grant',
        401,
      );
    }
    await requireActiveUser(assertion.user_id);
    await resolveRouteCredential(assertion);
    const grant = mintInferenceGrant(assertion, dependencies.secret);
    dependencies.log('grant_issued', {
      grantId: grant.claims.grant_id,
      provider: grant.claims.provider,
      route: grant.claims.route,
    });
    return {
      grantToken: grant.token,
      grantId: grant.claims.grant_id,
      provider: grant.claims.provider,
      route: grant.claims.route,
      expiresAt: new Date(grant.claims.exp * 1000).toISOString(),
      adapter: {
        id: assertion.adapter,
        baseUrl: `${proxyBaseUrl}/openai/v1`,
        auth: 'bearer_grant',
        paths: [adapterPath(assertion.adapter)],
        supportsStreaming: true,
      },
    };
  }

  async function proxyInference(
    input: ProxyInferenceInput,
    expectedAdapter: InferenceAdapter,
  ): Promise<ProxyChatCompletionsResult> {
    const grant = verifyInferenceGrant(input.grantToken, {
      secret: dependencies.secret,
      tenantId: dependencies.tenantId,
      nowMs: now(),
    });
    if (grant.worker_id !== input.workerId || grant.run_id !== input.runId) {
      throw new InferenceBrokerError(
        'grant_scope_mismatch',
        'GlassHive inference grant scope does not match this run',
        401,
      );
    }
    if (grant.adapter !== expectedAdapter) {
      throw new InferenceBrokerError(
        'grant_adapter_mismatch',
        'GlassHive inference grant does not allow this adapter',
        403,
      );
    }
    try {
      await dependencies.assertGrantActive(grant);
    } catch {
      throw new InferenceBrokerError(
        'grant_inactive',
        'GlassHive inference grant is inactive',
        401,
      );
    }
    const rateLimit = await dependencies.rememberGrantRequest(grant);
    if (!rateLimit.accepted) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(Number(rateLimit.retryAfterMs ?? 1000) / 1000),
      );
      throw new InferenceBrokerError(
        'rate_limited',
        'GlassHive inference broker rate limit exceeded',
        429,
        retryAfterSeconds,
      );
    }
    await requireActiveUser(grant.user_id);
    const requestBody = sanitizedRequestBody(input.body, grant.adapter) as Record<
      string,
      object | string
    >;
    if (!grant.models.includes(String(requestBody.model))) {
      throw new InferenceBrokerError(
        'model_not_allowed',
        'OpenAI model is not allowed by this grant',
        403,
      );
    }
    const credential = await resolveRouteCredential(grant);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1000, dependencies.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS),
    );
    timeout.unref?.();
    let response: Response;
    try {
      response = await dependencies.fetch(credential.url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${credential.apiKey}`,
          'Content-Type': 'application/json',
          ...credential.headers,
        },
        body: JSON.stringify(requestBody),
      });
    } catch {
      clearTimeout(timeout);
      throw new InferenceBrokerError(
        'upstream_unavailable',
        'OpenAI-compatible inference route is unavailable',
        502,
      );
    }
    clearTimeout(timeout);
    if (response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined);
      throw new InferenceBrokerError(
        'upstream_redirect_rejected',
        'OpenAI-compatible inference route returned an unsafe redirect',
        502,
      );
    }
    dependencies.log('request_completed', {
      grantId: grant.grant_id,
      provider: grant.provider,
      route: grant.route,
      status: response.status,
    });
    let safeResponse: Response;
    try {
      const maxResponseBytes = Math.max(
        1024,
        dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      );
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
        controller.abort();
        void response.body?.cancel().catch(() => undefined);
        throw new InferenceBrokerError(
          'upstream_response_too_large',
          'OpenAI-compatible inference response is too large',
          502,
        );
      }
      safeResponse = redactedUpstreamResponse(response, credential.apiKey);
    } catch (error) {
      controller.abort();
      throw error;
    }
    return {
      status: safeResponse.status,
      headers: safeResponseHeaders(safeResponse, credential.apiKey),
      response: safeResponse,
      responseIdleTimeoutMs: Math.max(
        1000,
        dependencies.responseIdleTimeoutMs ?? DEFAULT_RESPONSE_IDLE_TIMEOUT_MS,
      ),
      maxResponseBytes: Math.max(1024, dependencies.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES),
      dispose: () => controller.abort(),
      ...(rateLimit.remaining == null ? {} : { rateLimitRemaining: rateLimit.remaining }),
    };
  }

  async function proxyChatCompletions(
    input: ProxyChatCompletionsInput,
  ): Promise<ProxyChatCompletionsResult> {
    return proxyInference(input, 'openai_chat_completions_v1');
  }

  async function proxyResponses(input: ProxyResponsesInput): Promise<ProxyChatCompletionsResult> {
    return proxyInference(input, 'openai_responses_v1');
  }

  async function revokeGrant(
    issuerToken: string,
    grantToken: string,
  ): Promise<{ revoked: true; grantId: string }> {
    const assertion = verifyInferenceIssuerAssertion(issuerToken, {
      secret: dependencies.secret,
      tenantId: dependencies.tenantId,
      nowMs: now(),
    });
    const grant = verifyInferenceGrant(grantToken, {
      secret: dependencies.secret,
      tenantId: dependencies.tenantId,
      nowMs: now(),
    });
    if (assertion.action !== 'revoke' || !matchingScope(assertion, grant)) {
      throw new InferenceBrokerError(
        'grant_scope_mismatch',
        'GlassHive inference grant cannot be revoked by this assertion',
        403,
      );
    }
    await requireActiveUser(assertion.user_id);
    await dependencies.revokeGrant(grant);
    dependencies.log('grant_revoked', {
      grantId: grant.grant_id,
      provider: grant.provider,
      route: grant.route,
    });
    return { revoked: true, grantId: grant.grant_id };
  }

  return { issueGrant, proxyChatCompletions, proxyResponses, revokeGrant };
}

function bearerToken(request: ExpressRequest): string {
  const header = String(request.get('authorization') || '').trim();
  return header.replace(/^Bearer\s+/i, '').trim();
}

function requestScope(request: ExpressRequest, header: string): string {
  return String(request.get(header) || '').trim();
}

function isPlainObject(value: unknown): value is object {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function errorResponse(
  response: ExpressResponse,
  error: InferenceBrokerError,
  log: InferenceBrokerDependencies['log'],
): ExpressResponse {
  log('request_rejected', { code: error.code, status: error.status });
  response.set('Cache-Control', 'no-store');
  if (error.retryAfterSeconds != null) {
    response.set('Retry-After', String(error.retryAfterSeconds));
  }
  return response.status(error.status).json({
    error: { code: error.code, message: error.message },
  });
}

function normalizedBrokerError(error: unknown): InferenceBrokerError {
  if (error instanceof InferenceBrokerError) {
    return error;
  }
  return new InferenceBrokerError(
    'inference_broker_failed',
    'GlassHive inference broker request failed',
    500,
  );
}

async function writeProxyResponse(
  request: ExpressRequest,
  response: ExpressResponse,
  result: ProxyChatCompletionsResult,
): Promise<void> {
  response.status(result.status);
  response.set('Cache-Control', 'no-store');
  Object.entries(result.headers).forEach(([name, value]) => response.set(name, value));
  if (result.rateLimitRemaining != null) {
    response.set('X-GlassHive-Inference-Rate-Limit-Remaining', String(result.rateLimitRemaining));
  }
  if (!result.response.body) {
    result.dispose();
    response.end();
    return;
  }

  const contentType = String(result.headers['content-type'] || '').toLowerCase();
  const reader = result.response.body.getReader();
  let aborted = false;
  let completed = false;
  let responseBytes = 0;
  const abort = () => {
    if (completed) {
      return;
    }
    aborted = true;
    result.dispose();
    void reader.cancel().catch(() => undefined);
  };
  const readNext = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new InferenceBrokerError(
                  'upstream_idle_timeout',
                  'OpenAI-compatible inference response became idle',
                  504,
                ),
              ),
            result.responseIdleTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  const countChunk = (chunk: Uint8Array): void => {
    responseBytes += chunk.byteLength;
    if (responseBytes > result.maxResponseBytes) {
      throw new InferenceBrokerError(
        'upstream_response_too_large',
        'OpenAI-compatible inference response is too large',
        502,
      );
    }
  };
  request.once('aborted', abort);
  response.once('close', abort);
  try {
    if (contentType.includes('json')) {
      const chunks: Buffer[] = [];
      while (!aborted) {
        const chunk = await readNext();
        if (chunk.done) {
          break;
        }
        countChunk(chunk.value);
        chunks.push(Buffer.from(chunk.value));
      }
      if (!aborted) {
        completed = true;
        response.end(Buffer.concat(chunks, responseBytes));
      }
      return;
    }

    while (!aborted) {
      const chunk = await readNext();
      if (chunk.done) {
        break;
      }
      countChunk(chunk.value);
      if (!response.write(Buffer.from(chunk.value))) {
        await once(response, 'drain');
      }
    }
    if (!aborted) {
      completed = true;
      response.end();
    }
  } finally {
    request.off('aborted', abort);
    response.off('close', abort);
    result.dispose();
    reader.releaseLock();
  }
}

export function createGlassHiveInferenceBrokerRouter(
  dependencies: InferenceBrokerDependencies,
): express.Router {
  const router = express.Router();
  const broker = createGlassHiveInferenceBroker(dependencies);
  let isConfigured =
    Buffer.byteLength(dependencies.secret.trim(), 'utf8') >= MIN_BROKER_SECRET_BYTES;
  try {
    normalizedHttpsBaseUrl(dependencies.proxyBaseUrl, 'proxy_route_unavailable');
  } catch {
    isConfigured = false;
  }

  router.get('/health', (_request, response) =>
    response.json({
      status: isConfigured ? 'ok' : 'unavailable',
      service: 'glasshive-inference-broker',
      adapters: isConfigured
        ? [
            {
              id: 'openai_chat_completions_v1',
              provider: 'openai',
              paths: ['/openai/v1/chat/completions'],
              supportsStreaming: true,
            },
            {
              id: 'openai_responses_v1',
              provider: 'openai',
              paths: ['/openai/v1/responses'],
              supportsStreaming: true,
            },
          ]
        : [],
    }),
  );

  router.use((_request, response, next) => {
    if (isConfigured) {
      next();
      return;
    }
    errorResponse(
      response,
      new InferenceBrokerError(
        'inference_broker_unavailable',
        'GlassHive inference broker is unavailable',
        503,
      ),
      dependencies.log,
    );
  });

  router.post('/grants', async (request, response) => {
    try {
      const result = await broker.issueGrant(bearerToken(request));
      response.set('Cache-Control', 'no-store');
      return response.status(201).json(result);
    } catch (error) {
      return errorResponse(response, normalizedBrokerError(error), dependencies.log);
    }
  });

  router.post('/grants/revoke', async (request, response) => {
    try {
      const rawBody: unknown = request.body;
      const grantToken =
        isPlainObject(rawBody) && 'grantToken' in rawBody && typeof rawBody.grantToken === 'string'
          ? rawBody.grantToken
          : '';
      if (!grantToken || grantToken.length > 8192) {
        throw new InferenceBrokerError('invalid_grant', 'Invalid GlassHive inference grant', 400);
      }
      const result = await broker.revokeGrant(bearerToken(request), grantToken);
      response.set('Cache-Control', 'no-store');
      return response.json(result);
    } catch (error) {
      return errorResponse(response, normalizedBrokerError(error), dependencies.log);
    }
  });

  router.post('/openai/v1/chat/completions', async (request, response) => {
    try {
      const rawBody: unknown = request.body;
      if (!isPlainObject(rawBody)) {
        throw new InferenceBrokerError(
          'invalid_request',
          'OpenAI chat completion request must be an object',
          400,
        );
      }
      const result = await broker.proxyChatCompletions({
        grantToken: bearerToken(request),
        workerId: requestScope(request, 'x-glasshive-worker-id'),
        runId: requestScope(request, 'x-glasshive-run-id'),
        body: rawBody,
      });
      await writeProxyResponse(request, response, result);
      return undefined;
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return undefined;
      }
      return errorResponse(response, normalizedBrokerError(error), dependencies.log);
    }
  });

  router.post('/openai/v1/responses', async (request, response) => {
    try {
      const rawBody: unknown = request.body;
      if (!isPlainObject(rawBody)) {
        throw new InferenceBrokerError(
          'invalid_request',
          'OpenAI response request must be an object',
          400,
        );
      }
      const result = await broker.proxyResponses({
        grantToken: bearerToken(request),
        workerId: requestScope(request, 'x-glasshive-worker-id'),
        runId: requestScope(request, 'x-glasshive-run-id'),
        body: rawBody,
      });
      await writeProxyResponse(request, response, result);
      return undefined;
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return undefined;
      }
      return errorResponse(response, normalizedBrokerError(error), dependencies.log);
    }
  });

  return router;
}
/* === VIVENTIUM END === */
