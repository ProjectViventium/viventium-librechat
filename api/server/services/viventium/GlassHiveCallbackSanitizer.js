/* === VIVENTIUM START ===
 * Feature: Shared GlassHive callback evidence sanitization.
 * Purpose: Apply the same public-safe redaction before neutral status metadata, logs, or terminal
 * evidence reaches Main adjudication. Worker output is evidence, never direct assistant prose.
 * === VIVENTIUM END === */

const LOCAL_PATH_PATTERN =
  /(?:~\/|\/Users\/|\/home\/|\/private\/var\/|\/var\/folders\/|\/tmp\/|[A-Za-z]:\\Users\\)[^`'"<>\n\r]*?(?=$|[`'"<>\n\r]|[)\],.;:!?](?:\s|$)|\s+(?:and|or|from|at|with|then|while|because|but|plus|to|in|on)\b)/gi;
const SAFE_GLASSHIVE_LINK_PATTERN = /\[[^\]\n]{1,160}\]\((https?:\/\/[^)\s]+)\)/g;
const NON_USER_ARTIFACT_DIRS = new Set([
  '.codex',
  '.git',
  '.glasshive',
  '.venv',
  '__pycache__',
  'glasshive-host-tools',
  'node_modules',
]);
const NON_USER_ARTIFACT_FILES = new Set([
  '.mcp.json',
  'agents.md',
  'claude.md',
  'codex.md',
  'harness-prompt.md',
  'project-definition.md',
  'work-log.md',
]);

function isSafeGlassHiveActionUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const hostname = url.hostname.toLowerCase();
    const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname);
    const safeId = '[A-Za-z0-9_-]{1,128}';
    const isWatchLink =
      new RegExp(`^/watch/${safeId}$`).test(url.pathname) &&
      new RegExp(`^${safeId}$`).test(String(url.searchParams.get('project_id') || ''));
    const isSignedLink = new RegExp(`^/v1/signed-links/[A-Za-z0-9._-]{10,4096}$`).test(
      url.pathname,
    );
    const artifactPath = String(url.searchParams.get('path') || '').replace(/\\/g, '/');
    const segments = artifactPath.split('/').filter(Boolean);
    const artifactPathIsSafe =
      Boolean(artifactPath) &&
      artifactPath.length <= 1024 &&
      !artifactPath.startsWith('/') &&
      segments.length > 0 &&
      segments.every((segment) => segment !== '.' && segment !== '..' && !segment.startsWith('.')) &&
      !segments.some((segment) => NON_USER_ARTIFACT_DIRS.has(segment.toLowerCase())) &&
      !NON_USER_ARTIFACT_FILES.has(segments[segments.length - 1]?.toLowerCase());
    const isArtifact =
      isLocalHost &&
      (new RegExp(`^/v1/workers/${safeId}/artifacts/open$`).test(url.pathname) ||
        new RegExp(`^/v1/workers/${safeId}/artifacts/download$`).test(url.pathname)) &&
      artifactPathIsSafe;
    if (isLocalHost) return isWatchLink || isSignedLink || isArtifact;
    return (isWatchLink && url.searchParams.has('gh_token')) || isSignedLink;
  } catch {
    return false;
  }
}

function sanitizeGlassHiveCallbackText(value, { maxLength = 4000 } = {}) {
  const links = [];
  let text = String(value || '')
    .trim()
    .replace(SAFE_GLASSHIVE_LINK_PATTERN, (match, url) => {
      if (!isSafeGlassHiveActionUrl(url)) return match;
      const token = `__VIVENTIUM_SAFE_GLASSHIVE_LINK_${links.length}__`;
      links.push({ token, value: match });
      return token;
    });
  if (!text) return '';
  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [secret]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\b\s*[:=]\s*['"]?[A-Za-z0-9._~+/=-]{12,}['"]?/gi,
      (_match, label) => `${label}=[secret]`,
    )
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret]')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s)`'"<>]*/gi, '[local worker link]')
    .replace(LOCAL_PATH_PATTERN, '[local path]')
    .replace(/\]\(\[local path\](?!\))/g, ']([local path])')
    .replace(/\bwrk[_-][A-Za-z0-9_-]+\b/g, '[worker id]')
    .replace(/\brun[_-][A-Za-z0-9_-]+\b/g, '[run id]')
    .replace(/\bprj[_-][A-Za-z0-9_-]+\b/g, '[project id]')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => {
      const leadingWhitespace = line.match(/^[ \t]*/)?.[0] ?? '';
      const body = line.slice(leadingWhitespace.length).replace(/[ \t]+/g, ' ');
      return `${leadingWhitespace}${body}`.trimEnd();
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  for (const { token, value: link } of links) text = text.replace(token, link);
  if (maxLength && text.length > maxLength) return `${text.slice(0, maxLength - 3).trim()}...`;
  return text;
}

module.exports = { isSafeGlassHiveActionUrl, sanitizeGlassHiveCallbackText };
