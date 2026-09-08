import path from 'path';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import { z } from 'zod';

export const AUDIO_TRANSCRIPTION_TOOL = 'transcribe_audio';
export const audioTranscriptionArguments = z.object({ file_id: z.string().uuid() }).strict();
const attachmentReference = z.object({ file_id: z.string().uuid(), filename: z.string().optional() });
export function transcriptionAttachmentReferences(files: object[]) {
  const references = files.flatMap((file) => {
    const parsed = attachmentReference.safeParse(file);
    return parsed.success ? [parsed.data] : [];
  });
  return Array.from(new Map(references.map((file) => [file.file_id, file])).values());
}
export const audioTranscriptionDefinition = Object.freeze({
  name: AUDIO_TRANSCRIPTION_TOOL,
  description: 'Transcribe an attached audio or video file with the installation’s configured speech engine. The original attachment is preserved. Returns the transcript, successful empty speech, or an explicit unavailable/rejected status.',
  inputSchema: {
    type: 'object',
    properties: { file_id: { type: 'string', description: 'The attached file ID from the available files.' } },
    required: ['file_id'],
    additionalProperties: false,
  },
});

const transcriptionResult = z.union([
  z.object({ status: z.literal('completed'), transcript: z.string() }),
  z.object({ status: z.enum(['unavailable', 'rejected']), code: z.string().min(1) }),
]);
type AudioFile = { file_id: string; type: string; filename: string; bytes: number };
type Dependencies = {
  readFile: (ownerId: string, fileId: string) => Promise<{ file: AudioFile; stream: Readable } | null>;
  transcribe?: typeof runConfiguredTranscription;
};

/** The model chooses whether to transcribe. Scope and original bytes come from existing owners. */
export async function transcribeAttachedAudio(
  input: { ownerId: string; args: object; allowedFileIds: string[]; signal?: AbortSignal },
  dependencies: Dependencies,
) {
  const parsed = audioTranscriptionArguments.safeParse(input.args);
  if (!parsed.success || !input.ownerId || !input.allowedFileIds.includes(parsed.data.file_id)) {
    return { status: 'rejected', code: 'attachment_not_authorized' };
  }
  let selected;
  try { selected = await dependencies.readFile(input.ownerId, parsed.data.file_id); }
  catch { return { status: 'unavailable', code: 'attachment_unavailable' }; }
  if (!selected) return { status: 'rejected', code: 'attachment_not_found' };
  const { file, stream } = selected;
  if (!file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
    stream.destroy();
    return { status: 'rejected', code: 'unsupported_media_type' };
  }
  try {
    const result = await (dependencies.transcribe || runConfiguredTranscription)(stream, file.bytes, input.signal);
    return { ...result, file_id: file.file_id, filename: file.filename };
  } finally {
    stream.destroy();
  }
}

/** Invoke one existing runtime component, with no new service, model or transcript store. */
export async function runConfiguredTranscription(stream: Readable, bytes: number, signal?: AbortSignal) {
  const root = process.env.VIVENTIUM_NATIVE_RELEASE_ROOT || process.env.VIVENTIUM_REPO_ROOT;
  const support = process.env.VIVENTIUM_APP_SUPPORT_DIR;
  const python = process.env.VIVENTIUM_PYTHON_BIN || process.env.PYTHON_BIN;
  if (!root || !support || !python || !path.isAbsolute(root) || !path.isAbsolute(support)) {
    return { status: 'unavailable' as const, code: 'transcription_runtime_unavailable' };
  }
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 1024 * 1024 * 1024) {
    return { status: 'rejected' as const, code: 'audio_size_invalid' };
  }
  return new Promise<z.infer<typeof transcriptionResult>>((resolve) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['HOME', 'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'USER', 'VIVENTIUM_RUNTIME_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(python, [path.join(root, 'scripts/viventium/transcribe_audio.py'),
      '--app-support-dir', support, '--max-bytes', String(bytes)], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '';
    let received = 0;
    let settled = false;
    const finish = (value: z.infer<typeof transcriptionResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      stream.unpipe(child.stdin);
      if (child.pid && child.pid !== process.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
      }
      resolve(value);
    };
    const abort = () => finish({ status: 'unavailable', code: 'transcription_cancelled' });
    const timeout = Number(process.env.LOCAL_WHISPER_TIMEOUT_S) || 120;
    const timer = setTimeout(() => finish({ status: 'unavailable', code: 'transcription_timeout' }), timeout * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish({ status: 'unavailable', code: 'transcription_runtime_unavailable' }));
    // A not-ready engine can reply before consuming input. Its typed response owns that result.
    child.stdin.on('error', () => {});
    stream.on('error', () => finish({ status: 'unavailable', code: 'attachment_unavailable' }));
    stream.on('data', (chunk: Buffer) => {
      received += Buffer.byteLength(chunk);
      if (received > bytes) finish({ status: 'rejected', code: 'attachment_size_changed' });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > 4 * 1024 * 1024) finish({ status: 'unavailable', code: 'transcription_output_limit' });
    });
    child.on('close', () => {
      try {
        const result = transcriptionResult.parse(JSON.parse(output));
        finish(result.status === 'completed' && received !== bytes
          ? { status: 'rejected', code: 'attachment_size_changed' } : result);
      }
      catch { finish({ status: 'unavailable', code: 'transcription_invalid_response' }); }
    });
    if (signal?.aborted) return abort();
    stream.pipe(child.stdin);
  });
}
