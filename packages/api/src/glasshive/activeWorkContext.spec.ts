import { createActiveWorkContextService, formatActiveWorkContext } from './activeWorkContext';

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
const dependencies = () => ({
  getActiveWorkSnapshot: jest.fn(
    async (_input: { ownerId: string; timeoutMs: number }): Promise<Snapshot> => snapshot,
  ),
  preferredMode: (user?: { personalization?: { orchestration_mode?: 'parallel' | 'focused' } }) =>
    user?.personalization?.orchestration_mode || ('parallel' as const),
  tenantId: () => 'tenant-a',
});

afterEach(() => jest.useRealTimers());

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

it('limits voice to active count and urgent work, retaining the list tool for details', () => {
  const result = facts(
    formatActiveWorkContext({ snapshot, preferredMode: 'parallel', available: true, voice: true }),
  );
  expect(result.activeCount).toBe(2);
  expect(result.work.map((item: { workRef: string }) => item.workRef)).toEqual(['work-b']);
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
