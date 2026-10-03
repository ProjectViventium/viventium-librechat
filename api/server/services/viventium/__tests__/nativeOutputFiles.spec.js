/* === VIVENTIUM START === Existing file limits and storage boundary for native outputs. === */
const mockJob = jest.fn();
const mockCurrent = jest.fn();
const mockContext = jest.fn();
const mockImport = jest.fn();
const mockFind = jest.fn();
const mockCreate = jest.fn();
const mockSave = jest.fn();
const mockRoute = jest.fn();
const mockFetchFactory = jest.fn();
const mockOrigin = jest.fn();
const mockLog = jest.fn();
const mockPublisher = jest.fn();
const mockAccountRoute = jest.fn();
jest.mock('@librechat/api', () => ({
  importNativeOutputFiles: (...args) => mockImport(...args),
  createNativeOutputFileFetch: (...args) => mockFetchFactory(...args),
  nativeResponseOrigin: (...args) => mockOrigin(...args),
  nativeOutputFilePublisherForCarrier: (...args) => mockPublisher(...args),
  createAccountApiRoute: (...args) => mockAccountRoute(...args),
  normalizeNativeCallbackOutputFiles: (value) => value,
  nativeCallbackOutputFilesForMessage: (value, identity) => ({
    ...value,
    message_id: identity.responseMessageId,
  }),
  GenerationJobManager: {
    getJob: (...args) => mockJob(...args),
    getJobStore: () => ({
      getJob: (...args) => mockJob(...args),
      isCurrentLogicalTurn: (...args) => mockCurrent(...args),
    }),
  },
}));
jest.mock('@librechat/data-schemas', () => ({ logger: { debug: (...args) => mockLog(...args) } }));
jest.mock('../nativeResponseService', () => ({
  resolveNativeResponseRoute: (...args) => mockRoute(...args),
}));
jest.mock('~/models/File', () => ({
  findFileById: (...args) => mockFind(...args),
  createFile: (...args) => mockCreate(...args),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({ saveBuffer: mockSave }),
}));
jest.mock('../interactionContext', () => ({
  getTrustedInteractionContext: (...args) => mockContext(...args),
}));
const {
  nativeOutputFileLimit,
  nativeOutputFileLimits,
  prepareNativeOutputFiles,
  prepareCurrentNativeOutputFiles,
  prepareMissionOutputFiles,
} = require('../nativeOutputFiles');
const req = () => ({
  user: { id: 'owner' },
  config: {
    fileConfig: {
      serverFileSizeLimit: 40,
      endpoints: { agents: { fileSizeLimit: 30 } },
    },
  },
  body: { endpoint: 'agents' },
});
beforeEach(() => {
  jest.clearAllMocks();
  mockRoute.mockReset();
  mockFetchFactory.mockReset();
  mockOrigin.mockReset();
  mockPublisher.mockReset();
  mockPublisher.mockReturnValue({ providerId: 'native-provider', originSha256: 'current-origin' });
  mockRoute.mockResolvedValue({
    baseURL: 'http://127.0.0.1:8766/v1',
    headers: { Authorization: 'Bearer synthetic' },
  });
  mockOrigin.mockReturnValue('current-origin');
  mockFetchFactory.mockReturnValue(jest.fn());
  mockAccountRoute.mockReturnValue({
    baseURL: 'http://127.0.0.1:8766/v1',
    headers: { Authorization: 'Bearer synthetic' },
  });
});
test('coalesced mission files retain distinct names for the same bytes and dedupe exact replay', async () => {
  const file = { filename: 'result.csv', mime_type: 'text/csv', bytes: 20, sha256: 'a'.repeat(64) };
  const source = {
    owner_id: 'owner',
    run_id: 'run',
    attempt_id: 'attempt',
    callback_id: 'callback',
    files: [file, { ...file, filename: 'copy.csv' }],
  };
  const row = {
    ownerId: 'owner',
    runId: 'run',
    attemptId: 'attempt',
    outputFiles: source,
    destinations: [{ surface: 'telegram' }],
  };
  mockImport.mockImplementation(async (value) =>
    value.files.map((selected) => ({ file_id: selected.filename })),
  );
  const message = {
    messageId: 'actual-message',
    conversationId: 'actual-conversation',
    agent_id: 'main',
  };
  const result = await prepareMissionOutputFiles({ req: req(), rows: [row, row], message });
  expect(result).toEqual([{ file_id: 'result.csv' }, { file_id: 'copy.csv' }]);
  expect(mockImport.mock.calls[0][0].files).toEqual(source.files);
  expect(mockImport.mock.calls[1][0].files).toEqual([]);
  expect(mockAccountRoute).toHaveBeenCalledWith({ ownerId: 'owner' });
  expect(mockRoute).not.toHaveBeenCalled();
  expect(mockImport.mock.calls[0][1]).toMatchObject({
    userId: 'owner',
    conversationId: 'actual-conversation',
    responseMessageId: 'actual-message',
    streamId: 'actual-message',
    requestId: 'callback',
    runId: 'run',
    attemptId: 'attempt',
  });
  expect(mockImport.mock.calls[0][2].maxBytes).toBe(10_485_760);
});
test('uses the configured server and endpoint byte limits', () => {
  expect(nativeOutputFileLimit(req())).toBe(30 * 1024 * 1024);
  const smaller = req();
  smaller.config.fileConfig.serverFileSizeLimit = 5;
  expect(nativeOutputFileLimit(smaller)).toBe(5 * 1024 * 1024);
});

