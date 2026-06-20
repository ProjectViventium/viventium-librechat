/* === VIVENTIUM START ===
 * Feature: User-facing GlassHive signed-link hygiene.
 * Purpose: Accessibility/live-region text is user-facing; preserve useful labels while removing
 * signed URL/token material from hidden announcements and offscreen text.
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\(([^)\s]+(?:\s+"[^"]*")?)\)/g;
const SIGNED_GLASSHIVE_URL_PATTERN =
  /https?:\/\/[^\s<>)"']*(?:\/v1\/signed-links\/|[?&](?:gh_token|ghtoken|token)=)[^\s<>)"']*/gi;
const SIGNED_PATH_PATTERN =
  /\/v1\/signed-links\/[^\s<>)"']+|([?&](?:gh_token|ghtoken|token)=)[^\s<>)"']+/gi;

const isSensitiveGlassHiveUrl = (url: string) =>
  /\/v1\/signed-links\//i.test(url) || /[?&](?:gh_token|ghtoken|token)=/i.test(url);

export const sanitizeLiveAnnouncementText = (message: string) =>
  message
    .replace(MARKDOWN_LINK_PATTERN, (_match, label: string, url: string) =>
      isSensitiveGlassHiveUrl(url) ? label : _match,
    )
    .replace(SIGNED_GLASSHIVE_URL_PATTERN, '[signed link]')
    .replace(SIGNED_PATH_PATTERN, (_match, tokenPrefix: string | undefined) =>
      tokenPrefix ? `${tokenPrefix}[redacted]` : '/v1/signed-links/[redacted]',
    );
/* === VIVENTIUM END === */
