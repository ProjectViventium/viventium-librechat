const mockCheckAccess = jest.fn();
const mockGetRoleByName = jest.fn();
const mockGetAgent = jest.fn();
const mockCheckPermission = jest.fn();

jest.mock('@librechat/api', () => ({
  checkAccess: (...args) => mockCheckAccess(...args),
}));
jest.mock('~/models/Role', () => ({
  getRoleByName: (...args) => mockGetRoleByName(...args),
}));
jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: (...args) => mockCheckPermission(...args),
}));

const {
  assertVoiceAgentAccess,
  requireVoiceAgentAccess,
} = require('../VoiceAgentAuthorizationService');

describe('VoiceAgentAuthorizationService', () => {
  const req = {
    user: { id: 'user-1', role: 'USER' },
    body: { endpoint: 'agents', agent_id: 'agent-1' },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCheckAccess.mockResolvedValue(true);
    mockGetAgent.mockResolvedValue({ _id: 'resource-1', id: 'agent-1' });
    mockCheckPermission.mockResolvedValue(true);
  });

  test('allows own, shared, or public agents only when standard global USE and VIEW gates pass', async () => {
    await expect(assertVoiceAgentAccess({ req, agentId: 'agent-1' })).resolves.toMatchObject({
      id: 'agent-1',
    });
    expect(mockCheckAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        user: req.user,
        permissionType: 'AGENTS',
        permissions: ['USE'],
        getRoleByName: expect.any(Function),
      }),
    );
    expect(mockCheckPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        resourceType: 'agent',
        resourceId: 'resource-1',
        requiredPermission: 1,
      }),
    );
  });

  test.each([
    ['global use disabled', false, { _id: 'resource-1' }, true],
    ['foreign or deleted agent', true, null, true],
    ['resource view revoked', true, { _id: 'resource-1' }, false],
  ])('denies %s with the same non-enumerating error', async (_label, globalUse, agent, view) => {
    mockCheckAccess.mockResolvedValue(globalUse);
    mockGetAgent.mockResolvedValue(agent);
    mockCheckPermission.mockResolvedValue(view);

    await expect(assertVoiceAgentAccess({ req, agentId: 'agent-1' })).rejects.toMatchObject({
      status: 404,
      code: 'no_route',
      retryable: false,
      message: 'Voice assistant is unavailable',
    });
  });

  test('Listen-Only bypasses agent execution authorization while Call and Wing invoke it', async () => {
    const next = jest.fn();
    const res = { status: jest.fn(() => res), json: jest.fn() };
    await requireVoiceAgentAccess(
      {
        ...req,
        viventiumCallSession: {
          mode: 'listen_only',
          listenOnlyModeEnabled: true,
          agentId: 'agent-1',
        },
      },
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCheckAccess).not.toHaveBeenCalled();

    next.mockClear();
    await requireVoiceAgentAccess(
      {
        ...req,
        viventiumCallSession: { mode: 'wing', agentId: 'agent-1' },
      },
      res,
      next,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockCheckAccess).toHaveBeenCalledTimes(1);
  });

  test('authorizes only the canonical session agent and ignores a body decoy', async () => {
    const next = jest.fn();
    const res = { status: jest.fn(() => res), json: jest.fn() };
    mockGetAgent.mockImplementation(async ({ id }) => {
      expect(id).toBe('revoked-session-agent');
      return { _id: 'revoked-resource', id };
    });
    mockCheckPermission.mockResolvedValue(false);

    await requireVoiceAgentAccess(
      {
        ...req,
        body: { ...req.body, agent_id: 'accessible-decoy-agent' },
        viventiumCallSession: {
          mode: 'call',
          agentId: 'revoked-session-agent',
        },
      },
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      code: 'no_route',
      message: 'Voice assistant is unavailable.',
      retryable: false,
    });
  });
});
