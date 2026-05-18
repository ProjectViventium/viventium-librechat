import { EModelEndpoint } from 'librechat-data-provider';
import {
  GPTIcon,
  Sparkles,
  BedrockIcon,
  AssistantIcon,
  AnthropicIcon,
  AzureMinimalIcon,
  GoogleMinimalIcon,
  CustomMinimalIcon,
} from '@librechat/client';
import type { IconMapProps, AgentIconMapProps, IconsRecord } from '~/common';
import ViventiumLogoIcon from '~/components/Endpoints/ViventiumLogoIcon';
import { VIVENTIUM_LOGO_ICON_URL } from '~/components/Endpoints/viventiumLogoTheme';
import UnknownIcon from './UnknownIcon';
import { cn } from '~/utils';

const AssistantAvatar = ({
  className = '',
  assistantName = '',
  avatar = '',
  context,
  size,
}: IconMapProps) => {
  if (assistantName && avatar) {
    return (
      <img
        src={avatar}
        className="bg-token-surface-secondary dark:bg-token-surface-tertiary h-full w-full rounded-full object-cover"
        alt={assistantName}
        width="80"
        height="80"
      />
    );
  } else if (assistantName) {
    return <AssistantIcon className={cn('text-token-secondary', className)} size={size} />;
  }

  return <Sparkles className={cn(context === 'landing' ? 'icon-2xl' : '', className)} />;
};

const AgentAvatar = ({
  className = '',
  avatar = '',
  agentName,
  size,
  iconURL = VIVENTIUM_LOGO_ICON_URL,
}: AgentIconMapProps) => {
  if (agentName != null && agentName && avatar) {
    return (
      <img
        src={avatar}
        className="bg-token-surface-secondary dark:bg-token-surface-tertiary h-full w-full rounded-full object-cover"
        alt={agentName}
        width="80"
        height="80"
      />
    );
  }

  /* === VIVENTIUM START ===
   * Feature: Viventium-branded agent icon fallback
   * Purpose: Missing agent avatars should show the Viventium mark, not LibreChat's feather.
   */
  return (
    <ViventiumLogoIcon
      src={iconURL}
      alt={agentName || 'Viventium'}
      className={cn(agentName === '' ? 'icon-2xl' : '', className)}
      style={size != null ? { width: size, height: size } : undefined}
    />
  );
  /* === VIVENTIUM END === */
};

const Bedrock = ({ className = '' }: IconMapProps) => {
  return <BedrockIcon className={cn(className, 'h-full w-full')} />;
};

export const icons: IconsRecord = {
  [EModelEndpoint.azureOpenAI]: AzureMinimalIcon,
  [EModelEndpoint.openAI]: GPTIcon,
  [EModelEndpoint.anthropic]: AnthropicIcon,
  [EModelEndpoint.google]: GoogleMinimalIcon,
  [EModelEndpoint.custom]: CustomMinimalIcon,
  [EModelEndpoint.assistants]: AssistantAvatar,
  [EModelEndpoint.azureAssistants]: AssistantAvatar,
  [EModelEndpoint.agents]: AgentAvatar,
  [EModelEndpoint.bedrock]: Bedrock,
  unknown: UnknownIcon,
};
