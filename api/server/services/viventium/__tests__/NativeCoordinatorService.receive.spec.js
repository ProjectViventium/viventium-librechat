const mockReceive = jest.fn();
jest.mock('@librechat/api', () => ({
  createNativeCoordinatorHost: () => ({
    receive: (...args) => mockReceive(...args),
    accept: jest.fn(),
    snapshots: jest.fn(),
    control: jest.fn(),
  }),
  mergeHostedAndNativeRoster: jest.fn(),
  nativeCoordinatorCleanedSourceWorkRefs: jest.fn(),
  nativeCoordinatorConfiguration: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));
jest.mock('~/db/models', () => ({ Message: {} }));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: jest.fn() }));
jest.mock('../GlassHiveConversationProviderService', () => ({
  attachConversationProviderBootstrapBundle: jest.fn(),
}));

const { receive } = require('../NativeCoordinatorService');

const call = async (error) => {
  mockReceive.mockReset();
  if (error) mockReceive.mockRejectedValue(error);
  else mockReceive.mockResolvedValue({ accepted: true });
  const res = {
    headers: {},
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  await receive({ get: () => '', viventiumScheduleDueRawBody: Buffer.from('{}') }, res);
  return res;
};

describe('native coordinator notification receipt', () => {
  test('an accepted notification answers 202', async () => {
    expect((await call()).statusCode).toBe(202);
  });

  test('a conversation still answering an earlier turn answers "try again", never a final refusal', async () => {
    const res = await call(
      Object.assign(new Error('conversation_session_authority_conflict'), {
        code: 'conversation_session_authority_conflict',
        status: 409,
      }),
    );
    expect(res.statusCode).toBe(503);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
  });

  test('a changed or invalid notification stays a final refusal', async () => {
    expect(
      (await call(Object.assign(new Error('coordinator_dispatch_changed'), { status: 409 })))
        .statusCode,
    ).toBe(409);
    expect(
      (await call(Object.assign(new Error('coordinator_event_unavailable'), { status: 403 })))
        .statusCode,
    ).toBe(403);
  });

  test('an unclassified failure stays retryable', async () => {
    expect((await call(new Error('coordinator_request_unconfirmed'))).statusCode).toBe(503);
  });
});