describe('trusted native artifact transport wiring', () => {
  const owner = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    providerId: 'native-provider',
    agentId: 'agent',
    originSha256: 'current-origin',
    requestId: 'request',
  };
  const route = {
    baseURL: 'http://127.0.0.1:8766/v1',
    headers: { Authorization: 'Bearer synthetic' },
  };
  beforeEach(() => {
    mockRoute.mockResolvedValue(route);
    mockOrigin.mockReturnValue('current-origin');
    mockImport.mockResolvedValue([{ file_id: 'native-file' }]);
  });
  test('accepted native owner uses existing route resolver and fetchFile seam', async () => {
    const fetchFile = jest.fn();
    mockFetchFactory.mockReturnValue(fetchFile);
    expect(await prepareNativeOutputFiles(req(), {}, owner)).toEqual([{ file_id: 'native-file' }]);
    expect(mockRoute).toHaveBeenCalledWith(owner);
    expect(mockFetchFactory).toHaveBeenCalledWith(
      route,
      process.env.GLASSHIVE_ARTIFACT_BASE_URL || '',
      expect.any(Function),
    );
    expect(mockImport.mock.calls[0][2].fetchFile).toBe(fetchFile);
    mockFetchFactory.mock.calls[0][2]({
      status: 'failed',
      errorClass: 'TimeoutError',
      durationMs: 15,
    });
    expect(mockLog).toHaveBeenCalledWith('[NativeOutputFileTransport]', {
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: 'failed',
      errorClass: 'TimeoutError',
      durationMs: 15,
    });
  });
  test('changed native origin does not fetch through public or replacement route', async () => {
    mockOrigin.mockReturnValue('changed-origin');
    expect(await prepareNativeOutputFiles(req(), {}, owner)).toEqual([
      expect.objectContaining({
        nativeOutputFile: expect.objectContaining({ status: 'unavailable' }),
      }),
    ]);
    expect(mockFetchFactory).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
  });
  test('owner route refusal remains unavailable with no public fallback', async () => {
    mockRoute.mockRejectedValue(new Error('native_response_agent_unavailable'));
    await prepareNativeOutputFiles(req(), {}, owner);
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockFetchFactory).not.toHaveBeenCalled();
  });
  test('graph import takes transport identity from existing owned native admission', async () => {
    mockJob.mockResolvedValue({
      status: 'running',
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      nativeResponse: { providerId: 'native-provider', originSha256: 'current-origin' },
    });
    mockCurrent.mockResolvedValue(true);
    mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 1 });
    mockFetchFactory.mockReturnValue(jest.fn());
    await prepareCurrentNativeOutputFiles(
      req(),
      { requestId: 'request', envelope: {} },
      'publisher',
      'stream',
    );
    expect(mockRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'native-provider',
        originSha256: 'current-origin',
        agentId: 'publisher',
      }),
    );
  });
  test.each(['legacy-main', 'different-native-main'])(
    'consultant carries its own verified route with %s',
    async (main) => {
      const publisher = { providerId: 'publisher-provider', originSha256: 'publisher-origin' };
      const admission =
        main === 'legacy-main'
          ? undefined
          : {
              agentId: 'main',
              providerId: 'main-provider',
              originSha256: 'main-origin',
            };
      mockJob.mockResolvedValue({
        status: 'running',
        userId: 'owner',
        conversationId: 'conversation',
        responseMessageId: 'answer',
        ...(admission ? { nativeResponse: admission } : {}),
      });
      mockCurrent.mockResolvedValue(true);
      mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 1 });
      mockPublisher.mockReturnValue(publisher);
      mockOrigin.mockReturnValue('publisher-origin');
      mockFetchFactory.mockReturnValue(jest.fn());
      const carrier = { requestId: 'request', envelope: {}, publisher };
      await prepareCurrentNativeOutputFiles(req(), carrier, 'consultant', 'stream');
      expect(mockPublisher).toHaveBeenCalledWith(carrier, admission, 'consultant');
      expect(mockRoute).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'consultant', ...publisher }),
      );
      expect(mockImport.mock.calls[0][2].fetchFile).toBeDefined();
    },
  );
  test('a graph carrier with no verified publisher is unavailable without a public fetch', async () => {
    mockJob.mockResolvedValue({
      status: 'running',
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
    });
    mockCurrent.mockResolvedValue(true);
    mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 1 });
    mockPublisher.mockReturnValue(undefined);
    expect(
      await prepareCurrentNativeOutputFiles(
        req(),
        { requestId: 'request', envelope: {} },
        'consultant',
        'stream',
      ),
    ).toEqual([
      expect.objectContaining({
        nativeOutputFile: expect.objectContaining({ status: 'unavailable' }),
      }),
    ]);
    expect(mockImport).not.toHaveBeenCalled();
    expect(mockFetchFactory).not.toHaveBeenCalled();
  });
});
test('authenticated Telegram uses its existing 10MiB document download limit', () => {
  const telegram = req();
  telegram._viventiumTelegram = true;
  telegram.body.viventiumSurface = 'telegram';
  expect(nativeOutputFileLimit(telegram)).toBe(10_485_760);
  telegram._viventiumTelegram = false;
  expect(nativeOutputFileLimit(telegram)).toBe(30 * 1024 * 1024);
});
test('a configured disabled endpoint remains disabled', () => {
  const disabled = req();
  disabled.config.fileConfig.endpoints.agents.fileSizeLimit = 0;
  expect(nativeOutputFileLimit(disabled)).toBe(0);
});
test('uses the endpoint count and aggregate byte limits', () => {
  const current = req();
  current.config.fileConfig.endpoints.agents.fileLimit = 3;
  current.config.fileConfig.endpoints.agents.totalSizeLimit = 12;
  expect(nativeOutputFileLimits(current)).toEqual({
    maxBytes: 30 * 1024 * 1024,
    maxFiles: 3,
    maxTotalBytes: 12 * 1024 * 1024,
  });
});
test('ordinary answers do not load or call a File strategy', async () => {
  expect(await prepareNativeOutputFiles(req(), undefined, {})).toEqual([]);
  expect(mockImport).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});
