/* === VIVENTIUM START === Native goal ownership in the existing Active Work projection. === */
import { createHash } from 'node:crypto';
import type { requestAccountApi } from './accountClient';

type RecordValue = Record<string, unknown>;
type Freshness = 'fresh' | 'stale' | 'unavailable';
const ACTIONS = [
  'queue',
  'message',
  'pause',
  'resume',
  'stop',
  'steer',
  'retry',
  'dismiss',
] as const;
type Action = (typeof ACTIONS)[number];
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export interface NativeCoordinatorWorkBinding {
  _id?: string;
  kind?: string;
  ownerId: string;
  tenantId: string;
  conversationId: string;
  nativeConversationId?: string;
  active: boolean;
}

/** The Native goal_snapshot and its summary expose the same control identities. */
export interface NativeCoordinatorGoal {
  goal_id: string;
  source_turn_id?: string;
  text: string;
  state: string;
  work_ref?: string;
  worker_id?: string;
  run_id?: string;
  control_run_id?: string;
  control_state?: string;
  blocker?: string;
  actions?: string[];
  dismissed?: boolean;
  retryable?: boolean;
  has_result?: boolean;
  view_ref?: string;
  result_revision?: number;
  intent_state?: string;
  restore_hold?: boolean | number;
}

export interface NativeCoordinatorTurn {
  turn_id: string;
  source_turn_id?: string;
  retry_of_turn_id?: string;
  retry_turn_id?: string;
  run_id?: string;
  result_revision?: number;
  has_result?: boolean;
  presentation_eligible?: boolean;
  intent_state?: string;
  superseded?: boolean;
  message?: string;
  origin: string;
  state: string;
  actions?: string[];
  request_id?: string;
  blocker?: string;
  response_json?: string;
  created_at?: string;
  restore_hold?: boolean | number;
}

export interface NativeCoordinatorOwnedSnapshot {
  binding: NativeCoordinatorWorkBinding;
  snapshot: {
    conversation_id: string;
    goals: NativeCoordinatorGoal[];
    turns?: NativeCoordinatorTurn[];
  };
}

interface Owner {
  ownerId: string;
  tenantId: string;
}

export interface NativeCoordinatorWorkItem extends RecordValue {
  workRef: string;
  nativeWorkRef?: string;
  managementKind: 'native_coordinator';
  nativeConversationId: string;
  nativeGoalId: string;
  nativeState: string;
  conversationId: string;
  title: string;
  state: string;
  provider: string;
  actions: string[];
  delivery: { state: string; unreadTerminal: boolean };
}

export interface NativeCoordinatorTurnWorkItem
  extends
    Pick<
      NativeCoordinatorWorkItem,
      | 'workRef'
      | 'nativeConversationId'
      | 'nativeState'
      | 'conversationId'
      | 'title'
      | 'state'
      | 'provider'
      | 'actions'
      | 'delivery'
    >,
    RecordValue {
  managementKind: 'native_coordinator_turn';
  nativeTurnId: string;
}

const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const failure = (code: string, status: number) => Object.assign(new Error(code), { status });
const owned = (owner: Owner, binding: NativeCoordinatorWorkBinding) =>
  binding.active &&
  binding.ownerId === owner.ownerId &&
  binding.tenantId === owner.tenantId &&
  typeof binding.nativeConversationId === 'string' &&
  binding.nativeConversationId.length > 0;

/** Opaque and bounded independently of the length or characters of either Native identity. */
export function nativeCoordinatorWorkRef(conversationId: string, goalId: string): string {
  return `xpc_${createHash('sha256')
    .update(JSON.stringify([conversationId, goalId]))
    .digest('hex')}`;
}

export function nativeCoordinatorTurnRef(conversationId: string, turnId: string): string {
  return `xpt_${createHash('sha256')
    .update(JSON.stringify([conversationId, turnId]))
    .digest('hex')}`;
}

