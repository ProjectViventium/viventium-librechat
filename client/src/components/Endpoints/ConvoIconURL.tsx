import { memo, useMemo } from 'react';
import { URLIcon } from '~/components/Endpoints/URLIcon';
import { icons } from '~/hooks/Endpoint/Icons';

interface ConvoIconURLProps {
  iconURL?: string;
  modelLabel?: string | null;
  endpointIconURL?: string;
  assistantName?: string;
  agentName?: string;
  context?: 'landing' | 'menu-item' | 'nav' | 'message';
  assistantAvatar?: string;
  agentAvatar?: string;
}

const classMap = {
  'menu-item': 'relative flex h-full items-center justify-center overflow-hidden rounded-full',
  message: 'icon-md',
  default: 'icon-xl relative flex h-full overflow-hidden rounded-full',
};

const styleMap = {
  'menu-item': { width: '20px', height: '20px' },
  default: { width: '100%', height: '100%' },
};

const styleImageMap = {
  default: { width: '100%', height: '100%' },
};

const ConvoIconURL: React.FC<ConvoIconURLProps> = ({
  iconURL = '',
  modelLabel = '',
  endpointIconURL,
  assistantAvatar,
  assistantName,
  agentAvatar,
  agentName,
  context,
}) => {
  /* === VIVENTIUM START ===
   * Feature: Avatar-first icon resolution for agent/assistant conversations.
   * Purpose: Prevent stale persisted `iconURL` values (e.g., old cloud-hosted URLs)
   * from breaking chat icons when a current local avatar is available.
   * Added: 2026-03-05
   */
  const resolvedIconURL = useMemo(
    () => assistantAvatar || agentAvatar || iconURL,
    [assistantAvatar, agentAvatar, iconURL],
  );
  /* === VIVENTIUM END === */

  const Icon = useMemo(() => icons[resolvedIconURL] ?? icons.unknown, [resolvedIconURL]);
  const isURL = useMemo(
    () =>
      !!(
        resolvedIconURL &&
        (resolvedIconURL.includes('http') || resolvedIconURL.startsWith('/images/'))
      ),
    [resolvedIconURL],
  );
  if (isURL) {
    return (
      <URLIcon
        iconURL={resolvedIconURL}
        altName={modelLabel}
        className={classMap[context ?? 'default'] ?? classMap.default}
        containerStyle={styleMap[context ?? 'default'] ?? styleMap.default}
        imageStyle={styleImageMap[context ?? 'default'] ?? styleImageMap.default}
      />
    );
  }

  return (
    <div className="shadow-stroke relative flex h-full items-center justify-center rounded-full bg-white text-black">
      {Icon && (
        <Icon
          size={41}
          context={context}
          className="h-2/3 w-2/3"
          agentName={agentName}
          iconURL={endpointIconURL}
          assistantName={assistantName}
          avatar={assistantAvatar || agentAvatar}
        />
      )}
    </div>
  );
};

export default memo(ConvoIconURL);
