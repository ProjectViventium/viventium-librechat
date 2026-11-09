import { createHmac } from 'node:crypto';
import {
  backgroundWorkerResources,
  configuredBackgroundWorkerRoute,
} from './backgroundWorkerRoute';
import {
  createNativeCoordinatorHost,
  nativeCoordinatorConfiguration,
  nativeCoordinatorHandoffTurnId,
  nativeCoordinatorSourceBody,
} from './nativeCoordinator';

const secret = Buffer.alloc(32, 7).toString('base64');
const now = Date.parse('2026-01-01T00:00:00Z');

function fixture() {
  const bindings = new Map();
  const sources = new Map();
  const deps = {
    tenantId: () => 'local',
    secrets: () => [secret],
    now: () => now,
    readBinding: jest.fn(async (ref) => bindings.get(ref)),
    saveBinding: jest.fn(async (binding) => {
      if (!bindings.has(binding._id)) bindings.set(binding._id, binding);
      return bindings.get(binding._id);
    }),
    bindConversation: jest.fn(async (ref, nativeConversationId) => {
      const bound = { ...bindings.get(ref), nativeConversationId };
      bindings.set(ref, bound);
      return bound;
    }),
    saveSource: jest.fn(async (source) => {
      if (!sources.has(source._id)) sources.set(source._id, source);
    }),
    readSource: jest.fn(async (ref, turn) => sources.get(`${ref}:${turn}`) || null),
    readBindings: jest.fn(async (owner) =>
      [...bindings.values()].filter((binding) => binding.ownerId === owner),
    ),
    ensureDestination: jest.fn(async () => 'destination-test'),
    signBundle: jest.fn(() => ({ 'X-Test-Signature': 'signed' })),
    request: jest.fn(async (input) => {
      if (input.path.endsWith('/conversations')) return { conversation_id: 'conv_test' };
      if (input.path.endsWith('/prepare')) return { request_id: 'request_test' };
      return { state: 'accepted' };
    }),
    prepareTurn: jest.fn(async () => ({
      body: { model: 'exact-model', messages: [] },
      headers: {},
    })),
    prepareDispatch: jest.fn(async () => ({ delegation: {}, headers: {}, context: {} })),
    prepareAction: jest.fn(async () => ({ body: {}, headers: {} })),
    recordAction: jest.fn(async () => {}),
    recordDispatch: jest.fn(async () => {}),
    publishResult: jest.fn(async () => {}),
  };
  const host = createNativeCoordinatorHost(deps);
  return { host, deps, bindings, sources };
}

const admission = {
  ownerId: 'owner-test',
  conversationId: 'application-conversation',
  agentId: 'application-agent',
  occurrenceId: 'tool-occurrence-a',
  original: 'Make A and B. Keep the original conditions.\n',
  requestBody: {
    conversationId: 'application-conversation',
    agent_id: 'application-agent',
    messageId: 'source-a',
    viventiumTriggeringSourceSegments: [{ text: 'Unchanged original.' }],
    authorization: 'must-not-persist',
    viventiumVoiceWorkAuthority: { token: 'must-not-persist' },
  },
  configuration: { model: 'codex-cli:exact-model', effort: 'high', routes: [] },
};

function signedEvent(binding, type = 'coordinator.turn_due', extra = {}) {
  const eventId = 'event-a';
  const timestamp = String(now / 1000);
  const rawBody = Buffer.from(
    JSON.stringify({
      type,
      event_id: eventId,
      principal: { owner_id: binding.ownerId, tenant_id: binding.tenantId },
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      data: {
        conversation_id: binding.nativeConversationId,
        request_ref: binding._id,
        turn_id: 'turn-a',
        ...extra,
      },
    }),
  );
  const signature = `v1,${createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(`${eventId}.${timestamp}.`)
    .update(rawBody)
    .digest('base64')}`;
  return { rawBody, eventId, timestamp, signature };
}

