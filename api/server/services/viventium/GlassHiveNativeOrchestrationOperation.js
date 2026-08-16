/* === VIVENTIUM START ===
 * Feature: Native conversation-provider orchestration operation token.
 * Purpose: Give a provider-owned MCP loop a Core-attested mutation occurrence without trusting
 * reconnect-level JSON-RPC ids, progress tokens, model-authored operation ids, or prompt heuristics.
 * The token is self-contained, short-lived, and never persisted by Core.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { BROKER_AUTHORITY_KINDS } = require('./GlassHiveCapabilityBrokerAuth');
const {
  canonicalConversationOrchestrationArguments,
  isConversationOrchestrationMutationTool,
} = require('./GlassHiveConversationOrchestration');

const NATIVE_OPERATION_AUDIENCE = 'glasshive-native-orchestration-operation';
const NATIVE_OPERATION_TOKEN_FIELD = '_viventium_operation_token';
const DEFAULT_NATIVE_OPERATION_TTL_SECONDS = 120;
const MAX_NATIVE_OPERATION_TTL_SECONDS = 5 * 60;
const NATIVE_OPERATION_ENVELOPE_VERSION = 2;
const NATIVE_OPERATION_ENVELOPE_ALGORITHM = 'A256GCM';
const NATIVE_OPERATION_CLAIMS_VERSION = 1;
const NATIVE_OPERATION_TOKEN_MAX_LENGTH = 8192;
const NATIVE_OPERATION_IV_BYTES = 12;
const NATIVE_OPERATION_TAG_BYTES = 16;
const NATIVE_OPERATION_HKDF_SALT = Buffer.from(
  'viventium:glasshive-native-orchestration:hkdf-salt:v2',
  'utf8',
);
const NATIVE_OPERATION_HKDF_INFO = Buffer.from(
  'viventium:glasshive-native-orchestration:aead-key:v2',
  'utf8',
);
const NATIVE_OPERATION_AAD = Buffer.from(
  `${NATIVE_OPERATION_AUDIENCE}:${NATIVE_OPERATION_ENVELOPE_VERSION}:${NATIVE_OPERATION_ENVELOPE_ALGORITHM}`,
  'utf8',
);
const NATIVE_OPERATION_ENVELOPE_KEYS = Object.freeze([
  'algorithm',
  'ciphertext',
  'iv',
  'tag',
  'version',
]);
const NATIVE_OPERATION_CLAIM_KEYS = Object.freeze([
  'args_hash',
  'aud',
  'authority_kind',
  'claims_version',
  'conversation_id',
  'exp',
  'grant_id',
  'iat',
  'message_id',
  'nonce',
  'owner_id',
  'owner_role',
  'tool_name',
  'turn_id',
]);

class NativeOrchestrationOperationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'NativeOrchestrationOperationError';
    this.code = code;
  }
}

function operationError(code) {
  throw new NativeOrchestrationOperationError(code);
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function operationSecret() {
  const secret = String(process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET || '').trim();
  if (!secret) operationError('orchestration_operation_secret_unavailable');
  return secret;
}

function operationEncryptionKey(secret = operationSecret()) {
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(secret, 'utf8'),
      NATIVE_OPERATION_HKDF_SALT,
      NATIVE_OPERATION_HKDF_INFO,
      32,
    ),
  );
}

function hashCanonicalArgs(args) {
  return crypto.createHash('sha256').update(stableJson(args), 'utf8').digest('base64url');
}

function operationScope(grant = {}) {
  return {
    grant_id: boundedString(grant.grant_id, 192),
    owner_id: boundedString(grant.user_id, 160),
    owner_role: boundedString(grant.user_role, 80),
    authority_kind: boundedString(grant.authority_kind, 80),
    conversation_id: boundedString(grant.conversation_id, 192),
    message_id: boundedString(grant.message_id, 192),
    turn_id: boundedString(grant.turn_id, 192),
  };
}

function assertOperationScope(scope) {
  if (scope.authority_kind !== BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR) {
    operationError('orchestration_operation_authority_required');
  }
  if (
    !scope.grant_id ||
    !scope.owner_id ||
    !scope.owner_role ||
    !scope.message_id ||
    (!scope.conversation_id && !scope.turn_id)
  ) {
    operationError('orchestration_operation_scope_unavailable');
  }
}

function operationTtlSeconds() {
  const configured = Number(process.env.VIVENTIUM_GLASSHIVE_NATIVE_OPERATION_TTL_SECONDS);
  const ttl = Number.isFinite(configured)
    ? Math.floor(configured)
    : DEFAULT_NATIVE_OPERATION_TTL_SECONDS;
  return Math.max(15, Math.min(ttl, MAX_NATIVE_OPERATION_TTL_SECONDS));
}

function encodeToken(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeToken(token) {
  const boundedToken = typeof token === 'string' ? token.trim() : '';
  if (
    !boundedToken ||
    boundedToken.length > NATIVE_OPERATION_TOKEN_MAX_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(boundedToken)
  ) {
    operationError('orchestration_operation_token_invalid');
  }
  try {
    const payload = JSON.parse(Buffer.from(boundedToken, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      operationError('orchestration_operation_token_invalid');
    }
    return payload;
  } catch (error) {
    if (error instanceof NativeOrchestrationOperationError) throw error;
    operationError('orchestration_operation_token_invalid');
  }
}

function assertExactKeys(value, expectedKeys) {
  const keys = Object.keys(value || {}).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    operationError('orchestration_operation_token_invalid');
  }
}

function decodeEnvelopeBuffer(value, expectedBytes = 0) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9_-]+$/.test(value)) {
    operationError('orchestration_operation_token_invalid');
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    !decoded.length ||
    (expectedBytes && decoded.length !== expectedBytes) ||
    decoded.toString('base64url') !== value
  ) {
    operationError('orchestration_operation_token_invalid');
  }
  return decoded;
}

function encryptClaims(claims) {
  const iv = crypto.randomBytes(NATIVE_OPERATION_IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', operationEncryptionKey(), iv, {
    authTagLength: NATIVE_OPERATION_TAG_BYTES,
  });
  cipher.setAAD(NATIVE_OPERATION_AAD);
  const ciphertext = Buffer.concat([cipher.update(stableJson(claims), 'utf8'), cipher.final()]);
  return {
    version: NATIVE_OPERATION_ENVELOPE_VERSION,
    algorithm: NATIVE_OPERATION_ENVELOPE_ALGORITHM,
    iv: iv.toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
  };
}

function decryptClaims(envelope) {
  assertExactKeys(envelope, NATIVE_OPERATION_ENVELOPE_KEYS);
  if (
    envelope.version !== NATIVE_OPERATION_ENVELOPE_VERSION ||
    envelope.algorithm !== NATIVE_OPERATION_ENVELOPE_ALGORITHM
  ) {
    operationError('orchestration_operation_token_invalid');
  }
  const iv = decodeEnvelopeBuffer(envelope.iv, NATIVE_OPERATION_IV_BYTES);
  const ciphertext = decodeEnvelopeBuffer(envelope.ciphertext);
  const tag = decodeEnvelopeBuffer(envelope.tag, NATIVE_OPERATION_TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', operationEncryptionKey(), iv, {
      authTagLength: NATIVE_OPERATION_TAG_BYTES,
    });
    decipher.setAAD(NATIVE_OPERATION_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      'utf8',
    );
    const claims = JSON.parse(plaintext);
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
      operationError('orchestration_operation_token_invalid');
    }
    assertExactKeys(claims, NATIVE_OPERATION_CLAIM_KEYS);
    return claims;
  } catch (error) {
    if (error instanceof NativeOrchestrationOperationError) throw error;
    operationError('orchestration_operation_token_invalid');
  }
}

function canonicalOperationArgs(toolName, args = {}) {
  return canonicalConversationOrchestrationArguments(toolName, args);
}

function prepareNativeOrchestrationOperation({
  grant,
  toolName,
  args = {},
  nowMs = Date.now(),
} = {}) {
  const cleanToolName = boundedString(toolName, 192);
  if (!isConversationOrchestrationMutationTool(cleanToolName)) {
    operationError('orchestration_operation_tool_unsupported');
  }
  const scope = operationScope(grant);
  assertOperationScope(scope);
  const canonicalArgs = canonicalOperationArgs(cleanToolName, args);
  const iat = Math.floor(Number(nowMs) / 1000);
  const grantExpiry = Number(grant?.exp);
  const exp = Math.min(
    iat + operationTtlSeconds(),
    Number.isFinite(grantExpiry) ? Math.floor(grantExpiry) : iat,
  );
  if (!Number.isFinite(iat) || exp <= iat) {
    operationError('orchestration_operation_scope_expired');
  }
  const claims = {
    aud: NATIVE_OPERATION_AUDIENCE,
    claims_version: NATIVE_OPERATION_CLAIMS_VERSION,
    ...scope,
    tool_name: cleanToolName,
    args_hash: hashCanonicalArgs(canonicalArgs),
    iat,
    exp,
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const envelope = encryptClaims(claims);
  return {
    status: 'prepared',
    reason: 'orchestration_operation_confirmation_required',
    tool: cleanToolName,
    retryable: true,
    expiresAt: exp,
    [NATIVE_OPERATION_TOKEN_FIELD]: encodeToken(envelope),
  };
}

function verifyNativeOrchestrationOperation({
  token,
  grant,
  toolName,
  args = {},
  nowMs = Date.now(),
} = {}) {
  const cleanToolName = boundedString(toolName, 192);
  if (!isConversationOrchestrationMutationTool(cleanToolName)) {
    operationError('orchestration_operation_tool_unsupported');
  }
  const normalizedToken = typeof token === 'string' ? token.trim() : '';
  const envelope = decodeToken(normalizedToken);
  const payload = decryptClaims(envelope);
  if (
    payload.aud !== NATIVE_OPERATION_AUDIENCE ||
    Number(payload.claims_version) !== NATIVE_OPERATION_CLAIMS_VERSION
  ) {
    operationError('orchestration_operation_token_invalid');
  }
  const nowSeconds = Math.floor(Number(nowMs) / 1000);
  const issuedAt = Number(payload.iat);
  const expiresAt = Number(payload.exp);
  if (
    !Number.isInteger(issuedAt) ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_NATIVE_OPERATION_TTL_SECONDS ||
    issuedAt > nowSeconds + 5
  ) {
    operationError('orchestration_operation_token_invalid');
  }
  if (expiresAt <= nowSeconds) {
    operationError('orchestration_operation_token_expired');
  }
  const scope = operationScope(grant);
  assertOperationScope(scope);
  const expectedBindings = {
    ...scope,
    tool_name: cleanToolName,
    args_hash: hashCanonicalArgs(canonicalOperationArgs(cleanToolName, args)),
  };
  if (
    Object.entries(expectedBindings).some(
      ([key, value]) => String(payload[key] || '') !== String(value || ''),
    )
  ) {
    operationError('orchestration_operation_token_binding_mismatch');
  }
  const invocationId = `ghno_${crypto
    .createHash('sha256')
    .update(stableJson(envelope), 'utf8')
    .digest('hex')}`;
  return {
    invocationId,
    operationId: invocationId,
    args: canonicalOperationArgs(cleanToolName, args),
  };
}

function nativeMutationInputSchema(baseSchema = {}) {
  return Object.freeze({
    ...baseSchema,
    properties: Object.freeze({
      ...(baseSchema.properties || {}),
      [NATIVE_OPERATION_TOKEN_FIELD]: Object.freeze({
        type: 'string',
        minLength: 1,
        maxLength: 8192,
        description:
          'Core-signed commit token returned by the first exact call. Repeat the same mutation arguments with this token to commit; never invent or alter it.',
      }),
    }),
  });
}

function operationTokenFromArgs(args = {}) {
  return boundedString(args?.[NATIVE_OPERATION_TOKEN_FIELD], 8192);
}

module.exports = {
  NATIVE_OPERATION_AUDIENCE,
  NATIVE_OPERATION_TOKEN_FIELD,
  NativeOrchestrationOperationError,
  nativeMutationInputSchema,
  operationTokenFromArgs,
  prepareNativeOrchestrationOperation,
  verifyNativeOrchestrationOperation,
};
