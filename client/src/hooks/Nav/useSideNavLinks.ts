import { useMemo, useRef } from 'react';
/* === VIVENTIUM START ===
 * Feature: Feelings discovery in ordinary chat controls.
 * Purpose: Reuse the existing route and design-system icon from the right-side navigation.
 */
import { useNavigate } from 'react-router-dom';
import { Blocks, MCPIcon, AttachmentIcon } from '@librechat/client';
import {
  Database,
  Bookmark,
  Settings2,
  HeartPulse,
  ListTodo,
  ArrowRightToLine,
  MessageSquareQuote,
} from 'lucide-react';
/* === VIVENTIUM END === */
import {
  Permissions,
  EModelEndpoint,
  PermissionTypes,
  isParamEndpoint,
  isAgentsEndpoint,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import type { TInterfaceConfig, TEndpointsConfig } from 'librechat-data-provider';
import MCPBuilderPanel from '~/components/SidePanel/MCPBuilder/MCPBuilderPanel';
import type { NavLink } from '~/common';
import AgentPanelSwitch from '~/components/SidePanel/Agents/AgentPanelSwitch';
import BookmarkPanel from '~/components/SidePanel/Bookmarks/BookmarkPanel';
import PanelSwitch from '~/components/SidePanel/Builder/PanelSwitch';
import PromptsAccordion from '~/components/Prompts/PromptsAccordion';
import Parameters from '~/components/SidePanel/Parameters/Panel';
import { MemoryPanel } from '~/components/SidePanel/Memories';
import FilesPanel from '~/components/SidePanel/Files/Panel';
/* === VIVENTIUM START ===
 * Feature: Active work in the Control Panel.
 * Purpose: Keep live mission status and controls beside the conversation instead of in Account settings.
 */
import ActiveWorkPanel from '~/components/SidePanel/ActiveWork/ActiveWorkPanel';
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Feature: Feelings discovery in ordinary chat controls.
 * Purpose: Keep navigation availability aligned with the compiled startup-config gate.
 */
import { useGetStartupConfig } from '~/data-provider';
/* === VIVENTIUM END === */
/* === VIVENTIUM START ===
 * Feature: Active work in the Control Panel.
 * Purpose: Keep the entry dark when unavailable while preserving access to durable existing work.
 */
import { useOrchestrationPreferenceQuery } from '~/data-provider/ViventiumOrchestration';
/* === VIVENTIUM END === */
import { useHasAccess, useMCPServerManager } from '~/hooks';

export default function useSideNavLinks({
  hidePanel,
  keyProvided,
  endpoint,
  endpointType,
  interfaceConfig,
  endpointsConfig,
}: {
  hidePanel: () => void;
  keyProvided: boolean;
  endpoint?: EModelEndpoint | null;
  endpointType?: EModelEndpoint | null;
  interfaceConfig: Partial<TInterfaceConfig>;
  endpointsConfig: TEndpointsConfig;
}) {
  /* === VIVENTIUM START ===
   * Feature: Feelings discovery in ordinary chat controls.
   * Purpose: Expose the existing immersive route without leaving a dead entry when disabled.
   */
  const navigate = useNavigate();
  const { data: startupConfig } = useGetStartupConfig();
  const feelingsAvailable = startupConfig?.viventiumFeelingsAvailable !== false;
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Active work in the Control Panel.
   * Purpose: A disabled admission gate must not hide work that already exists. Once revealed,
   * retain the entry for this mounted session so dismissing the final item does not move the nav.
   */
  const parallelWorkAvailable =
    (startupConfig as { viventiumParallelWorkAvailable?: boolean } | undefined)
      ?.viventiumParallelWorkAvailable === true;
  const orchestrationPreference = useOrchestrationPreferenceQuery({
    enabled: !parallelWorkAvailable,
  });
  const activeWorkWasVisible = useRef(false);
  if (parallelWorkAvailable || orchestrationPreference.data?.hasKnownWork === true) {
    activeWorkWasVisible.current = true;
  }
  const showActiveWork = activeWorkWasVisible.current;
  /* === VIVENTIUM END === */
  const hasAccessToPrompts = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.USE,
  });
  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });
  const hasAccessToMemories = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.USE,
  });
  const hasAccessToReadMemories = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });
  const hasAccessToAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateAgents = useHasAccess({
    permissionType: PermissionTypes.AGENTS,
    permission: Permissions.CREATE,
  });
  const hasAccessToUseMCPSettings = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.USE,
  });
  const hasAccessToCreateMCP = useHasAccess({
    permissionType: PermissionTypes.MCP_SERVERS,
    permission: Permissions.CREATE,
  });
  const { availableMCPServers } = useMCPServerManager();

  const Links = useMemo(() => {
    const links: NavLink[] = [];
    if (
      isAssistantsEndpoint(endpoint) &&
      ((endpoint === EModelEndpoint.assistants &&
        endpointsConfig?.[EModelEndpoint.assistants] &&
        endpointsConfig[EModelEndpoint.assistants].disableBuilder !== true) ||
        (endpoint === EModelEndpoint.azureAssistants &&
          endpointsConfig?.[EModelEndpoint.azureAssistants] &&
          endpointsConfig[EModelEndpoint.azureAssistants].disableBuilder !== true)) &&
      keyProvided
    ) {
      links.push({
        title: 'com_sidepanel_assistant_builder',
        label: '',
        icon: Blocks,
        id: EModelEndpoint.assistants,
        Component: PanelSwitch,
      });
    }

    if (
      endpointsConfig?.[EModelEndpoint.agents] &&
      hasAccessToAgents &&
      hasAccessToCreateAgents &&
      endpointsConfig[EModelEndpoint.agents].disableBuilder !== true
    ) {
      links.push({
        title: 'com_sidepanel_agent_builder',
        label: '',
        icon: Blocks,
        id: EModelEndpoint.agents,
        Component: AgentPanelSwitch,
      });
    }

    /* === VIVENTIUM START ===
     * Feature: Active work in the Control Panel.
     * Purpose: Existing work must stay reachable even when new Parallel admission is unavailable.
     */
    if (showActiveWork) {
      links.push({
        title: 'com_ui_parallel_work_active',
        label: '',
        icon: ListTodo,
        id: 'active-work',
        Component: ActiveWorkPanel,
      });
    }
    /* === VIVENTIUM END === */

    if (hasAccessToPrompts) {
      links.push({
        title: 'com_ui_prompts',
        label: '',
        icon: MessageSquareQuote,
        id: 'prompts',
        Component: PromptsAccordion,
      });
    }

    /* === VIVENTIUM START ===
     * Feature: Feelings discovery in ordinary chat controls.
     * Purpose: Route to the existing authenticated Feelings page from the right control panel.
     */
    if (feelingsAvailable) {
      links.push({
        title: 'com_nav_feelings',
        label: '',
        icon: HeartPulse,
        id: 'feelings',
        onClick: () => navigate('/feelings'),
      });
    }
    /* === VIVENTIUM END === */

    if (hasAccessToMemories && hasAccessToReadMemories) {
      links.push({
        title: 'com_ui_memories',
        label: '',
        icon: Database,
        id: 'memories',
        Component: MemoryPanel,
      });
    }

    if (
      interfaceConfig.parameters === true &&
      isParamEndpoint(endpoint ?? '', endpointType ?? '') === true &&
      !isAgentsEndpoint(endpoint) &&
      keyProvided
    ) {
      links.push({
        title: 'com_sidepanel_parameters',
        label: '',
        icon: Settings2,
        id: 'parameters',
        Component: Parameters,
      });
    }

    links.push({
      title: 'com_sidepanel_attach_files',
      label: '',
      icon: AttachmentIcon,
      id: 'files',
      Component: FilesPanel,
    });

    if (hasAccessToBookmarks) {
      links.push({
        title: 'com_sidepanel_conversation_tags',
        label: '',
        icon: Bookmark,
        id: 'bookmarks',
        Component: BookmarkPanel,
      });
    }

    if (
      (hasAccessToUseMCPSettings && availableMCPServers && availableMCPServers.length > 0) ||
      hasAccessToCreateMCP
    ) {
      links.push({
        title: 'com_nav_setting_mcp',
        label: '',
        icon: MCPIcon,
        id: 'mcp-builder',
        Component: MCPBuilderPanel,
      });
    }

    links.push({
      title: 'com_sidepanel_hide_panel',
      label: '',
      icon: ArrowRightToLine,
      onClick: hidePanel,
      id: 'hide-panel',
    });

    return links;
  }, [
    endpoint,
    endpointsConfig,
    keyProvided,
    hasAccessToAgents,
    hasAccessToCreateAgents,
    hasAccessToPrompts,
    showActiveWork,
    feelingsAvailable,
    navigate,
    hasAccessToMemories,
    hasAccessToReadMemories,
    interfaceConfig.parameters,
    endpointType,
    hasAccessToBookmarks,
    availableMCPServers,
    hasAccessToUseMCPSettings,
    hasAccessToCreateMCP,
    hidePanel,
  ]);

  return Links;
}