/** An accepted planning turn is real Native state, before any Worker goal exists. */
export function projectNativeCoordinatorTurn(
  input: Owner & {
    binding: NativeCoordinatorWorkBinding;
    turn: NativeCoordinatorTurn;
    goals: NativeCoordinatorGoal[];
  },
): NativeCoordinatorTurnWorkItem | null {
  const { binding, turn } = input;
  if (!owned(input, binding) || turn.origin !== 'interactive') return null;
  if (
    !turn.turn_id ||
    (turn.message !== undefined && typeof turn.message !== 'string') ||
    typeof turn.state !== 'string'
  ) {
    throw failure('coordinator_turn_snapshot_invalid', 503);
  }
  if (
    turn.retry_turn_id ||
    turn.blocker === 'cancelled' ||
    (turn.state === 'cancelled' && !turn.actions?.includes('retry'))
  )
    return null;
  const attention =
    turn.state === 'failed' ||
    turn.state === 'blocked' ||
    turn.state === 'restore_held' ||
    Boolean(turn.blocker) ||
    Boolean(turn.restore_hold);
  const directResult =
    turn.state === 'completed' &&
    turn.has_result === true &&
    turn.presentation_eligible === true &&
    turn.intent_state === 'accepted' &&
    turn.restore_hold === false &&
    turn.superseded === false &&
    Boolean(turn.run_id);
  if (
    !attention &&
    !directResult &&
    (TERMINAL.has(turn.state) ||
      turn.response_json ||
      input.goals.some((goal) => goal.source_turn_id === (turn.source_turn_id || turn.turn_id)))
  )
    return null;
  return {
    workRef: nativeCoordinatorTurnRef(binding.nativeConversationId!, turn.turn_id),
    managementKind: 'native_coordinator_turn',
    nativeConversationId: binding.nativeConversationId!,
    nativeTurnId: turn.turn_id,
    nativeState: turn.state,
    conversationId: binding.conversationId,
    title:
      turn.message || (attention || directResult ? 'Background work' : 'Starting background work'),
    state: attention
      ? turn.state === 'restore_held' || turn.restore_hold
        ? 'needs_input'
        : turn.state === 'failed'
          ? 'failed'
          : 'blocked'
      : directResult
        ? 'completed'
        : 'queued',
    provider: '',
    delivery: { state: 'unknown', unreadTerminal: directResult },
    ...(directResult
      ? { nativeRunId: turn.run_id, resultRunId: turn.run_id, resultRevision: turn.result_revision }
      : {}),
    actions:
      turn.state === 'restore_held' || turn.restore_hold
        ? []
        : Array.isArray(turn.actions)
          ? turn.actions.filter((action) => action === 'stop' || action === 'retry')
          : [],
    ...(turn.created_at ? { createdAt: turn.created_at } : {}),
    ...(attention
      ? {
          attention: {
            kind: turn.state === 'restore_held' || turn.restore_hold ? 'input' : 'failure',
            code: turn.blocker || turn.state,
            summary:
              turn.state === 'restore_held' || turn.restore_hold
                ? 'Background work is paused after restore.'
                : turn.state === 'failed'
                  ? 'Background work did not finish.'
                  : 'Background work cannot start yet.',
          },
        }
      : {}),
  };
}

function currentTurns(input: Owner & { snapshots: NativeCoordinatorOwnedSnapshot[] }) {
  return input.snapshots.flatMap(({ binding, snapshot }) => {
    if (!owned(input, binding)) return [];
    if (
      snapshot.conversation_id !== binding.nativeConversationId ||
      !Array.isArray(snapshot.goals)
    ) {
      throw failure('coordinator_snapshot_binding_mismatch', 503);
    }
    return (snapshot.turns || [])
      .filter((turn) => turn.origin === 'interactive')
      .map((turn) => ({
        binding,
        turn,
        workRef: nativeCoordinatorTurnRef(binding.nativeConversationId!, turn.turn_id),
        work: projectNativeCoordinatorTurn({ ...input, binding, turn, goals: snapshot.goals }),
      }));
  });
}

export function resolveNativeCoordinatorTurnRef(
  input: Owner & {
    workRef: string;
    snapshots: NativeCoordinatorOwnedSnapshot[];
  },
) {
  if (!/^xpt_[a-f0-9]{64}$/.test(input.workRef)) return null;
  const matches = currentTurns(input).filter(
    (target) => target.work && target.workRef === input.workRef,
  );
  if (matches.length > 1) throw failure('coordinator_work_identity_ambiguous', 409);
  return matches[0] || null;
}

