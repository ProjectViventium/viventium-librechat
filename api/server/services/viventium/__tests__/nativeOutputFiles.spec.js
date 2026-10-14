/* === VIVENTIUM START === Existing file limits and storage boundary for native outputs. === */
const { createHash } = require('node:crypto');
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
const mockFollowUpBind = jest.fn();
let mockSourceRows = [], mockSourceFiles = new Map();
const mockReadSource = jest.fn();
const mockDownload = jest.fn();
jest.mock('~/db/models', () => ({
  Message: {
    find: jest.fn(() => ({ select: () => ({ lean: async () => mockSourceRows }) })),
    findOne: (...args) => ({ select: () => ({ session: () => ({ lean: async () => mockReadSource(...args) }) }) }),
  },
  File: { findOne: (filter) => ({ session: () => ({ lean: async () => mockSourceFiles.get(filter.file_id) }) }) },
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  nativeFollowUpOutputFilesForMessage: (...args) => mockFollowUpBind(...args),
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
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: (...args) => mockLog(...args) },
}));
jest.mock('../nativeResponseService', () => ({
  resolveNativeResponseRoute: (...args) => mockRoute(...args),
}));
jest.mock('~/models/File', () => ({
  findFileById: (...args) => mockFind(...args),
  createFile: (...args) => mockCreate(...args),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({ saveBuffer: mockSave, getDownloadStream: mockDownload }),
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
  prepareRetainedNativeOutputFiles,
} = require('../nativeOutputFiles');
// Imported File IDs are owned by the exact native envelope and verified descriptor.
const importedFixture = (envelope, file, identity) => ({
  file_id: `native_${createHash('sha256').update(JSON.stringify([
    envelope.owner_id, envelope.conversation_id, envelope.message_id, envelope.stream_id,
    envelope.agent_id, envelope.logical_turn_id, envelope.logical_turn_revision,
    envelope.request_id, envelope.run_id, envelope.attempt_id,
    file.filename, file.mime_type, file.bytes, file.sha256,
  ])).digest('hex')}`,
  user: identity.userId, filename: file.filename, type: file.mime_type, bytes: file.bytes,
  nativeOutputFile: { version: 1, status: 'available', messageId: identity.responseMessageId,
    downloadUrl: file.download_url },
});
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
  mockFollowUpBind.mockReset();
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
  mockImport.mockImplementation(async (value, identity) =>
    value.files.map((selected) => importedFixture(value, selected, identity)),
  );
  const message = {
    messageId: 'actual-message',
    conversationId: 'actual-conversation',
    agent_id: 'main',
    text: '[Download](https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef)',
    content: [
      {
        type: 'text',
        text: '[Download](https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef)',
      },
    ],
  };
  const result = await prepareMissionOutputFiles({ req: req(), rows: [row, row], message });
  expect(result.map((file) => file.filename)).toEqual(['result.csv', 'copy.csv']);
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
  expect(message.text).toBe(
    '[Download](https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef)',
  );
  expect(message.content).toEqual([{ type: 'text', text: message.text }]);
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

/* === VIVENTIUM START === A failed Main file cannot hide accepted callback bytes. === */
test.each([true, false])('mission merge prefers only verified Main import: available=%s', async (available) => {
  const mainGrant = 'https://artifacts.example.test/v1/link-refs/ghr_main1234567890abcdef';
  const workerGrant = 'https://artifacts.example.test/v1/link-refs/ghr_worker1234567890abcdef';
  const file = { filename: 'shape.svg', mime_type: 'image/svg+xml', bytes: 20,
    sha256: 'a'.repeat(64), download_url: mainGrant };
  const identity = { userId: 'owner', conversationId: 'conversation', responseMessageId: 'actual-message' };
  const selected = { envelope: { files: [file] }, identity };
  const capture = { publisher: { providerId: 'native-provider' } };
  mockFollowUpBind.mockReturnValue(selected);
  mockImport.mockImplementation(async (value, owner) => value.files.map((item) => {
    if (item.download_url === mainGrant && !available) return { filename: item.filename,
      nativeOutputFile: { version: 1, status: 'unavailable', code: 'native_output_file_content_mismatch' } };
    return importedFixture(value, item, owner);
  }));
  const rows = [{ outputFiles: { files: [{ ...file, download_url: workerGrant }],
    callback_id: 'callback', run_id: 'worker-run', attempt_id: 'worker-attempt' } }];
  const message = { messageId: 'actual-message', conversationId: 'conversation', agent_id: 'main' };
  const result = await prepareMissionOutputFiles({ req: req(), rows, message,
    nativeOutputFiles: capture, sourceMessageId: 'accepted-parent' });
  expect(result.filter((item) => item.nativeOutputFile.status === 'available').map((item) => item.nativeOutputFile.downloadUrl))
    .toEqual([available ? mainGrant : workerGrant]);
  expect(mockFollowUpBind).toHaveBeenCalledWith(capture, {
    userId: 'owner', conversationId: 'conversation', sourceMessageId: 'accepted-parent',
    responseMessageId: 'actual-message', agentId: 'main' });
  expect(mockRoute).toHaveBeenCalledWith({ userId: 'owner', agentId: 'main', providerId: 'native-provider' });
  expect(mockImport.mock.calls[1][0].files).toHaveLength(available ? 0 : 1);
});
test('invalid Main source refuses only its carrier and still imports valid callback files', async () => {
  mockFollowUpBind.mockImplementation(() => { throw new Error('native_output_files_identity_invalid'); });
  mockImport.mockImplementation(async (value, owner) => value.files.map((item) => importedFixture(value, item, owner)));
  const result = await prepareMissionOutputFiles({ req: req(), nativeOutputFiles: {},
    sourceMessageId: 'parent', message: { messageId: 'answer', conversationId: 'conversation', agent_id: 'main' },
    rows: [{ outputFiles: { callback_id: 'callback', run_id: 'run', attempt_id: 'attempt', files: [{
      filename: 'safe.csv', mime_type: 'text/csv', bytes: 20, sha256: 'a'.repeat(64), download_url: 'worker' }] } }] });
  expect(result.some((item) => item.filename === 'safe.csv' && item.nativeOutputFile.status === 'available')).toBe(true);
  expect(result[0].nativeOutputFile.status).toBe('unavailable');
  expect(mockRoute).not.toHaveBeenCalled();
  expect(mockImport).toHaveBeenCalledTimes(1);
});

test('imports only Main-selected accepted native observations through the owner File transport', async () => {
  const item = { kind: 'image', source: 'native_tool_result', run_id: 'run-selected',
    artifact_ref: `artifact_sha256:${'a'.repeat(64)}`, tool_call_id: 'call-selected',
    content_index: 0, mime_type: 'image/png', bytes: 67, sha256: 'a'.repeat(64),
    download_url: 'https://artifacts.example.test/v1/link-refs/ghr_selected12345678',
    open_url: 'https://artifacts.example.test/v1/link-refs/ghr_selected12345678' };
  const row = { ownerId: 'owner', runId: item.run_id, attemptId: 'attempt-selected',
    terminalCallbackId: `cb_terminal_${'d'.repeat(64)}`, originRef: 'origin-selected', workRef: 'work-selected',
    attemptNumber: 1, terminalCallbackResultKey: `ghtr_${'e'.repeat(64)}`,
    terminalCallbackAcceptedOperationId: 'f'.repeat(32), terminalCallbackEffectGeneration: 1,
    terminalCallbackResultRevision: 2, terminalCallbackResultDigest: `sha256:${'b'.repeat(64)}`,
    nativeMedia: { observations: [item, { ...item, content_index: 1,
      artifact_ref: `artifact_sha256:${'c'.repeat(64)}`, sha256: 'c'.repeat(64) }], omitted_count: 0 } };
  const selectedNativeMedia = [{ run_id: item.run_id, tool_call_id: item.tool_call_id,
    content_index: item.content_index, artifact_ref: item.artifact_ref, label: 'Selected evidence' }];
  const message = { conversationId: 'conversation-selected', messageId: 'answer-selected', agent_id: 'main' };
  mockImport.mockImplementation(async (envelope, identity) =>
    envelope.files.map((file) => importedFixture(envelope, file, identity)));
  const result = await prepareMissionOutputFiles({ req: req(), rows: [row], message, selectedNativeMedia });
  expect(result).toHaveLength(1);
  expect(mockImport.mock.calls[0][0]).toMatchObject({ run_id: item.run_id,
    attempt_id: 'attempt-selected', request_id: row.terminalCallbackId,
    files: [{ filename: 'Selected_evidence.png', mime_type: item.mime_type,
      bytes: item.bytes, sha256: item.sha256, download_url: item.download_url }] });
  expect(mockImport.mock.calls[0][1]).toMatchObject({ userId: 'owner',
    responseMessageId: message.messageId, requestId: row.terminalCallbackId,
    runId: item.run_id, attemptId: row.attemptId });
  expect(mockFetchFactory).toHaveBeenCalledWith(mockAccountRoute.mock.results[0].value,
    expect.any(String), expect.any(Function));
  await expect(prepareMissionOutputFiles({ req: req(), rows: [row], message,
    selectedNativeMedia: [{ ...selectedNativeMedia[0], tool_call_id: 'stale-call' }] }))
    .rejects.toThrow('native_media_selection_unavailable');
  await expect(prepareMissionOutputFiles({ req: req(), rows: [{ ...row, ownerId: 'other' }],
    message, selectedNativeMedia })).rejects.toThrow('native_media_authority_invalid');
  mockImport.mockClear();
  expect(await prepareMissionOutputFiles({ req: req(), rows: [row], message })).toEqual([]);
  expect(mockImport).not.toHaveBeenCalled();
});

describe('retained owned native File references', () => {
  function setupRetained() {
    const bytes = Buffer.from('<svg/>');
    const file = { filename: 'capture.svg', mime_type: 'image/svg+xml', bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      download_url: 'https://artifacts.example.test/v1/link-refs/ghr_retained1234567890' };
    const envelope = { version: 1, owner_id: 'owner', conversation_id: 'conversation', message_id: 'old-message',
      agent_id: 'main', stream_id: 'old-stream', logical_turn_id: '', logical_turn_revision: 1,
      request_id: 'old-request', run_id: 'old-run', attempt_id: 'old-attempt', invocation_id: '', files: [file] };
    const nativeIdentity = { userId: 'owner', conversationId: 'conversation', responseMessageId: 'old-message',
      agentId: 'main', streamId: 'old-stream', logicalTurnId: '', revision: 1, invocationId: '',
      providerId: 'native-provider', originSha256: 'a'.repeat(64) };
    const attachment = { ...importedFixture(envelope, file, nativeIdentity), filepath: '/uploads/old.svg', source: 'local' };
    const stored = { ...attachment, conversationId: 'conversation', messageId: 'old-message',
      metadata: { fileIdentifier: `native_output_sha256:${attachment.file_id.slice(7)}` } };
    const candidate = { text: `[Capture](${file.download_url})`, requestId: 'old-request', runId: 'old-run',
      authoritySha256: 'b'.repeat(64), responseJson: JSON.stringify({ id: 'old-request', glasshive: { output_files: envelope } }) };
    const row = { user: 'owner', conversationId: 'conversation', messageId: 'old-message', isCreatedByUser: false,
      unfinished: false, error: false, attachments: [attachment], nativeResponse: { ...nativeIdentity,
        status: 'completed', candidateJson: JSON.stringify(candidate), authoritySha256: candidate.authoritySha256,
        candidateSha256: require('@librechat/data-schemas').nativeResponseDigest(candidate) } };
    mockSourceRows = [row]; mockSourceFiles = new Map([[stored.file_id, stored]]);
    mockReadSource.mockResolvedValue(row); mockFind.mockResolvedValue(stored);
    mockDownload.mockImplementation(async () => (async function* () { yield bytes; })());
    process.env.GLASSHIVE_ARTIFACT_BASE_URL = 'https://artifacts.example.test';
    mockFollowUpBind.mockImplementation((capture, destination) => ({ envelope: { ...capture.envelope,
      message_id: destination.responseMessageId }, identity: { ...capture.identity, ...capture.publisher,
      responseMessageId: destination.responseMessageId } }));
    mockImport.mockImplementation(async (projected, identity, options) => {
      const response = await options.fetchFile(projected.files[0].download_url);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      return projected.files.map((item) => ({ ...importedFixture(projected, item, identity),
        filepath: '/uploads/new.svg', source: 'local' }));
    });
    return { row, file, stored, text: candidate.text,
      identity: { ...nativeIdentity, responseMessageId: 'new-message', requestId: 'new-request', runId: 'new-run' } };
  }
  test('imports original stored bytes into current message and rechecks exact source at publication', async () => {
    const fixture = setupRetained();
    const result = await prepareRetainedNativeOutputFiles(req(), fixture.identity, fixture.text);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0].identity).toMatchObject({ responseMessageId: 'new-message', requestId: 'old-request', runId: 'old-run' });
    expect(result.imports[0].attachments[0].nativeOutputFile.messageId).toBe('new-message');
    expect(result.imports[0].attachments[0].file_id).not.toBe(fixture.stored.file_id);
    expect(mockRoute).not.toHaveBeenCalled();
    expect(mockDownload).toHaveBeenCalledWith(expect.anything(), '/uploads/old.svg');
    await expect(result.authorizePublication({ inTransaction: () => true })).resolves.toBeUndefined();
  });
  test.each(['deleted', 'candidate_changed', 'file_missing', 'file_source_changed'])('revokes publication when original %s', async (kind) => {
    const fixture = setupRetained();
    const result = await prepareRetainedNativeOutputFiles(req(), fixture.identity, fixture.text);
    if (kind === 'deleted') mockReadSource.mockResolvedValue(null);
    if (kind === 'candidate_changed') fixture.row.nativeResponse.candidateSha256 = 'f'.repeat(64);
    if (kind === 'file_missing') mockSourceFiles.clear();
    if (kind === 'file_source_changed') fixture.stored.filepath = '/uploads/replaced.svg';
    await expect(result.authorizePublication({ inTransaction: () => true })).rejects.toThrow('native_output_files_retained_source_invalid');
  });
  test('preserves unrelated links and ignores unverified old attachment claims', async () => {
    const fixture = setupRetained(); fixture.row.nativeResponse.status = 'failed';
    const result = await prepareRetainedNativeOutputFiles(req(), fixture.identity, fixture.text);
    expect(result.imports).toHaveLength(0); expect(mockImport).not.toHaveBeenCalled();
    const unrelated = await prepareRetainedNativeOutputFiles(req(), fixture.identity, '[Reference](https://www.example.test)');
    expect(unrelated.imports).toHaveLength(0);
  });
  test('the shared Phase B mission consumer imports a retained grant without a new file envelope', async () => {
    const fixture = setupRetained();
    const result = await prepareMissionOutputFiles({ req: req(), rows: [],
      message: { messageId: 'new-message', conversationId: 'conversation', agent_id: 'main', text: fixture.text } });
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].nativeOutputFile.messageId).toBe('new-message');
    expect(mockImport).toHaveBeenCalledTimes(1);
    await expect(result.authorizePublication({ inTransaction: () => true })).resolves.toBeUndefined();
  });
  test('deduplicates a newly emitted identical file before retained import', async () => {
    const fixture = setupRetained();
    const originalEnvelope = JSON.parse(JSON.parse(fixture.row.nativeResponse.candidateJson).responseJson).glasshive.output_files;
    const targetEnvelope = { ...originalEnvelope, message_id: 'new-message' };
    const targetIdentity = { ...fixture.identity, requestId: 'old-request', runId: 'old-run' };
    const attachment = importedFixture(targetEnvelope, fixture.file, targetIdentity);
    const result = await prepareRetainedNativeOutputFiles(req(), fixture.identity, fixture.text,
      [{ envelope: targetEnvelope, identity: targetIdentity, attachments: [attachment] }]);
    expect(result.imports).toHaveLength(0); expect(mockImport).not.toHaveBeenCalled();
  });
});
