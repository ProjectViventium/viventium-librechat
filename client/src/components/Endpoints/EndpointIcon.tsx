import { getEndpointField, isAssistantsEndpoint, isAgentsEndpoint } from 'librechat-data-provider';
import type {
  TPreset,
  TConversation,
  TAssistantsMap,
  TAgentsMap,
  TEndpointsConfig,
} from 'librechat-data-provider';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import MinimalIcon from '~/components/Endpoints/MinimalIcon';
import { useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { getIconEndpoint } from '~/utils';

export default function EndpointIcon({
  conversation,
  endpointsConfig,
  className = 'mr-0',
  assistantMap,
  agentsMap,
  context,
}: {
  conversation: TConversation | TPreset | null;
  endpointsConfig: TEndpointsConfig;
  containerClassName?: string;
  context?: 'message' | 'nav' | 'landing' | 'menu-item';
  assistantMap?: TAssistantsMap;
  agentsMap?: TAgentsMap;
  className?: string;
  size?: number;
}) {
  /* === VIVENTIUM START ===
   * Feature: Agent avatar parity in endpoint icon rendering.
   * Purpose: Ensure agent conversations resolve icon fallback from live agent avatars
   * instead of relying on persisted `conversation.iconURL` values that can go stale.
   * Added: 2026-03-05
   */
  const assistantsMapFromContext = useAssistantsMapContext();
  const agentsMapFromContext = useAgentsMapContext();
  const resolvedAssistantMap = assistantMap ?? assistantsMapFromContext;
  const resolvedAgentsMap = agentsMap ?? agentsMapFromContext;
  /* === VIVENTIUM END === */

  const convoIconURL = conversation?.iconURL ?? '';
  let endpoint = conversation?.endpoint;
  endpoint = getIconEndpoint({ endpointsConfig, iconURL: convoIconURL, endpoint });

  const endpointType = getEndpointField(endpointsConfig, endpoint, 'type');
  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');

  const assistant = isAssistantsEndpoint(endpoint)
    ? resolvedAssistantMap?.[endpoint]?.[conversation?.assistant_id ?? '']
    : null;
  const assistantAvatar = (assistant && (assistant.metadata?.avatar as string)) || '';
  const assistantName = assistant && (assistant.name ?? '');

  const agent = isAgentsEndpoint(endpoint)
    ? resolvedAgentsMap?.[conversation?.agent_id ?? '']
    : null;
  const agentAvatar = agent?.avatar?.filepath ?? '';
  const agentName = agent?.name ?? '';

  /* === VIVENTIUM START ===
   * Feature: Avoid stale conversation icon URLs for non-agent endpoints
   * Purpose:
   * - Legacy conversations can carry old agent avatar URLs even when endpoint is model-based
   *   (e.g., xai), which renders red error badges in the sidebar.
   * - For non-agent/assistant endpoints, rely on endpoint icons instead of persisted convo iconURL.
   * Added: 2026-03-05
   */
  const allowConvoIconURL = isAssistantsEndpoint(endpoint) || isAgentsEndpoint(endpoint);
  const iconURL = assistantAvatar || agentAvatar || (allowConvoIconURL ? convoIconURL : '');
  /* === VIVENTIUM END === */

  if (iconURL && (iconURL.includes('http') || iconURL.startsWith('/images/'))) {
    return (
      <ConvoIconURL
        iconURL={iconURL}
        modelLabel={conversation?.chatGptLabel ?? conversation?.modelLabel ?? ''}
        context={context}
        endpointIconURL={endpointIconURL}
        assistantAvatar={assistantAvatar}
        assistantName={assistantName ?? ''}
        agentAvatar={agentAvatar}
        agentName={agentName}
      />
    );
  } else {
    return (
      <MinimalIcon
        size={20}
        iconURL={endpointIconURL}
        endpoint={endpoint}
        endpointType={endpointType}
        model={conversation?.model}
        error={false}
        className={className}
        isCreatedByUser={false}
        chatGptLabel={undefined}
        modelLabel={undefined}
      />
    );
  }
}
