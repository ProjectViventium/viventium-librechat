/* === VIVENTIUM START === Thin DB/native bindings for current coordinator context. === */
const mongoose = require('mongoose');
const {
  createNativeCoordinatorContextAdapter,
  createNativeCoordinatorResultPresenter,
  createAccountApiRoute,
  buildGlassHiveWorkActionSourceContext,
  configuredBackgroundWorkerRoute,
  backgroundWorkerResources,
  resolveBackgroundWorkerRoute,
  isConversationOrchestrationTool,
  nativeCoordinatorOutputFilesForMessage,
  nativeCoordinatorResultVoiceTurnId,
  buildCortexInsightDeliveryCandidates,
  normalizeInteractionSourceSegments,
  prepareMainAuthorContext,
} = require('@librechat/api');
const db = require('~/models');
const { EModelEndpoint } = require('librechat-data-provider');
const { loadAgent } = require('~/models/Agent');
const { getAppConfig } = require('~/server/services/Config');
const { initializeClient } = require('~/server/services/Endpoints/agents/initialize');
const {
  setTrustedInteractionContext,
  projectTrustedClientPresentation,
} = require('./interactionContext');
const {
  buildInheritedConversationContext,
  getMainContextAttemptState,
} = require('./ViventiumMainContextService');
const {
  declaredMcpServerNames,
  resolveHostToolCapabilityState,
  resolveConversationProviderUploadedFiles,
  resolveConversationProviderId,
  attachConversationProviderBootstrapBundle,
} = require('./GlassHiveConversationProviderService');
const {
  applyLocalMediaWorkerBootstrap,
  buildConversationProviderBootstrapBundle,
  mergeWorkerContextBundle,
  projectWorkerFeelingBundle,
  maybeInjectGlassHiveCapabilityBroker,
} = require('./GlassHiveCapabilityBootstrapService');
const { BROKER_AUTHORITY_KINDS } = require('./GlassHiveCapabilityBrokerAuth');
const {
  readCapabilityAuthorizationServerScope,
} = require('./GlassHiveCapabilityAuthorizationService');
const {
  reconcileGlassHiveLaunchResult,
  resolveConfiguredGlassHiveDestinations,
} = require('./GlassHiveCallbackBindingService');
const { invalidateActiveWorkSnapshot, requestAccountApi } = require('./GlassHiveAccountService');
const { createCortexFollowUpMessage } = require('./BackgroundCortexFollowUpService');
const {
  getCortexInsightDeliveriesForParent,
  claimPendingCortexInsightDeliveriesForParent,
} = require('./CortexInsightDeliveryService');
const { enqueueGlassHiveCallbackDelivery } = require('./GlassHiveCallbackDeliveryService');
const {
  bindNativeResultAuthority,
  nativeResultSource,
  presentationParent,
} = require('./nativeCoordinatorPresentation');

const bindings = () => mongoose.connection.collection('viventium_glasshive_callback_bindings');
const failure = (code) => Object.assign(new Error(code), { code, status: 503 });

