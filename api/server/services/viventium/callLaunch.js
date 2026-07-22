/* === VIVENTIUM START ===
 * Purpose: Shared playground launch helpers for Viventium call surfaces.
 * Feature: Reuse one browser-facing call deep-link contract across web and Telegram.
 * === VIVENTIUM END === */

const DEFAULT_PLAYGROUND_URL = 'http://localhost:3000';
const DEFAULT_VOICE_AGENT_NAME = 'librechat-voice-gateway';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const PLAYGROUND_HEALTH_TIMEOUT_MS = 2000;
const MAX_PLAYGROUND_HEALTH_BODY_LENGTH = 64 * 1024;
const SOURCE_REF_PATTERN = /^[0-9a-f]{40}$/;

function trimBaseUrl(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim().replace(/\/+$/, '');
}

function parseBaseUrl(value) {
  const trimmed = trimBaseUrl(value);
  if (!trimmed) {
    return null;
  }

  try {
    return new URL(trimmed);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTNAMES.has(
    String(hostname || '')
      .trim()
      .toLowerCase(),
  );
}

function normalizeLocalPlaygroundBaseUrl(baseUrl) {
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed) {
    return DEFAULT_PLAYGROUND_URL;
  }

  if (isLocalHostname(parsed.hostname)) {
    return trimBaseUrl(parsed.toString());
  }

  parsed.hostname = 'localhost';
  return trimBaseUrl(parsed.toString());
}

function resolvePlaygroundBaseUrl({ preferPublicPlayground = false } = {}) {
  const publicPlaygroundBase = trimBaseUrl(process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL || '');
  const defaultPlaygroundBase = trimBaseUrl(
    process.env.VIVENTIUM_PLAYGROUND_URL || DEFAULT_PLAYGROUND_URL,
  );

  if (preferPublicPlayground) {
    return publicPlaygroundBase || normalizeLocalPlaygroundBaseUrl(defaultPlaygroundBase);
  }

  return defaultPlaygroundBase || DEFAULT_PLAYGROUND_URL;
}

function resolveTelegramPublicPlaygroundBaseUrl() {
  const parsed = parseBaseUrl(process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL || '');
  if (!parsed) {
    return '';
  }

  if (parsed.protocol !== 'https:' || isLocalHostname(parsed.hostname)) {
    return '';
  }

  return trimBaseUrl(parsed.toString());
}

/* === VIVENTIUM START ===
 * Purpose: Prefer public playground links only for requests already coming through
 * the configured public browser origins, while keeping localhost links for same-Mac use.
 * === VIVENTIUM END === */
function resolveConfiguredBrowserOrigins() {
  return [
    process.env.VIVENTIUM_PUBLIC_CLIENT_URL,
    process.env.VIVENTIUM_PUBLIC_SERVER_URL,
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL,
  ]
    .map((value) => parseBaseUrl(value))
    .filter((value) => value && value.protocol === 'https:' && !isLocalHostname(value.hostname))
    .map((value) => value.origin);
}

function extractRequestOrigins(req) {
  const values = [];
  const origin = req?.get?.('origin') || req?.headers?.origin || '';
  const referer = req?.get?.('referer') || req?.get?.('referrer') || '';
  const forwardedProto = req?.get?.('x-forwarded-proto') || '';
  const host = req?.get?.('host') || req?.headers?.host || '';
  const protocol = forwardedProto || req?.protocol || '';

  if (origin) {
    values.push(origin);
  }
  if (referer) {
    values.push(referer);
  }
  if (protocol && host) {
    values.push(`${protocol}://${host}`);
  }

  return values
    .map((value) => parseBaseUrl(value))
    .filter(Boolean)
    .map((value) => value.origin);
}

function shouldPreferPublicPlaygroundForRequest(req) {
  if (!resolveTelegramPublicPlaygroundBaseUrl()) {
    return false;
  }

  const configuredOrigins = new Set(resolveConfiguredBrowserOrigins());
  if (configuredOrigins.size === 0) {
    return false;
  }

  return extractRequestOrigins(req).some((origin) => configuredOrigins.has(origin));
}

/* === VIVENTIUM START ===
 * Feature: Voice readiness and runtime identity guard.
 * Purpose: Fail closed unless the configured voice surface proves it is the selected Viventium
 * playground variant built from the exact expected component commit.
 * === VIVENTIUM END === */
