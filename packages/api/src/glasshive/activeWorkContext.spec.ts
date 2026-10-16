import { projectActiveWorkRoster, createActiveWorkContextService, formatActiveWorkContext } from './activeWorkContext';

const {
  applyTimeContextDelivery,
} = require('../../../../api/server/services/viventium/surfacePrompts');
const agent = { glasshive_options: { orchestration: { parallel_available: true } } };
const work = [
  { workRef: 'work-a', title: 'Website', state: 'running', actions: ['message', 'steer'] },
  { workRef: 'work-b', title: 'Checklist', state: 'needs_input', actions: ['message'] },
];
const snapshot = { snapshot: 'fresh', work, overflowCount: 0 };
type Snapshot = Parameters<typeof formatActiveWorkContext>[0]['snapshot'];
const facts = (capsule: string) => JSON.parse(capsule.split('\n').slice(2).join('\n'));
const nativeQuestion = (key = 'Which colour?') => ({
  version: 1, kind: 'question', state: 'pending', mode: 'form', runtimeName: 'native',
  requestId: 'request-1', requestFingerprint: 'a'.repeat(64), runId: 'run-1',
  attemptId: 'attempt-1', sessionId: 'session-1', expiresAt: '2099-01-01T00:00:00Z',
  message: 'Which colour?', requestedSchema: {
    type: 'object', required: ['answers'], additionalProperties: false,
    properties: {
      answers: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 16,
        properties: { [key]: { type: 'array', uniqueItems: true, minItems: 1, maxItems: 1,
          items: { type: 'string', enum: ['Blue', 'Other'] } } } },
      annotations: { type: 'object', additionalProperties: false, properties: {
        [key]: { type: 'object', additionalProperties: false, required: ['notes'],
          properties: { notes: { type: 'string', minLength: 1, maxLength: 8000 } } } } },
    },
  },
});
const nativePermission = () => ({
  ...nativeQuestion(), kind: 'permission', message: 'Write the drawing?',
  requestedSchema: { type: 'object', required: ['optionId'], properties: {
    optionId: { type: 'string', enum: ['once', 'always', 'deny'],
      enumNames: ['Allow once', 'Always allow', 'Reject once'],
      enumKinds: ['allow_once', 'allow_always', 'reject_once'], description: 'Write drawing.svg' },
  } },
});

