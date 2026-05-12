import { z } from 'zod';
import { ViolationTypes, ErrorTypes, normalizeEndpointName } from 'librechat-data-provider';
import type { Agent, TModelsConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';

/** Avatar schema shared between create and update */
export const agentAvatarSchema = z.object({
  filepath: z.string(),
  source: z.string(),
});

/** Base resource schema for tool resources */
export const agentBaseResourceSchema = z.object({
  file_ids: z.array(z.string()).optional(),
  files: z.array(z.any()).optional(), // Files are populated at runtime, not from user input
});

/** File resource schema extends base with vector_store_ids */
export const agentFileResourceSchema = agentBaseResourceSchema.extend({
  vector_store_ids: z.array(z.string()).optional(),
});

/** Tool resources schema matching AgentToolResources interface */
export const agentToolResourcesSchema = z
  .object({
    image_edit: agentBaseResourceSchema.optional(),
    execute_code: agentBaseResourceSchema.optional(),
    file_search: agentFileResourceSchema.optional(),
    context: agentBaseResourceSchema.optional(),
    /** @deprecated Use context instead */
    ocr: agentBaseResourceSchema.optional(),
  })
  .optional();

/** Support contact schema for agent */
export const agentSupportContactSchema = z
  .object({
    name: z.string().optional(),
    email: z.union([z.literal(''), z.string().email()]).optional(),
  })
  .optional();

/** Graph edge schema for agent handoffs */
export const graphEdgeSchema = z.object({
  from: z.union([z.string(), z.array(z.string())]),
  to: z.union([z.string(), z.array(z.string())]),
  description: z.string().optional(),
  edgeType: z.enum(['handoff', 'direct']).optional(),
  prompt: z.union([z.string(), z.function()]).optional(),
  excludeResults: z.boolean().optional(),
  promptKey: z.string().optional(),
});

/** Per-tool options schema (defer_loading, allowed_callers) */
export const toolOptionsSchema = z.object({
  defer_loading: z.boolean().optional(),
  allowed_callers: z.array(z.enum(['direct', 'code_execution'])).optional(),
});

/** Agent tool options - map of tool_id to tool options */
export const agentToolOptionsSchema = z.record(z.string(), toolOptionsSchema).optional();

/* === VIVENTIUM START ===
 * Feature: Background Cortices (Multi-Agent Brain Architecture)
 * Purpose: Validation schemas for background cortices configuration
 * Added: 2026-01-03
 */

/** Activation config schema for background cortices */
export const activationConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  provider: z.string(),
  prompt: z.string(),
  intent_scope: z.string().optional(),
  activation_failure_visibility: z.enum(['silent', 'visible']).optional(),
  confidence_threshold: z.number().min(0).max(1),
  cooldown_ms: z.number().min(0),
  max_history: z.number().min(1),
  fallbacks: z
    .array(
      z.object({
        provider: z.string(),
        model: z.string(),
      }),
    )
    .optional(),
});

/** Background cortex schema - an agent with its activation config */
export const backgroundCortexSchema = z.object({
  agent_id: z.string(),
  activation: activationConfigSchema,
});
/* === VIVENTIUM END === */
/** Base agent schema with all common fields */
export const agentBaseSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  avatar: agentAvatarSchema.nullable().optional(),
  model_parameters: z.record(z.unknown()).optional(),
  tools: z.array(z.string()).optional(),
  /** @deprecated Use edges instead */
  agent_ids: z.array(z.string()).optional(),
  edges: z.array(graphEdgeSchema).optional(),
  end_after_tools: z.boolean().optional(),
  hide_sequential_outputs: z.boolean().optional(),
  artifacts: z.string().optional(),
  recursion_limit: z.number().optional(),
  conversation_starters: z.array(z.string()).optional(),
  tool_resources: agentToolResourcesSchema,
  tool_options: agentToolOptionsSchema,
  support_contact: agentSupportContactSchema,
  category: z.string().optional(),
  /* === VIVENTIUM START ===
   * Feature: Agent-scoped conversation recall toggle
   * Added: 2026-02-19
   */
  conversation_recall_agent_only: z.boolean().optional(),
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START === */
  /** Background cortices attached to this main agent */
  background_cortices: z.array(backgroundCortexSchema).optional(),
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Voice Chat LLM Override
   * Added: 2026-02-24
   */
  voice_llm_model: z.string().nullable().optional(),
  voice_llm_provider: z.string().nullable().optional(),
  voice_llm_model_parameters: z.record(z.unknown()).optional(),
  /* === VIVENTIUM START ===
   * Feature: Voice Fallback LLM
   * Added: 2026-04-28
   */
  voice_fallback_llm_model: z.string().nullable().optional(),
  voice_fallback_llm_provider: z.string().nullable().optional(),
  voice_fallback_llm_model_parameters: z.record(z.unknown()).optional(),
  /* === VIVENTIUM END === */
  /* === VIVENTIUM START ===
   * Feature: Agent Fallback LLM
   * Added: 2026-04-28
   */
  fallback_llm_model: z.string().nullable().optional(),
  fallback_llm_provider: z.string().nullable().optional(),
  fallback_llm_model_parameters: z.record(z.unknown()).optional(),
  /* === VIVENTIUM END === */
});