it('admits all original source once without inference or worker preparation on the speaking path', async () => {
  const { host, deps, sources } = fixture();
  const first = await host.accept(admission);
  await host.accept(admission);
  expect(first.accepted).toBe(true);
  expect(deps.ensureDestination).toHaveBeenCalledTimes(1);
  const turns = deps.request.mock.calls
    .map(([request]) => request)
    .filter((request) => request.path.endsWith('/turns'));
  expect(turns).toHaveLength(2);
  expect(turns[0].body).toEqual(turns[1].body);
  expect(turns[0].body.message).toBe(admission.original);
  expect(turns[0].body.idempotency_key).toBe(
    nativeCoordinatorHandoffTurnId(admission.requestBody, admission.original),
  );
  expect(deps.prepareTurn).not.toHaveBeenCalled();
  expect(deps.prepareDispatch).not.toHaveBeenCalled();
  expect(JSON.stringify([...sources.values()])).not.toContain('must-not-persist');
});

it('requests fresh context for a pending turn, and acknowledges an already adopted replay without reminting', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  expect(await host.receive(signedEvent(binding))).toEqual({
    accepted: true,
    requestId: 'request_test',
  });
  expect(deps.prepareTurn).toHaveBeenCalledTimes(1);
  deps.request.mockImplementation(async () => ({ request_id: 'request_test', state: 'running' }));
  expect(await host.receive(signedEvent(binding))).toEqual({ accepted: true, duplicate: true });
  expect(deps.prepareTurn).toHaveBeenCalledTimes(1);
});

it('does not acknowledge a failed context preparation, so the native outbox retains retry ownership', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  deps.prepareTurn.mockRejectedValue(new Error('current_context_unavailable'));
  await expect(host.receive(signedEvent([...bindings.values()][0]))).rejects.toThrow(
    'current_context_unavailable',
  );
  expect(deps.request.mock.calls.some(([request]) => request.path.endsWith('/prepare'))).toBe(
    false,
  );
});

it('hydrates an automatic result wake from its retained original source, with the actual wake identity', async () => {
  const { host, deps, bindings } = fixture();
  const accepted = await host.accept(admission);
  const binding = [...bindings.values()][0];
  deps.request.mockImplementation(async (input) =>
    input.path.endsWith('/prepare')
      ? { request_id: 'result-request' }
      : { turn_id: 'turn-a', source_turn_id: accepted.turnId, origin: 'worker_results' },
  );
  await expect(host.receive(signedEvent(binding))).resolves.toMatchObject({
    requestId: 'result-request',
  });
  expect(deps.readSource).toHaveBeenLastCalledWith(binding._id, accepted.turnId);
  expect(deps.prepareTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      source: expect.objectContaining({ turnId: accepted.turnId }),
      turn: expect.objectContaining({ turn_id: 'turn-a', origin: 'worker_results' }),
    }),
  );
});

it('adopts an exact autonomous action with fresh context and does not remint an adopted retry', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  const data = {
    goal_id: 'goal A 🟦',
    action_key: 'continue A',
    action_digest: 'action-digest',
    run_id: 'run-source',
    source_turn_id: 'original-source',
  };
  let state = 'unprepared';
  deps.request.mockImplementation(async (input) =>
    input.method === 'POST' ? { accepted: true, workRef: 'real-work' } : { ...data, state },
  );
  await expect(host.receive(signedEvent(binding, 'coordinator.action_due', data))).resolves.toEqual(
    { accepted: true },
  );
  expect(deps.prepareAction).toHaveBeenCalledTimes(1);
  expect(deps.request.mock.calls.at(-1)?.[0]).toMatchObject({
    method: 'POST',
    path: '/v1/coordinator/conversations/conv_test/goals/goal%20A%20%F0%9F%9F%A6/actions?run_id=run-source',
  });
  state = 'pending';
  await expect(host.receive(signedEvent(binding, 'coordinator.action_due', data))).resolves.toEqual(
    { accepted: true, duplicate: true },
  );
  expect(deps.prepareAction).toHaveBeenCalledTimes(1);
});

it('rejects an action whose original run changed before fresh authority preparation', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  const data = {
    goal_id: 'g-a',
    action_key: 'action-a',
    action_digest: 'exact-action',
    run_id: 'run-a',
    source_turn_id: 'source-a',
  };
  deps.request.mockImplementation(async () => ({
    ...data,
    run_id: 'newer-run',
    state: 'unprepared',
  }));
  await expect(host.receive(signedEvent(binding, 'coordinator.action_due', data))).rejects.toThrow(
    'coordinator_action_changed',
  );
  expect(deps.prepareAction).not.toHaveBeenCalled();
});

