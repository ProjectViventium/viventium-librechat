import {
  createNativeCoordinatorWorkRequestAdapter,
  mergeHostedAndNativeRoster,
  nativeCoordinatorControlRequest,
  nativeCoordinatorWorkRef,
  nativeCoordinatorTurnRef,
  projectNativeCoordinatorWork,
  projectNativeCoordinatorTurn,
  resolveNativeCoordinatorWorkRef,
  resolveNativeCoordinatorTurnRef,
  resolveNativeCoordinatorAlias,
} from './nativeCoordinatorWork';
import type {
  NativeCoordinatorGoal,
  NativeCoordinatorOwnedSnapshot,
  NativeCoordinatorTurn,
  NativeCoordinatorWorkRequestDependencies,
} from './nativeCoordinatorWork';

const owner = { ownerId: 'owner-one', tenantId: 'tenant-one' };
const binding = {
  ...owner,
  active: true,
  conversationId: 'chat-one',
  nativeConversationId: 'native-one',
};
const goal = (id = 'goal-one'): NativeCoordinatorGoal => ({
  goal_id: id,
  text: `Original ${id}`,
  state: 'running',
  work_ref: `ghr_${id}`,
  run_id: `run_${id}`,
  control_run_id: `current_${id}`,
  control_state: 'running',
  actions: ['steer', 'stop'],
});
const snapshots = (goals = [goal()]): NativeCoordinatorOwnedSnapshot[] => [
  {
    binding,
    snapshot: { conversation_id: binding.nativeConversationId, goals },
  },
];
const hosted = {
  snapshot: 'fresh',
  cursor: 'signed.next-page',
  overflowCount: 7,
  work: [
    {
      workRef: 'old-hosted-work',
      title: 'Retained hosted work',
      state: 'running',
      actions: ['pause'],
    },
  ],
};

it('uses stable bounded opaque identities without collision-prone concatenation', () => {
  const ref = nativeCoordinatorWorkRef('native:one', `/${'long-'.repeat(32)}`);
  expect(ref).toMatch(/^xpc_[a-f0-9]{64}$/);
  expect(ref.length).toBeLessThanOrEqual(160);
  expect(ref).toBe(nativeCoordinatorWorkRef('native:one', `/${'long-'.repeat(32)}`));
  expect(nativeCoordinatorWorkRef('a:b', 'c')).not.toBe(nativeCoordinatorWorkRef('a', 'b:c'));
});

it('projects Native manager state and actions, retaining the raw result identity', () => {
  const value = projectNativeCoordinatorWork({ ...owner, binding, goal: goal() });
  expect(value).toMatchObject({
    workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
    nativeWorkRef: 'ghr_goal-one',
    nativeGoalId: 'goal-one',
    managementKind: 'native_coordinator',
    conversationId: 'chat-one',
    title: 'Original goal-one',
    state: 'running',
    actions: ['steer', 'stop'],
    delivery: { state: 'unknown', unreadTerminal: false },
  });
  expect(
    projectNativeCoordinatorWork({
      ...owner,
      binding,
      goal: {
        ...goal(),
        state: 'failed',
        control_state: 'queued',
        actions: ['stop'],
      },
    }),
  ).toMatchObject({ state: 'queued', nativeState: 'failed', actions: ['stop'] });
});

it.each(['blocked', 'restore_held'])(
  'keeps %s truth explicit with Native authority and continuity fences',
  (state) => {
    expect(
      projectNativeCoordinatorWork({
        ...owner,
        binding,
        goal: {
          ...goal(),
          state,
          blocker: 'native_blocker',
        },
      }),
    ).toMatchObject({
      state: state === 'restore_held' ? 'needs_input' : 'blocked',
      nativeState: state,
      actions: state === 'restore_held' ? [] : ['steer', 'stop'],
      attention: {
        kind: state === 'restore_held' ? 'input' : 'failure',
        code: 'native_blocker',
        summary:
          state === 'restore_held'
            ? 'Background work is paused after restore.'
            : 'Background work cannot start yet.',
      },
    });
  },
);

it('does not invent pending-goal actions or truncate original goal text', () => {
  const text = 'original '.repeat(2000);
  expect(
    projectNativeCoordinatorWork({
      ...owner,
      binding,
      goal: { goal_id: 'pending', text, state: 'accepted' },
    }),
  ).toMatchObject({ title: text, state: 'accepted', actions: [] });
});

it.each([{ ownerId: 'other-owner' }, { tenantId: 'other-tenant' }, { active: false }])(
  'excludes bindings outside the current active owner scope: %o',
  (change) => {
    const otherBinding = { ...binding, ...change };
    const sources = [
      { binding: otherBinding, snapshot: { conversation_id: 'native-one', goals: [goal()] } },
    ];
    expect(
      projectNativeCoordinatorWork({ ...owner, binding: otherBinding, goal: goal() }),
    ).toBeNull();
    expect(
      resolveNativeCoordinatorWorkRef({
        ...owner,
        snapshots: sources,
        workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
      }),
    ).toBeNull();
  },
);

