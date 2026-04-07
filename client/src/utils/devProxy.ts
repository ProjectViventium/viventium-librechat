/* === VIVENTIUM START ===
 * Feature: Separate browser-facing public origins from the local Vite dev proxy target.
 *
 * Purpose:
 * - Keep `DOMAIN_SERVER` free to advertise the browser-visible public API origin while ensuring
 *   the local Vite dev server still proxies `/api/*` to the real local LibreChat backend.
 *
 * Why:
 * - Remote-access modes export public HTTPS/WSS origins for browsers.
 * - Feeding that public HTTPS API URL back into the local Vite proxy causes self-referential
 *   proxying and TLS trust failures instead of reaching the local backend directly.
 *
 * Details: docs/requirements_and_learnings/47_Remote_Access_and_Tunneling.md
 * Added: 2026-04-04
 */
export type RuntimeEnv = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['localhost', '::1']);

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '');
}

export function parsePortFromUrl(value: string | undefined) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.port ? Number(url.port) : undefined;
  } catch (_error) {
    return undefined;
  }
}

export function hostnameFromUrl(value: string | undefined) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  try {
    return new URL(value).hostname || undefined;
  } catch (_error) {
    return undefined;
  }
}

export function isLoopbackHostname(value: string | undefined) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  const hostname = value.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return LOOPBACK_HOSTS.has(hostname) || hostname.startsWith('127.');
}

function sanitizeUrl(value: string | undefined) {
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  return trimTrailingSlash(value);
}

function resolveExplicitBackendProxyTarget(env: RuntimeEnv) {
  const explicitTarget = sanitizeUrl(env.VIVENTIUM_FRONTEND_PROXY_TARGET);
  if (explicitTarget) {
    return explicitTarget;
  }

  const domainServer = sanitizeUrl(env.DOMAIN_SERVER);
  if (domainServer && isLoopbackHostname(hostnameFromUrl(domainServer))) {
    return domainServer;
  }

  return undefined;
}

function resolveExplicitBackendPort(env: RuntimeEnv) {
  const explicitPort = Number(env.BACKEND_PORT || env.VIVENTIUM_LC_API_PORT);
  return Number.isFinite(explicitPort) && explicitPort > 0 ? explicitPort : undefined;
}

export function resolveBackendUrl(env: RuntimeEnv) {
  const explicitTarget = resolveExplicitBackendProxyTarget(env);
  if (explicitTarget) {
    return explicitTarget;
  }

  const explicitPort = resolveExplicitBackendPort(env);
  const domainServer = sanitizeUrl(env.DOMAIN_SERVER);
  if (!explicitPort && domainServer) {
    return domainServer;
  }

  const backendPort = explicitPort ?? 3080;
  const devHost = env.HOST || 'localhost';
  const backendHost = devHost === '::' || devHost === '0.0.0.0' ? 'localhost' : devHost;
  const needsIpv6Brackets = backendHost.includes(':') && !isLoopbackHostname(backendHost);

  return needsIpv6Brackets
    ? `http://[${backendHost}]:${backendPort}`
    : `http://${backendHost}:${backendPort}`;
}

export function resolveAllowedHosts(env: RuntimeEnv) {
  const allowedHosts = new Set(
    String(env.VITE_ALLOWED_HOSTS || '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  );

  for (const candidate of [env.DOMAIN_CLIENT, env.VIVENTIUM_PUBLIC_CLIENT_URL]) {
    const hostname = hostnameFromUrl(candidate);
    if (hostname) {
      allowedHosts.add(hostname);
    }
  }

  return Array.from(allowedHosts);
}
/* === VIVENTIUM END === */
