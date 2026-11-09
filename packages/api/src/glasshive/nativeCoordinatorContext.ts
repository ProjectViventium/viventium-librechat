/* === VIVENTIUM START === Current application context over ordinary Native transports. === */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { NativeCoordinatorBinding, NativeCoordinatorSource } from './nativeCoordinator';
import type { GlassHiveLaunchPreparationAuthority } from './callbackBinding';
import { buildCortexInsightDeliveryCandidates } from '../cortex/insightDeliveryService';
import { buildGlassHiveWorkActionRequest } from './workActionService';
import { inheritNativeConversationCapabilityInventory } from './nativeConversationInstructions';

type ObjectValue = Record<string, unknown>;
const object = z.record(z.unknown());
const identifier = z.string().min(1).max(200);
const sourceReference = z.object({ source_turn_id: identifier });
const routeSchema = z.object({
  id: identifier,
  profile: identifier,
  model: identifier,
  effort: identifier,
  execution_mode: z.enum(['host', 'docker']),
  resource_class: z.enum(['standard', 'light']),
  connection_id: z.string().optional(),
});
const dispatchSchema = z.object({
  conversation_id: identifier,
  goal_id: identifier,
  source_turn_id: identifier,
  request_ref: identifier,
  goal: z.string().min(1),
  instruction: z.string().min(1),
  dispatch_digest: z.string().min(1),
  route: routeSchema,
  guidance: z.string().nullish(),
  notification_ref: identifier.optional(),
  redispatch_generation: z.number().int().nonnegative().optional(),
});
const resultSchema = z.object({
  conversation_id: identifier,
  request_ref: identifier,
  goal_id: identifier,
  run_id: identifier,
  result_revision: z.number().int().positive(),
  result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const turnResultSchema = z
  .object({
    conversation_id: identifier,
    request_ref: identifier,
    turn_id: identifier,
    request_id: identifier,
    run_id: identifier,
    result_revision: z.number().int().positive(),
    result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
type NativeCoordinatorResultData = z.infer<typeof resultSchema> | z.infer<typeof turnResultSchema>;

export function nativeCoordinatorResultEventId(data: NativeCoordinatorResultData): string {
  return 'turn_id' in data
    ? `native-turn-result:${data.conversation_id}:${data.turn_id}:${data.request_id}:${data.run_id}:${data.result_revision}`
    : `native-result:${data.conversation_id}:${data.goal_id}:${data.run_id}:${data.result_revision}`;
}
const actionSchema = z.object({
  conversation_id: identifier,
  request_ref: identifier,
  goal_id: identifier,
  source_turn_id: identifier,
  run_id: identifier,
  action_key: identifier,
  action_digest: z.string().min(1),
  state: z.string(),
  action_request: object.optional(),
  control: z.object({
    action: z.enum(['queue', 'message', 'steer', 'retry']),
    message: z.string(),
    run_id: identifier,
    idempotency_key: identifier,
  }),
});

export interface NativeCoordinatorPreparedContext {
  presentationSurface?: string;
  accessMode?: 'full' | 'workspace';
  instructions: string;
  memoryContext: string;
  developerInstructionTail?: string;
  messages: ObjectValue[];
  inheritedConversation: ObjectValue;
  bundle: ObjectValue;
  user: ObjectValue;
  requestBody: ObjectValue;
  workerContext: ObjectValue;
  presentationContext: object;
}

export interface NativeCoordinatorContextDependencies {
  readBinding(
    ownerId: string,
    nativeConversationId: string,
  ): Promise<NativeCoordinatorBinding | null>;
  readSource(bindingRef: string, turnId: string): Promise<NativeCoordinatorSource | null>;
  prepareContext(input: {
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource;
    eventId: string;
    purpose: 'worker' | 'callback';
    workerWorkRef?: string;
  }): Promise<NativeCoordinatorPreparedContext>;
  signBundle(bundle: ObjectValue): Record<string, string>;
  prepareActionBundle(context: NativeCoordinatorPreparedContext): Promise<ObjectValue>;
  prepareActionSourceContext(input: {
    ownerId: string;
    workRef: string;
    action: string;
    operationId: string;
    sourceSurface: string;
  }): Promise<ObjectValue | null>;
  injectDelegation(input: {
    toolArguments: ObjectValue;
    user: ObjectValue;
    requestBody: ObjectValue;
    workerContext: ObjectValue;
    invocationId: string;
    route: z.infer<typeof routeSchema>;
    preparationAuthority?: GlassHiveLaunchPreparationAuthority;
  }): Promise<ObjectValue>;
  reconcile(input: {
    toolArguments: ObjectValue;
    result: ObjectValue;
  }): Promise<{ workRef?: string } | null>;
  invalidate(ownerId: string): void;
  request(ownerId: string, path: string): Promise<ObjectValue>;
  presentResult(input: {
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource;
    data: NativeCoordinatorResultData;
    text: string;
    eventId: string;
    outputFiles?: ObjectValue;
    publisher?: ObjectValue;
    state?: string;
    failureClass?: string;
    context: NativeCoordinatorPreparedContext;
  }): Promise<void>;
}

function unavailable(code: string): Error & { code: string; status: number } {
  return Object.assign(new Error(code), { code, status: 503 });
}
const segment = (value: string) => encodeURIComponent(value);

function assertNativeScope(binding: NativeCoordinatorBinding, data: ObjectValue) {
  if (
    !binding.active ||
    !binding.nativeConversationId ||
    data.conversation_id !== binding.nativeConversationId ||
    data.request_ref !== binding._id
  )
    throw unavailable('coordinator_context_scope_mismatch');
}

export async function readNativeCoordinatorGoalSnapshot(
  input: { ownerId: string; conversationId: string; goalId: string },
  request: NativeCoordinatorContextDependencies['request'],
) {
  const snapshot = await request(
    input.ownerId,
    `/v1/coordinator/conversations/${segment(input.conversationId)}?include_history=false`,
  );
  if (snapshot.conversation_id !== input.conversationId || !Array.isArray(snapshot.goals))
    throw unavailable('coordinator_goal_unavailable');
  const matches = z
    .array(object)
    .parse(snapshot.goals)
    .filter((goal) => goal.goal_id === input.goalId);
  if (matches.length !== 1) throw unavailable('coordinator_goal_unavailable');
  return matches[0];
}

export function nativeCoordinatorResultEvidence(input: {
  text: string;
  state?: string;
  failureClass?: string;
  runId: string;
  resultRevision: number;
  resultDigest: string;
}): string {
  return (
    input.text ||
    JSON.stringify({
      native_result: {
        state: input.state || '',
        failure_class: input.failureClass || '',
        run_id: input.runId,
        result_revision: input.resultRevision,
        result_digest: input.resultDigest,
        output_text: input.text,
      },
    })
  );
}

export async function readNativeCoordinatorGoalResult(
  input: {
    ownerId: string;
    conversationId: string;
    goalId: string;
    runId?: string;
    expectedDigest?: string;
    resultRevision?: number;
  },
  request: NativeCoordinatorContextDependencies['request'],
) {
  const goalPath = `/v1/coordinator/conversations/${segment(input.conversationId)}/goals/${segment(input.goalId)}`;
  const goal = await readNativeCoordinatorGoalSnapshot(input, request);
  const runId = identifier.parse(input.runId || goal.run_id);
  if (
    ((input.expectedDigest || input.resultRevision !== undefined) && goal.run_id !== runId) ||
    (input.resultRevision !== undefined && goal.result_revision !== input.resultRevision)
  )
    throw unavailable('coordinator_result_changed');
  const result = await readNativeCoordinatorResultPages(
    {
      ownerId: input.ownerId,
      path: goalPath,
      runId,
      expectedDigest: input.expectedDigest,
      expectedResultRevision: input.resultRevision,
      initialState: String(goal.state || ''),
      matches: (page) => page.goal_id === input.goalId,
    },
    request,
  );
  return {
    ...result,
    runId,
    resultRevision: input.resultRevision,
    sourceTurnId: sourceReference.parse(goal).source_turn_id,
  };
}

async function readNativeCoordinatorResultPages(
  input: {
    ownerId: string;
    path: string;
    runId: string;
    requestId?: string;
    expectedDigest?: string;
    expectedResultRevision?: number;
    initialState?: string;
    matches(page: ObjectValue): boolean;
  },
  request: NativeCoordinatorContextDependencies['request'],
) {
  let offset = 0;
  let resultDigest = input.expectedDigest || '';
  const chunks: string[] = [];
  let state = input.initialState || '';
  let failureClass = '';
  let outputFiles: ObjectValue | undefined;
  let publisher: ObjectValue | undefined;
  for (;;) {
    const page = await request(
      input.ownerId,
      `${input.path}/result?offset=${offset}&max_chars=64000&run_id=${segment(input.runId)}${input.requestId ? `&request_id=${segment(input.requestId)}` : ''}`,
    );
    const digest = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(page.sha256);
    if (!resultDigest) resultDigest = `sha256:${digest}`;
    if (
      page.run_id !== input.runId ||
      (input.expectedResultRevision !== undefined &&
        page.result_revision !== input.expectedResultRevision) ||
      !input.matches(page) ||
      page.offset !== offset ||
      `sha256:${digest}` !== resultDigest ||
      typeof page.output_text !== 'string'
    )
      throw unavailable('coordinator_result_changed');
    chunks.push(page.output_text);
    if (page.publisher != null) {
      const currentPublisher = object.parse(page.publisher);
      if (publisher && JSON.stringify(currentPublisher) !== JSON.stringify(publisher))
        throw unavailable('coordinator_result_files_changed');
      publisher = currentPublisher;
    }
    if (page.output_files != null) {
      const files = object.parse(page.output_files);
      if (outputFiles && JSON.stringify(files) !== JSON.stringify(outputFiles))
        throw unavailable('coordinator_result_files_changed');
      outputFiles = files;
    }
    state = String(page.state || state);
    failureClass = String(page.failure_class || '');
    if (page.next_offset === null) break;
    if (!Number.isSafeInteger(page.next_offset) || Number(page.next_offset) <= offset)
      throw unavailable('coordinator_result_page_invalid');
    offset = Number(page.next_offset);
  }
  const outputText = chunks.join('');
  if (`sha256:${createHash('sha256').update(outputText).digest('hex')}` !== resultDigest)
    throw unavailable('coordinator_result_changed');
  return { outputText, resultDigest, state, failureClass, outputFiles, publisher };
}

/** A selected accepted Native turn is its real result source; no goal or Worker is invented. */
export async function readNativeCoordinatorTurnResult(
  input: {
    ownerId: string;
    conversationId: string;
    turnId: string;
    requestId: string;
    runId: string;
    expectedDigest: string;
    resultRevision: number;
  },
  request: NativeCoordinatorContextDependencies['request'],
) {
  let sourceTurnId = '';
  const result = await readNativeCoordinatorResultPages(
    {
      ownerId: input.ownerId,
      path: `/v1/coordinator/conversations/${segment(input.conversationId)}/turns/${segment(input.turnId)}`,
      runId: input.runId,
      requestId: input.requestId,
      expectedDigest: input.expectedDigest,
      matches(page) {
        const currentSource = sourceReference.parse(page).source_turn_id;
        const publisher = object.parse(page.publisher);
        if (!sourceTurnId) sourceTurnId = currentSource;
        return (
          page.turn_id === input.turnId &&
          page.request_id === input.requestId &&
          currentSource === sourceTurnId &&
          page.state === 'completed' &&
          page.intent_state === 'accepted' &&
          page.restore_hold === false &&
          page.superseded === false &&
          page.presentation_eligible === true &&
          page.result_revision === input.resultRevision &&
          publisher.owner_id === input.ownerId &&
          publisher.conversation_id === input.conversationId &&
          publisher.agent_id === 'coordinator' &&
          publisher.request_id === input.requestId &&
          publisher.message_id === input.turnId &&
          publisher.stream_id === input.turnId &&
          publisher.run_id === input.runId
        );
      },
    },
    request,
  );
  if (result.state !== 'completed') throw unavailable('coordinator_result_changed');
  return { ...result, runId: input.runId, resultRevision: input.resultRevision, sourceTurnId };
}

/** No task rewriting or launch decisions occur here. Native owns accepted turns, goals and routes. */
export function createNativeCoordinatorContextAdapter(deps: NativeCoordinatorContextDependencies) {
  async function ownedSource(binding: NativeCoordinatorBinding, turnId: string) {
    const source = await deps.readSource(binding._id, turnId);
    if (
      !source ||
      source.kind !== 'native_coordinator_source' ||
      source.bindingRef !== binding._id ||
      source.turnId !== turnId ||
      source.requestBody.conversationId !== binding.conversationId ||
      source.requestBody.agent_id !== binding.agentId
    )
      throw unavailable('coordinator_source_unavailable');
    return source;
  }

  async function prepareNativeCoordinatorTurn({
    binding,
    source,
    turn,
  }: {
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource | null;
    turn: ObjectValue;
  }) {
    assertNativeScope(binding, turn);
    const turnId = identifier.parse(turn.turn_id);
    const sourceTurnId = identifier.parse(turn.source_turn_id || turnId);
    if (
      !source ||
      source._id !== `${binding._id}:${sourceTurnId}` ||
      source.bindingRef !== binding._id ||
      source.turnId !== sourceTurnId
    )
      throw unavailable('coordinator_source_unavailable');
    const owned = await ownedSource(binding, sourceTurnId);
    const context = await deps.prepareContext({
      binding,
      source: owned,
      eventId: turnId,
      purpose: 'worker',
    });
    const headers = {
      ...deps.signBundle(
        inheritNativeConversationCapabilityInventory(
          {
            ...context.bundle,
            application_context_format: 'opaque_v1',
            provider_capabilities: { native_tools: true },
            inherited_conversation: context.inheritedConversation,
          },
          { nativeTools: true },
        ),
      ),
    };
    const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
    if (!encoded) throw unavailable('coordinator_bootstrap_unavailable');
    delete headers['X-GlassHive-Bootstrap-Bundle-B64'];
    const body = {
      model: identifier.parse(binding.configuration.model),
      reasoning_effort: identifier.parse(binding.configuration.effort),
      stream: false,
      messages: [
        ...[context.instructions, context.memoryContext]
          .filter(Boolean)
          .map((content) => ({ role: 'system', content })),
        ...context.messages,
      ],
      metadata: {
        owner_id: binding.ownerId,
        tenant_id: binding.tenantId,
        conversation_id: binding.nativeConversationId,
        agent_id: 'coordinator',
        message_id: turnId,
        stream_id: turnId,
        idempotency_key: `${binding.nativeConversationId}:${turnId}`,
        surface: 'coordinator',
        actor_kind: 'system',
        origin: 'worker',
        ...(context.developerInstructionTail
          ? { developer_instruction_tail: context.developerInstructionTail }
          : {}),
        ...(context.accessMode ? { glasshive_options: { access: context.accessMode } } : {}),
        bootstrap_bundle_b64: encoded,
      },
    };
    return { body, headers };
  }

  async function actionCarrier(context: NativeCoordinatorPreparedContext, body: ObjectValue) {
    const headers = { ...deps.signBundle(await deps.prepareActionBundle(context)) };
    const encoded = headers['X-GlassHive-Bootstrap-Bundle-B64'];
    if (!encoded) throw unavailable('coordinator_bootstrap_unavailable');
    delete headers['X-GlassHive-Bootstrap-Bundle-B64'];
    return { body: { ...body, application_bootstrap_bundle_b64: encoded }, headers };
  }

  async function prepareNativeCoordinatorAction({
    binding,
    action: raw,
  }: {
    binding: NativeCoordinatorBinding;
    action: ObjectValue;
  }) {
    const action = actionSchema.parse(raw);
    assertNativeScope(binding, action);
    if (
      action.run_id !== action.control.run_id ||
      action.action_key !== action.control.idempotency_key
    )
      throw unavailable('coordinator_action_changed');
    const source = await ownedSource(binding, action.source_turn_id);
    const goal = await readNativeCoordinatorGoalSnapshot(
      { ownerId: binding.ownerId, conversationId: action.conversation_id, goalId: action.goal_id },
      deps.request,
    );
    if (
      (goal.control_run_id || goal.run_id) !== action.run_id ||
      !goal.work_ref ||
      sourceReference.parse(goal).source_turn_id !== action.source_turn_id
    )
      throw unavailable('coordinator_action_work_unavailable');
    let body = action.action_request;
    if (!body) {
      const sourceContext = await deps.prepareActionSourceContext({
        ownerId: binding.ownerId,
        workRef: identifier.parse(goal.work_ref),
        action: action.control.action,
        operationId: action.action_key,
        sourceSurface: String(source.requestBody.viventiumSurface || 'web'),
      });
      body = buildGlassHiveWorkActionRequest({
        action: action.control.action,
        instruction: action.control.message,
        idempotencyKey: action.action_key,
        sourceContext,
      });
    }
    if (
      body.action !== action.control.action ||
      body.idempotencyKey !== action.action_key ||
      String(body.instruction || '') !== action.control.message
    )
      throw unavailable('coordinator_action_changed');
    const prepared = await deps.prepareContext({
      binding,
      source,
      eventId: `native-action:${binding.nativeConversationId}:${action.goal_id}:${action.action_key}`,
      purpose: 'worker',
      workerWorkRef: identifier.parse(goal.work_ref),
    });
    const context = body.inheritedConversation
      ? { ...prepared, inheritedConversation: object.parse(body.inheritedConversation) }
      : prepared;
    return actionCarrier(context, body);
  }

  async function prepareNativeCoordinatorWorkAction(input: {
    ownerId: string;
    nativeConversationId: string;
    goalId: string;
    body: ObjectValue;
  }) {
    const action = z.string().parse(input.body.action);
    if (!['queue', 'message', 'steer', 'retry', 'resume'].includes(action))
      return { body: input.body, headers: {} };
    const binding = await deps.readBinding(input.ownerId, input.nativeConversationId);
    if (
      !binding ||
      !binding.active ||
      binding.ownerId !== input.ownerId ||
      binding.nativeConversationId !== input.nativeConversationId
    )
      throw unavailable('coordinator_binding_unavailable');
    const goal = await readNativeCoordinatorGoalSnapshot(
      { ownerId: input.ownerId, conversationId: input.nativeConversationId, goalId: input.goalId },
      deps.request,
    );
    const source = await ownedSource(binding, sourceReference.parse(goal).source_turn_id);
    const prepared = await deps.prepareContext({
      binding,
      source,
      eventId: `native-action:${input.nativeConversationId}:${input.goalId}:${identifier.parse(input.body.idempotencyKey)}`,
      purpose: 'worker',
      workerWorkRef: identifier.parse(goal.work_ref),
    });
    const context = input.body.inheritedConversation
      ? { ...prepared, inheritedConversation: object.parse(input.body.inheritedConversation) }
      : prepared;
    return actionCarrier(context, input.body);
  }

  async function prepareNativeCoordinatorDispatch({
    binding,
    dispatch: raw,
    notificationExpiresAt,
  }: {
    binding: NativeCoordinatorBinding;
    dispatch: ObjectValue;
    notificationExpiresAt?: string;
  }) {
    const dispatch = dispatchSchema.parse(raw);
    const preparationAuthority: GlassHiveLaunchPreparationAuthority | undefined =
      dispatch.notification_ref && notificationExpiresAt
        ? {
            kind: 'native_coordinator_dispatch',
            generation: dispatch.redispatch_generation || 0,
            notificationRef: dispatch.notification_ref,
            expiresAt: notificationExpiresAt,
          }
        : undefined;
    if (dispatch.redispatch_generation && !preparationAuthority)
      throw unavailable('coordinator_dispatch_retry_authority_missing');
    assertNativeScope(binding, dispatch);
    const configuredRoutes = z.array(routeSchema).parse(binding.configuration.routes);
    const configured = configuredRoutes.find((route) => route.id === dispatch.route.id);
    if (
      !configured ||
      Object.keys(routeSchema.shape).some(
        (key) =>
          String(configured[key as keyof typeof configured] || '') !==
          String(dispatch.route[key as keyof typeof configured] || ''),
      )
    )
      throw unavailable('coordinator_route_changed');
    const source = await ownedSource(binding, dispatch.source_turn_id);
    const invocationId = `${binding.nativeConversationId}:${dispatch.goal_id}`;
    const context = await deps.prepareContext({
      binding,
      source,
      eventId: invocationId,
      purpose: 'worker',
    });
    const inheritedConversation = dispatch.guidance
      ? {
          ...context.inheritedConversation,
          sources: [
            ...z.array(object).parse(context.inheritedConversation.sources),
            {
              id: `coordinator-guidance:${binding.nativeConversationId}:${dispatch.goal_id}`,
              role: 'context',
              kind: 'coordinator_guidance',
              text: dispatch.guidance,
            },
          ],
        }
      : context.inheritedConversation;
    const effective = await deps.injectDelegation({
      toolArguments: {
        title: dispatch.goal_id,
        goal: dispatch.goal,
        instruction: dispatch.instruction,
        profile: dispatch.route.profile,
        effort: dispatch.route.effort,
        resource_class: dispatch.route.resource_class,
        execution_mode: dispatch.route.execution_mode,
        bootstrap_bundle_json: { application_context_format: 'opaque_v1' },
        reuse_existing_workspace: false,
        require_callback: true,
        expose_diagnostics: false,
      },
      user: context.user,
      requestBody: context.requestBody,
      workerContext: {
        ...context.workerContext,
        glasshive_inherited_conversation: inheritedConversation,
      },
      invocationId,
      route: dispatch.route,
      ...(preparationAuthority ? { preparationAuthority } : {}),
    });
    const originalBundle = object.parse(effective.bootstrap_bundle_json);
    if (originalBundle.application_context_format !== 'opaque_v1')
      throw unavailable('coordinator_context_format_unavailable');
    const bundle: ObjectValue = { ...originalBundle };
    if (typeof bundle.inherited_conversation === 'string') {
      bundle.inherited_conversation = object.parse(JSON.parse(bundle.inherited_conversation));
    }
    if (Array.isArray(effective.uploaded_files) && effective.uploaded_files.length) {
      bundle.glasshive_upload_context = {
        ...(bundle.glasshive_upload_context ? object.parse(bundle.glasshive_upload_context) : {}),
        tool_uploaded_files: effective.uploaded_files,
      };
    }
    const identity = z
      .object({ idempotency_key: z.string().min(1) })
      .parse(bundle.viventium_delegation_identity);
    const originRef = z
      .object({ origin_ref: z.string().min(1) })
      .parse(bundle.callbacks).origin_ref;
    const delegation = {
      title: effective.title,
      goal: effective.goal,
      instruction: effective.instruction,
      profile: effective.profile,
      execution_mode: effective.execution_mode,
      resource_class: effective.resource_class,
      ...(effective.worker_name ? { worker_name: effective.worker_name } : {}),
      ...(effective.worker_role ? { worker_role: effective.worker_role } : {}),
      ...(effective.workspace_root ? { workspace_root: effective.workspace_root } : {}),
      ...(effective.bootstrap_profile ? { bootstrap_profile: effective.bootstrap_profile } : {}),
      bootstrap_bundle: bundle,
      origin_ref: originRef,
      origin_surface: String(source.requestBody.viventiumSurface || 'web'),
      file_upload_ids: Array.isArray(effective.file_upload_ids) ? effective.file_upload_ids : [],
    };
    return {
      delegation,
      headers: { 'Idempotency-Key': identity.idempotency_key },
      context: effective,
    };
  }

  async function recordNativeCoordinatorDispatch({
    binding,
    work,
    context,
  }: {
    binding: NativeCoordinatorBinding;
    work: ObjectValue;
    context: unknown;
  }) {
    const receipt = await deps.reconcile({ toolArguments: object.parse(context), result: work });
    if (!receipt?.workRef) throw unavailable('coordinator_launch_unconfirmed');
    deps.invalidate(binding.ownerId);
  }

  async function publishNativeCoordinatorResult({
    binding,
    data: raw,
  }: {
    binding: NativeCoordinatorBinding;
    data: ObjectValue;
  }) {
    const data = 'goal_id' in raw ? resultSchema.parse(raw) : turnResultSchema.parse(raw);
    assertNativeScope(binding, data);
    const result =
      'turn_id' in data
        ? await readNativeCoordinatorTurnResult(
            {
              ownerId: binding.ownerId,
              conversationId: data.conversation_id,
              turnId: data.turn_id,
              requestId: data.request_id,
              runId: data.run_id,
              expectedDigest: data.result_digest,
              resultRevision: data.result_revision,
            },
            deps.request,
          )
        : await readNativeCoordinatorGoalResult(
            {
              ownerId: binding.ownerId,
              conversationId: data.conversation_id,
              goalId: data.goal_id,
              runId: data.run_id,
              expectedDigest: data.result_digest,
              resultRevision: data.result_revision,
            },
            deps.request,
          );
    const source = await ownedSource(binding, result.sourceTurnId);
    const eventId = nativeCoordinatorResultEventId(data);
    const context = await deps.prepareContext({ binding, source, eventId, purpose: 'callback' });
    await deps.presentResult({
      binding,
      source,
      data,
      text: result.outputText,
      state: result.state,
      failureClass: result.failureClass,
      outputFiles: result.outputFiles,
      publisher: result.publisher,
      eventId,
      context,
    });
  }

  async function recordNativeCoordinatorAction({
    binding,
    result,
  }: {
    binding: NativeCoordinatorBinding;
    result: ObjectValue;
  }) {
    if (!result.run_id && !result.runId) throw unavailable('coordinator_action_unconfirmed');
    deps.invalidate(binding.ownerId);
  }

  return {
    prepareNativeCoordinatorTurn,
    prepareNativeCoordinatorDispatch,
    recordNativeCoordinatorDispatch,
    publishNativeCoordinatorResult,
    prepareNativeCoordinatorAction,
    prepareNativeCoordinatorWorkAction,
    recordNativeCoordinatorAction,
  };
}

type NativeCoordinatorResultInput = Parameters<
  NativeCoordinatorContextDependencies['presentResult']
>[0];
interface NativeCoordinatorResultDependencies {
  readPresentation(input: {
    ownerId: string;
    conversationId: string;
    parentMessageId: string;
    deliveryIds: string[];
  }): Promise<ObjectValue | null>;
  createFollowUp(input: {
    context: object;
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource;
    parentMessageId: string;
    eventId: string;
    insights: ObjectValue[];
    outputFiles?: ObjectValue;
    publisher?: ObjectValue;
    data: NativeCoordinatorResultData;
  }): Promise<ObjectValue | null>;
  enqueue(input: {
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource;
    eventId: string;
    message: ObjectValue;
    data: NativeCoordinatorResultData;
  }): Promise<{
    configured?: number;
    enqueued?: number;
    unresolved?: number;
    linkedWebCommitted?: boolean;
  }>;
}

/** Reuses the result author's existing claim, persisted message and surface-delivery receipt. */
export function createNativeCoordinatorResultPresenter(deps: NativeCoordinatorResultDependencies) {
  return async function presentNativeCoordinatorResult(input: NativeCoordinatorResultInput) {
    const { binding, source, data, text, eventId, context } = input;
    const parentMessageId = identifier.parse(
      source.requestBody.messageId || source.requestBody.parentMessageId,
    );
    const evidence = nativeCoordinatorResultEvidence({
      text,
      state: input.state,
      failureClass: input.failureClass,
      runId: data.run_id,
      resultRevision: data.result_revision,
      resultDigest: data.result_digest,
    });
    const insights = [
      {
        cortexId: eventId,
        status: 'completed',
        insight: evidence,
        authority: {
          kind: 'turn_id' in data ? 'native_coordinator_turn_result' : 'native_coordinator_result',
          conversationId: binding.nativeConversationId,
          ...('turn_id' in data
            ? { turnId: data.turn_id, requestId: data.request_id }
            : { goalId: data.goal_id }),
          runId: data.run_id,
          resultRevision: data.result_revision,
          resultDigest: data.result_digest,
          state: input.state || '',
          failureClass: input.failureClass || '',
        },
      },
    ];
    const candidates = buildCortexInsightDeliveryCandidates({
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      parentMessageId,
      surface: context.presentationSurface || source.requestBody.viventiumSurface || 'web',
      insights,
    });
    if (candidates.length !== 1) throw unavailable('coordinator_result_empty');
    const receiptInput = {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      parentMessageId,
      deliveryIds: candidates.map((candidate) => candidate.deliveryId),
    };
    let message = await deps.readPresentation(receiptInput);
    if (!message) {
      await deps.createFollowUp({
        context: context.presentationContext,
        binding,
        source,
        parentMessageId,
        eventId,
        insights,
        outputFiles: input.outputFiles,
        publisher: input.publisher,
        data,
      });
      message = await deps.readPresentation(receiptInput);
    }
    if (
      message?.presentationDisposition === 'dropped' &&
      typeof message.dropReason === 'string' &&
      message.dropReason.trim()
    )
      return;
    if (!message?.messageId) throw unavailable('coordinator_presentation_unconfirmed');
    const receipt = await deps.enqueue({ binding, source, eventId, message, data });
    if (
      Number(receipt.unresolved || 0) > 0 ||
      (Number(receipt.configured || 0) > 0 && Number(receipt.enqueued || 0) < 1) ||
      (!Number(receipt.configured || 0) && receipt.linkedWebCommitted !== true)
    )
      throw unavailable('coordinator_delivery_unconfirmed');
  };
}
/* === VIVENTIUM END === */
