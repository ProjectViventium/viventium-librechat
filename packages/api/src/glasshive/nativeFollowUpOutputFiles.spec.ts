/* === VIVENTIUM START === Native Phase B files retain exact source and destination authority. === */
import { createHash } from 'node:crypto';
import {
  nativeFollowUpOutputSource,
  captureNativeFollowUpOutputFiles,
  nativeFollowUpOutputFilesForMessage,
  importNativeOutputFiles,
  mergeVerifiedNativeOutputFileImports,
  retainedNativeOutputFilesForMessage,
  nativeOutputStoredFileMatches,
} from './nativeOutputFiles';
import type { NativeOutputFiles, NativeOutputStoredFile } from './nativeOutputFiles';
const bytes = Buffer.from('<svg><circle fill="blue"/></svg>');
const digest = createHash('sha256').update(bytes).digest('hex');
const grant = 'https://artifacts.example.test/v1/link-refs/ghr_main1234567890abcdef';
const headers = {
  'X-Viventium-User-Id': 'owner',
  'X-Viventium-Conversation-Id': 'conversation',
  'X-Viventium-Message-Id': 'accepted-parent',
  'X-GlassHive-Agent-Id': 'main:phase_b:followup',
  'X-Viventium-Stream-Id': 'phase_b:stable-stream',
  'X-GlassHive-Idempotency-Key': 'phase_b:stable-stream',
  Authorization: 'Bearer synthetic-never-retained',
};
const dispatch = {
  headers,
  userId: 'owner',
  conversationId: 'conversation',
  sourceMessageId: 'accepted-parent',
  agentId: 'main:phase_b:followup',
  presentationAgentId: 'main',
  providerId: 'native-provider',
  baseURL: 'https://native.example.test/v1',
  capability: { workspace_binding: true, conversation_session: true },
};
const file = {
  filename: 'circle.svg',
  mime_type: 'image/svg+xml',
  bytes: bytes.length,
  sha256: digest,
  download_url: grant,
};
const envelope: NativeOutputFiles = {
  version: 1,
  owner_id: 'owner',
  conversation_id: 'conversation',
  message_id: 'accepted-parent',
  agent_id: 'main:phase_b:followup',
  stream_id: 'phase_b:stable-stream',
  logical_turn_id: '',
  logical_turn_revision: 1,
  request_id: 'native-request',
  run_id: 'native-run',
  attempt_id: 'native-attempt',
  invocation_id: '',
  files: [file],
};
const destination = {
  userId: 'owner',
  conversationId: 'conversation',
  sourceMessageId: 'accepted-parent',
  responseMessageId: 'authored-follow-up',
  agentId: 'main',
};
function captured(value = envelope) {
  const source = nativeFollowUpOutputSource(dispatch);
  if (!source) throw new Error('missing synthetic dispatch');
  const capture = captureNativeFollowUpOutputFiles(
    {
      additional_kwargs: {
        __raw_response: {
          id: 'native-request',
          object: 'chat.completion.chunk',
          glasshive: { output_files: value },
        },
      },
    },
    source,
  );
  if (!capture) throw new Error('missing synthetic carrier');
  return capture;
}

