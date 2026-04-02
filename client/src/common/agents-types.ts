import { AgentCapabilities, ArtifactModes } from 'librechat-data-provider';
import type {
  AgentModelParameters,
  AgentToolOptions,
  /* === VIVENTIUM START ===
   * Feature: Background Cortices types (client)
   * Purpose: Import the BackgroundCortex type for agent form fields.
   * Added: 2026-01-03
   */
  BackgroundCortex,
  /* === VIVENTIUM END === */
  SupportContact,
  AgentProvider,
  GraphEdge,
  Agent,
} from 'librechat-data-provider';
import type { OptionWithIcon, ExtendedFile } from './types';

export type TAgentOption = OptionWithIcon &
  Agent & {
    knowledge_files?: Array<[string, ExtendedFile]>;
    context_files?: Array<[string, ExtendedFile]>;
    code_files?: Array<[string, ExtendedFile]>;
    _id?: string;
  };

export type TAgentCapabilities = {
  [AgentCapabilities.web_search]: boolean;
  [AgentCapabilities.file_search]: boolean;
  [AgentCapabilities.execute_code]: boolean;
  [AgentCapabilities.end_after_tools]?: boolean;
  [AgentCapabilities.hide_sequential_outputs]?: boolean;
};

export type AgentForm = {
  agent?: TAgentOption;
  id: string;
  name: string | null;
  description: string | null;
  instructions: string | null;
  model: string | null;
  model_parameters: AgentModelParameters;
  tools?: string[];
  /** Per-tool configuration options (deferred loading, allowed callers, etc.) */
  tool_options?: AgentToolOptions;
  provider?: AgentProvider | OptionWithIcon;
  /** @deprecated Use edges instead */
  agent_ids?: string[];
  edges?: GraphEdge[];
  [AgentCapabilities.artifacts]?: ArtifactModes | string;
  recursion_limit?: number;
  support_contact?: SupportContact;
  category: string;
  /* === VIVENTIUM START ===
   * Feature: Agent-scoped conversation recall toggle (builder form)
   * Added: 2026-02-19
   */
  conversation_recall_agent_only?: boolean;
  /* === VIVENTIUM END === */
  // Avatar management fields
  avatar_file?: File | null;
  avatar_preview?: string | null;
  avatar_action?: 'upload' | 'reset' | null;
  /* === VIVENTIUM START ===
   * Feature: Background Cortices (Multi-Agent Brain Architecture)
   * Purpose: Form fields for managing background cortices on main agents
   * Added: 2026-01-03
   * Updated: 2026-01-03 - Redesigned for many-to-many cortex relationships
   */
  background_cortices?: BackgroundCortex[];
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override
   * Added: 2026-02-24
   */
  voice_llm_model?: string | null;
  voice_llm_provider?: string | null;
  /* === VIVENTIUM END === */
} & TAgentCapabilities;