it('requires the current binding and exact snapshot identity, without decoding identities from a ref', () => {
  expect(
    resolveNativeCoordinatorWorkRef({ ...owner, snapshots: snapshots(), workRef: 'ghr_goal-one' }),
  ).toBeNull();
  expect(
    resolveNativeCoordinatorWorkRef({
      ...owner,
      snapshots: snapshots(),
      workRef: nativeCoordinatorWorkRef('native-other', 'goal-one'),
    }),
  ).toBeNull();
  expect(() =>
    resolveNativeCoordinatorWorkRef({
      ...owner,
      snapshots: [{ binding, snapshot: { conversation_id: 'native-other', goals: [goal()] } }],
      workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
    }),
  ).toThrow('coordinator_snapshot_binding_mismatch');
});

it('routes exactly A to its Native manager and current control run, leaving B independent', () => {
  const sources = snapshots([goal('A'), goal('B')]);
  const before = JSON.stringify(sources);
  const request = nativeCoordinatorControlRequest({
    ...owner,
    snapshots: sources,
    workRef: nativeCoordinatorWorkRef('native-one', 'A'),
    action: 'steer',
    operationId: 'operation-one',
    instruction: 'Keep this exact guidance.',
  });
  expect(request).toEqual({
    ownerId: owner.ownerId,
    method: 'POST',
    path: '/v1/coordinator/conversations/native-one/goals/A/control',
    body: {
      action: 'steer',
      run_id: 'current_A',
      idempotency_key: 'operation-one',
      message: 'Keep this exact guidance.',
    },
  });
  expect(JSON.stringify(sources)).toBe(before);
  expect(
    resolveNativeCoordinatorWorkRef({
      ...owner,
      snapshots: sources,
      workRef: nativeCoordinatorWorkRef('native-one', 'B'),
    })?.work,
  ).toMatchObject({
    state: 'running',
    actions: ['steer', 'stop'],
  });
});

it('uses the exact goal run only when no separate current control run exists', () => {
  const value = { ...goal(), goal_id: 'goal / one', control_run_id: undefined };
  expect(
    nativeCoordinatorControlRequest({
      ...owner,
      snapshots: snapshots([value]),
      workRef: nativeCoordinatorWorkRef('native-one', value.goal_id),
      action: 'stop',
      operationId: 'operation-stop',
    }),
  ).toMatchObject({
    path: '/v1/coordinator/conversations/native-one/goals/goal%20%2F%20one/control',
    body: { run_id: 'run_goal-one', action: 'stop' },
  });
});

it('rejects an unavailable action, foreign target, or ambiguous current identity', () => {
  const input = {
    ...owner,
    snapshots: snapshots(),
    workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
    operationId: 'operation-one',
  };
  expect(() => nativeCoordinatorControlRequest({ ...input, action: 'retry' })).toThrow(
    'coordinator_action_unavailable',
  );
  expect(() =>
    nativeCoordinatorControlRequest({ ...input, ownerId: 'other-owner', action: 'stop' }),
  ).toThrow('coordinator_work_unavailable');
  expect(() =>
    nativeCoordinatorControlRequest({
      ...input,
      snapshots: [...snapshots(), ...snapshots()],
      action: 'stop',
    }),
  ).toThrow('coordinator_work_identity_ambiguous');
});

it('replaces raw Worker cards with the stable manager card while preserving delivery, artifacts and pagination', () => {
  const source = {
    ...hosted,
    work: [
      ...hosted.work,
      {
        workRef: 'ghr_goal-one',
        provider: 'provider-one',
        state: 'paused',
        actions: ['resume'],
        delivery: { state: 'delivered', unreadTerminal: true },
        viewRef: 'https://example.test/result',
        updatedAt: '2026-11-08T00:00:00Z',
      },
    ],
  };
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted: source,
    native: { snapshot: 'fresh', snapshots: snapshots() },
    scope: 'active',
  });
  expect(result).toMatchObject({
    snapshot: 'fresh',
    cursor: hosted.cursor,
    overflowCount: 7,
    work: [
      hosted.work[0],
      {
        workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
        nativeWorkRef: 'ghr_goal-one',
        state: 'running',
        actions: ['steer', 'stop'],
        provider: 'provider-one',
        delivery: { state: 'delivered', unreadTerminal: true },
        viewRef: 'https://example.test/result',
        updatedAt: '2026-11-08T00:00:00Z',
      },
    ],
  });
  expect((result.work as Array<{ workRef: string }>).map((row) => row.workRef)).not.toContain(
    'ghr_goal-one',
  );
  expect(source.work[1].workRef).toBe('ghr_goal-one');
});

it('never suppresses old hosted work from an unverified owner snapshot', () => {
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted: { ...hosted, work: [{ workRef: 'ghr_goal-one' }] },
    native: {
      snapshot: 'fresh',
      snapshots: [{ ...snapshots()[0], binding: { ...binding, ownerId: 'foreign' } }],
    },
    scope: 'active',
  });
  expect(result.work).toEqual([{ workRef: 'ghr_goal-one' }]);
});

it('merges projected cards idempotently and suppresses duplicate raw aliases', () => {
  const input = {
    ...owner,
    hosted: {
      ...hosted,
      work: [...hosted.work, { workRef: 'ghr_goal-one' }, { workRef: 'ghr_goal-one' }],
    },
    native: { snapshot: 'fresh' as const, snapshots: snapshots() },
    scope: 'active' as const,
  };
  const first = mergeHostedAndNativeRoster(input);
  expect(first.work as unknown[]).toHaveLength(2);
  expect(mergeHostedAndNativeRoster({ ...input, hosted: first })).toEqual(first);
});