it.each([undefined, 'event-a'])(
  'couriers the current dispatch notification identity (%s)',
  async (notificationRef) => {
    const { host, deps, bindings } = fixture();
    await host.accept(admission);
    const binding = [...bindings.values()][0];
    deps.request.mockImplementation(async (input) =>
      input.method === 'POST'
        ? { work: { work_ref: 'real-work' } }
        : {
            dispatch_digest: 'exact-dispatch',
            ...(notificationRef ? { notification_ref: notificationRef } : {}),
          },
    );
    await expect(
      host.receive(
        signedEvent(binding, 'coordinator.dispatch_due', {
          goal_id: 'goal-a',
          dispatch_digest: 'exact-dispatch',
        }),
      ),
    ).resolves.toEqual({ accepted: true, workRef: 'real-work' });
    const preparedRequest = deps.request.mock.calls.at(-1)?.[0];
    expect(preparedRequest.body).toEqual({
      dispatch_digest: 'exact-dispatch',
      delegation: {},
      ...(notificationRef ? { notification_ref: notificationRef } : {}),
    });
    expect(deps.prepareDispatch).toHaveBeenCalledTimes(1);
    expect(deps.prepareDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationExpiresAt: new Date(now + 60_000).toISOString(),
      }),
    );
    expect(deps.recordDispatch).toHaveBeenCalledTimes(1);
  },
);

it('acknowledges a superseded dispatch wake before preparing context or reserving work', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  deps.request.mockClear();
  deps.request.mockImplementation(async () => ({
    dispatch_digest: 'exact-dispatch',
    notification_ref: 'event-new',
  }));
  await expect(
    host.receive(
      signedEvent(binding, 'coordinator.dispatch_due', {
        goal_id: 'goal-a',
        dispatch_digest: 'exact-dispatch',
      }),
    ),
  ).resolves.toEqual({ accepted: true, stale: true });
  expect(deps.request).toHaveBeenCalledTimes(1);
  expect(deps.prepareDispatch).not.toHaveBeenCalled();
  expect(deps.recordDispatch).not.toHaveBeenCalled();
});

it('rejects a correctly signed notification for another owner binding', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  await expect(host.receive(signedEvent({ ...binding, ownerId: 'other-owner' }))).rejects.toThrow(
    'coordinator_binding_unavailable',
  );
  expect(deps.prepareTurn).not.toHaveBeenCalled();
});

it('verifies the signature before invoking any application context reader', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  await expect(
    host.receive({ ...signedEvent([...bindings.values()][0]), signature: 'v1,invalid' }),
  ).rejects.toThrow();
  expect(deps.prepareTurn).not.toHaveBeenCalled();
});

it('retains the existing delivery courier for a manager-handled result', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  await host.receive(
    signedEvent([...bindings.values()][0], 'coordinator.result_ready', {
      goal_id: 'goal-a',
      run_id: 'run-a',
      result_revision: 1,
      result_digest: `sha256:${'a'.repeat(64)}`,
    }),
  );
  expect(deps.publishResult).toHaveBeenCalledTimes(1);
  expect(deps.prepareTurn).not.toHaveBeenCalled();
});

it.each([
  ['model-a', 'model-b'],
  ['codex-cli:model-a', 'claude-code:model-b'],
])('preserves configured primary/fallback model identity (%s, %s)', (primary, fallback) => {
  expect(
    nativeCoordinatorConfiguration(
      {
        worker_profile: 'codex-cli',
        worker_model: primary,
        worker_reasoning_effort: 'high',
        fallback_worker_profile: 'claude-code',
        fallback_worker_model: fallback,
        fallback_worker_reasoning_effort: 'high',
      },
      'host',
    ),
  ).toMatchObject({
    model: 'codex-cli:model-a',
    effort: 'high',
    routes: [
      { id: 'primary', model: 'codex-cli:model-a', effort: 'high' },
      { id: 'fallback', model: 'claude-code:model-b', effort: 'high' },
    ],
  });
  expect(() => nativeCoordinatorConfiguration({}, 'host')).toThrow(
    'coordinator_worker_configuration_unavailable',
  );
});

