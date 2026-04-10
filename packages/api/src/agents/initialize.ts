import { Providers } from '@librechat/agents';
import {
  Constants,
  ErrorTypes,
  EModelEndpoint,
  EToolResources,
  FileContext,
  Tools,
  buildConversationRecallFileId,
  ConversationRecallScope,
  paramEndpoints,
  isAgentsEndpoint,
  replaceSpecialVars,
  providerEndpointMap,
} from 'librechat-data-provider';
import type {
  AgentToolResources,
  AgentToolOptions,
  TEndpointOption,
  TFile,
  Agent,
  TUser,
} from 'librechat-data-provider';
import type { GenericTool, LCToolRegistry, ToolMap, LCTool } from '@librechat/agents';
import type { Response as ServerResponse } from 'express';
import type { IMongoFile } from '@librechat/data-schemas';
import type { InitializeResultBase, ServerRequest, EndpointDbMethods } from '~/types';
import {
  optionalChainWithEmptyCheck,
  extractLibreChatParams,
  getModelMaxTokens,
  getThreadData,
} from '~/utils';
import { filterFilesByEndpointConfig } from '~/files';
import { generateArtifactsPrompt } from '~/prompts';
import { getProviderConfig } from '~/endpoints';
import { logger } from '@librechat/data-schemas';
import {
  buildConversationRecallAttachmentFiles,
  getConversationRecallRuntimeScope,
  mergeConversationRecallResources,
  ensureConversationRecallTool,
} from './conversationRecall';
/* === VIVENTIUM START ===
 * Feature: Conversation recall runtime health/freshness gating.
 * Purpose: Avoid attaching stale or unreachable recall corpora as if they were live evidence.
 * Added: 2026-04-08
 * === VIVENTIUM END === */
import {
  evaluateConversationRecallCorpusFreshness,
  getConversationRecallVectorRuntimeStatus,
} from './conversationRecallAvailability';
import { primeResources } from './resources';

/**
 * Extended agent type with additional fields needed after initialization
 */
export type InitializedAgent = Agent & {
  tools: GenericTool[];
  attachments: IMongoFile[];
  toolContextMap: Record<string, unknown>;
  maxContextTokens: number;
  useLegacyContent: boolean;
  resendFiles: boolean;
  tool_resources?: AgentToolResources;
  userMCPAuthMap?: Record<string, Record<string, string>>;
  /** Tool map for ToolNode to use when executing tools (required for PTC) */
  toolMap?: ToolMap;
  /** Tool registry for PTC and tool search (only present when MCP tools with env classification exist) */
  toolRegistry?: LCToolRegistry;
  /** Serializable tool definitions for event-driven execution */
  toolDefinitions?: LCTool[];
  /** Precomputed flag indicating if any tools have defer_loading enabled (for efficient runtime checks) */
  hasDeferredTools?: boolean;
};

/**
 * Parameters for initializing an agent
 * Matches the CJS signature from api/server/services/Endpoints/agents/agent.js
 */
export interface InitializeAgentParams {
  /** Request object */
  req: ServerRequest;
  /** Response object */
  res: ServerResponse;
  /** Agent to initialize */
  agent: Agent;
  /** Conversation ID (optional) */
  conversationId?: string | null;
  /** Parent message ID for determining the current thread (optional) */
  parentMessageId?: string | null;
  /** Request files */
  requestFiles?: IMongoFile[];
  /** Function to load agent tools */
  loadTools?: (params: {
    req: ServerRequest;
    res: ServerResponse;
    provider: string;
    agentId: string;
    tools: string[];
    model: string | null;
    tool_options: AgentToolOptions | undefined;
    tool_resources: AgentToolResources | undefined;
  }) => Promise<{
    /** Full tool instances (only present when definitionsOnly=false) */
    tools?: GenericTool[];
    toolContextMap?: Record<string, unknown>;
    userMCPAuthMap?: Record<string, Record<string, string>>;
    toolRegistry?: LCToolRegistry;
    /** Serializable tool definitions for event-driven mode */
    toolDefinitions?: LCTool[];
    hasDeferredTools?: boolean;
  } | null>;
  /** Endpoint option (contains model_parameters and endpoint info) */
  endpointOption?: Partial<TEndpointOption>;
  /** Set of allowed providers */
  allowedProviders: Set<string>;
  /** Whether this is the initial agent */
  isInitialAgent?: boolean;
}