it('refuses two manager goals that claim one raw worker identity', () => {
  expect(() =>
    mergeHostedAndNativeRoster({
      ...owner,
      hosted,
      native: {
        snapshot: 'fresh',
        snapshots: snapshots([goal('A'), { ...goal('B'), work_ref: 'ghr_A' }]),
      },
      scope: 'active',
    }),
  ).toThrow('coordinator_work_identity_ambiguous');
});

it('does not append Native-only cards on hosted continuation pages', () => {
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted,
    native: { snapshot: 'fresh', snapshots: snapshots() },
    scope: 'active',
    includeNativeOnly: false,
  });
  expect(result).toMatchObject({ work: hosted.work, cursor: hosted.cursor, overflowCount: 7 });
});

it('keeps history and dismissed goals in the owning scope', () => {
  const sources = snapshots([
    { ...goal('done'), state: 'completed', control_state: 'completed', dismissed: true },
    goal('live'),
  ]);
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted: { snapshot: 'fresh', work: [] },
      native: { snapshot: 'fresh', snapshots: sources },
      scope: 'active',
    }).work,
  ).toMatchObject([{ nativeGoalId: 'live' }]);
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted: { snapshot: 'fresh', work: [] },
      native: { snapshot: 'fresh', snapshots: sources },
      scope: 'history',
    }).work,
  ).toMatchObject([{ nativeGoalId: 'done', state: 'completed' }]);
});

it('preserves unavailable truth with known hosted rows, and never converts unknown into an empty list', () => {
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted,
      native: { snapshot: 'unavailable', snapshots: [] },
      scope: 'active',
    }),
  ).toMatchObject({
    snapshot: 'unavailable',
    nativeSnapshot: 'unavailable',
    work: hosted.work,
    cursor: hosted.cursor,
    overflowCount: 7,
  });
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted: { snapshot: 'unavailable', work: null, overflowCount: null },
      native: { snapshot: 'fresh', snapshots: [] },
      scope: 'active',
    }),
  ).toMatchObject({
    snapshot: 'unavailable',
    work: null,
    overflowCount: null,
  });
});

it('keeps stale goal ownership visible with controls disabled until a current read', () => {
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted: { snapshot: 'fresh', work: [{ workRef: 'ghr_goal-one', actions: ['stop'] }] },
    native: { snapshot: 'stale', snapshots: snapshots() },
    scope: 'active',
  });
  expect(result).toMatchObject({
    snapshot: 'stale',
    work: [
      {
        managementKind: 'native_coordinator',
        workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
        actions: [],
      },
    ],
  });
});

const pendingTurn = (state = 'queued'): NativeCoordinatorTurn => ({
  turn_id: 'accepted-turn',
  message: 'Do both independent tasks exactly as requested.',
  origin: 'interactive',
  state,
  request_id: '',
  blocker: '',
  response_json: '',
  actions: ['stop'],
  created_at: '2026-11-08T00:00:00Z',
});
const turnSnapshots = (
  turn = pendingTurn(),
  goals: NativeCoordinatorGoal[] = [],
): NativeCoordinatorOwnedSnapshot[] => [
  {
    binding,
    snapshot: { conversation_id: 'native-one', goals, turns: [turn] },
  },
];

it('surfaces real accepted planning before any goal or Worker exists', () => {
  const sources = turnSnapshots();
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted: { snapshot: 'fresh', work: [], overflowCount: 0 },
    native: { snapshot: 'fresh', snapshots: sources },
    scope: 'active',
  });
  const ref = nativeCoordinatorTurnRef('native-one', 'accepted-turn');
  expect(ref).toMatch(/^xpt_[a-f0-9]{64}$/);
  expect(ref.length).toBeLessThanOrEqual(160);
  expect(result).toMatchObject({
    snapshot: 'fresh',
    work: [
      {
        workRef: ref,
        managementKind: 'native_coordinator_turn',
        nativeTurnId: 'accepted-turn',
        title: pendingTurn().message,
        state: 'queued',
        nativeState: 'queued',
        actions: ['stop'],
        createdAt: pendingTurn().created_at,
      },
    ],
  });
  expect((result.work as Array<Record<string, unknown>>)[0]).not.toHaveProperty('nativeWorkRef');
  expect(
    resolveNativeCoordinatorTurnRef({ ...owner, snapshots: sources, workRef: ref })?.turn.turn_id,
  ).toBe('accepted-turn');
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted: result,
      native: { snapshot: 'fresh', snapshots: sources },
      scope: 'active',
    }),
  ).toEqual(result);
});

it('retires the planning card when its real goal appears and preserves unrelated hosted work', () => {
  const turn = pendingTurn('running');
  const pending = projectNativeCoordinatorTurn({ ...owner, binding, turn, goals: [] })!;
  const current = turnSnapshots(turn, [{ ...goal(), source_turn_id: turn.turn_id }]);
  const result = mergeHostedAndNativeRoster({
    ...owner,
    hosted: { ...hosted, work: [...hosted.work, pending] },
    native: { snapshot: 'fresh', snapshots: current },
    scope: 'active',
  });
  expect(result.work).toMatchObject([
    hosted.work[0],
    { managementKind: 'native_coordinator', nativeGoalId: 'goal-one' },
  ]);
  expect(
    resolveNativeCoordinatorTurnRef({ ...owner, snapshots: current, workRef: pending.workRef }),
  ).toBeNull();
});