test('host dispatch snapshot drops credentials and requires exact accepted source and sealed publisher', () => {
  const source = nativeFollowUpOutputSource(dispatch)!;
  expect(JSON.stringify(source)).not.toContain('synthetic-never-retained');
  expect(source.identity).toMatchObject({
    responseMessageId: 'accepted-parent',
    agentId: 'main:phase_b:followup',
    streamId: 'phase_b:stable-stream',
    logicalTurnId: '',
    revision: 1,
  });
  expect(
    nativeFollowUpOutputSource({
      ...dispatch,
      capability: { workspace_binding: false, conversation_session: true },
    }),
  ).toBeUndefined();
});
test.each(Object.keys(headers).filter((key) => key !== 'Authorization'))(
  'host dispatch rejects substituted %s',
  (key) => {
    expect(
      nativeFollowUpOutputSource({ ...dispatch, headers: { ...headers, [key]: 'foreign' } }),
    ).toBeUndefined();
  },
);
test.each([
  'owner_id',
  'conversation_id',
  'message_id',
  'agent_id',
  'stream_id',
  'logical_turn_id',
  'logical_turn_revision',
  'request_id',
] as const)('carrier rejects foreign source %s before rebinding', (key) => {
  expect(() =>
    captured({ ...envelope, [key]: key === 'logical_turn_revision' ? 2 : 'foreign' }),
  ).toThrow();
});
test.each(['userId', 'conversationId', 'sourceMessageId', 'agentId'] as const)(
  'changed persistence target %s cannot inherit a prepared source',
  (key) => {
    expect(() =>
      nativeFollowUpOutputFilesForMessage(captured(), { ...destination, [key]: 'foreign' }),
    ).toThrow('native_output_files_identity_invalid');
  },
);
test('an exact prepared replay binds the new message only, retaining source run/attempt/publisher', () => {
  const capture = captured();
  const replay = JSON.parse(JSON.stringify(capture));
  const rebound = nativeFollowUpOutputFilesForMessage(replay, destination);
  expect(rebound.envelope).toEqual({ ...envelope, message_id: destination.responseMessageId });
  expect(rebound.identity).toMatchObject({
    responseMessageId: destination.responseMessageId,
    streamId: envelope.stream_id,
    requestId: envelope.request_id,
    runId: envelope.run_id,
    attemptId: envelope.attempt_id,
    agentId: envelope.agent_id,
    ...capture.publisher,
  });
  expect(capture.envelope.message_id).toBe('accepted-parent');
});
test('tampered prepared source and publisher remain rejected at persistence', () => {
  const capture = captured();
  expect(() =>
    nativeFollowUpOutputFilesForMessage(
      { ...capture, envelope: { ...capture.envelope, attempt_id: 'other-attempt' } },
      destination,
    ),
  ).toThrow();
  expect(() =>
    nativeFollowUpOutputFilesForMessage(
      { ...capture, publisher: { ...capture.publisher, originSha256: 'invalid' } },
      destination,
    ),
  ).toThrow();
});
test('merged SDK request IDs cannot become a canonical carrier', () => {
  const source = nativeFollowUpOutputSource(dispatch)!;
  expect(() =>
    captureNativeFollowUpOutputFiles(
      {
        id: 'native-requestnative-request',
        object: 'chat.completion.chunk',
        glasshive: { output_files: envelope },
      },
      source,
    ),
  ).toThrow();
});
async function imported(
  selected: NativeOutputFiles,
  identity = nativeFollowUpOutputFilesForMessage(captured(), destination).identity,
  corrupt = false,
  content = bytes,
) {
  const rows = new Map<string, NativeOutputStoredFile>();
  return importNativeOutputFiles(selected, identity, {
    artifactBaseURL: 'https://artifacts.example.test',
    maxBytes: 4096,
    recoverUnavailable: true,
    fetchFile: async () =>
      new Response(corrupt ? 'bad bytes' : content, {
        headers: {
          'Content-Type': 'image/svg+xml',
          'Content-Length': String(corrupt ? 9 : content.length),
        },
      }),
    store: {
      find: async (id) => rows.get(id) || null,
      save: async (item, _data, owner, keys) => {
        const row: NativeOutputStoredFile = {
          user: owner.userId,
          file_id: keys.fileId,
          conversationId: owner.conversationId,
          messageId: owner.responseMessageId,
          filename: item.filename,
          filepath: '/synthetic/immutable.svg',
          bytes: item.bytes,
          type: item.mime_type,
          source: 'local',
          object: 'file',
          metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
        };
        rows.set(keys.fileId, row);
        return row;
      },
    },
  });
}
test('verified Main grant wins without duplicate callback file or relaxed URL matching', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const seen = new Set<string>();
  const main = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope),
    seen,
  );
  expect(main.count).toBe(1);
  expect(main.attachments[0].nativeOutputFile).toMatchObject({
    status: 'available',
    downloadUrl: grant,
  });
  const callback = {
    ...selected.envelope,
    files: [{ ...file, download_url: grant.replace('main', 'worker') }],
  };
  const duplicate = mergeVerifiedNativeOutputFileImports(
    callback,
    selected.identity,
    await imported(callback),
    seen,
  );
  expect(duplicate.attachments).toEqual([]);
  expect(duplicate.count).toBe(0);
});
test('failed Main bytes cannot suppress a valid same-tuple callback import or consume its budget', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const seen = new Set<string>();
  const bad = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope, selected.identity, true),
    seen,
  );
  expect(bad.count).toBe(0);
  expect(bad.bytes).toBe(0);
  expect(seen.size).toBe(0);
  const good = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope),
    seen,
  );
  expect(good.count).toBe(1);
});
test('same digest different names and edited bytes remain distinct descriptors', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const names = { ...selected.envelope, files: [file, { ...file, filename: 'copy.svg' }] };
  const seen = new Set<string>();
  const merged = mergeVerifiedNativeOutputFileImports(
    names,
    selected.identity,
    await imported(names),
    seen,
  );
  expect(merged.count).toBe(2);
  const edited = { ...selected.envelope, files: [{ ...file, sha256: 'a'.repeat(64) }] };
  const rejected = mergeVerifiedNativeOutputFileImports(
    edited,
    selected.identity,
    await imported(edited),
    seen,
  );
  expect(rejected.count).toBe(0);
  expect(rejected.attachments[0].nativeOutputFile?.status).toBe('unavailable');
});

