import React, { memo, useContext } from 'react';
import { ThemeContext } from '@librechat/client';
import cn from '~/utils/cn';
import { VIVENTIUM_LOGO_ICON_URL, getViventiumLogoColorScheme } from './viventiumLogoTheme';

/* === VIVENTIUM START ===
 * Feature: Viventium-branded agent icon fallback
 * Purpose: Agent/model surfaces must never fall back to LibreChat's generic feather mark.
 * Source: docs/assets/favicon_viv/ copied to client/public/assets/logo.svg.
 */
type ViventiumLogoIconProps = {
  alt?: string;
  className?: string;
  src?: string;
  style?: React.CSSProperties;
};

const ViventiumLogoIcon = ({
  alt = 'Viventium',
  className = '',
  src = VIVENTIUM_LOGO_ICON_URL,
  style,
}: ViventiumLogoIconProps) => {
  const { theme } = useContext(ThemeContext);
  const colorScheme = getViventiumLogoColorScheme(theme);
  const logoStyle = colorScheme != null ? { ...style, colorScheme } : style;

  return (
    <img
      src={src || VIVENTIUM_LOGO_ICON_URL}
      alt={alt}
      className={cn('object-cover', className)}
      style={logoStyle}
      loading="lazy"
      decoding="async"
    />
  );
};
/* === VIVENTIUM END === */

export default memo(ViventiumLogoIcon);