it.each(['completed', 'cancelled'])(
  'hides a %s planning request instead of claiming it still runs',
  (state) => {
    const turn = pendingTurn(state);
    expect(projectNativeCoordinatorTurn({ ...owner, binding, turn, goals: [] })).toBeNull();
    expect(
      mergeHostedAndNativeRoster({
        ...owner,
        hosted,
        native: { snapshot: 'fresh', snapshots: turnSnapshots(turn) },
        scope: 'active',
      }).work,
    ).toEqual(hosted.work);
  },
);

it.each(['failed', 'blocked', 'restore_held'])(
  'retains %s planning attention with exact Native state',
  (state) => {
    const turn = { ...pendingTurn(state), blocker: 'native_failure' };
    expect(
      projectNativeCoordinatorTurn({
        ...owner,
        binding,
        turn,
        goals: [{ ...goal(), source_turn_id: turn.turn_id }],
      }),
    ).toMatchObject({
      nativeState: state,
      state: state === 'restore_held' ? 'needs_input' : state === 'failed' ? 'failed' : 'blocked',
      actions: state === 'restore_held' ? [] : ['stop'],
      attention: { code: 'native_failure' },
    });
  },
);

it('uses only the exact Native turn Stop endpoint, with no fabricated Worker or goal action', () => {
  const sources = turnSnapshots();
  const input = {
    ...owner,
    snapshots: sources,
    workRef: nativeCoordinatorTurnRef('native-one', 'accepted-turn'),
    operationId: 'operation-stop',
  };
  expect(nativeCoordinatorControlRequest({ ...input, action: 'stop' })).toEqual({
    ownerId: owner.ownerId,
    method: 'POST',
    path: '/v1/coordinator/conversations/native-one/turns/accepted-turn/stop',
  });
  expect(() =>
    nativeCoordinatorControlRequest({ ...input, action: 'steer', instruction: 'Different task.' }),
  ).toThrow('coordinator_action_unavailable');
  expect(() =>
    nativeCoordinatorControlRequest({ ...input, ownerId: 'foreign-owner', action: 'stop' }),
  ).toThrow('coordinator_work_unavailable');
  expect(() =>
    nativeCoordinatorControlRequest({
      ...input,
      snapshots: turnSnapshots({ ...pendingTurn(), actions: [] }),
      action: 'stop',
    }),
  ).toThrow('coordinator_action_unavailable');
});

it('does not turn internal result wakes into new user work cards', () => {
  const turn = {
    ...pendingTurn(),
    origin: 'worker_results',
    message: '{"private_result_evidence":true}',
  };
  expect(projectNativeCoordinatorTurn({ ...owner, binding, turn, goals: [] })).toBeNull();
  expect(
    mergeHostedAndNativeRoster({
      ...owner,
      hosted,
      native: { snapshot: 'fresh', snapshots: turnSnapshots(turn) },
      scope: 'active',
    }).work,
  ).toEqual(hosted.work);
});

function requestFixture(prepareAction?: NativeCoordinatorWorkRequestDependencies['prepareAction']) {
  const request = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
  const read = jest.fn().mockResolvedValue({ snapshot: 'fresh', snapshots: snapshots() });
  const adapter = createNativeCoordinatorWorkRequestAdapter({
    tenantId: () => owner.tenantId,
    snapshots: read,
    request,
    ...(prepareAction ? { prepareAction } : {}),
  });
  return { ...adapter, rawRequest: request, read };
}

it('resolves the stable alias into current owned Native location without persisting another ledger', () => {
  expect(
    resolveNativeCoordinatorAlias({
      ...owner,
      snapshot: 'fresh',
      snapshots: snapshots(),
      workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
    }),
  ).toMatchObject({
    kind: 'goal',
    nativeConversationId: 'native-one',
    nativeGoalId: 'goal-one',
    nativeWorkRef: 'ghr_goal-one',
    runId: 'current_goal-one',
    actions: ['steer', 'stop'],
  });
  expect(() =>
    resolveNativeCoordinatorAlias({
      ...owner,
      snapshot: 'stale',
      snapshots: snapshots(),
      workRef: nativeCoordinatorWorkRef('native-one', 'goal-one'),
    }),
  ).toThrow('coordinator_snapshot_not_current');
});

it('leaves ordinary hosted requests and options untouched without Native inventory calls', async () => {
  const f = requestFixture();
  const input = {
    ownerId: owner.ownerId,
    path: '/v1/work/hosted/actions',
    method: 'POST',
    body: { action: 'stop' },
    timeoutMs: 12345,
  };
  f.rawRequest.mockResolvedValue({ state: 'stopping' });
  await expect(f.request(input)).resolves.toEqual({ state: 'stopping' });
  expect(f.rawRequest.mock.calls[0][0]).toBe(input);
  expect(f.read).not.toHaveBeenCalled();
});

