/* === VIVENTIUM START === Actual Mongo File uniqueness across independent consumers. === */
import mongoose from 'mongoose';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { createHash } from 'node:crypto';
import { importNativeOutputFiles } from './nativeOutputFiles';
import type {
  NativeOutputFiles,
  NativeOutputStoredFile,
  NativeOutputFileStore,
} from './nativeOutputFiles';

test('independent File upserts share the built-in _id and recover without duplicate rows', async () => {
  const server = await MongoMemoryServer.create();
  const data = Buffer.from('item,value\nAster,10\n');
  let downloads = 0;
  const files = createServer((request, response) => {
    if (request.url !== '/v1/link-refs/ghr_1234567890abcdef') {
      response.writeHead(404);
      response.end();
      return;
    }
    downloads++;
    response.writeHead(200, { 'content-type': 'text/csv', 'content-length': data.length });
    response.end(data);
  });
  await new Promise<void>((resolve) => files.listen(0, '127.0.0.1', resolve));
  const artifactBaseURL = `http://127.0.0.1:${(files.address() as AddressInfo).port}`;
  const left = new mongoose.Mongoose();
  const right = new mongoose.Mongoose();
  try {
    await Promise.all([left.connect(server.getUri()), right.connect(server.getUri())]);
    createModels(left);
    createModels(right);
    const sources = [left, right].map((connection) => createMethods(connection));
    const owner = new mongoose.Types.ObjectId().toString();
    const identity = {
      userId: owner,
      conversationId: 'conversation',
      responseMessageId: 'answer',
      streamId: 'stream',
      agentId: 'agent',
      logicalTurnId: 'turn',
      revision: 1,
      requestId: 'request',
      runId: 'run',
    };
    const value: NativeOutputFiles = {
      version: 1,
      owner_id: owner,
      conversation_id: 'conversation',
      message_id: 'answer',
      stream_id: 'stream',
      agent_id: 'agent',
      logical_turn_id: 'turn',
      logical_turn_revision: 1,
      request_id: 'request',
      run_id: 'run',
      attempt_id: 'attempt',
      invocation_id: '',
      files: [
        {
          filename: 'result.csv',
          bytes: data.length,
          mime_type: 'text/csv',
          sha256: createHash('sha256').update(data).digest('hex'),
          download_url: `${artifactBaseURL}/v1/link-refs/ghr_1234567890abcdef`,
        },
      ],
    };
    let entered = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stores = sources.map((db): NativeOutputFileStore => ({
      find: async (fileId) => (await db.findFileById(fileId)) as unknown as NativeOutputStoredFile,
      save: async (file, bytes, source, keys) => {
        expect(bytes).toEqual(data);
        entered++;
        if (entered === 2) release();
        await barrier;
        return (await db.createFile(
          {
            _id: new mongoose.Types.ObjectId(keys.objectId),
            user: new mongoose.Types.ObjectId(source.userId),
            conversationId: source.conversationId,
            messageId: source.responseMessageId,
            file_id: keys.fileId,
            filepath: '/uploads/synthetic/result.csv',
            bytes: file.bytes,
            filename: file.filename,
            type: file.mime_type,
            source: 'local',
            object: 'file',
            metadata: { fileIdentifier: `native_output_sha256:${keys.fingerprint}` },
          },
          true,
        )) as unknown as NativeOutputStoredFile;
      },
    }));
    const run = (store: NativeOutputFileStore) =>
      importNativeOutputFiles(value, identity, {
        artifactBaseURL,
        maxBytes: 10_485_760,
        store,
      });
    const [first, duplicate] = await Promise.all(stores.map(run));
    expect(first).toEqual(duplicate);
    expect(entered).toBe(2);
    expect(await left.models.File.countDocuments()).toBe(1);
    expect(await run(stores[1])).toEqual(first);
    expect(entered).toBe(2);
    expect(downloads).toBe(2);
    const row = await left.models.File.findOne().lean<{
      messageId: string;
      user: unknown;
      _id: unknown;
    }>();
    expect(row?.messageId).toBe('answer');
    expect(String(row?.user)).toBe(owner);
    expect(String(row?._id)).toMatch(/^[a-f0-9]{24}$/);
  } finally {
    await Promise.all([left.disconnect(), right.disconnect()]);
    await new Promise<void>((resolve, reject) =>
      files.close((error) => (error ? reject(error) : resolve())),
    );
    await server.stop();
  }
}, 30_000);
/* === VIVENTIUM END === */
