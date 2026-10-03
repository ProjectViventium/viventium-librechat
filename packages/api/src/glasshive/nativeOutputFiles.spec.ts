import { createHash } from 'node:crypto';
import {
  importNativeOutputFiles,
  normalizeNativeOutputFiles,
  inspectNativeOutputFileCarrier,
  createNativeOutputFileFetch,
  nativeOutputFilePublisherFromContext,
  nativeOutputFilePublisherForCarrier,
  normalizeNativeCallbackOutputFiles,
  nativeCallbackOutputFilesForMessage,
} from './nativeOutputFiles';
import { nativeResponseOrigin } from './nativeResponse';
import type { NativeOutputFiles, NativeOutputStoredFile } from './nativeOutputFiles';
const bytes = Buffer.from('item,value\nAster,10\n');
const identity = {
  userId: 'owner-one',
  conversationId: 'conversation-one',
  responseMessageId: 'answer-one',
  streamId: 'stream-one',
  agentId: 'agent-one',
  logicalTurnId: 'turn-one',
  revision: 2,
  requestId: 'request-one',
  runId: 'run-one',
  invocationId: 'invocation-one',
};
const base = 'https://artifacts.example.test';
describe('host-owned native file publisher identity', () => {
  const capability = { workspace_binding: true, conversation_session: true };
  const publisher = {
    providerId: 'consultant-native',
    originSha256: nativeResponseOrigin('https://native.example.test/v1'),
  };
  test('seals the emitting native context rather than the visible Main provider', () => {
    expect(
      nativeOutputFilePublisherFromContext({
        providerId: publisher.providerId,
        baseURL: 'https://native.example.test/v1',
        capability,
      }),
    ).toEqual(publisher);
    expect(nativeOutputFilePublisherForCarrier({ publisher }, undefined, 'consultant')).toEqual(
      publisher,
    );
  });
  test('consultant transport wins over a different native Main admission', () => {
    expect(
      nativeOutputFilePublisherForCarrier(
        { publisher },
        {
          agentId: 'main',
          providerId: 'other-native',
          originSha256: 'b'.repeat(64),
        },
        'consultant',
      ),
    ).toEqual(publisher);
  });
  test('a missing consultant identity never borrows Main authority', () => {
    expect(
      nativeOutputFilePublisherForCarrier(
        {},
        {
          agentId: 'main',
          ...publisher,
        },
        'consultant',
      ),
    ).toBeUndefined();
  });
  test('an exact first-class Main admission remains a valid source', () => {
    expect(
      nativeOutputFilePublisherForCarrier({}, { agentId: 'main', ...publisher }, 'main'),
    ).toEqual(publisher);
  });
  test('invalid explicit publisher identity cannot fall back to Main', () => {
    expect(
      nativeOutputFilePublisherForCarrier(
        { publisher: { providerId: 'bad' } },
        { agentId: 'main', ...publisher },
        'main',
      ),
    ).toBeUndefined();
  });
  test.each([
    { baseURL: undefined, capability },
    { baseURL: 'https://native.example.test/v2', capability },
    { baseURL: 'https://user:secret@native.example.test/v1', capability },
    { baseURL: 'https://native.example.test/v1?token=invalid', capability },
    {
      baseURL: 'https://native.example.test/v1',
      capability: { ...capability, workspace_binding: false },
    },
    {
      baseURL: 'https://native.example.test/v1',
      capability: { ...capability, conversation_session: false },
    },
  ])('unproved host context does not seal publisher transport %#', (context) => {
    expect(
      nativeOutputFilePublisherFromContext({ providerId: 'native', ...context }),
    ).toBeUndefined();
  });
});
const envelope: NativeOutputFiles = {
  version: 1,
  owner_id: identity.userId,
  conversation_id: identity.conversationId,
  message_id: identity.responseMessageId,
  stream_id: identity.streamId,
  agent_id: identity.agentId,
  logical_turn_id: identity.logicalTurnId,
  logical_turn_revision: 2,
  request_id: identity.requestId,
  run_id: identity.runId,
  attempt_id: 'attempt-one',
  invocation_id: identity.invocationId,
  files: [
    {
      filename: 'result.csv',
      mime_type: 'text/csv',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      download_url: `${base}/v1/link-refs/ghr_1234567890abcdef`,
    },
  ],
};
describe('accepted terminal callback file scope', () => {
  const sourceIdentity = {
    ownerId: identity.userId,
    runId: identity.runId,
    attemptId: 'attempt-one',
    callbackId: 'callback-one',
    originRef: 'origin-one',
    workRef: 'work-one',
    resultRevision: 1,
    resultDigest: `sha256:${'a'.repeat(64)}`,
  };
  const source = {
    version: 1 as const,
    owner_id: sourceIdentity.ownerId,
    run_id: sourceIdentity.runId,
    attempt_id: sourceIdentity.attemptId,
    callback_id: sourceIdentity.callbackId,
    origin_ref: sourceIdentity.originRef,
    work_ref: sourceIdentity.workRef,
    result_revision: sourceIdentity.resultRevision,
    result_digest: sourceIdentity.resultDigest,
    files: envelope.files,
  };
  test.each([
    'owner_id',
    'run_id',
    'attempt_id',
    'callback_id',
    'origin_ref',
    'work_ref',
    'result_digest',
  ])('rejects a mismatched native source %s', (field) => {
    const foreign = field === 'result_digest' ? `sha256:${'b'.repeat(64)}` : 'foreign';
    expect(() =>
      normalizeNativeCallbackOutputFiles({ ...source, [field]: foreign }, sourceIdentity),
    ).toThrow('native_output_files_identity_invalid');
  });
  test('rejects destination fields and a different accepted result revision', () => {
    expect(() =>
      normalizeNativeCallbackOutputFiles({ ...source, message_id: 'forged' }, sourceIdentity),
    ).toThrow('native_output_files_invalid');
    expect(() =>
      normalizeNativeCallbackOutputFiles({ ...source, result_revision: 2 }, sourceIdentity),
    ).toThrow('native_output_files_identity_invalid');
  });
  test('binds verified files to Core own destination without provider admission', () => {
    const accepted = normalizeNativeCallbackOutputFiles(source, sourceIdentity)!;
    const destination = {
      ...identity,
      responseMessageId: 'actual-followup',
      streamId: 'actual-followup',
      requestId: source.callback_id,
      attemptId: source.attempt_id,
      invocationId: '',
      logicalTurnId: '',
      revision: 1,
    };
    const mapped = nativeCallbackOutputFilesForMessage(accepted, destination);
    expect(normalizeNativeOutputFiles(mapped, destination)).toEqual(mapped);
    expect(mapped.message_id).toBe('actual-followup');
    expect(mapped.files).toEqual(source.files);
    expect(mapped).not.toHaveProperty('providerId');
  });
});
function fixture() {
  const rows = new Map<string, NativeOutputStoredFile>();
  const fetchFile = jest.fn(
    async () =>
      new Response(bytes, {
        headers: {
          'content-type': 'text/csv',
          'content-length': String(bytes.length),
        },
      }),
  );
  const find = jest.fn(async (key: string) => rows.get(key) || null);
  const save = jest.fn(async (file, data, source, keys) => {
    expect(data).toEqual(bytes);
    const row: NativeOutputStoredFile = {
      file_id: keys.fileId,
      user: source.userId,
      conversationId: source.conversationId,
      messageId: source.responseMessageId,
      filename: file.filename,
      type: file.mime_type,
      bytes: file.bytes,
      filepath: `/uploads/owner-one/${keys.fileId}.csv`,
      source: 'local',
      object: 'file',
      metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
    };
    rows.set(keys.fileId, row);
    return row;
  });
  return {
    rows,
    find,
    save,
    fetchFile,
    options: { artifactBaseURL: base, maxBytes: 10_485_760, fetchFile, store: { find, save } },
  };
}

