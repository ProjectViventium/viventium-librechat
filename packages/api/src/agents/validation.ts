import { z } from 'zod';
import {
  ViolationTypes,
  ErrorTypes,
  normalizeEndpointName,
  isAgentProviderCapabilityEnabled,
} from 'librechat-data-provider';
import type { Agent, AgentProviderCapabilityRole, TModelsConfig } from 'librechat-data-provider';
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
export const activationConfigSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(['classified', 'always', 'disabled']).optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    prompt: z.string().optional(),
    intent_scope: z.string().optional(),
    activation_failure_visibility: z.enum(['silent', 'visible']).optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    cooldown_ms: z.number().min(0).optional(),
    max_history: z.number().min(1).optional(),
    fallbacks: z
      .array(
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      )
      .optional(),
  })
  .superRefine((activation, ctx) => {
    const mode = activation.enabled === false ? 'disabled' : (activation.mode ?? 'classified');
    if (mode !== 'classified') {
      return;
    }

    const requireClassifierString = (field: 'provider' | 'model' | 'prompt', message: string) => {
      if (String(activation[field] ?? '').trim()) {
        return;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message,
      });
    };
    requireClassifierString('provider', 'Classifier provider is required');
    requireClassifierString('model', 'Classifier model is required');
    requireClassifierString('prompt', 'Classifier prompt is required');
    if (activation.confidence_threshold == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confidence_threshold'],
        message: 'Classifier confidence threshold is required',
      });
    }
    if (activation.cooldown_ms == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cooldown_ms'],
        message: 'Classifier cooldown is required',
      });
    }
    if (activation.max_history == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['max_history'],
        message: 'Classifier history depth is required',
      });
    }
  });