export function projectNativeCoordinatorWork(
  input: Owner & {
    binding: NativeCoordinatorWorkBinding;
    goal: NativeCoordinatorGoal;
  },
): NativeCoordinatorWorkItem | null {
  const { binding, goal } = input;
  if (!owned(input, binding)) return null;
  if (
    !goal ||
    typeof goal.goal_id !== 'string' ||
    !goal.goal_id ||
    typeof goal.text !== 'string' ||
    typeof goal.state !== 'string'
  ) {
    throw failure('coordinator_goal_snapshot_invalid', 503);
  }
  const held = goal.state === 'restore_held' || goal.state === 'blocked';
  const state = held
    ? goal.state === 'restore_held'
      ? 'needs_input'
      : 'blocked'
    : goal.control_state || goal.state;
  return {
    workRef: nativeCoordinatorWorkRef(binding.nativeConversationId!, goal.goal_id),
    ...(goal.work_ref ? { nativeWorkRef: goal.work_ref } : {}),
    managementKind: 'native_coordinator',
    nativeConversationId: binding.nativeConversationId!,
    nativeGoalId: goal.goal_id,
    nativeRunId: goal.control_run_id || goal.run_id || '',
    nativeState: goal.state,
    conversationId: binding.conversationId,
    title: goal.text,
    state,
    provider: '',
    actions:
      goal.state === 'restore_held'
        ? []
        : Array.isArray(goal.actions)
          ? goal.actions.filter((action): action is Action => ACTIONS.includes(action as Action))
          : [],
    delivery: { state: 'unknown', unreadTerminal: false },
    ...(typeof goal.view_ref === 'string' && goal.view_ref ? { viewRef: goal.view_ref } : {}),
    ...(held
      ? {
          attention: {
            kind: goal.state === 'restore_held' ? 'input' : 'failure',
            code: goal.blocker || goal.state,
            summary:
              goal.state === 'restore_held'
                ? 'Background work is paused after restore.'
                : 'Background work cannot start yet.',
          },
        }
      : {}),
  };
}

function currentGoals(input: Owner & { snapshots: NativeCoordinatorOwnedSnapshot[] }) {
  return input.snapshots.flatMap(({ binding, snapshot }) => {
    if (!owned(input, binding)) return [];
    if (
      snapshot.conversation_id !== binding.nativeConversationId ||
      !Array.isArray(snapshot.goals)
    ) {
      throw failure('coordinator_snapshot_binding_mismatch', 503);
    }
    return snapshot.goals.map((goal) => ({
      binding,
      goal,
      work: projectNativeCoordinatorWork({ ...input, binding, goal })!,
    }));
  });
}

/** Resolve only against snapshots fetched for the current authenticated owner's bindings. */
export function resolveNativeCoordinatorWorkRef(
  input: Owner & {
    workRef: string;
    snapshots: NativeCoordinatorOwnedSnapshot[];
  },
) {
  if (!/^xpc_[a-f0-9]{64}$/.test(input.workRef)) return null;
  const matches = currentGoals(input).filter(({ work }) => work.workRef === input.workRef);
  if (matches.length > 1) throw failure('coordinator_work_identity_ambiguous', 409);
  return matches[0] || null;
}

/** Fresh, owner-bound Native location for ordinary detail, action and delivery adapters. */
export function resolveNativeCoordinatorAlias(
  input: Owner & {
    workRef: string;
    snapshot: Freshness;
    snapshots: NativeCoordinatorOwnedSnapshot[];
  },
) {
  if (!/^xp[ct]_[a-f0-9]{64}$/.test(input.workRef)) return null;
  if (input.snapshot !== 'fresh') throw failure('coordinator_snapshot_not_current', 503);
  const goal = resolveNativeCoordinatorWorkRef(input);
  if (goal)
    return {
      ...goal,
      kind: 'goal' as const,
      workRef: input.workRef,
      nativeConversationId: goal.binding.nativeConversationId!,
      nativeGoalId: goal.goal.goal_id,
      nativeWorkRef: goal.goal.work_ref || '',
      runId: goal.goal.control_run_id || goal.goal.run_id || '',
      actions: goal.work.actions,
    };
  const turns = currentTurns(input).filter((turn) => turn.workRef === input.workRef);
  if (turns.length > 1) throw failure('coordinator_work_identity_ambiguous', 409);
  const turn = turns[0];
  return turn
    ? {
        ...turn,
        kind: 'turn' as const,
        workRef: input.workRef,
        nativeConversationId: turn.binding.nativeConversationId!,
        nativeTurnId: turn.turn.turn_id,
        nativeWorkRef: '',
        runId: '',
        actions: turn.work?.actions || [],
      }
    : null;
}

