import { createHash } from 'node:crypto';
import {
  nativeCoordinatorOutputFilesForMessage,
  importNativeOutputFiles,
} from './nativeOutputFiles';

const publisher = {
  owner_id: 'owner',
  conversation_id: 'native-chat',
  agent_id: 'coordinator',
  request_id: 'request',
  message_id: 'native-manager-turn',
  stream_id: 'native-manager-turn',
  run_id: 'run',
};
const envelope = {
  version: 1,
  ...publisher,
  logical_turn_id: '',
  logical_turn_revision: 1,
  attempt_id: 'attempt',
  invocation_id: 'invocation',
  files: [
    {
      filename: 'diagram.html',
      mime_type: 'text/html',
      bytes: 64,
      sha256: '0'.repeat(64),
      download_url: '/v1/conversation/requests/request/files/' + '0'.repeat(64),
    },
  ],
};
const source = { ownerId: 'owner', conversationId: 'native-chat', runId: 'run', publisher };
const destination = {
  userId: 'owner',
  conversationId: 'core-chat',
  responseMessageId: 'main-result',
  agentId: 'main',
};

test('binds a genuine selected Native file to its Core result without changing publisher evidence', () => {
  const bound = nativeCoordinatorOutputFilesForMessage(envelope, source, destination);
  expect(bound.sourceEnvelope).toEqual(envelope);
  expect(bound.identity).toMatchObject({
    userId: 'owner',
    conversationId: 'core-chat',
    responseMessageId: 'main-result',
    agentId: 'main',
    requestId: 'request',
    runId: 'run',
    attemptId: 'attempt',
    invocationId: 'invocation',
    streamId: 'native-manager-turn',
  });
  expect(bound.envelope).toMatchObject({
    conversation_id: 'core-chat',
    message_id: 'main-result',
    agent_id: 'main',
    request_id: 'request',
    run_id: 'run',
    files: envelope.files,
  });
  expect(envelope.message_id).toBe('native-manager-turn');
});

test.each([
  'owner_id',
  'conversation_id',
  'agent_id',
  'request_id',
  'message_id',
  'stream_id',
  'run_id',
])('rejects changed canonical publisher field %s', (key) => {
  expect(() =>
    nativeCoordinatorOutputFilesForMessage({ ...envelope, [key]: 'other' }, source, destination),
  ).toThrow('native_output_files_identity_invalid');
});

test('rejects a Core destination belonging to another owner', () => {
  expect(() =>
    nativeCoordinatorOutputFilesForMessage(envelope, source, { ...destination, userId: 'other' }),
  ).toThrow('native_output_files_identity_invalid');
});

test('imports selected published bytes through the existing File owner', async () => {
  const bytes = Buffer.from('<!doctype html><title>Public-safe result</title>');
  const file = {
    ...envelope.files[0],
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    download_url: 'https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
  };
  const bound = nativeCoordinatorOutputFilesForMessage(
    { ...envelope, files: [file] },
    source,
    destination,
  );
  const options: Parameters<typeof importNativeOutputFiles>[2] = {
    artifactBaseURL: 'https://artifacts.example.test',
    maxBytes: 1024,
    fetchFile: jest.fn(
      async () => new Response(bytes, { headers: { 'content-type': 'text/html' } }),
    ),
    store: {
      find: async () => null,
      save: async (selected, actualBytes, owner, keys) => {
        expect(actualBytes).toEqual(bytes);
        expect(owner.conversationId).toBe('core-chat');
        expect(owner.responseMessageId).toBe('main-result');
        return {
          user: owner.userId,
          conversationId: owner.conversationId,
          messageId: owner.responseMessageId,
          file_id: keys.fileId,
          filename: selected.filename,
          filepath: `/uploads/owner/${keys.fileId}.html`,
          bytes: actualBytes.length,
          type: selected.mime_type,
          source: 'local',
          object: 'file',
          metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
        };
      },
    },
  };
  const imported = await importNativeOutputFiles(bound.envelope, bound.identity, options);
  expect(imported[0]).toMatchObject({
    filename: 'diagram.html',
    nativeOutputFile: {
      status: 'available',
      messageId: 'main-result',
      downloadUrl: file.download_url,
    },
  });
});

test('cannot use a protected local Life path as a published-file download', async () => {
  const bound = nativeCoordinatorOutputFilesForMessage(
    {
      ...envelope,
      files: [{ ...envelope.files[0], download_url: 'file:///Life/Self/private.html' }],
    },
    source,
    destination,
  );
  const fetchFile = jest.fn();
  const save = jest.fn();
  const imported = await importNativeOutputFiles(bound.envelope, bound.identity, {
    artifactBaseURL: 'https://artifacts.example.test',
    maxBytes: 1024,
    fetchFile,
    store: { find: async () => null, save },
    recoverUnavailable: true,
  });
  expect(imported[0]).toMatchObject({ nativeOutputFile: { status: 'unavailable' } });
  expect(fetchFile).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