it.each(['worker', 'fallback_worker'])(
  'rejects a foreign qualified %s model without remapping it',
  (prefix) => {
    const resources = {
      worker_profile: 'codex-cli',
      worker_model: 'codex-cli:model-a',
      worker_reasoning_effort: 'high',
      fallback_worker_profile: 'claude-code',
      fallback_worker_model: 'claude-code:model-b',
      fallback_worker_reasoning_effort: 'high',
      [`${prefix}_model`]: 'foreign-profile:model-c',
    };
    expect(() => nativeCoordinatorConfiguration(resources, 'host')).toThrow(
      'coordinator_worker_configuration_mismatch',
    );
  },
);

it('accepts the existing saved Worker resource projection without adding another profile prefix', () => {
  const orchestration = {
    worker_profile: 'codex-cli',
    worker_model: 'codex-cli:gpt-6.1-sol',
    worker_reasoning_effort: 'high',
    fallback_worker_profile: 'claude-code',
    fallback_worker_model: 'claude-code:claude-opus-5-5',
    fallback_worker_reasoning_effort: 'high',
  };
  const resources = backgroundWorkerResources(
    configuredBackgroundWorkerRoute({ glasshive_options: { orchestration } }),
  );
  const result = nativeCoordinatorConfiguration(resources, 'host');
  expect(result.model).toBe(orchestration.worker_model);
  expect(result.routes.map(({ model, profile, effort }) => ({ model, profile, effort }))).toEqual([
    { model: orchestration.worker_model, profile: orchestration.worker_profile, effort: 'high' },
    {
      model: orchestration.fallback_worker_model,
      profile: orchestration.fallback_worker_profile,
      effort: 'high',
    },
  ]);
});

it('keeps complete original files/text but never stores live grants or old generation authority', () => {
  const text = 'Original '.repeat(20_000);
  const body = nativeCoordinatorSourceBody({
    ...admission.requestBody,
    viventiumTriggeringSourceSegments: [{ text }],
    files: Array.from({ length: 120 }, (_, i) => ({ file_id: `file-${i}` })),
    viventiumStreamId: 'finished-stream',
    bootstrap_bundle: { env: { TOKEN: 'secret' } },
  });
  expect(body.viventiumTriggeringSourceSegments).toEqual([{ text }]);
  expect(body.files).toHaveLength(120);
  expect(body).not.toHaveProperty('viventiumStreamId');
  expect(body).not.toHaveProperty('bootstrap_bundle');
});

it('routes genuine turn completion through the same signed Native result owner without preparing a Worker', async () => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  const binding = [...bindings.values()][0];
  const data = {
    turn_id: 'turn',
    request_id: 'request',
    run_id: 'run',
    result_revision: 1,
    result_digest: `sha256:${'a'.repeat(64)}`,
  };
  await host.receive(signedEvent(binding, 'coordinator.turn_result_ready', data));
  expect(deps.publishResult).toHaveBeenCalledWith({
    binding,
    data: { conversation_id: binding.nativeConversationId, request_ref: binding._id, ...data },
  });
  expect(deps.prepareTurn).not.toHaveBeenCalled();
  expect(deps.prepareDispatch).not.toHaveBeenCalled();
});
it.each([
  { turn_id: 'turn', run_id: 'run', result_revision: 1 },
  {
    turn_id: 'turn',
    request_id: 'request',
    goal_id: 'fake-goal',
    run_id: 'run',
    result_revision: 1,
    result_digest: `sha256:${'a'.repeat(64)}`,
  },
])('rejects a mixed or incomplete turn event before publication', async (data) => {
  const { host, deps, bindings } = fixture();
  await host.accept(admission);
  await expect(
    host.receive(signedEvent([...bindings.values()][0], 'coordinator.turn_result_ready', data)),
  ).rejects.toThrow();
  expect(deps.publishResult).not.toHaveBeenCalled();
});
