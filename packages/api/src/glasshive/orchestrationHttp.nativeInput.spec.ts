import { createOrchestrationHttpHandlers } from './orchestrationHttp';
import type { OrchestrationHttpDependencies } from './orchestrationHttp';

const nativeInput = { version: 1, requestId: 'input-1', requestFingerprint: 'a'.repeat(64), action: 'decline' };
const operationId = 'cba79c03-fc4e-423f-8e21-8c8fcd6aef9d';
function setup() {
  const executeGlassHiveWorkAction = jest.fn(async () => ({ accepted: true }));
  const unused = async () => { throw new Error('Unexpected unrelated HTTP dependency'); };
  const dependencies: OrchestrationHttpDependencies = {
    executeGlassHiveWorkAction,
    logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    getUserById: unused, updateUserViventiumOrchestrationPreferences: unused,
    getActiveWorkPage: unused, getActiveWorkHistoryPage: unused,
    getActiveWorkInteractiveSnapshot: unused, parallelWorkClaimStateAsync: unused,
    preferredOrchestrationMode: () => 'parallel', observeOrchestrationOwner: jest.fn(),
    refreshOrchestrationReadiness: unused, providerBaseUrl: () => 'http://localhost:8766',
  };
  const res = { status: jest.fn(), json: jest.fn(), set: jest.fn() };
  res.status.mockReturnValue(res);
  return { executeGlassHiveWorkAction, res, handlers: createOrchestrationHttpHandlers(dependencies) };
}
it('derives owner-control provenance from authenticated HTTP, never posted fields', async () => {
  const { handlers, res, executeGlassHiveWorkAction } = setup();
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' }, body: { action: 'resume', operationId, nativeInput } }, res);
  expect(executeGlassHiveWorkAction).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-1', ownerInputControl: true, nativeInput }));
});
it.each([
  { action: 'stop', operationId, nativeInput },
  { action: 'resume', operationId, nativeInput, ownerInputControl: true },
  { action: 'resume', operationId, nativeInput: { ...nativeInput, requestFingerprint: 'foreign' } },
])('rejects incompatible or caller-forged native control %#', async (body) => {
  const { handlers, res, executeGlassHiveWorkAction } = setup();
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' }, body }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
});
