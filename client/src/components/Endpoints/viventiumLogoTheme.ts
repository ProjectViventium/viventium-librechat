import type { CSSProperties } from 'react';

/* === VIVENTIUM START ===
 * Feature: Viventium logo theme bridge
 * Purpose: The branded SVG contains light/dark variants; force the correct embedded
 * variant whenever the app theme is explicitly light or dark.
 * Source: docs/assets/favicon_viv/ copied to client/public/assets/logo.svg.
 */
export const VIVENTIUM_LOGO_ICON_URL = '/assets/logo.svg';

export const isViventiumLogoIconURL = (iconURL?: string | null) =>
  (iconURL ?? '') === VIVENTIUM_LOGO_ICON_URL;

export const getViventiumLogoColorScheme = (theme: string): CSSProperties['colorScheme'] => {
  if (theme === 'dark' || theme === 'light') {
    return theme;
  }

  return undefined;
};
/* === VIVENTIUM END === */