it('maps current detail back to the logical alias while preserving exact pending input and options', async () => {
  const f = requestFixture();
  const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
  const pendingNativeInput = {
    runId: 'current_goal-one',
    requestId: 'permission-one',
    requestFingerprint: 'fingerprint-one',
  };
  const fetchImpl = jest.fn();
  f.rawRequest.mockResolvedValue({
    workRef: 'ghr_goal-one',
    pendingNativeInput,
    actions: ['pause'],
    failureClass: 'synthetic_failure',
    viewRef: 'https://example.test/result',
  });
  const result = await f.request({
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}?projection=actions`,
    timeoutMs: 1200,
    maxResponseBytes: 9876,
    fetchImpl,
  });
  expect(f.rawRequest).toHaveBeenCalledWith({
    ownerId: owner.ownerId,
    path: '/v1/work/ghr_goal-one?projection=actions',
    timeoutMs: 1200,
    maxResponseBytes: 9876,
    fetchImpl,
  });
  expect(result).toMatchObject({
    workRef,
    nativeWorkRef: 'ghr_goal-one',
    actions: ['steer', 'stop'],
    pendingNativeInput,
    failureClass: 'synthetic_failure',
    viewRef: 'https://example.test/result',
  });
  expect((result as { pendingNativeInput: unknown }).pendingNativeInput).toBe(pendingNativeInput);
});

it.each(['/actions', '/actions/receipt'])(
  'preserves the whole ordinary body and assertion for rich Native %s',
  async (suffix) => {
    const f = requestFixture();
    const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
    const nativeInput = {
      action: 'accept' as const,
      requestId: 'request-one',
      requestFingerprint: 'fingerprint-one',
    };
    const body = Object.freeze({
      action: 'steer',
      instruction: 'Original exact steering.',
      idempotencyKey: 'exact-key',
      sourceContext: { original: true },
      fileInputs: [{ fileId: 'file-one', sha256: 'a'.repeat(64) }],
      inheritedConversation: { source: ['original input'] },
      capabilityReauthorization: { authorizationRef: 'authorization-one' },
      runtimeBundle: { current: true },
      nativeHumanInput: { user: 'owner-one' },
      nativeInput,
    });
    f.rawRequest.mockResolvedValue({ status: 'ok' });
    await f.request({
      ownerId: owner.ownerId,
      path: `/v1/work/${workRef}${suffix}`,
      method: 'POST',
      body,
      ownerNativeInput: nativeInput,
      timeoutMs: 14000,
    });
    const actual = f.rawRequest.mock.calls[0][0];
    expect(actual).toMatchObject({
      ownerId: owner.ownerId,
      method: 'POST',
      timeoutMs: 14000,
      path: `/v1/coordinator/conversations/native-one/goals/goal-one${suffix}?run_id=current_goal-one`,
    });
    expect(actual.body).toBe(body);
    expect(actual.ownerNativeInput).toBe(nativeInput);
  },
);

it('reads the current replacement run for receipt routing and leaves prior-operation recovery to Native', async () => {
  const f = requestFixture();
  const body = {
    action: 'steer',
    idempotencyKey: 'same-exact-operation',
    instruction: 'Original guidance.',
  };
  const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
  f.rawRequest.mockResolvedValue({ status: 'ok' });
  await f.request({
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}/actions`,
    method: 'POST',
    body,
  });
  f.read.mockResolvedValue({
    snapshot: 'fresh',
    snapshots: snapshots([{ ...goal(), control_run_id: 'replacement-run', actions: [] }]),
  });
  await f.request({
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}/actions/receipt`,
    method: 'POST',
    body,
  });
  expect(f.rawRequest.mock.calls[1][0].path).toBe(
    '/v1/coordinator/conversations/native-one/goals/goal-one/actions/receipt?run_id=replacement-run',
  );
  expect(f.rawRequest.mock.calls[1][0].body).toBe(body);
});

it('fails stale, foreign and changed detail identities before any write or invented target', async () => {
  const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
  const input = {
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}/actions`,
    method: 'POST',
    body: { action: 'stop' },
  };
  const stale = requestFixture();
  stale.read.mockResolvedValue({ snapshot: 'stale', snapshots: snapshots() });
  await expect(stale.request(input)).rejects.toThrow('coordinator_snapshot_not_current');
  expect(stale.rawRequest).not.toHaveBeenCalled();
  const foreign = requestFixture();
  await expect(foreign.request({ ...input, ownerId: 'foreign' })).rejects.toThrow(
    'coordinator_work_unavailable',
  );
  expect(foreign.rawRequest).not.toHaveBeenCalled();
  const changed = requestFixture();
  changed.rawRequest.mockResolvedValue({ workRef: 'different-work' });
  await expect(
    changed.request({ ownerId: owner.ownerId, path: `/v1/work/${workRef}` }),
  ).rejects.toThrow('coordinator_work_detail_changed');
});