describe('authenticated native artifact transport', () => {
  const route = {
    baseURL: 'http://127.0.0.1:8766/v1',
    headers: {
      Authorization: 'Bearer synthetic-credential',
      'X-Viventium-User-Id': identity.userId,
    },
  };

  test('unavailable public route retains a failure while the same grant on native imports verified bytes', async () => {
    const f = fixture();
    const network = jest.fn(async (url: string, init?: RequestInit) => {
      if (new URL(url).origin === base) throw new DOMException('Synthetic timeout', 'TimeoutError');
      expect(url).toBe('http://127.0.0.1:8766/v1/link-refs/ghr_1234567890abcdef');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-credential');
      expect(new Headers(init?.headers).get('X-Viventium-User-Id')).toBe(identity.userId);
      return new Response(bytes, {
        headers: { 'content-type': 'text/csv', 'content-length': String(bytes.length) },
      });
    });
    const prior = await importNativeOutputFiles(envelope, identity, {
      ...f.options,
      fetchFile: network,
      recoverUnavailable: true,
    });
    expect(prior[0]).toMatchObject({
      nativeOutputFile: { code: 'native_output_file_unavailable' },
    });
    expect(f.save).not.toHaveBeenCalled();
    const current = {
      ...f.options,
      fetchFile: createNativeOutputFileFetch(route, base, undefined, network),
    };
    const delivered = await importNativeOutputFiles(envelope, identity, current);
    expect(delivered[0]).toHaveProperty('file_id');
    expect(await importNativeOutputFiles(envelope, identity, current)).toEqual(delivered);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(2);
  });

  test.each([
    'https://foreign.example.test/v1/link-refs/ghr_1234567890abcdef',
    `${base}/v1/link-refs/ghr_1234567890abcdef?scope=other`,
    `${base}/v1/link-refs/ghr_1234567890abcdef#other`,
    'https://username@artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
    `${base}/v1/health`,
    `${base}/v1/link-refs/../private`,
  ])('invalid original grant never reaches the configured native origin: %s', async (url) => {
    const network = jest.fn();
    await expect(createNativeOutputFileFetch(route, base, undefined, network)(url)).rejects.toThrow(
      'native_output_file_origin_invalid',
    );
    expect(network).not.toHaveBeenCalled();
  });

  test.each([
    'ftp://127.0.0.1/v1',
    'http://username@127.0.0.1/v1',
    'http://127.0.0.1/v1?other=true',
    'http://127.0.0.1/v1#other',
    'http://127.0.0.1/other',
  ])('unusable configured native transport is refused: %s', (baseURL) => {
    expect(() => createNativeOutputFileFetch({ ...route, baseURL }, base)).toThrow(
      'native_output_file_origin_invalid',
    );
  });

  test('existing signed token path and signal remain intact, with only scoped route headers', async () => {
    const network = jest.fn(async () => new Response(bytes));
    const signal = new AbortController().signal;
    await createNativeOutputFileFetch(
      route,
      base,
      undefined,
      network,
    )(`${base}/v1/signed-links/synthetic-token-123`, {
      signal,
      redirect: 'follow',
      headers: { Authorization: 'Bearer untrusted' },
    });
    const [url, init] = network.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8766/v1/signed-links/synthetic-token-123');
    expect(init?.signal).toBe(signal);
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer synthetic-credential');
  });

  test('foreign owner is rejected before either transport or storage', async () => {
    const f = fixture();
    await expect(
      importNativeOutputFiles(
        envelope,
        { ...identity, userId: 'foreign-owner' },
        {
          ...f.options,
          fetchFile: createNativeOutputFileFetch(route, base, undefined, f.fetchFile),
        },
      ),
    ).rejects.toThrow('native_output_files_identity_invalid');
    expect(f.fetchFile).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });

  test.each(['expired', 'wrong-mime', 'wrong-bytes'])(
    'native relocation retains %s rejection',
    async (kind) => {
      const f = fixture();
      const network = jest.fn(async () =>
        kind === 'expired'
          ? new Response(null, { status: 401 })
          : new Response(kind === 'wrong-bytes' ? Buffer.alloc(bytes.length) : bytes, {
              headers: {
                'content-type': kind === 'wrong-mime' ? 'image/png' : 'text/csv',
                'content-length': String(bytes.length),
              },
            }),
      );
      const result = await importNativeOutputFiles(envelope, identity, {
        ...f.options,
        recoverUnavailable: true,
        fetchFile: createNativeOutputFileFetch(route, base, undefined, network),
      });
      expect(result[0]).toMatchObject({
        nativeOutputFile: {
          status: 'unavailable',
          code:
            kind === 'expired'
              ? 'native_output_file_unavailable'
              : 'native_output_file_content_mismatch',
        },
      });
      expect(f.save).not.toHaveBeenCalled();
    },
  );

  test('transport observations contain only bounded status, duration and class; observation failure cannot change delivery', async () => {
    const observe = jest.fn();
    const cause = Object.assign(new Error('private body, credential and URL'), {
      name: 'private-secret-name',
    });
    const network = jest.fn(async () => {
      throw cause;
    });
    await expect(
      createNativeOutputFileFetch(route, base, observe, network)(envelope.files[0].download_url),
    ).rejects.toBe(cause);
    expect(observe).toHaveBeenCalledWith({
      status: 'failed',
      errorClass: 'Error',
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(observe.mock.calls)).not.toContain('private');
    const unavailable = new Response(null, { status: 503 });
    const throwingObserver = () => {
      throw new Error('Recorder unavailable');
    };
    expect(
      await createNativeOutputFileFetch(
        route,
        base,
        throwingObserver,
        async () => unavailable,
      )(envelope.files[0].download_url),
    ).toBe(unavailable);
  });
});
test('a rejected explicit selection yields a truthful unavailable receipt without a fetch or File', async () => {
  const f = fixture();
  const rejected = ['source_root_unsupported', 'not_deliverable', 'unreadable'] as const;
  const value = {
    ...envelope,
    files: [],
    rejected: rejected.map((code, index) => ({ name: `result-${index}.csv`, code })),
  };
  const result = await importNativeOutputFiles(value, identity, {
    ...f.options,
    recoverUnavailable: true,
  });
  expect(result).toEqual(
    rejected.map((code, index) => ({
      filename: `result-${index}.csv`,
      messageId: identity.responseMessageId,
      nativeOutputFile: { version: 1, status: 'unavailable', code: `native_output_file_${code}` },
    })),
  );
  expect(f.fetchFile).not.toHaveBeenCalled();
  expect(f.find).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});
test.each(['../private.csv', '/private.csv', 'folder\\private.csv'])(
  'rejected selection cannot expose a path: %s',
  async (name) => {
    const f = fixture();
    await expect(
      importNativeOutputFiles(
        { ...envelope, files: [], rejected: [{ name, code: 'unreadable' }] },
        identity,
        f.options,
      ),
    ).rejects.toThrow('native_output_files_invalid');
    expect(f.fetchFile).not.toHaveBeenCalled();
  },
);
test('configured file count is enforced before import, preserving order and the excess notice', async () => {
  const f = fixture();
  const value = {
    ...envelope,
    files: Array.from({ length: 11 }, (_, index) => ({
      ...envelope.files[0],
      filename: `result-${index}.csv`,
    })),
  };
  const result = await importNativeOutputFiles(value, identity, {
    ...f.options,
    maxFiles: 10,
    recoverUnavailable: true,
  });
  expect(result.map((file) => file.filename)).toEqual(value.files.map((file) => file.filename));
  expect(f.fetchFile).toHaveBeenCalledTimes(10);
  expect(f.save).toHaveBeenCalledTimes(10);
  expect(result[10]).toMatchObject({
    filename: 'result-10.csv',
    nativeOutputFile: { status: 'unavailable', code: 'native_output_file_count_limit' },
  });
});
test('aggregate byte bound is checked before any over-budget download', async () => {
  const f = fixture();
  const value = {
    ...envelope,
    files: ['first.csv', 'second.csv', 'third.csv'].map((filename) => ({
      ...envelope.files[0],
      filename,
    })),
  };
  const result = await importNativeOutputFiles(value, identity, {
    ...f.options,
    maxTotalBytes: bytes.length * 2,
    recoverUnavailable: true,
  });
  expect(f.fetchFile).toHaveBeenCalledTimes(2);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(result[2]).toMatchObject({
    filename: 'third.csv',
    nativeOutputFile: { status: 'unavailable', code: 'native_output_file_total_size_limit' },
  });
});
test('zero file count disables downloads honestly', async () => {
  const f = fixture();
  const result = await importNativeOutputFiles(envelope, identity, {
    ...f.options,
    maxFiles: 0,
    recoverUnavailable: true,
  });
  expect(result[0]).toMatchObject({
    nativeOutputFile: { status: 'unavailable', code: 'native_output_file_count_limit' },
  });
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test('ordinary and legacy answers do no file work', async () => {
  const f = fixture();
  expect(await importNativeOutputFiles(undefined, identity, f.options)).toEqual([]);
  expect(f.find).not.toHaveBeenCalled();
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test('exact selected bytes become one reusable normal attachment', async () => {
  const f = fixture();
  const first = await importNativeOutputFiles(envelope, identity, f.options);
  expect(first).toEqual([
    {
      user: identity.userId,
      file_id: expect.stringMatching(/^native_[a-f0-9]{64}$/),
      filename: 'result.csv',
      filepath: expect.stringContaining('/uploads/'),
      bytes: bytes.length,
      type: 'text/csv',
      source: 'local',
      object: 'file',
    },
  ]);
  expect(await importNativeOutputFiles(envelope, identity, f.options)).toEqual(first);
  expect(f.save).toHaveBeenCalledTimes(1);
  expect(f.fetchFile).toHaveBeenCalledTimes(1);
  expect(f.fetchFile).toHaveBeenCalledWith(
    envelope.files[0].download_url,
    expect.objectContaining({ redirect: 'error' }),
  );
  expect(f.save.mock.calls[0][3].objectId).toMatch(/^[a-f0-9]{24}$/);
});
test.each([
  'owner_id',
  'conversation_id',
  'message_id',
  'stream_id',
  'agent_id',
  'logical_turn_id',
  'request_id',
  'run_id',
  'invocation_id',
])('rejects foreign/stale %s before fetch', async (field) => {
  const f = fixture();
  await expect(
    importNativeOutputFiles({ ...envelope, [field]: 'foreign' }, identity, f.options),
  ).rejects.toThrow('native_output_files_identity_invalid');
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test('rejects stale revision before work', () => {
  expect(() =>
    normalizeNativeOutputFiles({ ...envelope, logical_turn_revision: 1 }, identity),
  ).toThrow('native_output_files_identity_invalid');
});
test('dedupes exact selections while preserving published distinct filenames with identical bytes', async () => {
  const f = fixture();
  const value = {
    ...envelope,
    files: [envelope.files[0], envelope.files[0], { ...envelope.files[0], filename: 'second.csv' }],
  };
  const files = await importNativeOutputFiles(value, identity, f.options);
  expect(files.map((file) => file.filename)).toEqual(['result.csv', 'second.csv']);
  expect('file_id' in files[0] && files[0].file_id).not.toBe(
    'file_id' in files[1] && files[1].file_id,
  );
  expect(f.save).toHaveBeenCalledTimes(2);
});
test.each([
  'https://foreign.example.test/v1/link-refs/ghr_1234567890abcdef',
  `${base}/v1/link-refs/ghr_1234567890abcdef?secret=one`,
  `${base}/arbitrary`,
  'https://user:pass@artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
])('rejects untrusted origin or link %s', async (url) => {
  const f = fixture();
  await expect(
    importNativeOutputFiles(
      { ...envelope, files: [{ ...envelope.files[0], download_url: url }] },
      identity,
      f.options,
    ),
  ).rejects.toThrow('native_output_file_origin_invalid');
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test('configured cap is checked before any fetch', async () => {
  const f = fixture();
  await expect(
    importNativeOutputFiles(envelope, identity, { ...f.options, maxBytes: bytes.length - 1 }),
  ).rejects.toThrow('native_output_file_size_limit');
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test.each(['mime', 'length', 'hash', 'overflow', 'unavailable', 'redirect'])(
  'rejects %s and never stores it',
  async (kind) => {
    const f = fixture();
    if (kind === 'redirect') f.fetchFile.mockRejectedValueOnce(new Error('redirect'));
    else {
      let responseBytes = bytes;
      if (kind === 'overflow') responseBytes = Buffer.concat([bytes, bytes]);
      else if (kind === 'hash') responseBytes = Buffer.alloc(bytes.length);
      f.fetchFile.mockResolvedValueOnce(
        new Response(responseBytes, {
          status: kind === 'unavailable' ? 404 : 200,
          headers: {
            'content-type': kind === 'mime' ? 'application/pdf' : 'text/csv',
            ...(kind === 'overflow'
              ? {}
              : { 'content-length': String(kind === 'length' ? 99 : bytes.length) }),
          },
        }),
      );
    }
    await expect(importNativeOutputFiles(envelope, identity, f.options)).rejects.toThrow(
      /native_output_file_/,
    );
    expect(f.save).not.toHaveBeenCalled();
  },
);
test('foreign stored File is not overwritten or returned', async () => {
  const f = fixture();
  const [first] = await importNativeOutputFiles(envelope, identity, f.options);
  if (!('file_id' in first)) throw new Error('expected verified File');
  f.rows.set(first.file_id, { ...f.rows.get(first.file_id)!, user: 'foreign' });
  await expect(importNativeOutputFiles(envelope, identity, f.options)).rejects.toThrow(
    'native_output_file_storage_conflict',
  );
  expect(f.save).toHaveBeenCalledTimes(1);
});

test('current pre-merge canonical/chunk carriers retain exact request identity', () => {
  for (const raw of [
    { id: identity.requestId, object: 'chat.completion', glasshive: { output_files: envelope } },
    {
      id: identity.requestId,
      object: 'chat.completion.chunk',
      choices: [
        {
          delta: {
            provider_specific_fields: { viventium: { output_files: envelope } },
          },
        },
      ],
    },
  ])
    expect(inspectNativeOutputFileCarrier({ additional_kwargs: { __raw_response: raw } })).toEqual({
      envelope,
      requestId: identity.requestId,
    });
  expect(() =>
    inspectNativeOutputFileCarrier({
      id: 'request-onerequest-one',
      object: 'chat.completion.chunk',
      glasshive: { output_files: envelope },
    }),
  ).toThrow('native_output_files_request_invalid');
  expect(
    inspectNativeOutputFileCarrier({
      id: identity.requestId,
      object: 'other',
      glasshive: { output_files: envelope },
    }),
  ).toBeUndefined();
});
test('stale attempt is rejected before fetch', async () => {
  const f = fixture();
  await expect(
    importNativeOutputFiles(envelope, { ...identity, attemptId: 'other-attempt' }, f.options),
  ).rejects.toThrow('native_output_files_identity_invalid');
  expect(f.fetchFile).not.toHaveBeenCalled();
});
test('unavailable selected file remains a typed receipt; verified siblings still attach', async () => {
  const f = fixture();
  const result = await importNativeOutputFiles(
    {
      ...envelope,
      files: [
        { ...envelope.files[0], filename: 'large.csv', bytes: f.options.maxBytes + 1 },
        envelope.files[0],
      ],
    },
    identity,
    { ...f.options, recoverUnavailable: true },
  );
  expect(result[0]).toEqual({
    filename: 'large.csv',
    messageId: identity.responseMessageId,
    nativeOutputFile: { version: 1, status: 'unavailable', code: 'native_output_file_size_limit' },
  });
  expect(result[1]).toMatchObject({ file_id: expect.any(String), filename: 'result.csv' });
  expect(f.fetchFile).toHaveBeenCalledTimes(1);
  expect(f.save).toHaveBeenCalledTimes(1);
});
test('foreign identity yields generic unavailable receipt without fake File or fetch', async () => {
  const f = fixture();
  const result = await importNativeOutputFiles({ ...envelope, owner_id: 'foreign' }, identity, {
    ...f.options,
    recoverUnavailable: true,
  });
  expect(result).toEqual([
    {
      filename: 'File',
      messageId: identity.responseMessageId,
      nativeOutputFile: {
        version: 1,
        status: 'unavailable',
        code: 'native_output_files_identity_invalid',
      },
    },
  ]);
  expect(f.find).not.toHaveBeenCalled();
  expect(f.fetchFile).not.toHaveBeenCalled();
  expect(f.save).not.toHaveBeenCalled();
});
test('hash mismatch persists honest unavailable receipt and retry can recover', async () => {
  const f = fixture();
  f.fetchFile.mockResolvedValueOnce(
    new Response('wrong', { headers: { 'content-type': 'text/csv' } }),
  );
  const result = await importNativeOutputFiles(envelope, identity, {
    ...f.options,
    recoverUnavailable: true,
  });
  expect(result[0]).toEqual({
    filename: 'result.csv',
    messageId: identity.responseMessageId,
    nativeOutputFile: {
      version: 1,
      status: 'unavailable',
      code: 'native_output_file_content_mismatch',
    },
  });
  expect(f.save).not.toHaveBeenCalled();
  expect(
    (
      await importNativeOutputFiles(envelope, identity, { ...f.options, recoverUnavailable: true })
    )[0],
  ).toMatchObject({ filename: 'result.csv', file_id: expect.any(String) });
});