describe('current native input in existing bounded work context', () => {
  test.each(['fresh', 'stale'])('does not invent an omitted input form in %s work facts', (freshness) => {
    const current = { snapshot: freshness, work: [{ workRef: 'work-1', state: 'needs_input',
      attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
      actions: ['message', 'resume', 'stop'] }] };
    const projected = [
      facts(formatActiveWorkContext({ snapshot: current, preferredMode: 'parallel', available: true })),
      projectActiveWorkRoster(current, 'active'),
    ];
    for (const result of projected) {
      expect(result.work[0]).not.toHaveProperty('nativeInputOmitted');
      expect(result.work[0]).toMatchObject({ workRef: 'work-1', state: 'needs_input',
        attention: current.work[0].attention, actions: current.work[0].actions });
      expect(result.work[0]).not.toHaveProperty('pendingNativeInput');
    }
  });

  test.each(['Which colour? 🔵', '__proto__'])('retains exact question key %s on every surface', (key) => {
    const pending = nativeQuestion(key);
    const current = { snapshot: 'fresh', work: [{ workRef: 'work-1', state: 'needs_input',
      pendingNativeInput: pending }] };
    const textFacts = facts(formatActiveWorkContext({ snapshot: current, preferredMode: 'parallel', available: true }));
    const voiceFacts = facts(formatActiveWorkContext({ snapshot: current, preferredMode: 'parallel', available: true, voice: true }));
    expect(voiceFacts).toEqual(textFacts);
    expect(textFacts.work[0].pendingNativeInput).toMatchObject({
      version: 1, kind: 'question', requestId: pending.requestId,
      requestFingerprint: pending.requestFingerprint, runId: pending.runId,
      attemptId: pending.attemptId, sessionId: pending.sessionId, expiresAt: pending.expiresAt,
      message: pending.message,
      questionForm: { questions: [{ key, label: key, multiSelect: false,
        options: [{ value: 'Blue', label: 'Blue' }, { value: 'Other', label: 'Other' }] }] },
    });
    expect(textFacts.work[0]).not.toHaveProperty('nativeInputOmitted');
  });

  test('retains exact permission option IDs with their native consent kinds', () => {
    const pending = nativePermission();
    const result = facts(formatActiveWorkContext({ snapshot: { snapshot: 'fresh', work: [
      { workRef: 'work-1', state: 'needs_input', pendingNativeInput: pending },
    ] }, preferredMode: 'parallel', available: true }));
    expect(result.work[0].pendingNativeInput).toMatchObject({ kind: 'permission',
      requestId: 'request-1', requestFingerprint: 'a'.repeat(64), operationTitle: 'Write drawing.svg',
      choices: [{ value: 'once', label: 'Allow once', kind: 'allow_once' },
        { value: 'always', label: 'Always allow', kind: 'allow_always' },
        { value: 'deny', label: 'Reject once', kind: 'reject_once' }] });
  });

  test.each(['stale', 'unavailable', 'expired', 'malformed', 'running', 'permission-kinds'])(
    'keeps basic work truth while omitting %s input', (mutation) => {
      const pending: any = mutation === 'permission-kinds' ? nativePermission() : nativeQuestion();
      if (mutation === 'expired') pending.expiresAt = '2000-01-01T00:00:00Z';
      if (mutation === 'malformed') pending.requestFingerprint = 'invalid';
      if (mutation === 'permission-kinds') pending.requestedSchema.properties.optionId.enumKinds.pop();
      const result = facts(formatActiveWorkContext({ snapshot: {
        snapshot: ['stale', 'unavailable'].includes(mutation) ? mutation : 'fresh', work: [
          { workRef: 'work-1', state: mutation === 'running' ? 'running' : 'needs_input', pendingNativeInput: pending },
        ],
      }, preferredMode: 'parallel', available: true }));
      expect(result.work[0].workRef).toBe('work-1');
      expect(result.work[0]).not.toHaveProperty('pendingNativeInput');
      if (mutation !== 'running') expect(result.work[0].nativeInputOmitted).toBe(true);
    },
  );

  test('omits a whole oversized form before sacrificing common work rows', () => {
    const pending = nativeQuestion('🌲'.repeat(4000));
    const current = { snapshot: 'fresh', work: [
      { workRef: 'work-1', state: 'needs_input', pendingNativeInput: pending },
      { workRef: 'work-2', state: 'running', actions: ['steer'] },
    ] };
    const context = formatActiveWorkContext({ snapshot: current, preferredMode: 'parallel', available: true });
    const result = facts(context);
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(16 * 1024);
    expect(result.work).toHaveLength(2);
    expect(result.work[0]).toMatchObject({ workRef: 'work-1', state: 'needs_input', nativeInputOmitted: true });
    expect(result.work[0]).not.toHaveProperty('pendingNativeInput');
    expect(result.omittedVisibleWork).toBe(0);
  });
});
const dependencies = () => ({
  getActiveWorkSnapshot: jest.fn(
    async (_input: { ownerId: string; timeoutMs: number }): Promise<Snapshot> => snapshot,
  ),
  preferredMode: (user?: { personalization?: { orchestration_mode?: 'parallel' | 'focused' } }) =>
    user?.personalization?.orchestration_mode || ('parallel' as const),
  tenantId: () => 'tenant-a',
});

afterEach(() => jest.useRealTimers());

it('keeps owner-wide original delivery scope on both Voice and text contexts', () => {
  const deliveryScope = {
    originConversationId: 'prior-chat',
    destinations: ['telegram'],
    resultRunId: 'prior-run',
    resultRevision: 2,
  };
  const scoped = {
    snapshot: 'fresh',
    work: [
      { workRef: 'work-a', state: 'running', delivery: { state: 'delivered' }, deliveryScope },
    ],
  };
  for (const voice of [true, false]) {
    expect(
      facts(
        formatActiveWorkContext({
          snapshot: scoped,
          preferredMode: 'parallel',
          available: true,
          voice,
        }),
      ).work[0],
    ).toMatchObject({
      workRef: 'work-a',
      state: 'running',
      deliveryState: 'delivered',
      deliveryScope,
    });
  }
});