/**
 * Database methods required for agent initialization
 * Most methods come from data-schemas via createMethods()
 * getConvoFiles not yet in data-schemas but included here for consistency
 */
export interface InitializeAgentDbMethods extends EndpointDbMethods {
  /** Update usage tracking for multiple files */
  updateFilesUsage: (files: Array<{ file_id: string }>, fileIds?: string[]) => Promise<unknown[]>;
  /** Get files from database */
  getFiles: (filter: unknown, sort: unknown, select: unknown, opts?: unknown) => Promise<unknown[]>;
  /** Get tool files by IDs (user-uploaded files only, code files handled separately) */
  getToolFilesByIds: (fileIds: string[], toolSet: Set<EToolResources>) => Promise<unknown[]>;
  /** Get conversation file IDs */
  getConvoFiles: (conversationId: string) => Promise<string[] | null>;
  /** Get code-generated files by conversation ID and optional message IDs */
  getCodeGeneratedFiles?: (conversationId: string, messageIds?: string[]) => Promise<unknown[]>;
  /** Get user-uploaded execute_code files by file IDs (from message.files in thread) */
  getUserCodeFiles?: (fileIds: string[]) => Promise<unknown[]>;
  /** Get messages for a conversation (supports select for field projection) */
  getMessages?: (
    filter: { conversationId: string },
    select?: string,
  ) => Promise<Array<{
    messageId: string;
    parentMessageId?: string;
    files?: Array<{ file_id: string }>;
  }> | null>;
  /** Get the newest recall-eligible message timestamp for a user */
  getLatestRecallEligibleMessageCreatedAt?: (params: { user: string }) => Promise<Date | string | null>;
}

/**
 * Initializes an agent for use in requests.
 * Handles file processing, tool loading, provider configuration, and context token calculations.
 *
 * This function is exported from @librechat/api and replaces the CJS version from
 * api/server/services/Endpoints/agents/agent.js
 *
 * @param params - Initialization parameters
 * @param deps - Optional dependency injection for testing
 * @returns Promise resolving to initialized agent with tools and configuration
 * @throws Error if agent provider is not allowed or if required dependencies are missing
 */