test('verified bytes use normal uploads and an existing unique Mongo identity', async () => {
  mockSave.mockResolvedValue('/uploads/owner/native_example.csv');
  mockCreate.mockResolvedValue({ file_id: 'native_example' });
  mockImport.mockImplementation(async (_envelope, owner, options) => {
    expect(options.maxBytes).toBe(30 * 1024 * 1024);
    expect(options.maxFiles).toBe(10);
    expect(options.maxTotalBytes).toBe(512 * 1024 * 1024);
    return options.store.save(
      { filename: 'result.csv', bytes: 4, mime_type: 'text/csv' },
      Buffer.from('data'),
      owner,
      { fileId: 'native_example', objectId: 'a'.repeat(24), fingerprint: 'a'.repeat(64) },
    );
  });
  const owner = { userId: 'owner', conversationId: 'conversation', responseMessageId: 'answer' };
  await prepareNativeOutputFiles(req(), {}, owner);
  expect(mockSave).toHaveBeenCalledWith({
    userId: 'owner',
    buffer: Buffer.from('data'),
    fileName: 'native_example.csv',
    basePath: 'uploads',
  });
  expect(mockCreate).toHaveBeenCalledWith(
    expect.objectContaining({
      _id: 'a'.repeat(24),
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
      file_id: 'native_example',
      bytes: 4,
      filename: 'result.csv',
      type: 'text/csv',
      metadata: { fileIdentifier: `native_output_sha256:${'a'.repeat(64)}` },
    }),
    true,
  );
});
/* === VIVENTIUM END === */