/** Create schema extends base with required fields for creation */
export const agentCreateSchema = agentBaseSchema.extend({
  provider: z.string(),
  model: z.string().nullable(),
  tools: z.array(z.string()).optional().default([]),
});

/** Update schema extends base with all fields optional and additional update-only fields */
export const agentUpdateSchema = agentBaseSchema.extend({
  avatar: z.union([agentAvatarSchema, z.null()]).optional(),
  provider: z.string().optional(),
  model: z.string().nullable().optional(),
  projectIds: z.array(z.string()).optional(),
  removeProjectIds: z.array(z.string()).optional(),
  isCollaborative: z.boolean().optional(),
});

interface ValidateAgentModelParams {
  req: Request;
  res: Response;
  agent: Agent;
  modelsConfig: TModelsConfig;
  logViolation: (
    req: Request,
    res: Response,
    type: string,
    errorMessage: Record<string, unknown>,
    score?: number | string,
  ) => Promise<void>;
}

interface ValidateAgentModelResult {
  isValid: boolean;
  error?: {
    message: string;
  };
}

/**
 * Validates an agent's model against the available models configuration.
 * This is a non-middleware version of validateModel that can be used
 * in service initialization flows.
 *
 * @param params - Validation parameters
 * @returns Object indicating whether the model is valid and any error details
 */
export async function validateAgentModel(
  params: ValidateAgentModelParams,
): Promise<ValidateAgentModelResult> {
  const { req, res, agent, modelsConfig, logViolation } = params;
  const { model, provider: endpoint } = agent;

  if (!model) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.MISSING_MODEL}", "info": "${endpoint}" }`,
      },
    };
  }

  if (!modelsConfig) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.MODELS_NOT_LOADED}" }`,
      },
    };
  }

  let availableModels: string[] | undefined = modelsConfig[endpoint];
  if (!availableModels) {
    const normalizedEndpoint = normalizeEndpointName(endpoint);
    const matchedKey = Object.keys(modelsConfig).find(
      (key) => normalizeEndpointName(key) === normalizedEndpoint,
    );
    availableModels = matchedKey ? modelsConfig[matchedKey] : undefined;
  }
  if (!availableModels) {
    return {
      isValid: false,
      error: {
        message: `{ "type": "${ErrorTypes.ENDPOINT_MODELS_NOT_LOADED}", "info": "${endpoint}" }`,
      },
    };
  }

  const validModel = !!availableModels.find((availableModel) => availableModel === model);

  if (validModel) {
    return { isValid: true };
  }

  const { ILLEGAL_MODEL_REQ_SCORE: score = 1 } = process.env ?? {};
  const type = ViolationTypes.ILLEGAL_MODEL_REQUEST;
  const errorMessage = {
    type,
    model,
    endpoint,
  };

  await logViolation(req, res, type, errorMessage, score);

  return {
    isValid: false,
    error: {
      message: `{ "type": "${ViolationTypes.ILLEGAL_MODEL_REQUEST}", "info": "${endpoint}|${model}" }`,
    },
  };
}
