/* === VIVENTIUM START ===
 * Purpose: Shared playground launch helpers for Viventium call surfaces.
 * Feature: Reuse one browser-facing call deep-link contract across web and Telegram.
 * === VIVENTIUM END === */

const DEFAULT_PLAYGROUND_URL = 'http://localhost:3000';
const DEFAULT_VOICE_AGENT_NAME = 'librechat-voice-gateway';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

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
  return LOCAL_HOSTNAMES.has(String(hostname || '').trim().toLowerCase());
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

function resolveVoiceAgentName() {
  return (
    trimBaseUrl(process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME || '') ||
    DEFAULT_VOICE_AGENT_NAME
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
  shouldPreferPublicPlaygroundForRequest,
  resolveTelegramPublicPlaygroundBaseUrl,
  resolveVoiceAgentName,
};
