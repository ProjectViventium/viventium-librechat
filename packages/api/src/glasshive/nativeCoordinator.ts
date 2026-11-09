/* === VIVENTIUM START === Native management with application-owned context and delivery. === */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyScheduleDueSignature } from '../scheduling/scheduleDueReceiver';
import { nativeCoordinatorControlRequest } from './nativeCoordinatorWork';
import type { NativeCoordinatorOwnedSnapshot } from './nativeCoordinatorWork';

type RecordValue = Record<string, unknown>;
const id = z.string().min(1).max(200);
const eventSchema = z
  .object({
    type: z.enum([
      'coordinator.turn_due',
      'coordinator.dispatch_due',
      'coordinator.action_due',
      'coordinator.result_ready',
      'coordinator.turn_result_ready',
    ]),
    event_id: id,
    principal: z.object({ tenant_id: id, owner_id: id }).strict(),
    created_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
    data: z
      .object({
        conversation_id: id,
        request_ref: id,
        turn_id: id.optional(),
        request_id: id.optional(),
        goal_id: id.optional(),
        dispatch_digest: z.string().min(1).max(200).optional(),
        action_key: id.optional(),
        action_digest: z.string().min(1).max(200).optional(),
        source_turn_id: id.optional(),
        run_id: id.optional(),
        result_revision: z.number().int().positive().optional(),
        result_digest: z.string().min(1).max(200).optional(),
      })
      .strict(),
  })
  .strict();

export interface NativeCoordinatorBinding {
  _id: string;
  kind: 'native_coordinator_binding';
  ownerId: string;
  tenantId: string;
  conversationId: string;
  agentId: string;
  nativeConversationId?: string;
  configuration: RecordValue;
  active: boolean;
}

export interface NativeCoordinatorSource {
  _id: string;
  kind: 'native_coordinator_source';
  bindingRef: string;
  turnId: string;
  requestBody: RecordValue;
}