export const cortexResultEvidencePolicySchema = z
  .object({
    visible_insight_requires: z
      .array(
        z
          .object({
            tool: z.string().trim().min(1),
            receipt: z.literal('non_empty_sources'),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

/** Background cortex schema - an agent with its activation config */
export const backgroundCortexSchema = z.object({
  agent_id: z.string(),
  activation: activationConfigSchema,
  result_evidence: cortexResultEvidencePolicySchema.optional(),
});
/* === VIVENTIUM END === */
/* === VIVENTIUM START === GlassHive core Agent provider */
export const glassHiveOptionsSchema = z
  .object({
    workspace: z.object({
      mode: z.enum(['life', 'custom']),
      path: z.string().optional(),
    }),
    access: z.enum(['full', 'workspace']),
    fallback_model: z.string().optional(),
    fallback_reasoning_effort: z.string().optional(),
    orchestration: z
      .object({
        parallel_available: z.boolean(),
        default_mode: z.enum(['focused', 'parallel']),
        worker_profile: z.enum(['codex-cli', 'claude-code', 'openclaw-general']).optional(),
        fallback_worker_profile: z
          .enum(['codex-cli', 'claude-code', 'openclaw-general'])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((value, ctx) => {
    const customPath = value.workspace.path?.trim() ?? '';
    if (value.workspace.mode === 'custom' && !customPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workspace', 'path'],
        message: 'Custom GlassHive workspace requires a server-side path',
      });
    } else if (
      value.workspace.mode === 'custom' &&
      !(
        customPath.startsWith('/') ||
        customPath.startsWith('~/') ||
        /^[A-Za-z]:[\\/]/.test(customPath)
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workspace', 'path'],
        message: 'Custom GlassHive workspace must be an absolute server-side path',
      });
    }
  });
/* === VIVENTIUM END === */
/** Base agent schema with all common fields */
export const agentBaseSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  instructions: z.string().nullable().optional(),
  avatar: agentAvatarSchema.nullable().optional(),
  model_parameters: z.record(z.unknown()).optional(),
  glasshive_options: glassHiveOptionsSchema.optional(),
  tools: z.array(z.string()).optional(),
  /** @deprecated Use edges instead */
  agent_ids: z.array(z.string()).optional(),
  edges: z.array(graphEdgeSchema).optional(),
  end_after_tools: z.boolean().optional(),
  hide_sequential_outputs: z.boolean().optional(),
  presentation_policy: z.enum(['primary_final']).optional(),
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

/* === VIVENTIUM START ===
 * Feature: Config-owned exact provider/model validation.
 * Purpose: Capability-backed providers fail visibly on unsupported model/effort selections and
 * receive registry defaults without branching on provider names or display labels.
 * === VIVENTIUM END === */
export type ProviderCapabilityRegistry = Record<
  string,
  {
    main_chat?: boolean;
    activation_classifier?: boolean;
    voice_pipeline_llm?: boolean;
    native_realtime_voice?: boolean;
    realtime_voice?: boolean;
    automatic_fallback_target?: boolean;
    serial_model_fallback?: boolean;
    workspace_binding?: boolean;
    native_tools?: boolean;
    worker_native_tools?: boolean;
    host_tools_transport?: 'broker_mcp';
    host_tools?: string[];
    conversation_session?: boolean;
    responses_api?: boolean;
    messaging_delivery_disposition?: boolean;
    messaging_delivery_disposition_version?: 1;
    default_access?: 'full' | 'workspace';
    allow_full_access?: boolean;
    excluded_mcp_servers?: string[];
    /* === VIVENTIUM START ===
     * Feature: Deferred connected-account projection.
     * Purpose: Keep the provider registry type aligned with the parsed capability contract.
     * === VIVENTIUM END === */
    reviewed_mcp_projection?: 'deferred';
    models?: Array<{
      id: string;
      effortChoices?: string[];
      recommendedEffort?: string;
    }>;
  }
>;

export function applyAgentProviderCapabilityDefaults<T extends Record<string, unknown>>(
  agent: T,
  registry: ProviderCapabilityRegistry | undefined,
  requiredProviders: string[] = [],
): T {
  const next = { ...agent } as T & {
    model_parameters?: Record<string, unknown>;
    voice_llm_provider?: unknown;
    voice_llm_model?: unknown;
    voice_llm_model_parameters?: Record<string, unknown>;
    voice_fallback_llm_provider?: unknown;
    voice_fallback_llm_model?: unknown;
    voice_fallback_llm_model_parameters?: Record<string, unknown>;
    glasshive_options?: {
      workspace: { mode: 'life' | 'custom'; path?: string };
      access: 'full' | 'workspace';
      fallback_model?: string;
      fallback_reasoning_effort?: string;
      orchestration?: {
        parallel_available: boolean;
        default_mode: 'focused' | 'parallel';
        worker_profile?: string;
        fallback_worker_profile?: string;
      };
    };
  };
  const rejectCapabilityTarget = (
    selectedProviderValue: unknown,
    capabilityField: AgentProviderCapabilityRole,
    path: Array<string | number>,
  ) => {
    const selectedProvider = String(selectedProviderValue ?? '').trim();
    if (!selectedProvider) {
      return;
    }
    const selectedCapability = registry?.[selectedProvider];
    if (requiredProviders.includes(selectedProvider) && !selectedCapability) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path,
          message: `Provider capability configuration is unavailable for ${selectedProvider}`,
        },
      ]);
    }
    if (
      selectedCapability &&
      !isAgentProviderCapabilityEnabled(selectedCapability, capabilityField)
    ) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path,
          message: `Provider ${selectedProvider} does not support agent capability ${capabilityField}`,
        },
      ]);
    }
  };

  rejectCapabilityTarget(next.voice_llm_provider, 'voice_pipeline_llm', ['voice_llm_provider']);
  rejectCapabilityTarget(next.voice_fallback_llm_provider, 'voice_pipeline_llm', [
    'voice_fallback_llm_provider',
  ]);
  rejectCapabilityTarget(next.voice_fallback_llm_provider, 'automatic_fallback_target', [
    'voice_fallback_llm_provider',
  ]);
  rejectCapabilityTarget(next.fallback_llm_provider, 'automatic_fallback_target', [
    'fallback_llm_provider',
  ]);

  const normalizeCapabilityRoute = ({
    providerField,
    modelField,
    parametersField,
  }: {
    providerField: 'voice_llm_provider' | 'voice_fallback_llm_provider';
    modelField: 'voice_llm_model' | 'voice_fallback_llm_model';
    parametersField: 'voice_llm_model_parameters' | 'voice_fallback_llm_model_parameters';
  }) => {
    const routeProvider = String(next[providerField] ?? '').trim();
    if (!routeProvider) {
      return;
    }
    const routeCapability = registry?.[routeProvider];
    if (!routeCapability) {
      return;
    }
    const routeModel = String(next[modelField] ?? '').trim();
    const routeModelMetadata = routeCapability.models?.find(
      (candidate) => candidate.id === routeModel,
    );
    if (!routeModelMetadata) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [modelField],
          message: `Unsupported model for configured provider ${routeProvider}`,
        },
      ]);
    }
    const routeParameters = { ...(next[parametersField] ?? {}) };
    routeParameters.model = routeModel;
    if (routeCapability.responses_api === false) {
      delete routeParameters.useResponsesApi;
      delete routeParameters.reasoning;
      delete routeParameters.reasoning_summary;
      delete routeParameters.verbosity;
      delete routeParameters.web_search;
    }
    const routeEffort = String(
      routeParameters.reasoning_effort ?? routeModelMetadata.recommendedEffort ?? '',
    ).trim();
    if (routeEffort && !(routeModelMetadata.effortChoices ?? []).includes(routeEffort)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: [parametersField, 'reasoning_effort'],
          message: `Unsupported reasoning effort for model ${routeModel}`,
        },
      ]);
    }
    if (routeEffort) {
      routeParameters.reasoning_effort = routeEffort;
    }
    next[parametersField] = routeParameters;
  };

  normalizeCapabilityRoute({
    providerField: 'voice_llm_provider',
    modelField: 'voice_llm_model',
    parametersField: 'voice_llm_model_parameters',
  });
  normalizeCapabilityRoute({
    providerField: 'voice_fallback_llm_provider',
    modelField: 'voice_fallback_llm_model',
    parametersField: 'voice_fallback_llm_model_parameters',
  });
  const backgroundCortices = next.background_cortices;
  if (Array.isArray(backgroundCortices)) {
    backgroundCortices.forEach((entry, cortexIndex) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }
      const activation = (entry as { activation?: unknown }).activation;
      if (!activation || typeof activation !== 'object') {
        return;
      }
      const activationConfig = activation as {
        enabled?: boolean;
        mode?: 'classified' | 'always' | 'disabled';
        provider?: unknown;
        fallbacks?: Array<{ provider?: unknown }>;
      };
      const activationMode =
        activationConfig.enabled === false ? 'disabled' : (activationConfig.mode ?? 'classified');
      if (activationMode !== 'classified') {
        return;
      }
      rejectCapabilityTarget(activationConfig.provider, 'activation_classifier', [
        'background_cortices',
        cortexIndex,
        'activation',
        'provider',
      ]);
      (activationConfig.fallbacks ?? []).forEach((fallback, fallbackIndex) => {
        rejectCapabilityTarget(fallback.provider, 'activation_classifier', [
          'background_cortices',
          cortexIndex,
          'activation',
          'fallbacks',
          fallbackIndex,
          'provider',
        ]);
      });
    });
  }

  const provider = String(agent.provider ?? '').trim();
  const capability = registry?.[provider];
  const workspaceCapability = [
    capability,
    registry?.[String(next.voice_llm_provider ?? '').trim()],
    registry?.[String(next.voice_fallback_llm_provider ?? '').trim()],
  ].find((candidate) => candidate?.workspace_binding === true);
  if (workspaceCapability && !next.glasshive_options) {
    next.glasshive_options = {
      workspace: { mode: 'life' },
      access: workspaceCapability.default_access === 'full' ? 'full' : 'workspace',
    };
  }
  if (
    workspaceCapability &&
    next.glasshive_options?.access === 'full' &&
    workspaceCapability.allow_full_access !== true
  ) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['glasshive_options', 'access'],
        message: `Selected provider does not permit full host access`,
      },
    ]);
  }
  if (provider && requiredProviders.includes(provider) && !capability) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['provider'],
        message: `Provider capability configuration is unavailable for ${provider}`,
      },
    ]);
  }
  if (!capability) {
    return next;
  }
  if (!isAgentProviderCapabilityEnabled(capability, 'main_chat')) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['provider'],
        message: `Provider ${provider} does not support main Agent chat`,
      },
    ]);
  }
  const model = String(agent.model ?? '').trim();
  const modelMetadata = capability.models?.find((candidate) => candidate.id === model);
  if (!modelMetadata) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['model'],
        message: `Unsupported model for configured provider ${provider}`,
      },
    ]);
  }

  const modelParameters = { ...(next.model_parameters ?? {}) };
  // The top-level Agent model is canonical. Do not let a stale nested model silently initialize a
  // different harness after a provider/model switch, source sync, or historical version revert.
  modelParameters.model = model;
  if (capability.responses_api === false) {
    delete modelParameters.useResponsesApi;
    delete modelParameters.reasoning;
    delete modelParameters.reasoning_summary;
    delete modelParameters.verbosity;
    delete modelParameters.web_search;
  }
  const effort = String(
    modelParameters.reasoning_effort ?? modelMetadata.recommendedEffort ?? '',
  ).trim();
  if (effort && !(modelMetadata.effortChoices ?? []).includes(effort)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['model_parameters', 'reasoning_effort'],
        message: `Unsupported reasoning effort for model ${model}`,
      },
    ]);
  }
  if (effort) {
    modelParameters.reasoning_effort = effort;
  }
  next.model_parameters = modelParameters;
  const fallbackModel = String(next.glasshive_options?.fallback_model ?? '').trim();
  if (fallbackModel) {
    if (capability.serial_model_fallback !== true) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['glasshive_options', 'fallback_model'],
          message: `Provider ${provider} does not support serial model fallback`,
        },
      ]);
    }
    const fallbackMetadata = capability.models?.find((candidate) => candidate.id === fallbackModel);
    if (!fallbackMetadata) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['glasshive_options', 'fallback_model'],
          message: `Unsupported GlassHive fallback model ${fallbackModel}`,
        },
      ]);
    }
    if (fallbackModel === model) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['glasshive_options', 'fallback_model'],
          message: 'GlassHive fallback model must differ from the primary model',
        },
      ]);
    }
    const fallbackEffort = String(
      next.glasshive_options?.fallback_reasoning_effort ?? fallbackMetadata.recommendedEffort ?? '',
    ).trim();
    if (fallbackEffort && !(fallbackMetadata.effortChoices ?? []).includes(fallbackEffort)) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['glasshive_options', 'fallback_reasoning_effort'],
          message: `Unsupported reasoning effort for fallback model ${fallbackModel}`,
        },
      ]);
    }
    const glassHiveOptions = next.glasshive_options;
    if (!glassHiveOptions) {
      throw new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ['glasshive_options'],
          message: `Provider ${provider} requires GlassHive options for serial model fallback`,
        },
      ]);
    }
    next.glasshive_options = {
      workspace: glassHiveOptions.workspace,
      access: glassHiveOptions.access,
      fallback_model: fallbackModel,
      ...(fallbackEffort ? { fallback_reasoning_effort: fallbackEffort } : {}),
      ...(glassHiveOptions.orchestration ? { orchestration: glassHiveOptions.orchestration } : {}),
    };
  } else if (next.glasshive_options) {
    next.glasshive_options = {
      workspace: next.glasshive_options.workspace,
      access: next.glasshive_options.access,
      ...(next.glasshive_options.orchestration
        ? { orchestration: next.glasshive_options.orchestration }
        : {}),
    };
  }
  return next;
}

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
