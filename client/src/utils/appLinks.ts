/** Keep links to the configured installation on the origin where the user signed in. */
export function resolveAppLink(
  href: string,
  configuredOrigin?: string,
  activeOrigin?: string,
): string {
  if (!configuredOrigin || !activeOrigin) return href;
  try {
    const target = new URL(href);
    const configured = new URL(configuredOrigin);
    const active = new URL(activeOrigin);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      !['http:', 'https:'].includes(active.protocol) ||
      target.username ||
      target.password ||
      target.origin !== configured.origin ||
      target.origin === active.origin
    )
      return href;
    return `${active.origin}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return href;
  }
}