interface NativeRequest {
  ownerId: string;
  path: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface NativeCoordinatorDependencies {
  tenantId(): string;
  secrets(): readonly string[];
  readBinding(ref: string): Promise<NativeCoordinatorBinding | null>;
  saveBinding(value: NativeCoordinatorBinding): Promise<NativeCoordinatorBinding>;
  bindConversation(ref: string, nativeId: string): Promise<NativeCoordinatorBinding>;
  saveSource(value: NativeCoordinatorSource): Promise<void>;
  readSource(bindingRef: string, turnId: string): Promise<NativeCoordinatorSource | null>;
  readBindings(ownerId: string): Promise<NativeCoordinatorBinding[]>;
  ensureDestination(ownerId: string): Promise<string>;
  request(input: NativeRequest): Promise<RecordValue>;
  signBundle(bundle: RecordValue): Record<string, string>;
  prepareTurn(input: {
    binding: NativeCoordinatorBinding;
    source: NativeCoordinatorSource | null;
    turn: RecordValue;
  }): Promise<{ body: RecordValue; headers: Record<string, string> }>;
  prepareDispatch(input: {
    binding: NativeCoordinatorBinding;
    dispatch: RecordValue;
    notificationExpiresAt?: string;
  }): Promise<{ delegation: RecordValue; headers: Record<string, string>; context: unknown }>;
  prepareAction(input: {
    binding: NativeCoordinatorBinding;
    action: RecordValue;
  }): Promise<{ body: RecordValue; headers: Record<string, string> }>;
  recordAction(input: { binding: NativeCoordinatorBinding; result: RecordValue }): Promise<void>;
  recordDispatch(input: {
    binding: NativeCoordinatorBinding;
    work: RecordValue;
    context: unknown;
  }): Promise<void>;
  publishResult(input: { binding: NativeCoordinatorBinding; data: RecordValue }): Promise<void>;
  now?(): number;
}

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const segment = (value: unknown) => encodeURIComponent(id.parse(value));
const conversationPath = (value: unknown) => `/v1/coordinator/conversations/${segment(value)}`;

export function nativeCoordinatorHandoffTurnId(requestBody: RecordValue, original: string): string {
  return `handoff_${hash([
    requestBody.messageId,
    requestBody.viventiumSourceEventId,
    requestBody.viventiumTriggeringSourceSegments,
    original,
  ])}`;
}

export function nativeCoordinatorSourceBody(value: RecordValue): RecordValue {
  const fields = [
    'conversationId',
    'parentMessageId',
    'messageId',
    'agent_id',
    'files',
    'viventiumSourceEventId',
    'viventiumTriggeringSourceSegments',
    'viventiumSurface',
    'viventiumInputMode',
    'viventiumTelegramChatId',
    'viventiumTelegramUserId',
    'viventiumTelegramMessageId',
    'viventiumTelegramMessageThreadId',
    'viventiumVoiceCallSessionId',
    'viventiumCallSessionId',
    'viventiumVoiceTaskId',
    'viventiumVoiceRequestId',
  ];
  return Object.fromEntries(
    fields.flatMap((key) => (value[key] === undefined ? [] : [[key, structuredClone(value[key])]])),
  );
}

export function nativeCoordinatorConfiguration(resources: RecordValue, executionMode: string) {
  const routes = ['worker', 'fallback_worker'].flatMap((prefix, index) => {
    const profile = String(resources[`${prefix}_profile`] || '');
    const model = String(resources[`${prefix}_model`] || '');
    const effort = String(resources[`${prefix}_reasoning_effort`] || '');
    if (!profile && index) return [];
    if (!profile || !model || !effort)
      throw new Error('coordinator_worker_configuration_unavailable');
    const qualifiedModel = model.includes(':') ? model : `${profile}:${model}`;
    if (!qualifiedModel.startsWith(`${profile}:`))
      throw new Error('coordinator_worker_configuration_mismatch');
    return [
      {
        id: index ? 'fallback' : 'primary',
        profile,
        model: qualifiedModel,
        effort,
        execution_mode: executionMode,
        resource_class: 'standard',
      },
    ];
  });
  return {
    model: routes[0].model,
    effort: routes[0].effort,
    routes,
    max_goals: null,
    scope: { execution_mode: executionMode },
  };
}

/** Native turns/goals own execution state. These records bind application context only. */
export function createNativeCoordinatorHost(deps: NativeCoordinatorDependencies) {
  async function ownedBinding(ref: string, ownerId: string, nativeId?: string) {
    const binding = await deps.readBinding(ref);
    if (
      !binding ||
      !binding.active ||
      binding.ownerId !== ownerId ||
      binding.tenantId !== deps.tenantId() ||
      (nativeId && binding.nativeConversationId !== nativeId)
    ) {
      throw Object.assign(new Error('coordinator_binding_unavailable'), { status: 403 });
    }
    return binding;
  }

  async function accept(input: {
    ownerId: string;
    conversationId: string;
    agentId: string;
    occurrenceId: string;
    original: string;
    requestBody: RecordValue;
    configuration: RecordValue;
  }) {
    if (!input.original || !input.occurrenceId) throw new Error('coordinator_source_unavailable');
    const bindingRef = `coordinator_${hash([
      deps.tenantId(),
      input.ownerId,
      input.conversationId,
      input.agentId,
      input.configuration,
    ])}`;
    let binding = await deps.saveBinding({
      _id: bindingRef,
      kind: 'native_coordinator_binding',
      ownerId: input.ownerId,
      tenantId: deps.tenantId(),
      conversationId: input.conversationId,
      agentId: input.agentId,
      configuration: input.configuration,
      active: true,
    });
    if (!binding.nativeConversationId) {
      const destination = await deps.ensureDestination(input.ownerId);
      const configuration = {
        ...input.configuration,
        application: { destination_id: destination, request_ref: bindingRef },
      };
      const native = await deps.request({
        ownerId: input.ownerId,
        path: '/v1/coordinator/conversations',
        method: 'POST',
        body: { application_config: configuration },
        headers: deps.signBundle({ coordinator_application_config: configuration }),
      });
      binding = await deps.bindConversation(bindingRef, id.parse(native.conversation_id));
    }
    const turnId = nativeCoordinatorHandoffTurnId(input.requestBody, input.original);
    await deps.saveSource({
      _id: `${bindingRef}:${turnId}`,
      kind: 'native_coordinator_source',
      bindingRef,
      turnId,
      requestBody: nativeCoordinatorSourceBody(input.requestBody),
    });
    const accepted = await deps.request({
      ownerId: input.ownerId,
      path: `${conversationPath(binding.nativeConversationId)}/turns`,
      method: 'POST',
      body: { idempotency_key: turnId, message: input.original },
    });
    if (
      accepted.blocker ||
      ['failed', 'cancelled', 'restore_held'].includes(String(accepted.state))
    )
      throw new Error(String(accepted.blocker || 'coordinator_admission_unavailable'));
    return {
      status: 'ok',
      accepted: true,
      handoffRef: `${binding.nativeConversationId}:${turnId}`,
      conversationId: binding.nativeConversationId,
      turnId,
    };
  }

  async function receive(input: {
    rawBody: Buffer;
    eventId: string;
    timestamp: string;
    signature: string;
  }) {
    const now = deps.now?.() ?? Date.now();
    verifyScheduleDueSignature({ ...input, secrets: deps.secrets(), nowMs: now });
    const event = eventSchema.parse(JSON.parse(input.rawBody.toString('utf8')));
    if (
      event.event_id !== input.eventId ||
      event.principal.tenant_id !== deps.tenantId() ||
      Date.parse(event.expires_at) <= now
    ) {
      throw Object.assign(new Error('coordinator_event_unavailable'), { status: 403 });
    }
    const binding = await ownedBinding(
      event.data.request_ref,
      event.principal.owner_id,
      event.data.conversation_id,
    );
    const path = conversationPath(event.data.conversation_id);
    if (
      event.type === 'coordinator.result_ready' ||
      event.type === 'coordinator.turn_result_ready'
    ) {
      if (event.type === 'coordinator.turn_result_ready') {
        if (
          event.data.goal_id !== undefined ||
          !event.data.turn_id ||
          !event.data.request_id ||
          !event.data.run_id ||
          !event.data.result_revision ||
          !/^sha256:[a-f0-9]{64}$/.test(event.data.result_digest || '')
        )
          throw Object.assign(new Error('coordinator_turn_result_invalid'), { status: 403 });
      }
      await deps.publishResult({ binding, data: event.data });
      return { accepted: true };
    }
    if (event.type === 'coordinator.turn_due') {
      const turnId = id.parse(event.data.turn_id);
      const turn = await deps.request({
        ownerId: binding.ownerId,
        path: `${path}/turns/${segment(turnId)}`,
      });
      if (turn.request_id || turn.state === 'completed') return { accepted: true, duplicate: true };
      if (turn.blocker === 'cancelled' || turn.state === 'cancelled')
        return { accepted: true, cancelled: true };
      const source = await deps.readSource(binding._id, id.parse(turn.source_turn_id || turnId));
      const prepared = await deps.prepareTurn({ binding, source, turn });
      const receipt = await deps.request({
        ownerId: binding.ownerId,
        method: 'POST',
        path: `${path}/turns/${segment(turnId)}/prepare`,
        ...prepared,
      });
      if (!receipt.request_id) throw new Error('coordinator_request_unconfirmed');
      return { accepted: true, requestId: receipt.request_id };
    }
    const goalId = id.parse(event.data.goal_id);
    if (event.type === 'coordinator.action_due') {
      const actionKey = id.parse(event.data.action_key);
      const goalPath = `${path}/goals/${segment(goalId)}`;
      const action = await deps.request({
        ownerId: binding.ownerId,
        path: `${goalPath}/actions/${segment(actionKey)}/preparation`,
      });
      if (
        action.action_digest !== event.data.action_digest ||
        action.run_id !== event.data.run_id ||
        action.source_turn_id !== event.data.source_turn_id
      )
        throw Object.assign(new Error('coordinator_action_changed'), { status: 409 });
      if (['pending', 'completed', 'failed', 'cancelled'].includes(String(action.state)))
        return { accepted: true, duplicate: true };
      const prepared = await deps.prepareAction({ binding, action });
      const receipt = await deps.request({
        ownerId: binding.ownerId,
        method: 'POST',
        path: `${goalPath}/actions?run_id=${segment(action.run_id)}`,
        ...prepared,
      });
      if (!receipt.workRef && !receipt.work_ref && receipt.accepted !== true)
        throw new Error('coordinator_action_unconfirmed');
      await deps.recordAction({ binding, result: receipt });
      return { accepted: true };
    }
    const dispatch = await deps.request({
      ownerId: binding.ownerId,
      path: `${path}/goals/${segment(goalId)}/dispatch`,
    });
    if (dispatch.dispatch_digest !== event.data.dispatch_digest)
      throw Object.assign(new Error('coordinator_dispatch_changed'), { status: 409 });
    const notificationRef =
      dispatch.notification_ref == null ? undefined : id.parse(dispatch.notification_ref);
    if (notificationRef && notificationRef !== event.event_id)
      return { accepted: true, stale: true };
    const prepared = await deps.prepareDispatch({
      binding,
      dispatch,
      notificationExpiresAt: event.expires_at,
    });
    const receipt = await deps.request({
      ownerId: binding.ownerId,
      method: 'POST',
      path: `${path}/goals/${segment(goalId)}/prepare`,
      headers: prepared.headers,
      body: {
        dispatch_digest: dispatch.dispatch_digest,
        delegation: prepared.delegation,
        ...(notificationRef ? { notification_ref: notificationRef } : {}),
      },
    });
    const work = receipt.work as RecordValue | undefined;
    if (!work?.work_ref && !work?.workRef) throw new Error('coordinator_work_unconfirmed');
    await deps.recordDispatch({ binding, work, context: prepared.context });
    return { accepted: true, workRef: work.work_ref || work.workRef };
  }

  async function snapshots(ownerId: string): Promise<NativeCoordinatorOwnedSnapshot[]> {
    const bindings = await deps.readBindings(ownerId);
    const output: NativeCoordinatorOwnedSnapshot[] = [];
    for (const binding of bindings) {
      if (!binding.active || !binding.nativeConversationId) continue;
      const snapshot = await deps.request({
        ownerId,
        path: `${conversationPath(binding.nativeConversationId)}?include_history=false`,
      });
      output.push({ binding, snapshot: snapshot as NativeCoordinatorOwnedSnapshot['snapshot'] });
    }
    return output;
  }

  async function control(input: {
    ownerId: string;
    workRef: string;
    action: string;
    operationId: string;
    instruction?: string;
  }) {
    const request = nativeCoordinatorControlRequest({
      ...input,
      tenantId: deps.tenantId(),
      snapshots: await snapshots(input.ownerId),
    });
    return deps.request(request);
  }

  return { accept, receive, snapshots, control };
}
/* === VIVENTIUM END === */