function resolveExpectedPlaygroundIdentity() {
  const configuredVariant = String(process.env.PLAYGROUND_VARIANT || '')
    .trim()
    .toLowerCase();
  const variant = configuredVariant === 'classic' ? 'classic' : 'modern';
  const sourceRef = String(process.env.VIVENTIUM_PLAYGROUND_SOURCE_REF || '')
    .trim()
    .toLowerCase();

  if (!SOURCE_REF_PATTERN.test(sourceRef)) {
    return null;
  }

  return {
    schema_version: 1,
    product: 'viventium-playground',
    status: 'ok',
    surface: `${variant}-playground`,
    variant,
    source_ref: sourceRef,
  };
}

function matchesExpectedPlaygroundIdentity(payload, expected) {
  return (
    payload != null &&
    typeof payload === 'object' &&
    Object.entries(expected).every(([key, value]) => payload[key] === value)
  );
}

function contentLengthIsInvalidOrOversized(response) {
  const rawLength = response?.headers?.get?.('content-length');
  if (rawLength == null || rawLength === '') {
    return false;
  }
  if (!/^\d+$/.test(rawLength)) {
    return true;
  }
  const length = Number(rawLength);
  return !Number.isSafeInteger(length) || length > MAX_PLAYGROUND_HEALTH_BODY_LENGTH;
}

async function readBoundedPlaygroundHealthBody(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    return null;
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let body = '';
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!(value instanceof Uint8Array)) {
        await reader.cancel().catch(() => {});
        return null;
      }
      bytesRead += value.byteLength;
      if (bytesRead > MAX_PLAYGROUND_HEALTH_BODY_LENGTH) {
        await reader.cancel().catch(() => {});
        return null;
      }
      try {
        body += decoder.decode(value, { stream: true });
      } catch {
        await reader.cancel().catch(() => {});
        return null;
      }
    }
    try {
      body += decoder.decode();
    } catch {
      return null;
    }
    return body;
  } finally {
    reader.releaseLock?.();
  }
}

async function verifyPlaygroundReadiness({ preferPublicPlayground = false } = {}) {
  const expected = resolveExpectedPlaygroundIdentity();
  if (!expected) {
    return { ready: false, reason: 'playground_source_unavailable' };
  }

  const baseUrl = resolvePlaygroundBaseUrl({ preferPublicPlayground });
  let healthUrl;
  try {
    healthUrl = new URL('/api/health', `${baseUrl}/`).toString();
  } catch {
    return { ready: false, reason: 'playground_configuration_invalid' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PLAYGROUND_HEALTH_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ready: false, reason: 'playground_unhealthy' };
    }

    if (contentLengthIsInvalidOrOversized(response)) {
      return { ready: false, reason: 'playground_identity_mismatch' };
    }

    const body = await readBoundedPlaygroundHealthBody(response);
    if (body == null) {
      return { ready: false, reason: 'playground_identity_mismatch' };
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ready: false, reason: 'playground_identity_mismatch' };
    }

    if (!matchesExpectedPlaygroundIdentity(payload, expected)) {
      return { ready: false, reason: 'playground_identity_mismatch' };
    }

    return { ready: true };
  } catch {
    return { ready: false, reason: 'playground_unreachable' };
  } finally {
    clearTimeout(timeout);
  }
}
/* === VIVENTIUM END === */

function resolveVoiceAgentName() {
  return (
    trimBaseUrl(process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME || '') || DEFAULT_VOICE_AGENT_NAME
  );
}

function buildPlaygroundUrl(
  session,
  { preferPublicPlayground = false, voiceAgentName = resolveVoiceAgentName() } = {},
) {
  const playgroundBase = resolvePlaygroundBaseUrl({ preferPublicPlayground });
  const url = new URL(playgroundBase);

  url.searchParams.set('roomName', session.roomName);
  url.searchParams.set('callSessionId', session.callSessionId);
  url.searchParams.set('agentName', voiceAgentName);
  url.searchParams.set('autoConnect', '1');

  return url.toString();
}

function buildCallLaunchResponse(session, options = {}) {
  const playgroundUrl = buildPlaygroundUrl(session, options);

  return {
    callSessionId: session.callSessionId,
    conversationId: session.conversationId,
    roomName: session.roomName,
    requestedVoiceRoute: session.requestedVoiceRoute,
    playgroundUrl,
    callUrl: playgroundUrl,
  };
}

module.exports = {
  buildCallLaunchResponse,
  buildPlaygroundUrl,
  resolvePlaygroundBaseUrl,
  verifyPlaygroundReadiness,
  shouldPreferPublicPlaygroundForRequest,
  resolveTelegramPublicPlaygroundBaseUrl,
  resolveVoiceAgentName,
};