test('a verified edited file with the same name is retained beside the original', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const seen = new Set<string>();
  const original = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope),
    seen,
  );
  const changed = Buffer.from('<svg><circle fill="green"/></svg>');
  const edited = {
    ...selected.envelope,
    files: [
      {
        ...file,
        bytes: changed.length,
        sha256: createHash('sha256').update(changed).digest('hex'),
        download_url: grant.replace('main', 'edited'),
      },
    ],
  };
  const edit = mergeVerifiedNativeOutputFileImports(
    edited,
    selected.identity,
    await imported(edited, selected.identity, false, changed),
    seen,
  );
  expect(original.count).toBe(1);
  expect(edit.count).toBe(1);
  expect(seen.size).toBe(2);
});
test('partial Main failure leaves the corresponding callback and distinct available Main file', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const partial = {
    ...selected.envelope,
    files: [
      { ...file, sha256: 'a'.repeat(64) },
      { ...file, filename: 'another.svg' },
    ],
  };
  const seen = new Set<string>();
  const main = mergeVerifiedNativeOutputFileImports(
    partial,
    selected.identity,
    await imported(partial),
    seen,
  );
  expect(main.count).toBe(1);
  const callback = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope),
    seen,
  );
  expect(callback.count).toBe(1);
  expect(callback.attachments[0].filename).toBe('circle.svg');
});
test('duplicate grant shape cannot associate verified bytes with another descriptor SHA', async () => {
  const selected = nativeFollowUpOutputFilesForMessage(captured(), destination);
  const misleading = { ...selected.envelope, files: [{ ...file, sha256: 'a'.repeat(64) }, file] };
  const seen = new Set<string>();
  const main = mergeVerifiedNativeOutputFileImports(
    misleading,
    selected.identity,
    await imported(misleading),
    seen,
  );
  expect(main.count).toBe(1);
  expect(
    main.attachments.filter((item) => item.nativeOutputFile?.status === 'available'),
  ).toHaveLength(1);
  const callback = mergeVerifiedNativeOutputFileImports(
    selected.envelope,
    selected.identity,
    await imported(selected.envelope),
    seen,
  );
  expect(callback.count).toBe(0);
  expect(callback.attachments).toEqual([]);
  expect(seen.has(JSON.stringify([file.filename, file.mime_type, file.bytes, file.sha256]))).toBe(
    true,
  );
  expect(
    seen.has(JSON.stringify([file.filename, file.mime_type, file.bytes, 'a'.repeat(64)])),
  ).toBe(false);
});

