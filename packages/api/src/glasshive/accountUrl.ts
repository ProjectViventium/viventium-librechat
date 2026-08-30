/* === VIVENTIUM START ===
 * Feature: Same-origin GlassHive account API URL construction.
 * Purpose: Prevent an account path from redirecting owner authorization headers away from the
 * configured provider origin or escaping its configured base directory.
 * === VIVENTIUM END === */

export function glassHiveAccountUrl(configuredBaseUrl: string, path: string): string {
  let base: URL;
  try {
    base = new URL(configuredBaseUrl);
  } catch {
    throw new Error('glasshive_account_base_url_invalid');
  }

  if (!['http:', 'https:'].includes(base.protocol) || base.search !== '' || base.hash !== '') {
    throw new Error('glasshive_account_base_url_invalid');
  }

  const normalizedPath = String(path || '');
  if (!normalizedPath.startsWith('/v1/')) {
    throw new Error('glasshive_account_path_invalid');
  }

  const relativePath = normalizedPath.slice(4);
  if (relativePath.startsWith('/') || relativePath.includes('\\')) {
    throw new Error('glasshive_account_path_invalid');
  }

  if (!base.pathname.endsWith('/')) {
    base.pathname = `${base.pathname}/`;
  }

  const resolved = new URL(relativePath, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new Error('glasshive_account_path_invalid');
  }

  return resolved.toString();
}
