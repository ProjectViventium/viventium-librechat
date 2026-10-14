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
  return { executeGlassHiveWorkAction, res, logger: dependencies.logger, handlers: createOrchestrationHttpHandlers(dependencies) };
}
it('derives owner-control provenance from authenticated HTTP, never posted fields', async () => {
  const { handlers, res, executeGlassHiveWorkAction } = setup();
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' }, body: { action: 'resume', operationId, nativeInput } }, res);
  expect(executeGlassHiveWorkAction).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-1', ownerInputControl: true, nativeInput }));
});
it('attests the authenticated plain owner Resume for horizon renewal', async () => {
  const { handlers, res, executeGlassHiveWorkAction } = setup();
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' },
    body: { action: 'resume', operationId } }, res);
  expect(executeGlassHiveWorkAction).toHaveBeenCalledWith(expect.objectContaining({
    ownerId: 'owner-1', action: 'resume', ownerInputControl: true,
  }));
});
it.each([
  { action: 'stop', operationId, nativeInput },
  { action: 'resume', operationId, nativeInput, ownerInputControl: true },
  { action: 'resume', operationId, ownerInputControl: true },
  { action: 'resume', operationId, nativeInput: { ...nativeInput, requestFingerprint: 'foreign' } },
])('rejects incompatible or caller-forged native control %#', async (body) => {
  const { handlers, res, executeGlassHiveWorkAction } = setup();
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' }, body }, res);
  expect(res.status).toHaveBeenCalledWith(400);
  expect(executeGlassHiveWorkAction).not.toHaveBeenCalled();
});

it('keeps rejected action status and code in the rendered log without private error details', async () => {
  const { handlers, res, logger, executeGlassHiveWorkAction } = setup();
  executeGlassHiveWorkAction.mockRejectedValueOnce(Object.assign(new Error('private details'), {
    status: 404, code: 'capability_authorization_not_found',
  }));
  await handlers.postWorkAction({ user: { id: 'owner-1' }, params: { workRef: 'work-1' },
    body: { action: 'resume', operationId } }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(logger.warn).toHaveBeenCalledWith(
    '[VIVENTIUM][orchestration] Active work action rejected {"action":"resume","status":404,"code":"capability_authorization_not_found"}',
  );
  expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('private details');
});
