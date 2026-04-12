import { Document, Types } from 'mongoose';
import type { GraphEdge, AgentToolOptions } from 'librechat-data-provider';

export interface ISupportContact {
  name?: string;
  email?: string;
}

/* === VIVENTIUM START ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Purpose: Types for background cortices with per-cortex activation configuration
 * Added: 2026-01-03
 * Updated: 2026-01-03 - Redesigned for many-to-many cortex relationships
 */

/**
 * Configuration for LLM-based activation detection.
 * Each cortex attached to a main agent has its own activation config.
 */
export interface IActivationConfig {
  /** Whether activation detection is enabled */
  enabled: boolean;
  /** Model to use for activation detection (e.g., "gpt-4o-mini") */
  model: string;
  /** Provider for the activation model (e.g., "openai") */
  provider: string;
  /** System prompt for making activation decisions */
  prompt: string;
  /** Optional config-defined routing scope for runtime helper context */
  intent_scope?: string;
  /** Minimum confidence threshold (0.0-1.0) to trigger activation */
  confidence_threshold: number;
  /** Minimum time between activations in milliseconds */
  cooldown_ms: number;
  /** Number of recent messages to include in activation context */
  max_history: number;
}

/**
 * A background cortex entry attached to a main agent.
 * Each cortex has its own activation configuration specific to this main agent.
 */
export interface IBackgroundCortex {
  /** ID of the agent serving as a background cortex */
  agent_id: string;
  /** Activation configuration for this cortex (specific to this main agent) */
  activation: IActivationConfig;
}
/* === VIVENTIUM END === */
export interface IAgent extends Omit<Document, 'model'> {
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  avatar?: {
    filepath: string;
    source: string;
  };
  provider: string;
  model: string;
  model_parameters?: Record<string, unknown>;
  artifacts?: string;
  access_level?: number;
  recursion_limit?: number;
  tools?: string[];
  tool_kwargs?: Array<unknown>;
  actions?: string[];
  author: Types.ObjectId;
  authorName?: string;
  hide_sequential_outputs?: boolean;
  end_after_tools?: boolean;
  /** @deprecated Use edges instead */
  agent_ids?: string[];
  edges?: GraphEdge[];
  /** @deprecated Use ACL permissions instead */
  isCollaborative?: boolean;
  conversation_starters?: string[];
  tool_resources?: unknown;
  projectIds?: Types.ObjectId[];
  versions?: Omit<IAgent, 'versions'>[];
  category: string;
  support_contact?: ISupportContact;
  is_promoted?: boolean;
  /* === VIVENTIUM START ===
   * Feature: Agent-scoped conversation recall toggle
   * Purpose: When enabled, retrieval uses only this agent's conversation history corpus.
   * Added: 2026-02-19
   */
  conversation_recall_agent_only?: boolean;
  /* === VIVENTIUM END === */
  /** MCP server names extracted from tools for efficient querying */
  mcpServerNames?: string[];
  /** Per-tool configuration (defer_loading, allowed_callers) */
  tool_options?: AgentToolOptions;
  /* === VIVENTIUM START === */
  /**
   * Background cortices attached to this main agent.
   * Each cortex runs in parallel, independently deciding whether to activate.
   */
  background_cortices?: IBackgroundCortex[];
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override
   * Added: 2026-02-24
   */
  voice_llm_model?: string | null;
  voice_llm_provider?: string | null;
  voice_llm_model_parameters?: Record<string, unknown>;
  /* === VIVENTIUM END === */
}
