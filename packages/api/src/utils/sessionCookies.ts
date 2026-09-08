import { isEnabled } from './common';

/** Keep side-by-side development sessions out of the daily app's host-wide cookies. */
export function getSessionCookieName(name: string): string {
  if (!isEnabled(process.env.VIVENTIUM_DEV_ENV_ENABLED)) {
    return name;
  }
  const scope = process.env.VIVENTIUM_DEV_ENV_NAME;
  if (
    !scope ||
    scope.trim() !== scope ||
    scope === '.' ||
    scope === '..' ||
    scope.includes('/') ||
    scope.includes('\0')
  ) {
    throw new Error('Development session cookies require a valid environment name.');
  }
  return `viventium_dev_${Buffer.from(scope).toString('hex')}_${name}`;
}