it('routes only exact pending-turn Stop and never fabricates an action receipt', async () => {
  const f = requestFixture();
  f.read.mockResolvedValue({ snapshot: 'fresh', snapshots: turnSnapshots() });
  const workRef = nativeCoordinatorTurnRef('native-one', 'accepted-turn');
  f.rawRequest.mockResolvedValue({ state: 'cancelled' });
  await f.request({
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}/actions`,
    method: 'POST',
    body: { action: 'stop', idempotencyKey: 'ordinary-key' },
    timeoutMs: 7000,
  });
  expect(f.rawRequest).toHaveBeenCalledWith({
    ownerId: owner.ownerId,
    method: 'POST',
    timeoutMs: 7000,
    path: '/v1/coordinator/conversations/native-one/turns/accepted-turn/stop',
  });
  await expect(
    f.request({
      ownerId: owner.ownerId,
      path: `/v1/work/${workRef}/actions/receipt`,
      method: 'POST',
      body: { action: 'stop', idempotencyKey: 'ordinary-key' },
    }),
  ).rejects.toThrow('work_action_outcome_unconfirmed');
  expect(f.rawRequest).toHaveBeenCalledTimes(1);
});

it('shows Native planning Retry and retires only the parent of an accepted retry child', () => {
  const failed = { ...pendingTurn('failed'), blocker: 'failed', actions: ['retry'] };
  expect(
    projectNativeCoordinatorTurn({ ...owner, binding, turn: failed, goals: [] }),
  ).toMatchObject({ actions: ['retry'], state: 'failed' });
  expect(
    nativeCoordinatorControlRequest({
      ...owner,
      snapshots: turnSnapshots(failed),
      workRef: nativeCoordinatorTurnRef('native-one', 'accepted-turn'),
      operationId: 'retry-one',
      action: 'retry',
    }).path,
  ).toBe('/v1/coordinator/conversations/native-one/turns/accepted-turn/retry');
  expect(
    projectNativeCoordinatorTurn({
      ...owner,
      binding,
      turn: { ...failed, retry_turn_id: 'accepted-retry' },
      goals: [],
    }),
  ).toBeNull();
  expect(
    projectNativeCoordinatorTurn({
      ...owner,
      binding,
      turn: { ...pendingTurn(), turn_id: 'accepted-retry', source_turn_id: 'accepted-turn' },
      goals: [{ ...goal(), source_turn_id: 'accepted-turn' }],
    }),
  ).toBeNull();
});

it('routes explicit planning Retry and recovers its accepted child with a read-only receipt', async () => {
  const f = requestFixture();
  const failed = { ...pendingTurn('failed'), blocker: 'failed', actions: ['retry'] };
  f.read.mockResolvedValue({ snapshot: 'fresh', snapshots: turnSnapshots(failed) });
  const workRef = nativeCoordinatorTurnRef('native-one', 'accepted-turn');
  const input = {
    ownerId: owner.ownerId,
    path: `/v1/work/${workRef}/actions`,
    method: 'POST',
    body: { action: 'retry', idempotencyKey: 'retry-operation' },
  };
  await f.request(input);
  expect(f.rawRequest).toHaveBeenLastCalledWith({
    ownerId: owner.ownerId,
    method: 'POST',
    path: '/v1/coordinator/conversations/native-one/turns/accepted-turn/retry',
  });
  f.read.mockResolvedValue({
    snapshot: 'fresh',
    snapshots: turnSnapshots({ ...failed, actions: [], retry_turn_id: 'accepted-retry' }),
  });
  await f.request({ ...input, path: `/v1/work/${workRef}/actions/receipt` });
  expect(f.rawRequest).toHaveBeenLastCalledWith({
    ownerId: owner.ownerId,
    method: 'GET',
    path: '/v1/coordinator/conversations/native-one/turns/accepted-retry',
  });
  expect(f.rawRequest).toHaveBeenCalledTimes(2);
  await expect(
    f.request({ ...input, body: { ...input.body, instruction: 'Replace the original' } }),
  ).rejects.toThrow('coordinator_planning_retry_invalid');
});

it.each(['missing', 'unprepared'])(
  'prepares fresh signed cognition only after Native %s preflight and preserves the ordinary action',
  async (state) => {
    const body = Object.freeze({
      action: 'steer',
      idempotencyKey: 'exact-original-key',
      instruction: 'Exact original guidance.',
      runtimeBundle: { schedule: 'original' },
      inheritedConversation: { source: 'original source' },
      sourceContext: { sourceEventId: 'source-one' },
      fileInputs: [{ fileId: 'file-one' }],
      capabilityReauthorization: { authorizationRef: 'grant-one' },
    });
    const prepare = jest.fn().mockResolvedValue({
      body: {
        ...body,
        instruction: 'must not replace original',
        application_bootstrap_bundle_b64: 'fresh-signed-runtime-cognition',
      },
      headers: {
        'X-GlassHive-Bootstrap-Timestamp': '1234',
        'X-GlassHive-Bootstrap-Signature': 'signature-one',
      },
    });
    const f = requestFixture(prepare);
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}'));
    f.rawRequest.mockImplementation(async (input) => {
      if (String(input.path).includes('/preflight?')) return { state };
      await (input.fetchImpl as typeof fetch)('https://example.test/native', {
        method: 'POST',
        headers: { Authorization: 'service-assertion', 'X-Existing': 'kept' },
        body: JSON.stringify(input.body),
      });
      return { status: 'ok' };
    });
    const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
    await expect(
      f.request({
        ownerId: owner.ownerId,
        path: `/v1/work/${workRef}/actions`,
        method: 'POST',
        body,
        fetchImpl,
        timeoutMs: 14500,
        maxResponseBytes: 9876,
      }),
    ).resolves.toEqual({ status: 'ok' });
    expect(prepare).toHaveBeenCalledWith({
      ownerId: owner.ownerId,
      nativeConversationId: 'native-one',
      goalId: 'goal-one',
      body,
    });
    expect(f.rawRequest.mock.calls[0][0].body).toBe(body);
    const transmitted = f.rawRequest.mock.calls[1][0];
    expect(transmitted).toMatchObject({ timeoutMs: 14500, maxResponseBytes: 9876 });
    expect(transmitted.body).toEqual({
      ...body,
      application_bootstrap_bundle_b64: 'fresh-signed-runtime-cognition',
    });
    expect((transmitted.body as Record<string, unknown>).inheritedConversation).toBe(
      body.inheritedConversation,
    );
    expect((transmitted.body as Record<string, unknown>).fileInputs).toBe(body.fileInputs);
    expect(body).not.toHaveProperty('application_bootstrap_bundle_b64');
    const init = fetchImpl.mock.calls[0][1];
    expect(new Headers(init.headers).get('authorization')).toBe('service-assertion');
    expect(new Headers(init.headers).get('x-existing')).toBe('kept');
    expect(new Headers(init.headers).get('x-glasshive-bootstrap-signature')).toBe('signature-one');
    expect(new Headers(init.headers).has('x-glasshive-bootstrap-bundle-b64')).toBe(false);
  },
);

it.each(['pending', 'completed', 'failed'])(
  'replays existing Native %s action through its ordinary receipt without fresh grants',
  async (state) => {
    const prepare = jest.fn();
    const f = requestFixture(prepare);
    f.read.mockResolvedValue({
      snapshot: 'fresh',
      snapshots: snapshots([
        { ...goal(), actions: [], state: 'completed', control_state: 'completed' },
      ]),
    });
    f.rawRequest
      .mockResolvedValueOnce({ state })
      .mockResolvedValueOnce({ status: 'ok', exactReceipt: true });
    const body = {
      action: 'steer',
      idempotencyKey: 'existing-key',
      instruction: 'Exact original.',
    };
    const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
    await expect(
      f.request({
        ownerId: owner.ownerId,
        path: `/v1/work/${workRef}/actions`,
        method: 'POST',
        body,
      }),
    ).resolves.toEqual({ status: 'ok', exactReceipt: true });
    expect(f.rawRequest.mock.calls[1][0].path).toBe(
      '/v1/coordinator/conversations/native-one/goals/goal-one/actions/receipt?run_id=current_goal-one',
    );
    expect(f.rawRequest.mock.calls[1][0].body).toBe(body);
    expect(prepare).not.toHaveBeenCalled();
  },
);

it('never prepares context for direct receipt reads, Stop, or ordinary hosted requests', async () => {
  const prepare = jest.fn();
  const f = requestFixture(prepare);
  f.rawRequest.mockResolvedValue({ status: 'ok' });
  const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
  for (const [path, action] of [
    [`/v1/work/${workRef}/actions/receipt`, 'steer'],
    [`/v1/work/${workRef}/actions`, 'stop'],
    ['/v1/work/ordinary/actions', 'steer'],
  ]) {
    await f.request({
      ownerId: owner.ownerId,
      path,
      method: 'POST',
      body: { action, idempotencyKey: 'key-one' },
    });
  }
  expect(prepare).not.toHaveBeenCalled();
  expect(
    f.rawRequest.mock.calls.every(([input]) => !String(input.path).includes('/preflight?')),
  ).toBe(true);
});

it('propagates exact Native body conflicts before context preparation or an action write', async () => {
  const prepare = jest.fn();
  const f = requestFixture(prepare);
  const conflict = Object.assign(new Error('immutable_native_conflict'), { status: 409 });
  f.rawRequest.mockRejectedValue(conflict);
  const workRef = nativeCoordinatorWorkRef('native-one', 'goal-one');
  await expect(
    f.request({
      ownerId: owner.ownerId,
      path: `/v1/work/${workRef}/actions`,
      method: 'POST',
      body: { action: 'steer', idempotencyKey: 'changed-key', instruction: 'Changed body.' },
    }),
  ).rejects.toBe(conflict);
  expect(prepare).not.toHaveBeenCalled();
  expect(f.rawRequest).toHaveBeenCalledTimes(1);
});

it('keeps exact native permission input attached when a valid Resume obtains fresh runtime cognition', async () => {
  const prepare = jest
    .fn()
    .mockResolvedValue({ body: { application_bootstrap_bundle_b64: 'fresh' }, headers: {} });
  const f = requestFixture(prepare);
  f.read.mockResolvedValue({
    snapshot: 'fresh',
    snapshots: snapshots([{ ...goal(), actions: ['resume'], control_state: 'needs_input' }]),
  });
  f.rawRequest.mockResolvedValueOnce({ state: 'missing' }).mockResolvedValueOnce({ status: 'ok' });
  const nativeInput = {
    version: 1 as const,
    action: 'accept' as const,
    requestId: 'input-one',
    requestFingerprint: 'a'.repeat(64),
    content: { optionId: 'allow-once' },
  };
  const body = { action: 'resume', idempotencyKey: 'resume-key', nativeInput };
  await f.request({
    ownerId: owner.ownerId,
    path: `/v1/work/${nativeCoordinatorWorkRef('native-one', 'goal-one')}/actions`,
    method: 'POST',
    body,
    ownerNativeInput: nativeInput,
  });
  expect(f.rawRequest.mock.calls[1][0].ownerNativeInput).toBe(nativeInput);
  expect((f.rawRequest.mock.calls[1][0].body as Record<string, unknown>).nativeInput).toBe(
    nativeInput,
  );
});

it('projects the actual compact Native pending-turn shape without fetching historical text', () => {
  const turn: NativeCoordinatorTurn = {
    turn_id: 'handoff_synthetic_compact',
    origin: 'interactive',
    request_id: '',
    blocker: '',
    created_at: '2026-01-01T00:00:00.000Z',
    restore_hold: 0,
    state: 'queued',
    actions: ['stop'],
  };
  const result = projectNativeCoordinatorTurn({ ...owner, binding, turn, goals: [] });
  expect(result).toMatchObject({
    managementKind: 'native_coordinator_turn',
    nativeTurnId: turn.turn_id,
    title: 'Starting background work',
    state: 'queued',
    actions: ['stop'],
    provider: '',
  });
  expect(result).not.toHaveProperty('nativeWorkRef');
  expect(
    projectNativeCoordinatorTurn({
      ...owner,
      binding,
      turn: { ...turn, state: 'blocked', blocker: 'application_unavailable' },
      goals: [],
    }),
  ).toMatchObject({ title: 'Background work', state: 'blocked' });
  expect(
    projectNativeCoordinatorTurn({
      ...owner,
      binding,
      turn: { ...turn, state: 'completed' },
      goals: [],
    }),
  ).toBeNull();
});

it.each([null, 17])(
  'rejects malformed supplied compact text while allowing its absence',
  (message) => {
    expect(() =>
      projectNativeCoordinatorTurn({
        ...owner,
        binding,
        turn: { ...pendingTurn(), message } as unknown as NativeCoordinatorTurn,
        goals: [],
      }),
    ).toThrow('coordinator_turn_snapshot_invalid');
  },
);

it('shows rejected unlaunched dispatch as blocked, without a fabricated input request or Retry', () => {
  const projected = projectNativeCoordinatorWork({
    ...owner,
    binding,
    goal: {
      ...goal(),
      state: 'blocked',
      work_ref: '',
      run_id: '',
      blocker: 'application_delivery_rejected',
      actions: ['stop'],
    },
  });
  expect(projected).toMatchObject({
    state: 'blocked',
    actions: ['stop'],
    attention: {
      kind: 'failure',
      code: 'application_delivery_rejected',
      summary: 'Background work cannot start yet.',
    },
  });
  expect(projected?.attention).not.toHaveProperty('summary', 'application_delivery_rejected');
});

it('routes an authoritative no-run dispatch Retry to Native without per-run grants or a fake Worker', async () => {
  const prepare = jest.fn();
  const f = requestFixture(prepare);
  f.read.mockResolvedValue({
    snapshot: 'fresh',
    snapshots: snapshots([
      {
        ...goal(),
        state: 'blocked',
        control_state: undefined,
        work_ref: '',
        run_id: '',
        control_run_id: '',
        blocker: 'application_delivery_rejected',
        actions: ['retry', 'stop'],
      },
    ]),
  });
  f.rawRequest.mockResolvedValue({ action: 'retry', status: 'accepted' });
  const body = { action: 'retry', idempotencyKey: 'exact-rejected-dispatch-retry' };
  await expect(
    f.request({
      ownerId: owner.ownerId,
      path: `/v1/work/${nativeCoordinatorWorkRef('native-one', 'goal-one')}/actions`,
      method: 'POST',
      body,
    }),
  ).resolves.toMatchObject({ action: 'retry', status: 'accepted' });
  expect(prepare).not.toHaveBeenCalled();
  expect(f.rawRequest).toHaveBeenCalledTimes(1);
  expect(f.rawRequest).toHaveBeenCalledWith({
    ownerId: owner.ownerId,
    path: '/v1/coordinator/conversations/native-one/goals/goal-one/actions?run_id=',
    method: 'POST',
    body,
  });
});

it('retains the genuine completed direct-turn work ref for result delivery without creating a goal card', () => {
  const turn: NativeCoordinatorTurn = {
    turn_id: 'turn',
    source_turn_id: 'original',
    origin: 'interactive',
    state: 'completed',
    request_id: 'request',
    run_id: 'run',
    result_revision: 1,
    has_result: true,
    presentation_eligible: true,
    intent_state: 'accepted',
    restore_hold: false,
    superseded: false,
    actions: [],
  };
  expect(projectNativeCoordinatorTurn({ ...owner, binding, turn, goals: [] })).toMatchObject({
    workRef: nativeCoordinatorTurnRef('native-one', 'turn'),
    managementKind: 'native_coordinator_turn',
    nativeTurnId: 'turn',
    state: 'completed',
    actions: [],
    delivery: { state: 'unknown', unreadTerminal: true },
  });
  expect(
    projectNativeCoordinatorTurn({
      ...owner,
      binding,
      turn: { ...turn, has_result: false },
      goals: [],
    }),
  ).toBeNull();
});