type AccountRequest = Parameters<typeof requestAccountApi>[0];
export interface NativeCoordinatorWorkRequestDependencies {
  tenantId(): string;
  snapshots(
    ownerId: string,
  ): Promise<{ snapshot: Freshness; snapshots: NativeCoordinatorOwnedSnapshot[] }>;
  request(input: AccountRequest): Promise<unknown>;
  prepareAction?(input: {
    ownerId: string;
    nativeConversationId: string;
    goalId: string;
    body: RecordValue;
  }): Promise<{ body: RecordValue; headers: Record<string, string> }>;
}

/** Called inside the ordinary action service, after its current source/capability/Voice guards. */
export function createNativeCoordinatorWorkRequestAdapter(
  deps: NativeCoordinatorWorkRequestDependencies,
) {
  async function resolve(input: { ownerId?: unknown; workRef: string }) {
    if (!/^xp[ct]_[a-f0-9]{64}$/.test(input.workRef)) return null;
    const ownerId = String(input.ownerId || '').trim();
    if (!ownerId) throw failure('glasshive_owner_required', 403);
    const current = await deps.snapshots(ownerId);
    const target = resolveNativeCoordinatorAlias({
      ownerId,
      tenantId: deps.tenantId(),
      workRef: input.workRef,
      ...current,
    });
    if (!target) throw failure('coordinator_work_unavailable', 403);
    return target;
  }

  async function request(input: AccountRequest): Promise<unknown> {
    const route = /^\/v1\/work\/([^/?]+)(\/actions(?:\/receipt)?)?(\?[^#]*)?$/.exec(input.path);
    if (!route) return deps.request(input);
    let workRef: string;
    try {
      workRef = decodeURIComponent(route[1]);
    } catch {
      throw failure('coordinator_work_identity_invalid', 400);
    }
    if (!/^xp[ct]_[a-f0-9]{64}$/.test(workRef)) return deps.request(input);
    const target = (await resolve({ ownerId: input.ownerId, workRef }))!;
    const method = (input.method || 'GET').toUpperCase();
    const conversation = `/v1/coordinator/conversations/${encodeURIComponent(target.nativeConversationId)}`;
    if (method === 'GET' && !route[2]) {
      if (target.kind === 'turn')
        return {
          ...target.work,
          workRef,
          managementKind: 'native_coordinator_turn',
          nativeTurnId: target.nativeTurnId,
          nativeConversationId: target.nativeConversationId,
          nativeRetryTurnId: target.turn.retry_turn_id || '',
          nativeState: target.turn.state,
          title: target.turn.message,
          state: target.work?.state || target.turn.state,
          actions: target.actions,
        };
      if (!target.nativeWorkRef) return target.work;
      const detail = record(
        await deps.request({
          ...input,
          path: `/v1/work/${encodeURIComponent(target.nativeWorkRef)}${route[3] || ''}`,
        }),
      );
      if (detail.workRef !== target.nativeWorkRef)
        throw failure('coordinator_work_detail_changed', 409);
      return {
        ...detail,
        workRef,
        nativeWorkRef: target.nativeWorkRef,
        managementKind: 'native_coordinator',
        nativeGoalId: target.nativeGoalId,
        nativeConversationId: target.nativeConversationId,
        actions: target.actions,
      };
    }
    if (method !== 'POST' || !route[2]) throw failure('coordinator_work_route_unavailable', 400);
    if (target.kind === 'turn') {
      const body = record(input.body);
      if (body.action === 'retry') {
        if (
          typeof body.idempotencyKey !== 'string' ||
          !body.idempotencyKey ||
          input.ownerNativeInput ||
          Object.keys(body).some((key) => !['action', 'idempotencyKey'].includes(key))
        ) {
          throw failure('coordinator_planning_retry_invalid', 400);
        }
        const { body: _body, ownerNativeInput: _nativeInput, ...ordinaryOptions } = input;
        if (route[2] === '/actions/receipt') {
          if (!target.turn.retry_turn_id) throw failure('work_action_outcome_unconfirmed', 503);
          return deps.request({
            ...ordinaryOptions,
            method: 'GET',
            path: `${conversation}/turns/${encodeURIComponent(target.turn.retry_turn_id)}`,
          });
        }
        if (!target.actions.includes('retry') && !target.turn.retry_turn_id) {
          throw failure('coordinator_action_unavailable', 409);
        }
        return deps.request({
          ...ordinaryOptions,
          method: 'POST',
          path: `${conversation}/turns/${encodeURIComponent(target.nativeTurnId)}/retry`,
        });
      }
      if (route[2] === '/actions/receipt') throw failure('work_action_outcome_unconfirmed', 503);
      if (body.action !== 'stop' || !target.actions.includes('stop')) {
        throw failure('coordinator_action_unavailable', 409);
      }
      const { body: _body, ownerNativeInput: _nativeInput, ...ordinaryOptions } = input;
      return deps.request({
        ...ordinaryOptions,
        path: `${conversation}/turns/${encodeURIComponent(target.nativeTurnId)}/stop`,
        method: 'POST',
      });
    }
    const query = new URLSearchParams(route[3]?.slice(1));
    query.set('run_id', target.runId);
    const actionPath = `${conversation}/goals/${encodeURIComponent(target.nativeGoalId)}`;
    const ordinaryBody = record(input.body);
    // These typed lifecycle actions can invoke the model again, including permission resume.
    if (
      route[2] === '/actions' &&
      deps.prepareAction &&
      !(ordinaryBody.action === 'retry' && !target.nativeWorkRef && !target.runId) &&
      ['queue', 'message', 'steer', 'retry', 'resume'].includes(String(ordinaryBody.action))
    ) {
      const preflight = record(
        await deps.request({
          ...input,
          path: `${actionPath}/actions/preflight?${query.toString()}`,
        }),
      );
      if (['pending', 'completed', 'failed'].includes(String(preflight.state))) {
        return deps.request({
          ...input,
          path: `${actionPath}/actions/receipt?${query.toString()}`,
        });
      }
      if (!['missing', 'unprepared'].includes(String(preflight.state))) {
        throw failure('coordinator_action_preflight_unavailable', 503);
      }
      if (!target.actions.includes(String(ordinaryBody.action))) {
        throw failure('coordinator_action_unavailable', 409);
      }
      const prepared = await deps.prepareAction({
        ownerId: String(input.ownerId || '').trim(),
        nativeConversationId: target.nativeConversationId,
        goalId: target.nativeGoalId,
        body: ordinaryBody,
      });
      const carrier = prepared.body.application_bootstrap_bundle_b64;
      if (
        typeof carrier !== 'string' ||
        !carrier ||
        Object.prototype.hasOwnProperty.call(ordinaryBody, 'application_bootstrap_bundle_b64')
      ) {
        throw failure('coordinator_action_context_unavailable', 503);
      }
      const fetch = input.fetchImpl || globalThis.fetch;
      return deps.request({
        ...input,
        path: `${actionPath}/actions?${query.toString()}`,
        // Preserve every ordinary field and its nested objects; fresh authority is separate.
        body: { ...ordinaryBody, application_bootstrap_bundle_b64: carrier },
        fetchImpl: (url, init) => {
          const headers = new Headers(init?.headers);
          for (const [key, value] of Object.entries(prepared.headers)) {
            if (
              !['x-glasshive-bootstrap-timestamp', 'x-glasshive-bootstrap-signature'].includes(
                key.toLowerCase(),
              )
            ) {
              throw failure('coordinator_action_signature_invalid', 503);
            }
            headers.set(key, value);
          }
          return fetch(url, { ...init, headers });
        },
      });
    }
    return deps.request({
      ...input,
      path: `${actionPath}${route[2]}?${query.toString()}`,
    });
  }

  return { request, resolve };
}

/** Native remains the manager; never send a goal control to its raw worker work_ref. */
export function nativeCoordinatorControlRequest(
  input: Owner & {
    workRef: string;
    snapshots: NativeCoordinatorOwnedSnapshot[];
    action: string;
    operationId: string;
    instruction?: string;
  },
) {
  if (/^xpt_[a-f0-9]{64}$/.test(input.workRef)) {
    const turn = resolveNativeCoordinatorTurnRef(input);
    if (!turn) throw failure('coordinator_work_unavailable', 403);
    if (
      !['stop', 'retry'].includes(input.action) ||
      !turn.work!.actions.includes(input.action) ||
      (input.action === 'retry' && input.instruction !== undefined)
    ) {
      throw failure('coordinator_action_unavailable', 409);
    }
    return {
      ownerId: input.ownerId,
      method: 'POST' as const,
      path:
        `/v1/coordinator/conversations/${encodeURIComponent(turn.binding.nativeConversationId!)}` +
        `/turns/${encodeURIComponent(turn.turn.turn_id)}/${input.action}`,
    };
  }
  const target = resolveNativeCoordinatorWorkRef(input);
  if (!target) throw failure('coordinator_work_unavailable', 403);
  if (!target.work.actions.includes(input.action))
    throw failure('coordinator_action_unavailable', 409);
  if (
    !input.operationId ||
    input.operationId.length > 160 ||
    (input.instruction !== undefined && typeof input.instruction !== 'string')
  ) {
    throw failure('coordinator_control_invalid', 400);
  }
  return {
    ownerId: input.ownerId,
    method: 'POST' as const,
    path:
      `/v1/coordinator/conversations/${encodeURIComponent(target.binding.nativeConversationId!)}` +
      `/goals/${encodeURIComponent(target.goal.goal_id)}/control`,
    body: {
      action: input.action,
      run_id: target.goal.control_run_id || target.goal.run_id || '',
      idempotency_key: input.operationId,
      ...(input.instruction !== undefined ? { message: input.instruction } : {}),
    },
  };
}

/** Ephemeral join only. Existing hosted pagination, delivery and artifact metadata stay owned there. */
export function mergeHostedAndNativeRoster(
  input: Owner & {
    hosted: unknown;
    native: { snapshot: Freshness; snapshots: NativeCoordinatorOwnedSnapshot[] };
    scope: 'active' | 'history';
    includeNativeOnly?: boolean;
  },
): RecordValue {
  const hosted = record(input.hosted);
  const raw = Array.isArray(hosted.work) ? (hosted.work as RecordValue[]) : [];
  const goals = currentGoals({ ...input, snapshots: input.native.snapshots });
  const turns = currentTurns({ ...input, snapshots: input.native.snapshots });
  const turnsByRef = new Map(turns.map((target) => [target.workRef, target]));
  const eligible = goals.filter(({ goal, work }) =>
    input.scope === 'history' ? TERMINAL.has(work.state) : goal.dismissed !== true,
  );
  const byRef = new Map<string, (typeof goals)[number]>();
  for (const target of goals) {
    for (const ref of [target.work.workRef, target.goal.work_ref].filter(Boolean) as string[]) {
      if (byRef.has(ref) && byRef.get(ref)!.work.workRef !== target.work.workRef) {
        throw failure('coordinator_work_identity_ambiguous', 409);
      }
      byRef.set(ref, target);
    }
  }
  const seen = new Set<string>();
  const work = raw.flatMap((row) => {
    const turn = turnsByRef.get(String(row.workRef || ''));
    if (turn) {
      if (
        !turn.work ||
        seen.has(turn.workRef) ||
        (input.scope === 'history' && turn.work.state !== 'failed')
      )
        return [];
      seen.add(turn.workRef);
      return [
        { ...row, ...turn.work, ...(input.native.snapshot !== 'fresh' ? { actions: [] } : {}) },
      ];
    }
    const target = byRef.get(String(row.workRef || ''));
    if (!target) return [row];
    if (!eligible.includes(target) || seen.has(target.work.workRef)) return [];
    seen.add(target.work.workRef);
    return [
      {
        ...row,
        ...target.work,
        provider: typeof row.provider === 'string' ? row.provider : target.work.provider,
        ...(row.delivery ? { delivery: row.delivery } : {}),
        ...(input.native.snapshot !== 'fresh' ? { actions: [] } : {}),
      },
    ];
  });
  if (input.includeNativeOnly !== false) {
    for (const { work: goalWork } of eligible) {
      if (seen.has(goalWork.workRef)) continue;
      seen.add(goalWork.workRef);
      work.push({ ...goalWork, ...(input.native.snapshot !== 'fresh' ? { actions: [] } : {}) });
    }
    for (const { workRef, work: turnWork } of turns) {
      if (
        !turnWork ||
        seen.has(workRef) ||
        (input.scope === 'history' && turnWork.state !== 'failed')
      )
        continue;
      seen.add(workRef);
      work.push({ ...turnWork, ...(input.native.snapshot !== 'fresh' ? { actions: [] } : {}) });
    }
  }
  const statuses = [hosted.snapshot, input.native.snapshot];
  const snapshot =
    statuses.includes('unavailable') || !Array.isArray(hosted.work)
      ? 'unavailable'
      : statuses.includes('stale')
        ? 'stale'
        : 'fresh';
  return {
    ...hosted,
    snapshot,
    nativeSnapshot: input.native.snapshot,
    work: snapshot === 'unavailable' && !work.length ? null : work,
  };
}
/* === VIVENTIUM END === */
