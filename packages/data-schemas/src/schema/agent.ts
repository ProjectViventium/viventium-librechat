import { Schema } from 'mongoose';
import type { IAgent } from '~/types';

const agentSchema = new Schema<IAgent>(
  {
    id: {
      type: String,
      index: true,
      unique: true,
      required: true,
    },
    name: {
      type: String,
    },
    description: {
      type: String,
    },
    instructions: {
      type: String,
    },
    avatar: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    provider: {
      type: String,
      required: true,
    },
    model: {
      type: String,
      required: true,
    },
    model_parameters: {
      type: Object,
    },
    artifacts: {
      type: String,
    },
    access_level: {
      type: Number,
    },
    recursion_limit: {
      type: Number,
    },
    tools: {
      type: [String],
      default: undefined,
    },
    tool_kwargs: {
      type: [{ type: Schema.Types.Mixed }],
    },
    actions: {
      type: [String],
      default: undefined,
    },
    author: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    authorName: {
      type: String,
      default: undefined,
    },
    hide_sequential_outputs: {
      type: Boolean,
    },
    end_after_tools: {
      type: Boolean,
    },
    /** @deprecated Use edges instead */
    agent_ids: {
      type: [String],
    },
    edges: {
      type: [{ type: Schema.Types.Mixed }],
      default: [],
    },
    isCollaborative: {
      type: Boolean,
      default: undefined,
    },
    conversation_starters: {
      type: [String],
      default: [],
    },
    tool_resources: {
      type: Schema.Types.Mixed,
      default: {},
    },
    projectIds: {
      type: [Schema.Types.ObjectId],
      ref: 'Project',
      index: true,
    },
    versions: {
      type: [Schema.Types.Mixed],
      default: [],
    },
    category: {
      type: String,
      trim: true,
      index: true,
      default: 'general',
    },
    support_contact: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    is_promoted: {
      type: Boolean,
      default: false,
      index: true,
    },
    /* === VIVENTIUM START ===
     * Feature: Agent-scoped conversation recall toggle
     * Purpose: If enabled, this agent uses a conversation-history RAG corpus filtered to itself.
     * Added: 2026-02-19
     */
    conversation_recall_agent_only: {
      type: Boolean,
      default: false,
    },
    /* === VIVENTIUM END === */
    /** MCP server names extracted from tools for efficient querying */
    mcpServerNames: {
      type: [String],
      default: [],
      index: true,
    },
    /** Per-tool configuration (defer_loading, allowed_callers) */
    tool_options: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
    /* === VIVENTIUM START ===
     * Feature: Background Cortices (Multi-Agent Brain Architecture)
     * Purpose: Allow main agents to have multiple background cortices with per-cortex activation config
     * Added: 2026-01-03
     * Updated: 2026-01-03 - Redesigned to store cortices on main agent (many-to-many)
     *
     * Architecture:
     * - Main agent has array of background cortices
     * - Each cortex entry has its own activation configuration
     * - Same cortex agent can be used by multiple main agents with different configs
     */
    /**
     * Viventium: Array of background cortices attached to this main agent.
     * Each cortex runs in parallel, deciding independently whether to activate.
     */
    background_cortices: {
      type: [{ type: Schema.Types.Mixed }],
      default: [],
      // Shape of each item:
      // {
      //   agent_id: string,           // ID of the cortex agent
      //   activation: {
      //     enabled: boolean,
      //     model: string,            // e.g., "gpt-4o-mini"
      //     provider: string,         // e.g., "openai"
      //     prompt: string,           // Custom activation prompt for this cortex
      //     intent_scope?: string,    // Optional config-defined routing scope
      //     confidence_threshold: number, // 0.0-1.0
      //     cooldown_ms: number,      // Min time between activations
      //     max_history: number,      // Messages to include in activation check
      //   }
      // }
    },
    /* === VIVENTIUM END === */
    /* === VIVENTIUM START ===
     * Feature: Voice Chat LLM Override
     * Purpose: Store a faster model/provider for LiveKit voice calls.
     * Added: 2026-02-24
     */
    voice_llm_model: { type: String, default: null },
    voice_llm_provider: { type: String, default: null },
    voice_llm_model_parameters: { type: Object, default: undefined },
    /* === VIVENTIUM END === */
  },
  {
    timestamps: true,
  },
);

agentSchema.index({ updatedAt: -1, _id: 1 });
agentSchema.index({ 'edges.to': 1 });

export default agentSchema;