it('starts one owner snapshot alongside authority and exposes the actual settled mode and exact siblings', async () => {
  const deps = dependencies();
  const service = createActiveWorkContextService(deps);
  const req = { user: { id: 'owner-a' }, _viventiumParallelWorkTurnAvailable: false };
  const first = service.startActiveWorkContext(req, agent);
  expect(service.startActiveWorkContext(req, agent)).toBe(first);
  await first;
  req._viventiumParallelWorkTurnAvailable = true;
  const context = await service.getActiveWorkTurnContext(req, agent);
  expect(context).toContain('Mode: parallel');
  expect(facts(context).work.map((item: { workRef: string }) => item.workRef)).toEqual([
    'work-b',
    'work-a',
  ]);
  expect(facts(context).work[1].actions).toEqual(['message', 'steer']);
  expect(deps.getActiveWorkSnapshot).toHaveBeenCalledTimes(1);
  expect(deps.getActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-a', timeoutMs: 100 });
  expect(JSON.stringify(req)).not.toContain('_viventiumActiveWorkContext');
});

it('omits focused known-empty context and performs no roster query', async () => {
  const deps = dependencies();
  const service = createActiveWorkContextService(deps);
  const req = {
    user: { id: 'owner-a', personalization: { orchestration_mode: 'focused' as const } },
  };
  expect(await service.getActiveWorkTurnContext(req, agent)).toBe('');
  expect(deps.getActiveWorkSnapshot).not.toHaveBeenCalled();
});

it('keeps accepted work visible while focused or new-delegation authority is unavailable', async () => {
  const service = createActiveWorkContextService(dependencies());
  const req = {
    user: {
      id: 'owner-a',
      personalization: { orchestration_mode: 'focused' as const, parallel_work_known: true },
    },
    _viventiumParallelWorkTurnAvailable: false,
  };
  const context = await service.getActiveWorkTurnContext(req, agent);
  expect(context).toContain('Mode: focused');
  expect(facts(context)).toMatchObject({
    preferredMode: 'focused',
    available: false,
    work: expect.any(Array),
  });
});

it('returns unavailable at the hard cold deadline, without claiming an empty roster', async () => {
  jest.useFakeTimers();
  const deps = dependencies();
  deps.getActiveWorkSnapshot.mockImplementation(() => new Promise(() => {}));
  const service = createActiveWorkContextService(deps);
  const result = service.getActiveWorkTurnContext(
    { user: { id: 'owner-a' }, _viventiumParallelWorkTurnAvailable: true },
    agent,
  );
  await jest.advanceTimersByTimeAsync(100);
  expect(facts(await result)).toMatchObject({
    snapshot: 'unavailable',
    work: null,
    activeCount: null,
  });
});

it('never reuses another owner or tenant snapshot and omits non-roster state', async () => {
  const deps = dependencies();
  deps.getActiveWorkSnapshot.mockImplementation(async ({ ownerId }) => ({
    snapshot: 'fresh',
    work: [{ workRef: ownerId, workspace: '/private/owner-data', bootstrap: 'secret' }],
    overflowCount: 0,
  }));
  const service = createActiveWorkContextService(deps);
  const req = { user: { id: 'owner-a' }, _viventiumParallelWorkTurnAvailable: true };
  expect(await service.getActiveWorkTurnContext(req, agent)).toContain('owner-a');
  req.user.id = 'owner-b';
  const next = await service.getActiveWorkTurnContext(req, agent);
  expect(next).toContain('owner-b');
  expect(next).not.toContain('owner-a');
  expect(next).not.toContain('/private/owner-data');
  expect(next).not.toContain('secret');
  deps.tenantId = () => 'tenant-b';
  await service.getActiveWorkTurnContext(req, agent);
  expect(deps.getActiveWorkSnapshot).toHaveBeenCalledTimes(3);
});

it('fails closed if account scope changes while the old read is pending', async () => {
  const deps = dependencies();
  let resolve: (value: Snapshot) => void = () => {};
  deps.getActiveWorkSnapshot.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const service = createActiveWorkContextService(deps);
  const req = { user: { id: 'owner-a' } };
  const pending = service.getActiveWorkTurnContext(req, agent);
  await Promise.resolve();
  req.user.id = 'owner-b';
  resolve(snapshot);
  expect(facts(await pending).work).toBeNull();
});

it('gives voice the same known work facts and exact actions as other surfaces', () => {
  const result = facts(
    formatActiveWorkContext({ snapshot, preferredMode: 'parallel', available: true, voice: true }),
  );
  expect(result.activeCount).toBe(2);
  expect(result).toEqual(
    facts(formatActiveWorkContext({ snapshot, preferredMode: 'parallel', available: true })),
  );
  expect(result.work.map((item: { workRef: string }) => item.workRef)).toEqual([
    'work-b',
    'work-a',
  ]);
  expect(result.fullRosterTool).toBe('active_work_list');
});

it('bounds context bytes and reports overflow instead of truncating work identities', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    workRef: `work-${i}`,
    title: '🌲'.repeat(300),
    state: 'running',
  }));
  const context = formatActiveWorkContext({
    snapshot: { snapshot: 'fresh', work: many, overflowCount: 20 },
    preferredMode: 'parallel',
    available: true,
  });
  expect(Buffer.byteLength(context)).toBeLessThanOrEqual(16 * 1024);
  expect(facts(context).omittedVisibleWork).toBeGreaterThan(0);
  expect(facts(context).overflowCount).toBe(20);
});