async function prepareContext({ binding, source, eventId, purpose, workerWorkRef }) {
  const missionServerScope = workerWorkRef
    ? await readCapabilityAuthorizationServerScope({
        ownerId: binding.ownerId,
        workRef: workerWorkRef,
      })
    : null;
  if (workerWorkRef && missionServerScope === null)
    throw failure('coordinator_worker_capabilities_unavailable');
  const requestBody = source.requestBody;
  const presentationSurface =
    purpose === 'callback' && requestBody.viventiumSurface === 'voice'
      ? 'web'
      : requestBody.viventiumSurface || 'web';
  const user = await db.getUserById(binding.ownerId, '-password -__v -totpSecret -backupCodes');
  if (!user) throw failure('coordinator_owner_unavailable');
  const config = await getAppConfig({ role: user.role });
  const initialReq = {
    user: { ...user, id: binding.ownerId },
    config,
    headers: {},
    body: requestBody,
  };
  const agent = await loadAgent({
    req: initialReq,
    agent_id: binding.agentId,
    endpoint: EModelEndpoint.agents,
  });
  if (!agent) throw failure('coordinator_main_unavailable');
  const messages = await db.getMessages({
    user: binding.ownerId,
    conversationId: binding.conversationId,
  });
  const sourceSegments = normalizeInteractionSourceSegments(
    requestBody.viventiumTriggeringSourceSegments,
  ).segments;
  if (!sourceSegments.length) throw failure('coordinator_original_context_unavailable');
  let client;
  const context = await prepareMainAuthorContext(
    {
      ownerId: binding.ownerId,
      agent,
      conversationId: binding.conversationId,
      parentMessageId: requestBody.messageId || requestBody.parentMessageId,
      messageId: eventId,
      text: '',
      sourceEventId: requestBody.viventiumSourceEventId || sourceSegments.at(-1).source_event_id,
      sourceSegments,
      messages,
      request: { body: requestBody, headers: {} },
    },
    {
      readUser: async () => user,
      readConfig: async () => config,
      bindRequest: (req) => {
        setTrustedInteractionContext(req, {
          actor_kind: 'system',
          origin: purpose,
          surface: presentationSurface,
          conversation_id: binding.conversationId,
          source_event_id: eventId,
          source_segments: sourceSegments,
        });
        if (requestBody.viventiumSurface === 'telegram') req._viventiumTelegram = true;
        if (purpose === 'callback') {
          delete req.body.viventiumVoiceTaskId;
          delete req.body.viventiumCallSessionId;
          delete req.body.viventiumVoiceWorkAuthority;
          delete req.viventiumCallSession;
          req.body.voiceMode = false;
          req.body.viventiumInputMode = 'text';
        }
      },
      createClient: async (req, currentAgent) => {
        ({ client } = await initializeClient({
          req,
          res: { locals: {} },
          signal: new AbortController().signal,
          endpointOption: {
            endpoint: EModelEndpoint.agents,
            agent: Promise.resolve(currentAgent),
            model_parameters: currentAgent.model_parameters,
          },
        }));
        return client;
      },
    },
  );
  const { req } = context;
  const currentAgent = client.options.agent;
  const workerRoute = configuredBackgroundWorkerRoute(currentAgent);
  const workerAccess = workerRoute.workerAccess;
  const inheritedConversation =
    getMainContextAttemptState(req)?.inheritedConversation ||
    buildInheritedConversationContext({
      conversationId: binding.conversationId,
      messages: context.messages,
      sourceSegments,
    });
  const projectedBody = projectTrustedClientPresentation(
    { ...req.body, messageId: requestBody.messageId, parentMessageId: requestBody.parentMessageId },
    req,
  );
  const capability =
    config.endpoints?.agents?.providerCapabilities?.[resolveConversationProviderId(currentAgent)];
  if (!capability?.workspace_binding) throw failure('coordinator_capabilities_unavailable');
  const uploadedFiles = await resolveConversationProviderUploadedFiles(req, projectedBody, {
    includeHistory: true,
  });
  const host = await resolveHostToolCapabilityState({
    targetAgent: currentAgent,
    declarationSource: currentAgent,
    capability,
    req,
    uploadedFiles,
  });
  const hostTools = host.authorizedHostTools.filter(
    (name) => !isConversationOrchestrationTool(name),
  );
  const resources = Object.fromEntries(
    Object.entries(host.hostToolResources).filter(([name]) => hostTools.includes(name)),
  );
  const workerContext = {
    glasshive_worker_route: backgroundWorkerResources(workerRoute),
    glasshive_uploaded_files: uploadedFiles,
    glasshive_worker_memory: req._viventiumGlassHiveWorkerMemory || '',
    glasshive_worker_feelings: req._viventiumGlassHiveWorkerFeelings || '',
    glasshive_worker_feelings_enabled: req._viventiumGlassHiveWorkerFeelingsEnabled === true,
    glasshive_worker_feelings_hash: req._viventiumGlassHiveWorkerFeelingsHash || '',
    glasshive_worker_feelings_scope: req._viventiumGlassHiveWorkerFeelingsScope || 'unknown',
    glasshive_worker_feelings_range_prompt_override_count:
      req._viventiumGlassHiveWorkerFeelingsRangePromptOverrideCount || 0,
    glasshive_worker_feelings_active_range_prompt_override_count:
      req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideCount || 0,
    glasshive_worker_feelings_active_range_prompt_override_chars:
      req._viventiumGlassHiveWorkerFeelingsActiveRangePromptOverrideChars || 0,
    glasshive_host_tools: hostTools,
    glasshive_host_tool_resources: resources,
    glasshive_capability_dependency: req._viventiumGlassHiveCapabilityDependency || {},
  };
  const declaredServerNames = declaredMcpServerNames(currentAgent, capability.excluded_mcp_servers);
  const allowedServerNames =
    missionServerScope === null
      ? declaredServerNames
      : declaredServerNames.filter((name) => missionServerScope.includes(name));
  const bundle = await buildConversationProviderBootstrapBundle({
    user: req.user,
    requestBody: projectedBody,
    allowedServerNames,
    allowedHostTools: hostTools,
    hostToolResources: resources,
    allowedConversationOrchestrationTools: [],
    workerMemory: workerContext.glasshive_worker_memory,
    workerFeelings: workerContext.glasshive_worker_feelings,
    workerFeelingsEnabled: workerContext.glasshive_worker_feelings_enabled,
    workerFeelingsHash: workerContext.glasshive_worker_feelings_hash,
    workerFeelingsScope: workerContext.glasshive_worker_feelings_scope,
    capabilityDependency: workerContext.glasshive_capability_dependency,
  });
  if (purpose === 'worker')
    applyLocalMediaWorkerBootstrap(bundle, binding.configuration?.scope?.execution_mode);
  if ((allowedServerNames.length || hostTools.length) && !bundle.glasshive_capability_broker)
    throw failure('coordinator_capabilities_unavailable');
  if (workerContext.glasshive_uploaded_files.length)
    bundle.glasshive_upload_context = {
      tool_uploaded_files: workerContext.glasshive_uploaded_files,
    };
  const transportMessages = context.messages
    .map((message) => ({
      role:
        { human: 'user', ai: 'assistant' }[message._getType?.()] ||
        message._getType?.() ||
        message.role,
      content: message.content,
      ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}),
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    }))
    .filter((message) => message.content !== '');
  return {
    ...context,
    presentationSurface,
    ...(workerAccess === 'full'
      ? { accessMode: 'full' }
      : workerAccess === 'ask'
        ? { accessMode: 'workspace' }
        : {}),
    messages: transportMessages,
    inheritedConversation,
    bundle,
    user: req.user,
    requestBody: projectedBody,
    workerContext,
    presentationContext: { req, agent: currentAgent, messages },
  };
}

