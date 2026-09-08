import { Readable } from 'stream';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runConfiguredTranscription, transcribeAttachedAudio } from './transcribeAudio';

const fileId = '8e183edd-d83a-4770-9589-52d3b8b61a4b';
const input = { ownerId: 'owner-a', args: { file_id: fileId }, allowedFileIds: [fileId] };
const file = { file_id: fileId, filename: 'recording.m4a', type: 'audio/mp4', bytes: 4 };

it('passes only the selected original bytes from the authenticated file owner', async () => {
  const readFile = jest.fn(async () => ({ file, stream: Readable.from([Buffer.from('data')]) }));
  const transcribe = jest.fn(async (stream: Readable) => {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('data');
    return { status: 'completed' as const, transcript: 'A spoken goal.' };
  });
  const result = await transcribeAttachedAudio(input, { readFile, transcribe });
  expect(readFile).toHaveBeenCalledWith('owner-a', fileId);
  expect(result).toMatchObject({ status: 'completed', transcript: 'A spoken goal.', file_id: fileId });
});

it.each([
  { ...input, allowedFileIds: [] },
  { ...input, ownerId: '' },
  { ...input, args: { file_id: fileId, path: '/tmp/untrusted' } },
  { ...input, args: { file_id: '../../another-owner' } },
])('rejects unauthorized or model-supplied path authority before storage access: %j', async (request) => {
  const readFile = jest.fn();
  expect(await transcribeAttachedAudio(request, { readFile })).toEqual({ status: 'rejected', code: 'attachment_not_authorized' });
  expect(readFile).not.toHaveBeenCalled();
});

it('does not transcribe another owner’s missing file', async () => {
  const transcribe = jest.fn();
  expect(await transcribeAttachedAudio(input, { readFile: async () => null, transcribe }))
    .toEqual({ status: 'rejected', code: 'attachment_not_found' });
  expect(transcribe).not.toHaveBeenCalled();
});

it.each([
  { status: 'completed' as const, transcript: '' },
  { status: 'unavailable' as const, code: 'transcription_model_unavailable' },
])('keeps empty speech distinct from engine unavailability: %j', async (engineResult) => {
  const result = await transcribeAttachedAudio(input, {
    readFile: async () => ({ file, stream: Readable.from(['data']) }),
    transcribe: async () => engineResult,
  });
  expect(result).toMatchObject(engineResult);
});

it('does not treat an arbitrary file as speech or invent a transcript on storage failure', async () => {
  const transcribe = jest.fn();
  const result = await transcribeAttachedAudio(input, {
    readFile: async () => ({ file: { ...file, type: 'text/plain' }, stream: Readable.from(['data']) }), transcribe,
  });
  expect(result).toMatchObject({ code: 'unsupported_media_type' });
  expect(transcribe).not.toHaveBeenCalled();
  expect(await transcribeAttachedAudio(input, { readFile: async () => { throw new Error('storage offline'); } }))
    .toEqual({ status: 'unavailable', code: 'attachment_unavailable' });
});

it('rejects a short original stream even if the child reports success', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-owner-'));
  const previous = { ...process.env };
  try {
    await fs.mkdir(path.join(root, 'scripts/viventium'), { recursive: true });
    await fs.writeFile(path.join(root, 'scripts/viventium/transcribe_audio.py'),
      "process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({status:'completed',transcript:'content'})));" );
    delete process.env.VIVENTIUM_NATIVE_RELEASE_ROOT;
    process.env.VIVENTIUM_REPO_ROOT = root;
    process.env.VIVENTIUM_APP_SUPPORT_DIR = root;
    process.env.VIVENTIUM_PYTHON_BIN = process.execPath;
    expect(await runConfiguredTranscription(Readable.from(['ab']), 4))
      .toEqual({ status: 'rejected', code: 'attachment_size_changed' });
  } finally {
    process.env = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('handles a failed spawn even when cancellation was already requested', async () => {
  const previous = { ...process.env };
  try {
    delete process.env.VIVENTIUM_NATIVE_RELEASE_ROOT;
    process.env.VIVENTIUM_REPO_ROOT = os.tmpdir();
    process.env.VIVENTIUM_APP_SUPPORT_DIR = os.tmpdir();
    process.env.VIVENTIUM_PYTHON_BIN = path.join(os.tmpdir(), 'missing-transcription-runtime');
    const controller = new AbortController();
    controller.abort();
    expect(await runConfiguredTranscription(Readable.from(['data']), 4, controller.signal))
      .toEqual({ status: 'unavailable', code: 'transcription_cancelled' });
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.env = previous; }
});