export async function initializeAgent(
  params: InitializeAgentParams,
  db?: InitializeAgentDbMethods,
): Promise<InitializedAgent> {
  const {
    req,
    res,
    agent,
    loadTools,
    requestFiles = [],
    conversationId,
    endpointOption,
    parentMessageId,
    allowedProviders,
    isInitialAgent = false,
  } = params;

  if (!db) {
    throw new Error('initializeAgent requires db methods to be passed');
  }

  if (
    isAgentsEndpoint(endpointOption?.endpoint) &&
    allowedProviders.size > 0 &&
    !allowedProviders.has(agent.provider)
  ) {
    throw new Error(
      `{ "type": "${ErrorTypes.INVALID_AGENT_PROVIDER}", "info": "${agent.provider}" }`,
    );
  }

  let currentFiles: IMongoFile[] | undefined;

  const _modelOptions = structuredClone(
    Object.assign(
      { model: agent.model },
      agent.model_parameters ?? { model: agent.model },
      isInitialAgent === true ? endpointOption?.model_parameters : {},
    ),
  );

  const { resendFiles, maxContextTokens, modelOptions } = extractLibreChatParams(
    _modelOptions as Record<string, unknown>,
  );

  const provider = agent.provider;
  agent.endpoint = provider;

  /**
   * Load conversation files for ALL agents, not just the initial agent.
   * This enables handoff agents to access files that were uploaded earlier
   * in the conversation. Without this, file_search and execute_code tools
   * on handoff agents would fail to find previously attached files.
   */
  if (conversationId != null && resendFiles) {
    const fileIds = (await db.getConvoFiles(conversationId)) ?? [];
    const toolResourceSet = new Set<EToolResources>();
    for (const tool of agent.tools ?? []) {
      if (EToolResources[tool as keyof typeof EToolResources]) {
        toolResourceSet.add(EToolResources[tool as keyof typeof EToolResources]);
      }
    }

    const toolFiles = (await db.getToolFilesByIds(fileIds, toolResourceSet)) as IMongoFile[];

    /**
     * Retrieve execute_code files filtered to the current thread.
     * This includes both code-generated files and user-uploaded execute_code files.
     */
    let codeGeneratedFiles: IMongoFile[] = [];
    let userCodeFiles: IMongoFile[] = [];

    if (toolResourceSet.has(EToolResources.execute_code)) {
      let threadMessageIds: string[] | undefined;
      let threadFileIds: string[] | undefined;

      if (parentMessageId && parentMessageId !== Constants.NO_PARENT && db.getMessages) {
        /** Only select fields needed for thread traversal */
        const messages = await db.getMessages(
          { conversationId },
          'messageId parentMessageId files',
        );
        if (messages && messages.length > 0) {
          /** Single O(n) pass: build Map, traverse thread, collect both IDs */
          const threadData = getThreadData(messages, parentMessageId);
          threadMessageIds = threadData.messageIds;
          threadFileIds = threadData.fileIds;
        }
      }

      /** Code-generated files (context: execute_code) filtered by messageId */
      if (db.getCodeGeneratedFiles) {
        codeGeneratedFiles = (await db.getCodeGeneratedFiles(
          conversationId,
          threadMessageIds,
        )) as IMongoFile[];
      }

      /** User-uploaded execute_code files (context: agents/message_attachment) from thread messages */
      if (db.getUserCodeFiles && threadFileIds && threadFileIds.length > 0) {
        userCodeFiles = (await db.getUserCodeFiles(threadFileIds)) as IMongoFile[];
      }
    }

    const allToolFiles = toolFiles.concat(codeGeneratedFiles, userCodeFiles);
    if (requestFiles.length || allToolFiles.length) {
      currentFiles = (await db.updateFilesUsage(requestFiles.concat(allToolFiles))) as IMongoFile[];
    }
  } else if (requestFiles.length) {
    currentFiles = (await db.updateFilesUsage(requestFiles)) as IMongoFile[];
  }

  if (currentFiles && currentFiles.length) {
    let endpointType: EModelEndpoint | undefined;
    if (!paramEndpoints.has(agent.endpoint ?? '')) {
      endpointType = EModelEndpoint.custom;
    }

    currentFiles = filterFilesByEndpointConfig(req, {
      files: currentFiles,
      endpoint: agent.endpoint ?? '',
      endpointType,
    });
  }

  const { attachments: primedAttachments, tool_resources: primedToolResources } = await primeResources({
    req: req as never,
    getFiles: db.getFiles as never,
    appConfig: req.config,
    agentId: agent.id,
    attachments: currentFiles
      ? (Promise.resolve(currentFiles) as unknown as Promise<TFile[]>)
      : undefined,
    tool_resources: agent.tool_resources,
    requestFileSet: new Set(requestFiles?.map((file) => file.file_id)),
  });

  let tool_resources = primedToolResources;

  /* === VIVENTIUM START ===
   * Feature: Conversation Recall runtime file_search resource injection
   *
   * Purpose:
   * - Reuse the existing file_search pipeline for conversation-history retrieval.
   * - Scope selection policy:
   *   1) Agent-level `conversation_recall_agent_only` => agent-only corpus
   *   2) User personalization `conversation_recall` => all-conversations corpus
   *
   * Added: 2026-02-19
   * === VIVENTIUM END === */
  const conversationRecallScope = getConversationRecallRuntimeScope({
    user: (req.user ?? null) as unknown as TUser | null,
    agent,
  });
  const conversationRecallVectorStatus =
    conversationRecallScope !== 'none' && req.user?.id
      ? await getConversationRecallVectorRuntimeStatus()
      : { available: false, reason: 'unconfigured' as const };

  if (conversationRecallScope !== 'none' && req.user?.id) {
    try {
      const recallFileId =
        conversationRecallScope === 'agent'
          ? buildConversationRecallFileId({
              userId: req.user.id,
              scope: ConversationRecallScope.agent,
              agentId: agent.id,
            })
          : buildConversationRecallFileId({
              userId: req.user.id,
              scope: ConversationRecallScope.all,
            });

      const conversationRecallFiles =
        (((await db.getFiles(
          {
            user: req.user.id,
            context: FileContext.conversation_recall,
            file_id: recallFileId,
          },
          null,
          { text: 0 },
          { userId: req.user.id, agentId: agent.id },
        )) as TFile[]) ?? []) as TFile[];

      let recallFilesAreFresh = conversationRecallFiles.length > 0;
      if (conversationRecallScope === 'all' && db.getLatestRecallEligibleMessageCreatedAt) {
        const latestRecallEligibleMessageCreatedAt =
          await db.getLatestRecallEligibleMessageCreatedAt({ user: req.user.id });
        const freshness = evaluateConversationRecallCorpusFreshness({
          recallFiles: conversationRecallFiles,
          latestMessageCreatedAt: latestRecallEligibleMessageCreatedAt,
        });
        recallFilesAreFresh = freshness.fresh;
        if (!freshness.fresh) {
          logger.debug('[initializeAgent] Falling back to source-only conversation recall attachment', {
            userId: req.user.id,
            agentId: agent.id,
            scope: conversationRecallScope,
            recallCorpusUpdatedAt: freshness.corpusUpdatedAt?.toISOString?.() ?? null,
            latestRecallEligibleMessageCreatedAt:
              freshness.latestMessageCreatedAt?.toISOString?.() ?? null,
          });
        }
      }

      const recallAttachmentMode =
        conversationRecallVectorStatus.available && recallFilesAreFresh && conversationRecallFiles.length > 0
          ? 'vector'
          : 'source_only';
      const recallAttachmentFiles = buildConversationRecallAttachmentFiles({
        userId: req.user.id,
        scope: conversationRecallScope,
        agentId: agent.id,
        existingFiles: conversationRecallFiles,
        mode: recallAttachmentMode,
      });

      if (recallAttachmentFiles.length > 0) {
        agent.tools = ensureConversationRecallTool(agent.tools);
        tool_resources = mergeConversationRecallResources({
          tool_resources,
          recallFiles: recallAttachmentFiles,
        });
      }

      if (conversationRecallFiles.length === 0) {
        logger.debug('[initializeAgent] No vector-backed conversation recall corpus found; attached source-only recall resource', {
          userId: req.user.id,
          agentId: agent.id,
          scope: conversationRecallScope,
        });
      } else if (recallAttachmentMode === 'source_only') {
        logger.debug('[initializeAgent] Attached source-only conversation recall resource', {
          userId: req.user.id,
          agentId: agent.id,
          scope: conversationRecallScope,
          reason: conversationRecallVectorStatus.reason,
        });
      }
    } catch (error) {
      logger.error('[initializeAgent] Failed to load conversation recall resources', error);
    }
  }

  const {
    toolRegistry,
    toolContextMap,
    userMCPAuthMap,
    toolDefinitions,
    hasDeferredTools,
    tools: structuredTools,
  } = (await loadTools?.({
    req,
    res,
    provider,
    agentId: agent.id,
    tools: agent.tools ?? [],
    model: agent.model,
    tool_options: agent.tool_options,
    tool_resources,
  })) ?? {
    tools: [],
    toolContextMap: {},
    userMCPAuthMap: undefined,
    toolRegistry: undefined,
    toolDefinitions: [],
    hasDeferredTools: false,
  };

  const { getOptions, overrideProvider } = getProviderConfig({
    provider,
    appConfig: req.config,
  });
  const resolvedProvider = overrideProvider;
  if (resolvedProvider !== agent.provider) {
    agent.provider = resolvedProvider;
  }

  const finalModelOptions = {
    ...modelOptions,
    model: agent.model,
  };

  const options: InitializeResultBase = await getOptions({
    req,
    endpoint: resolvedProvider,
    model_parameters: finalModelOptions,
    db,
  });

  const llmConfig = options.llmConfig as Record<string, unknown>;
  const tokensModel =
    agent.provider === EModelEndpoint.azureOpenAI ? agent.model : (llmConfig?.model as string);
  const maxOutputTokens = optionalChainWithEmptyCheck(
    llmConfig?.maxOutputTokens as number | undefined,
    llmConfig?.maxTokens as number | undefined,
    0,
  );
  const agentMaxContextTokens = optionalChainWithEmptyCheck(
    maxContextTokens,
    getModelMaxTokens(
      tokensModel ?? '',
      providerEndpointMap[provider as keyof typeof providerEndpointMap],
      options.endpointTokenConfig,
    ),
    18000,
  );

  if (
    agent.endpoint === EModelEndpoint.azureOpenAI &&
    (llmConfig?.azureOpenAIApiInstanceName as string | undefined) == null
  ) {
    agent.provider = Providers.OPENAI;
  }

  if (options.provider != null) {
    agent.provider = options.provider;
  }

  /** Check for tool presence from either full instances or definitions (event-driven mode) */
  const hasAgentTools = (structuredTools?.length ?? 0) > 0 || (toolDefinitions?.length ?? 0) > 0;

  let tools: GenericTool[] = options.tools?.length
    ? (options.tools as GenericTool[])
    : (structuredTools ?? []);

  if (
    (agent.provider === Providers.GOOGLE || agent.provider === Providers.VERTEXAI) &&
    options.tools?.length &&
    hasAgentTools
  ) {
    throw new Error(`{ "type": "${ErrorTypes.GOOGLE_TOOL_CONFLICT}"}`);
  } else if (
    (agent.provider === Providers.OPENAI ||
      agent.provider === Providers.AZURE ||
      agent.provider === Providers.ANTHROPIC) &&
    options.tools?.length &&
    structuredTools?.length
  ) {
    tools = structuredTools.concat(options.tools as GenericTool[]);
  }

  agent.model_parameters = { ...options.llmConfig } as Agent['model_parameters'];
  if (options.configOptions) {
    (agent.model_parameters as Record<string, unknown>).configuration = options.configOptions;
  }

  if (agent.instructions && agent.instructions !== '') {
    /* === VIVENTIUM START ===
     * Feature: Pass client timezone into special variable replacement
     * Purpose: Render {{current_date}}/{{current_datetime}} in the user's timezone.
     * Added: 2026-02-01
     */
    agent.instructions = replaceSpecialVars({
      text: agent.instructions,
      user: req.user ? (req.user as unknown as TUser) : null,
      timeZone: req?.body?.clientTimezone,
    });
    /* === VIVENTIUM END === */
  }

  if (typeof agent.artifacts === 'string' && agent.artifacts !== '') {
    const artifactsPromptResult = generateArtifactsPrompt({
      endpoint: agent.provider,
      artifacts: agent.artifacts as never,
    });
    agent.additional_instructions = artifactsPromptResult ?? undefined;
  }

  const agentMaxContextNum = Number(agentMaxContextTokens) || 18000;
  const maxOutputTokensNum = Number(maxOutputTokens) || 0;

  const finalAttachments: IMongoFile[] = (primedAttachments ?? [])
    .filter((a): a is TFile => a != null)
    .map((a) => a as unknown as IMongoFile);

  const initializedAgent: InitializedAgent = {
    ...agent,
    resendFiles,
    toolRegistry,
    tool_resources,
    userMCPAuthMap,
    toolDefinitions,
    hasDeferredTools,
    attachments: finalAttachments,
    toolContextMap: toolContextMap ?? {},
    useLegacyContent: !!options.useLegacyContent,
    tools: (tools ?? []) as GenericTool[] & string[],
    maxContextTokens: Math.round((agentMaxContextNum - maxOutputTokensNum) * 0.9),
  };

  return initializedAgent;
}