it('uses the same existing mutable context delivery for native and ordinary providers', async () => {
  const service = createActiveWorkContextService(dependencies());
  const req = { user: { id: 'owner-a' }, _viventiumParallelWorkTurnAvailable: true };
  const context = await service.getActiveWorkTurnContext(req, agent);
  const nativeReq = { body: { text: 'Please continue' } };
  const nativeBody: { viventiumGlassHiveTurnContextB64?: string } = {};
  const native = applyTimeContextDelivery({
    req: nativeReq,
    requestBody: nativeBody,
    instructions: 'STATIC',
    timeContextInstructions: context,
    providerCapability: { workspace_binding: true, conversation_session: true },
  });
  const ordinaryReq = { body: { text: 'Please continue' } };
  const ordinary = applyTimeContextDelivery({
    req: ordinaryReq,
    instructions: 'STATIC',
    timeContextInstructions: context,
    providerCapability: {},
  });
  expect(native).toBe('STATIC');
  expect(Buffer.from(nativeBody.viventiumGlassHiveTurnContextB64 || '', 'base64').toString()).toBe(
    context,
  );
  expect(ordinary).toBe(`STATIC\n\n${context}`);
  expect(nativeReq.body.text).toBe('Please continue');
  expect(ordinaryReq.body).toEqual({ text: 'Please continue' });
});

describe('readiness capsule facts: native text and voice projection', () => {
  test.each([false, true])(
    'pins the refusal instead of inferring focused intent on voice=%s',
    async (voice) => {
      const service = createActiveWorkContextService(dependencies());
      const req = {
        user: { id: 'owner-a', personalization: { orchestration_mode: 'parallel' as const } },
        _viventiumParallelWorkTurnAvailable: false,
        _viventiumParallelWorkTurnReadiness: {
          status: 'unready',
          reason: 'storage_pressure_critical',
        },
      };
      const f = facts(await service.getActiveWorkTurnContext(req, agent, { voice }));
      expect(f).toMatchObject({
        preferredMode: 'parallel',
        available: false,
        readiness: { status: 'unready', reason: 'storage_pressure_critical' },
      });
      expect(f.activeCount).toBe(2);
      expect(f.fullRosterTool).toBe('active_work_list');
    },
  );
  test('an accepted focused roster has no invented refusal reason', () => {
    expect(
      facts(formatActiveWorkContext({ snapshot, preferredMode: 'focused', available: false })),
    ).not.toHaveProperty('readiness');
    expect(
      facts(
        formatActiveWorkContext({
          snapshot,
          preferredMode: 'parallel',
          available: true,
          readiness: { status: 'ready', reason: '' },
        }),
      ),
    ).not.toHaveProperty('readiness');
  });
});