const presentationDependencies = {
  async readPresentation({ ownerId, conversationId, parentMessageId, deliveryIds }) {
    let rows = (
      await getCortexInsightDeliveriesForParent({ ownerId, parentMessageId, deliveryIds })
    ).filter(
      (row) =>
        row.conversationId === conversationId &&
        row.parentMessageId === parentMessageId &&
        deliveryIds.includes(row.deliveryId),
    );
    if (rows.length !== deliveryIds.length) return null;
    if (
      rows.every(
        (row) =>
          row.status === 'dropped' &&
          row.dropReason !== 'delivery_attempts_exhausted' &&
          typeof row.dropReason === 'string' &&
          row.dropReason.trim(),
      )
    )
      return { presentationDisposition: 'dropped', dropReason: rows[0].dropReason };
    if (rows.some((row) => !row.persistedMessageId)) {
      const savedOwner = require('./NativeCoordinatorPresentationService');
      const scope = { ownerId, conversationId, parentMessageId, deliveryIds };
      const retained = await savedOwner.resolve(scope);
      if (retained && !retained.eligible) throw failure('coordinator_presentation_unavailable');
      if (!retained?.message) return null;
      await savedOwner.recover(scope);
      rows = await getCortexInsightDeliveriesForParent({ ownerId, parentMessageId, deliveryIds });
      if (
        rows.length !== deliveryIds.length ||
        rows.some(
          (row) =>
            row.conversationId !== conversationId ||
            row.parentMessageId !== parentMessageId ||
            !deliveryIds.includes(row.deliveryId) ||
            !row.persistedMessageId,
        )
      )
        throw failure('coordinator_presentation_unconfirmed');
    }
    const ids = new Set(rows.map((row) => row.persistedMessageId));
    if (ids.size !== 1) throw failure('coordinator_presentation_conflict');
    const [message] = await db.getMessages({
      user: ownerId,
      conversationId,
      messageId: [...ids][0],
      isCreatedByUser: false,
    });
    if (
      !message ||
      String(message.user || '') !== ownerId ||
      message.conversationId !== conversationId ||
      presentationParent(message) !== parentMessageId ||
      deliveryIds.some((id) => !message.metadata?.viventium?.cortexInsightDeliveryIds?.includes(id))
    )
      throw failure('coordinator_presentation_unavailable');
    return message;
  },
  createFollowUp: async ({
    context,
    binding,
    source,
    parentMessageId,
    eventId,
    insights,
    outputFiles,
    publisher,
    data,
  }) => {
    const currentOutputFiles = outputFiles
      ? nativeCoordinatorOutputFilesForMessage(
          outputFiles,
          {
            ownerId: binding.ownerId,
            conversationId: binding.nativeConversationId,
            runId: data.run_id,
            publisher,
          },
          {
            userId: binding.ownerId,
            conversationId: binding.conversationId,
            responseMessageId: parentMessageId,
            agentId: binding.agentId,
          },
        ).sourceEnvelope
      : null;
    const authorizedResultFiles =
      currentOutputFiles?.files.map((file) => ({
        run_id: currentOutputFiles.run_id,
        attempt_id: currentOutputFiles.attempt_id,
        sha256: file.sha256,
      })) || [];
    const candidates = buildCortexInsightDeliveryCandidates({
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      parentMessageId,
      surface: context.req.body?.viventiumSurface || 'web',
      insights,
    });
    const existing =
      (await getCortexInsightDeliveriesForParent({
        ownerId: binding.ownerId,
        parentMessageId,
        deliveryIds: candidates.map((candidate) => candidate.deliveryId),
      })) || [];
    const scopes = new Set(existing.map((row) => row.publicationId || ''));
    if (scopes.size > 1 || (existing.length && existing.length !== candidates.length))
      throw failure('coordinator_presentation_authority_conflict');
    const publicationId = existing.length ? [...scopes][0] : eventId;
    const claimedDeliveryBatch = existing.length
      ? await claimPendingCortexInsightDeliveriesForParent({
          ownerId: binding.ownerId,
          parentMessageId,
          deliveryIds: candidates.map((candidate) => candidate.deliveryId),
          surface: context.req.body?.viventiumSurface || 'web',
        })
      : null;
    if (claimedDeliveryBatch && !claimedDeliveryBatch.claimed?.length) return null;
    return createCortexFollowUpMessage({
      req: context.req,
      agent: context.agent,
      conversationId: binding.conversationId,
      parentMessageId,
      deliveryParentMessageId: parentMessageId,
      publicationId,
      ...(claimedDeliveryBatch ? { claimedDeliveryBatch } : {}),
      runId: eventId,
      insightsData: { insights, errors: [], cortexCount: insights.length },
      recentResponse: '',
      forceVisibleFollowUp: true,
      allowMovedOnUsefulFollowUp: true,
      authorizedResultFiles,
      dependencies: {
        saveMessage: (req, message, options) =>
          db.saveMessage(req, bindNativeResultAuthority(message, binding, source, data), options),
        ...(currentOutputFiles
          ? {
              prepareAttachments: async (message) => {
                const {
                  prepareNativeOutputFiles,
                  prepareMissionOutputFiles,
                } = require('./nativeOutputFiles');
                const selected = nativeCoordinatorOutputFilesForMessage(
                  currentOutputFiles,
                  {
                    ownerId: binding.ownerId,
                    conversationId: binding.nativeConversationId,
                    runId: data.run_id,
                    publisher,
                  },
                  {
                    userId: binding.ownerId,
                    conversationId: binding.conversationId,
                    responseMessageId: message.messageId,
                    agentId: message.agent_id,
                  },
                );
                const attachments = await prepareNativeOutputFiles(
                  context.req,
                  selected.envelope,
                  selected.identity,
                  { route: createAccountApiRoute({ ownerId: binding.ownerId }) },
                );
                return prepareMissionOutputFiles({
                  req: context.req,
                  rows: [],
                  message,
                  sourceMessageId: parentMessageId,
                  initialImports: [
                    {
                      envelope: selected.envelope,
                      identity: selected.identity,
                      attachments,
                    },
                  ],
                });
              },
            }
          : {}),
      },
    });
  },
  async enqueue({ binding, source, eventId, message, data }) {
    message = await require('./NativeCoordinatorPresentationService').persistAuthority(
      message,
      binding,
      source,
      data,
    );
    const destinations = await resolveConfiguredGlassHiveDestinations({
      ownerId: binding.ownerId,
      requestBody: source.requestBody,
    });
    const linkedDestinations = destinations.filter(
      (destination) => destination.surface !== 'voice',
    );
    const sourceCallSessionId =
      source.requestBody.viventiumCallSessionId ||
      source.requestBody.viventiumVoiceCallSessionId ||
      '';
    const nativeCoordinatorResult = nativeResultSource(binding, source, data);
    const mainGenerationPresentation = { nativeCoordinatorResult };
    if (
      source.requestBody.viventiumSurface === 'voice' &&
      sourceCallSessionId &&
      message.text?.trim()
    ) {
      const activeCall = await require('./CallSessionService').getActiveCallSessionForConversation({
        userId: binding.ownerId,
        conversationId: binding.conversationId,
      });
      if (
        activeCall?.callSessionId === sourceCallSessionId &&
        activeCall.userId === binding.ownerId &&
        activeCall.conversationId === binding.conversationId
      ) {
        linkedDestinations.push({
          surface: 'voice',
          voiceCallSessionId: sourceCallSessionId,
          voiceRequestId: nativeCoordinatorResultVoiceTurnId(
            nativeCoordinatorResult,
            message.messageId,
          ),
        });
      }
    }
    if (
      !linkedDestinations.some((destination) => ['telegram', 'voice'].includes(destination.surface))
    ) {
      const linkedWebCommitted = linkedDestinations.some((destination) =>
        ['librechat', 'workbench'].includes(destination.surface),
      );
      if (linkedWebCommitted) {
        await require('./NativeCoordinatorPresentationService').settleLinkedWeb({
          ownerId: binding.ownerId,
          conversationId: binding.conversationId,
          parentMessageId: presentationParent(message),
          deliveryIds: message.metadata?.viventium?.cortexInsightDeliveryIds,
        });
      }
      return {
        configured: 0,
        enqueued: 0,
        unresolved: 0,
        linkedWebCommitted,
      };
    }
    return enqueueGlassHiveCallbackDelivery({
      body: { callback_id: eventId, event: 'main.followup', origin_ref: binding._id },
      message,
      text: message.text || '',
      fullText: '',
      deliveryContext: {
        ownerId: binding.ownerId,
        originRef: binding._id,
        conversationId: binding.conversationId,
        anchorMessageId: source.requestBody.messageId,
        requestedParentMessageId: source.requestBody.parentMessageId,
        inputMode: source.requestBody.viventiumInputMode,
        destinations: linkedDestinations,
        mainGenerationPresentation,
      },
    });
  },
};
const presentResult = createNativeCoordinatorResultPresenter(presentationDependencies);