/* === VIVENTIUM START === Retained canonical Main output Files preserve source authority. === */
describe('retained native output references', () => {
  function retained() {
    const source = captured();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          envelope.owner_id,
          envelope.conversation_id,
          envelope.message_id,
          envelope.stream_id,
          envelope.agent_id,
          envelope.logical_turn_id,
          envelope.logical_turn_revision,
          envelope.request_id,
          envelope.run_id,
          envelope.attempt_id,
          file.filename,
          file.mime_type,
          file.bytes,
          file.sha256,
        ]),
      )
      .digest('hex');
    const stored = {
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'accepted-parent',
      file_id: `native_${fingerprint}`,
      filename: file.filename,
      type: file.mime_type,
      bytes: file.bytes,
      filepath: '/uploads/original.svg',
      source: 'local',
      object: 'file' as const,
      metadata: { fileIdentifier: `native_output_sha256:${fingerprint}` },
    };
    const candidate = {
      text: `[Capture](${grant})`,
      authoritySha256: 'a'.repeat(64),
      requestId: envelope.request_id,
      runId: envelope.run_id,
      responseJson: JSON.stringify({
        id: envelope.request_id,
        glasshive: { output_files: envelope },
      }),
    };
    const nativeResponse = {
      ...source.identity,
      ...source.publisher,
      responseMessageId: 'accepted-parent',
      status: 'completed' as const,
      candidateJson: JSON.stringify(candidate),
      candidateSha256: require('@librechat/data-schemas').nativeResponseDigest(candidate),
      authoritySha256: candidate.authoritySha256,
    };
    const row = {
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'accepted-parent',
      isCreatedByUser: false,
      unfinished: false,
      error: false,
      nativeResponse,
      attachments: [
        {
          ...stored,
          user: 'owner',
          nativeOutputFile: {
            version: 1 as const,
            status: 'available' as const,
            messageId: 'accepted-parent',
            downloadUrl: grant,
          },
        },
      ],
    };
    return { row, stored, source };
  }
  test('rebinds only the authored message while preserving original native request/run/attempt', () => {
    const { row, stored, source } = retained();
    const selected = retainedNativeOutputFilesForMessage(
      row as any,
      [stored],
      [grant],
      destination,
    )!;
    expect(selected.envelope).toEqual({ ...envelope, message_id: destination.responseMessageId });
    expect(selected.identity).toMatchObject({
      ...source.identity,
      responseMessageId: destination.responseMessageId,
      ...source.publisher,
    });
    expect(selected.sourceFiles).toEqual([stored]);
    expect(nativeOutputStoredFileMatches(envelope, file, source.identity, stored)).toBe(true);
    expect(selected.identity.runId).toBe(envelope.run_id);
  });
  test.each([false, true])(
    're-imports verified retained bytes through the real importer, corrupted=%s',
    async (corrupted) => {
      const { row, stored } = retained();
      const selected = retainedNativeOutputFilesForMessage(
        row as any,
        [stored],
        [grant],
        destination,
      )!;
      const save = jest.fn(async (descriptor, _bytes, owner, keys) => ({
        ...stored,
        user: owner.userId,
        conversationId: owner.conversationId,
        messageId: owner.responseMessageId,
        file_id: keys.fileId,
        filepath: '/uploads/new.svg',
        filename: descriptor.filename,
        type: descriptor.mime_type,
        bytes: descriptor.bytes,
        metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
      }));
      const imported = await importNativeOutputFiles(selected.envelope, selected.identity, {
        artifactBaseURL: 'https://artifacts.example.test',
        maxBytes: 1024,
        recoverUnavailable: true,
        fetchFile: async () =>
          new Response(corrupted ? Buffer.alloc(bytes.length) : bytes, {
            headers: { 'content-type': file.mime_type, 'content-length': String(bytes.length) },
          }),
        store: { find: async () => null, save },
      });
      expect(imported).toHaveLength(1);
      expect(imported[0].nativeOutputFile?.status).toBe(corrupted ? 'unavailable' : 'available');
      expect(save).toHaveBeenCalledTimes(corrupted ? 0 : 1);
      if (!corrupted) {
        expect((imported[0] as any).file_id).not.toBe(stored.file_id);
        expect(imported[0].nativeOutputFile?.messageId).toBe(destination.responseMessageId);
      }
    },
  );
  test('leaves unrelated links unselected', () => {
    const { row, stored } = retained();
    expect(
      retainedNativeOutputFilesForMessage(
        row as any,
        [stored],
        ['https://www.example.test'],
        destination,
      ),
    ).toBeUndefined();
  });
  test.each([
    'foreign_owner',
    'foreign_conversation',
    'unfinished',
    'failed',
    'deleted',
    'candidate_changed',
    'native_identity_changed',
    'missing_files',
    'file_owner',
    'file_message',
    'file_fingerprint',
    'unverified_receipt',
  ])('rejects %s without promoting an old attachment assertion', (kind) => {
    const { row, stored } = retained();
    const changed: any = structuredClone(row);
    let files: any[] = [structuredClone(stored)];
    if (kind === 'foreign_owner') changed.user = 'foreign';
    if (kind === 'foreign_conversation') changed.conversationId = 'foreign';
    if (kind === 'unfinished') changed.unfinished = true;
    if (kind === 'failed') changed.nativeResponse.status = 'failed';
    if (kind === 'deleted') changed.deletedAt = new Date();
    if (kind === 'candidate_changed') changed.nativeResponse.candidateJson += ' ';
    if (kind === 'candidate_changed') changed.nativeResponse.candidateSha256 = 'f'.repeat(64);
    if (kind === 'native_identity_changed') changed.nativeResponse.streamId = 'foreign';
    if (kind === 'missing_files') files = [];
    if (kind === 'file_owner') files[0].user = 'foreign';
    if (kind === 'file_message') files[0].messageId = 'foreign';
    if (kind === 'file_fingerprint') files[0].metadata.fileIdentifier = 'foreign';
    if (kind === 'unverified_receipt')
      changed.attachments[0].nativeOutputFile.status = 'unavailable';
    expect(() =>
      retainedNativeOutputFilesForMessage(changed, files, [grant], destination),
    ).toThrow();
  });
});
/* === VIVENTIUM END === */