describe('compact native tool roster projection', () => {
  test('keeps every fetched identity, complete mask, scope and cursor before optional fields', () => {
    const deliveryScope = { originConversationId: 'prior-chat', destinations: ['telegram'],
      resultRunId: 'retained-run', resultRevision: 2 };
    const actions = Array.from({ length: 15 }, (_, index) => `native-action-${index}`);
    const rows = Array.from({ length: 73 }, (_, index) => ({
      workRef: `work-${index}-${'x'.repeat(165)}`, title: `Work ${index}`,
      state: index === 72 ? 'needs_input' : index > 49 ? 'failed' : 'completed',
      actions, deliveryScope, updatedAt: '2026-01-01T00:00:00Z',
      queue: { instructions: 'verbose'.repeat(1000) }, artifactLinks: { items: ['verbose'] },
    }));
    const result = projectActiveWorkRoster({ snapshot: 'fresh', work: rows,
      overflowCount: 227, cursor: 'native.cursor' }, 'history') as {
        work: typeof rows; scope: string; cursor: string; overflowCount: number;
        omittedVisibleWork: number; exceedsCompactBudget: boolean;
        fullOutputRequired?: boolean; nativeSavedOutputRequiredIfTruncated?: boolean;
      };
    expect(result.scope).toBe('history');
    expect(result.cursor).toBe('native.cursor');
    expect(result.overflowCount).toBe(227);
    expect(result.omittedVisibleWork).toBe(0);
    expect(result.work).toHaveLength(73);
    expect(new Set(result.work.map((row) => row.workRef))).toEqual(new Set(rows.map((row) => row.workRef)));
    for (const row of result.work) {
      expect(row.actions).toEqual(actions);
      expect(row.deliveryScope).toEqual(deliveryScope);
      expect(row).not.toHaveProperty('queue');
      expect(row).not.toHaveProperty('artifactLinks');
      expect(row).not.toHaveProperty('updatedAt');
    }
    expect(result.work[0].state).toBe('needs_input');
    expect(result.exceedsCompactBudget).toBe(true);
    expect(result.fullOutputRequired).toBe(true);
    expect(result.nativeSavedOutputRequiredIfTruncated).toBe(true);
  });

  test('retains current native forms whole when valid and omits oversized forms without losing rows', () => {
    for (const key of ['Which colour?', '🌲'.repeat(8000)]) {
      const result = projectActiveWorkRoster({ snapshot: 'fresh', work: [
        { workRef: 'work-question', state: 'needs_input', actions: ['resume', 'stop'],
          pendingNativeInput: nativeQuestion(key) },
        { workRef: 'work-other', state: 'running', actions: ['steer'] },
      ] }, 'active') as { work: Array<{ workRef: string; pendingNativeInput?: unknown;
        nativeInputOmitted?: boolean }>; omittedVisibleWork: number };
      expect(result.work).toHaveLength(2);
      expect(result.omittedVisibleWork).toBe(0);
      if (key.length < 100) expect(result.work[0].pendingNativeInput).toBeDefined();
      else {
        expect(result.work[0].pendingNativeInput).toBeUndefined();
        expect(result.work[0].nativeInputOmitted).toBe(true);
      }
    }
  });

  test('unavailable and malformed rows do not become a fresh empty roster', () => {
    const unavailable = { snapshot: 'unavailable', work: null };
    expect(projectActiveWorkRoster(unavailable, 'active')).toBe(unavailable);
    expect(projectActiveWorkRoster({ snapshot: 'stale', work: [null,
      { state: 'needs_input' }, { workRef: 'work-retained', state: 'needs_input' }],
      overflowCount: 0 }, 'active')).toMatchObject({ snapshot: 'stale', omittedVisibleWork: 2,
      work: [{ workRef: 'work-retained', state: 'needs_input' }] });
  });
});


test.each(['active', 'history'] as const)('compact %s work retains delivery uncertainty as a fact, not an action', (scope) => {
  const work = ['unknown', 'failed', 'delivered', 'pending'].map((state, index) => ({
    workRef: `work-${index}`, title: 'Work item', state: 'completed', actions: ['message'],
    delivery: { state, unreadTerminal: state !== 'delivered' }, updatedAt: '2026-01-01T00:00:00Z',
  }));
  const result = projectActiveWorkRoster({ snapshot: 'fresh', work }, scope);
  expect(result.work.map((item: { deliveryState: string }) => item.deliveryState))
    .toEqual(work.map((item) => item.delivery.state));
  for (const item of result.work) {
    expect(item.actions).toEqual(['message']);
    expect(item).not.toHaveProperty('updatedAt');
  }
});