module.exports = createNativeCoordinatorContextAdapter({
  readBinding: (ownerId, nativeConversationId) =>
    bindings().findOne({
      kind: 'native_coordinator_binding',
      ownerId,
      nativeConversationId,
      tenantId: process.env.VIVENTIUM_TENANT_ID || 'local',
      active: true,
    }),
  readSource: (bindingRef, turnId) =>
    bindings().findOne({
      _id: `${bindingRef}:${turnId}`,
      kind: 'native_coordinator_source',
      bindingRef,
      turnId,
    }),
  prepareContext,
  async prepareActionSourceContext(input) {
    const originRef = await require('./GlassHiveActiveWorkProjectionService').getCoreWorkOriginRef(
      input,
    );
    return buildGlassHiveWorkActionSourceContext(input, originRef);
  },
  async prepareActionBundle(context) {
    const bundle = mergeWorkerContextBundle({
      existingBundle: {
        ...context.bundle,
        application_context_format: 'opaque_v1',
        inherited_conversation: context.inheritedConversation,
      },
      workerMemory: context.workerContext.glasshive_worker_memory,
      workerFeelings: context.workerContext.glasshive_worker_feelings,
    });
    projectWorkerFeelingBundle({
      bundle,
      workerFeelings: context.workerContext.glasshive_worker_feelings,
      workerFeelingsScope: context.workerContext.glasshive_worker_feelings_scope,
    });
    if (process.env.VIVENTIUM_XPERFECT_SCHEDULED_WAKES_ENABLED === 'true') {
      await require('./ScheduleDueService').applyConversationScheduleAccess({
        bundle,
        user: context.user,
        requestBody: context.requestBody,
      });
    }
    return bundle;
  },
  signBundle(bundle) {
    const targetAgent = { model_parameters: {} };
    if (!attachConversationProviderBootstrapBundle({ targetAgent, bundle }))
      throw failure('coordinator_bootstrap_unavailable');
    return targetAgent.model_parameters.configuration.defaultHeaders;
  },
  injectDelegation: ({
    toolArguments,
    user,
    requestBody,
    workerContext,
    invocationId,
    route,
    preparationAuthority,
  }) =>
    maybeInjectGlassHiveCapabilityBroker({
      serverName:
        String(process.env.VIVENTIUM_GLASSHIVE_MCP_SERVER_NAMES || 'glasshive-workers-projects')
          .split(',')
          .map((value) => value.trim())
          .find(Boolean) || 'glasshive-workers-projects',
      toolName: 'worker_delegate_once',
      toolArguments: {
        ...toolArguments,
        ...(workerContext.glasshive_uploaded_files?.length
          ? { uploaded_files: workerContext.glasshive_uploaded_files }
          : {}),
      },
      config: {
        toolCall: { id: invocationId, name: 'worker_delegate_once', turn: 0 },
        configurable: {
          ...workerContext,
          user,
          requestBody,
          glasshive_launch_authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
          ...(preparationAuthority
            ? { glasshive_launch_preparation_authority: preparationAuthority }
            : {}),
          glasshive_worker_route: resolveBackgroundWorkerRoute(
            { profile: route.profile, effort: route.effort },
            {
              worker_access: workerContext.glasshive_worker_route?.worker_access,
              worker_profile: route.profile,
              worker_model: route.model,
              worker_reasoning_effort: route.effort,
            },
          ).authority,
        },
      },
    }),
  reconcile: reconcileGlassHiveLaunchResult,
  invalidate: (ownerId) => invalidateActiveWorkSnapshot({ ownerId }),
  request: (ownerId, path) => requestAccountApi({ ownerId, path, maxResponseBytes: null }),
  presentResult,
});
module.exports.enqueueSavedNativeCoordinatorPresentation = presentationDependencies.enqueue;
/* === VIVENTIUM END === */
