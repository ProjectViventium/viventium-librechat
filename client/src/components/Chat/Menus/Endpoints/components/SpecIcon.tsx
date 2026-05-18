import React, { memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { TModelSpec, TEndpointsConfig } from 'librechat-data-provider';
import type { IconMapProps } from '~/common';
import { getModelSpecIconURL, getIconKey } from '~/utils';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { icons } from '~/hooks/Endpoint/Icons';

interface SpecIconProps {
  currentSpec: TModelSpec;
  endpointsConfig: TEndpointsConfig;
}

type IconType = (props: IconMapProps) => React.JSX.Element;

/* === VIVENTIUM START ===
 * Feature: Viventium model-spec icon rendering
 * Purpose: Treat configured asset paths like /assets/logo.svg as images instead of falling through
 * to LibreChat's built-in agent feather icon.
 */
const imageIconPattern =
  /^(?:https?:\/\/|data:image\/|\/|assets\/|.*\.(?:svg|png|jpe?g|webp|gif|ico)(?:\?.*)?$)/i;

function isImageIconURL(iconURL: string) {
  return iconURL !== '' && icons[iconURL] == null && imageIconPattern.test(iconURL);
}
/* === VIVENTIUM END === */

const SpecIcon: React.FC<SpecIconProps> = ({ currentSpec, endpointsConfig }) => {
  const iconURL = getModelSpecIconURL(currentSpec);
  const { endpoint } = currentSpec.preset;
  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');
  const iconKey = getIconKey({ endpoint, endpointsConfig, endpointIconURL });
  let Icon: IconType;

  if (isImageIconURL(iconURL)) {
    return (
      <URLIcon
        iconURL={iconURL}
        altName={currentSpec.name}
        containerStyle={{ width: 20, height: 20 }}
        className="icon-md shrink-0 overflow-hidden rounded-full"
        endpoint={endpoint || undefined}
      />
    );
  }

  if (!iconURL.includes('http')) {
    Icon = (icons[iconURL] ?? icons[iconKey] ?? icons.unknown) as IconType;
  } else if (iconURL) {
    return (
      <URLIcon
        iconURL={iconURL}
        altName={currentSpec.name}
        containerStyle={{ width: 20, height: 20 }}
        className="icon-md shrink-0 overflow-hidden rounded-full"
        endpoint={endpoint || undefined}
      />
    );
  } else {
    Icon = (icons[endpoint ?? ''] ?? icons[iconKey] ?? icons.unknown) as IconType;
  }

  return (
    <Icon
      size={20}
      endpoint={endpoint}
      context="menu-item"
      iconURL={endpointIconURL}
      className="icon-md shrink-0 text-text-primary"
    />
  );
};

export default memo(SpecIcon);