test('current graph collector uses normal owner, saved response and trusted revision', async () => {
  mockJob.mockResolvedValue({
    status: 'running',
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
  });
  mockCurrent.mockResolvedValue(true);
  mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 2 });
  mockImport.mockResolvedValue([{ file_id: 'selected' }]);
  expect(
    await prepareCurrentNativeOutputFiles(
      req(),
      { envelope: {}, requestId: 'request' },
      'agent',
      'stream',
    ),
  ).toEqual([{ file_id: 'selected' }]);
  expect(mockImport).toHaveBeenCalledWith(
    {},
    {
      userId: 'owner',
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      agentId: 'agent',
      logicalTurnId: 'turn',
      revision: 2,
      requestId: 'request',
      providerId: 'native-provider',
      originSha256: 'current-origin',
    },
    expect.objectContaining({ recoverUnavailable: true }),
  );
});
test.each([
  { status: 'running', userId: 'foreign' },
  { status: 'superseded', userId: 'owner' },
  { status: 'cancelled', userId: 'owner' },
  { status: 'failed', userId: 'owner' },
  null,
])('obsolete or foreign owner does not import or emit files: %s', async (job) => {
  mockJob.mockResolvedValue(job);
  mockCurrent.mockResolvedValue(true);
  expect(
    await prepareCurrentNativeOutputFiles(
      req(),
      { envelope: {}, requestId: 'request' },
      'agent',
      'stream',
    ),
  ).toEqual([]);
  expect(mockImport).not.toHaveBeenCalled();
});
test('prepared storage errors become an unavailable receipt and preserve useful response', async () => {
  mockImport.mockRejectedValue(new Error('store unavailable'));
  expect(await prepareNativeOutputFiles(req(), {}, { responseMessageId: 'answer' })).toEqual([
    {
      filename: 'File',
      messageId: 'answer',
      nativeOutputFile: {
        version: 1,
        status: 'unavailable',
        code: 'native_output_file_unavailable',
      },
    },
  ]);
});

test('stale logical turn and mismatched current revision cannot import files', async () => {
  mockJob.mockResolvedValue({
    status: 'running',
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    interactionContext: { logical_turn_id: 'turn', revision: 1 },
  });
  mockCurrent.mockResolvedValue(false);
  mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 2 });
  expect(
    await prepareCurrentNativeOutputFiles(
      req(),
      { envelope: {}, requestId: 'request' },
      'agent',
      'stream',
    ),
  ).toEqual([]);
  mockCurrent.mockResolvedValue(true);
  expect(
    await prepareCurrentNativeOutputFiles(
      req(),
      { envelope: {}, requestId: 'request' },
      'agent',
      'stream',
    ),
  ).toEqual([]);
  expect(mockImport).not.toHaveBeenCalled();
});

test('bound initial invocation is checked while current unbound graph return stays legal', async () => {
  mockJob.mockResolvedValue({
    status: 'running',
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
  });
  mockCurrent.mockResolvedValue(true);
  mockContext.mockReturnValue({ logical_turn_id: 'turn', revision: 1 });
  mockImport.mockResolvedValue([]);
  const current = req();
  current._viventiumNativeResponseIdentity = { invocationId: 'bound-current' };
  await prepareCurrentNativeOutputFiles(
    current,
    { requestId: 'request', envelope: { invocation_id: 'provider-current' } },
    'agent',
    'stream',
  );
  expect(mockImport.mock.calls[0][1].invocationId).toBe('bound-current');
  await prepareCurrentNativeOutputFiles(
    current,
    { requestId: 'graph-return', envelope: { invocation_id: '' } },
    'agent',
    'stream',
  );
  expect(mockImport.mock.calls[1][1].invocationId).toBeUndefined();
});
