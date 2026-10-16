/* === VIVENTIUM START === Model-selected native files use the existing File attachment path. === */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { nativeResponseDigest } from '@librechat/data-schemas';
import type { NativeResponseIdentity, NativeResponseAdmission, NativeResponseCandidate } from '@librechat/data-schemas';
import type { NativeResponseRoute } from './nativeResponse';
import { nativeResponseOrigin } from './nativeResponse';
import type { TAgentProviderCapability } from 'librechat-data-provider';

const id = z.string().min(1).max(512);
const descriptor = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !value.includes('/') &&
          !value.includes('\\') &&
          !Array.from(value).some((character) => character.charCodeAt(0) < 32),
      ),
    mime_type: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    download_url: z.string().min(1).max(8192),
  })
  .strict();
const outputFiles = z
  .object({
    version: z.literal(1),
    owner_id: id,
    conversation_id: id,
    message_id: id,
    stream_id: id,
    agent_id: id,
    logical_turn_id: z.string().max(160),
    logical_turn_revision: z.number().int().positive(),
    request_id: id,
    run_id: id,
    attempt_id: z.string().max(160),
    invocation_id: z.string().max(160),
    files: z.array(descriptor),
    rejected: z
      .array(
        z
          .object({
            name: descriptor.shape.filename,
            code: z.enum(['source_root_unsupported', 'not_deliverable', 'unreadable']),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type NativeOutputFiles = z.infer<typeof outputFiles>;
export type NativeOutputFile = NativeOutputFiles['files'][number];
const callbackOutputFiles = z
  .object({
    version: z.literal(1),
    owner_id: id,
    run_id: id,
    attempt_id: id,
    callback_id: id,
    origin_ref: id,
    work_ref: id,
    result_revision: z.number().int().positive(),
    result_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    files: z.array(descriptor),
    rejected: outputFiles.shape.rejected,
  })
  .strict();
export type NativeCallbackOutputFiles = z.infer<typeof callbackOutputFiles>;
export interface NativeCallbackOutputFileIdentity {
  ownerId: string;
  runId: string;
  attemptId: string;
  callbackId: string;
  originRef: string;
  workRef: string;
  resultRevision: number;
  resultDigest: string;
}

/** Accept only Native-owned descriptors from the bound terminal result. */
export function normalizeNativeCallbackOutputFiles(
  value: unknown,
  identity: NativeCallbackOutputFileIdentity,
): NativeCallbackOutputFiles | undefined {
  if (value == null) return undefined;
  const parsed = callbackOutputFiles.safeParse(value);
  if (!parsed.success) throw error('native_output_files_invalid');
  const envelope = parsed.data;
  if (
    envelope.owner_id !== identity.ownerId ||
    envelope.run_id !== identity.runId ||
    envelope.attempt_id !== identity.attemptId ||
    envelope.callback_id !== identity.callbackId ||
    envelope.origin_ref !== identity.originRef ||
    envelope.work_ref !== identity.workRef ||
    envelope.result_revision !== identity.resultRevision ||
    envelope.result_digest !== identity.resultDigest
  )
    throw error('native_output_files_identity_invalid');
  return envelope;
}

/** Core binds an accepted callback's files to the actual authored destination. */
export function nativeCallbackOutputFilesForMessage(
  source: NativeCallbackOutputFiles,
  identity: NativeOutputFileIdentity,
): NativeOutputFiles {
  if (
    source.owner_id !== identity.userId ||
    source.run_id !== identity.runId ||
    source.attempt_id !== identity.attemptId ||
    source.callback_id !== identity.requestId
  )
    throw error('native_output_files_identity_invalid');
  return {
    version: 1,
    owner_id: identity.userId,
    conversation_id: identity.conversationId,
    message_id: identity.responseMessageId,
    stream_id: identity.streamId,
    agent_id: identity.agentId,
    logical_turn_id: identity.logicalTurnId,
    logical_turn_revision: identity.revision,
    request_id: identity.requestId,
    run_id: source.run_id,
    attempt_id: source.attempt_id,
    invocation_id: '',
    files: source.files,
    ...(source.rejected ? { rejected: source.rejected } : {}),
  };
}
export type NativeOutputFileFetch = (url: string, init?: RequestInit) => Promise<Response>;
const publisherIdentity = z
  .object({
    providerId: id,
    originSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type NativeOutputFilePublisherIdentity = z.infer<typeof publisherIdentity>;

/** Seal host-resolved emitting transport metadata; never take it from native output or Main. */
export function nativeOutputFilePublisherFromContext({
  providerId,
  baseURL,
  capability,
}: {
  providerId: unknown;
  baseURL: unknown;
  capability?: Pick<TAgentProviderCapability, 'workspace_binding' | 'conversation_session'>;
}): NativeOutputFilePublisherIdentity | undefined {
  if (
    capability?.workspace_binding !== true ||
    capability.conversation_session !== true ||
    typeof providerId !== 'string' ||
    typeof baseURL !== 'string'
  )
    return undefined;
  try {
    const base = new URL(baseURL);
    if (!['http:', 'https:'].includes(base.protocol) || !['/v1', '/v1/'].includes(base.pathname))
      return undefined;
    return publisherIdentity.parse({ providerId, originSha256: nativeResponseOrigin(baseURL) });
  } catch {
    return undefined;
  }
}

/** A prior Main admission is usable only when that exact agent is the emitting publisher. */
export function nativeOutputFilePublisherForCarrier(
  carrier: { publisher?: unknown },
  admission: { agentId?: unknown; providerId?: unknown; originSha256?: unknown } | undefined,
  agentId: string,
): NativeOutputFilePublisherIdentity | undefined {
  const source = carrier.publisher ?? (admission?.agentId === agentId ? admission : undefined);
  if (!source || typeof source !== 'object') return undefined;
  const parsed = publisherIdentity.safeParse({
    providerId: (source as NativeOutputFilePublisherIdentity).providerId,
    originSha256: (source as NativeOutputFilePublisherIdentity).originSha256,
  });
  return parsed.success ? parsed.data : undefined;
}
export type NativeOutputFileIdentity = Pick<
  NativeResponseIdentity,
  | 'userId'
  | 'conversationId'
  | 'responseMessageId'
  | 'streamId'
  | 'agentId'
  | 'logicalTurnId'
  | 'revision'
> & {
  requestId: string;
  runId?: string;
  invocationId?: string;
  attemptId?: string;
};
export interface NativeFollowUpOutputSource {
  identity: Omit<NativeOutputFileIdentity, 'requestId'>;
  presentationAgentId: string;
  publisher: NativeOutputFilePublisherIdentity;
}
export interface NativeFollowUpOutputFiles extends NativeFollowUpOutputSource {
  envelope: NativeOutputFiles;
  identity: NativeOutputFileIdentity;
}

/** Snapshot only the host-authored dispatch fields, without retaining authorization headers. */
export function nativeFollowUpOutputSource({
  headers, userId, conversationId, sourceMessageId, agentId, presentationAgentId,
  providerId, baseURL, capability,
}: {
  headers: HeadersInit;
  userId: string;
  conversationId: string;
  sourceMessageId: string;
  agentId: string;
  presentationAgentId: string;
  providerId: string;
  baseURL: string;
  capability?: Pick<TAgentProviderCapability, 'workspace_binding' | 'conversation_session'>;
}): NativeFollowUpOutputSource | undefined {
  const values = new Headers(headers);
  const streamId = values.get('X-Viventium-Stream-Id') || '';
  const publisher = nativeOutputFilePublisherFromContext({ providerId, baseURL, capability });
  if (!publisher || !userId || !conversationId || !sourceMessageId || !agentId ||
      !presentationAgentId || !streamId ||
      values.get('X-Viventium-User-Id') !== userId ||
      values.get('X-Viventium-Conversation-Id') !== conversationId ||
      values.get('X-Viventium-Message-Id') !== sourceMessageId ||
      values.get('X-GlassHive-Agent-Id') !== agentId ||
      values.get('X-GlassHive-Idempotency-Key') !== streamId) return undefined;
  return {
    identity: {
      userId, conversationId, responseMessageId: sourceMessageId, agentId, streamId,
      logicalTurnId: values.get('X-Viventium-Logical-Turn-Id') || '',
      revision: Number(values.get('X-Viventium-Logical-Turn-Revision') || 1),
    },
    presentationAgentId,
    publisher,
  };
}

/** The authenticated emitting response owns request/run/attempt; source authority is host-owned. */
export function captureNativeFollowUpOutputFiles(
  value: unknown, source: NativeFollowUpOutputSource,
): NativeFollowUpOutputFiles | undefined {
  const carrier = inspectNativeOutputFileCarrier(value);
  if (!carrier) return undefined;
  const identity = { ...source.identity, requestId: carrier.requestId };
  const envelope = normalizeNativeOutputFiles(carrier.envelope, identity);
  if (!envelope) return undefined;
  return {
    ...source,
    identity: {
      ...identity, runId: envelope.run_id, attemptId: envelope.attempt_id,
      invocationId: envelope.invocation_id,
    },
    envelope,
  };
}

/** Verify the accepted source first; then bind only its message to the authored destination. */
export function nativeFollowUpOutputFilesForMessage(
  capture: NativeFollowUpOutputFiles,
  destination: {
    userId: string; conversationId: string; sourceMessageId: string;
    responseMessageId: string; agentId: string;
  },
): { envelope: NativeOutputFiles; identity: NativeOutputFileIdentity & NativeOutputFilePublisherIdentity } {
  if (capture.identity.userId !== destination.userId ||
      capture.identity.conversationId !== destination.conversationId ||
      capture.identity.responseMessageId !== destination.sourceMessageId ||
      capture.presentationAgentId !== destination.agentId || !destination.responseMessageId)
    throw error('native_output_files_identity_invalid');
  const source = normalizeNativeOutputFiles(capture.envelope, capture.identity);
  if (!source) throw error('native_output_files_invalid');
  const publisher = publisherIdentity.parse(capture.publisher);
  const identity = { ...capture.identity, ...publisher, responseMessageId: destination.responseMessageId };
  return { envelope: { ...source, message_id: destination.responseMessageId }, identity };
}
export interface NativeOutputAttachment {
  user: string;
  file_id: string;
  filename: string;
  filepath: string;
  bytes: number;
  type: string;
  source: string;
  object: 'file';
  nativeOutputFile?: {
    version: 1;
    status: 'available';
    messageId: string;
    downloadUrl: string;
    selectedReferences?: string[];
  };
}
export interface NativeOutputStoredFile extends Omit<NativeOutputAttachment, 'user'> {
  user: unknown;
  conversationId?: string;
  messageId?: string;
  metadata?: { fileIdentifier?: string };
}
export interface NativeOutputUnavailableAttachment {
  filename: string;
  messageId: string;
  nativeOutputFile: { version: 1; status: 'unavailable'; code: string };
}
export type NativeOutputDeliveryAttachment =
  NativeOutputAttachment | NativeOutputUnavailableAttachment;
export function nativeOutputFileDescriptorKey(file: NativeOutputFile): string {
  return JSON.stringify([file.filename, file.mime_type, file.bytes, file.sha256]);
}

/** Only a successful exact owner/message/grant import can replace a callback attachment. */
export function mergeVerifiedNativeOutputFileImports(
  envelope: NativeOutputFiles,
  identity: NativeOutputFileIdentity,
  imported: NativeOutputDeliveryAttachment[],
  seen: Set<string>,
): { attachments: NativeOutputDeliveryAttachment[]; count: number; bytes: number } {
  const attachments: NativeOutputDeliveryAttachment[] = [];
  let count = 0;
  let bytes = 0;
  for (const attachment of imported) {
    if (attachment.nativeOutputFile?.status !== 'available' || !('user' in attachment)) {
      attachments.push(attachment);
      continue;
    }
    const file = envelope.files.find((item) =>
      item.filename === attachment.filename && item.mime_type === attachment.type &&
      item.bytes === attachment.bytes && item.download_url === attachment.nativeOutputFile?.downloadUrl &&
      attachment.file_id === `native_${fileFingerprint(envelope, item)}`,
    );
    if (!file || attachment.user !== identity.userId ||
        attachment.nativeOutputFile.messageId !== identity.responseMessageId) continue;
    const key = nativeOutputFileDescriptorKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push(attachment);
    count += 1;
    bytes += file.bytes;
  }
  return { attachments, count, bytes };
}
export interface NativeOutputFileStore {
  find: (fileId: string) => Promise<NativeOutputStoredFile | null>;
  save: (
    file: NativeOutputFile,
    bytes: Buffer,
    identity: NativeOutputFileIdentity,
    keys: { fileId: string; objectId: string; fingerprint: string },
  ) => Promise<NativeOutputStoredFile>;
}
function error(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** Only an exact canonical response or pre-merge chunk from the current model may call this. */
export function normalizeNativeOutputFiles(
  value: unknown,
  identity: NativeOutputFileIdentity,
): NativeOutputFiles | undefined {
  if (value == null) return undefined;
  const parsed = outputFiles.safeParse(value);
  if (!parsed.success) throw error('native_output_files_invalid');
  const envelope = parsed.data;
  if (
    envelope.owner_id !== identity.userId ||
    envelope.conversation_id !== identity.conversationId ||
    envelope.message_id !== identity.responseMessageId ||
    envelope.stream_id !== identity.streamId ||
    envelope.agent_id !== identity.agentId ||
    envelope.logical_turn_id !== identity.logicalTurnId ||
    envelope.logical_turn_revision !== identity.revision ||
    envelope.request_id !== identity.requestId ||
    (identity.runId != null && envelope.run_id !== identity.runId) ||
    (identity.attemptId != null && envelope.attempt_id !== identity.attemptId) ||
    (identity.invocationId != null && envelope.invocation_id !== identity.invocationId)
  ) {
    throw error('native_output_files_identity_invalid');
  }
  const seen = new Set<string>();
  return {
    ...envelope,
    files: envelope.files.filter((file) => {
      const key = JSON.stringify(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}
function signedURL(value: string, artifactBaseURL: string): string {
  try {
    const base = new URL(artifactBaseURL);
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^\/v1\/(?:link-refs\/ghr_[A-Za-z0-9_-]{12,96}|signed-links\/[A-Za-z0-9._-]{10,4096})$/.test(
        url.pathname,
      )
    )
      throw new Error();
    return url.href;
  } catch {
    throw error('native_output_file_origin_invalid');
  }
}
export interface NativeOutputFileTransportObservation {
  status: number | 'failed';
  durationMs: number;
  errorClass?: 'TimeoutError' | 'AbortError' | 'TypeError' | 'Error';
}

/** Keep the verified public grant path while using the authenticated provider transport. */
export function createNativeOutputFileFetch(
  route: NativeResponseRoute,
  artifactBaseURL: string,
  observe?: (observation: NativeOutputFileTransportObservation) => void,
  fetchFile: NativeOutputFileFetch = fetch,
): NativeOutputFileFetch {
  const base = new URL(route.baseURL);
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !['/v1', '/v1/'].includes(base.pathname)
  )
    throw error('native_output_file_origin_invalid');
  const headers = new Headers(route.headers);
  const notify = (observation: NativeOutputFileTransportObservation) => {
    try {
      observe?.(observation);
    } catch {
      /* Observation cannot change delivery. */
    }
  };
  return async (value, init) => {
    const original = new URL(signedURL(value, artifactBaseURL));
    const target = new URL(original.pathname, base.origin);
    const started = performance.now();
    try {
      const response = await fetchFile(target.href, {
        ...init,
        headers: new Headers(headers),
        redirect: 'error',
      });
      notify({ status: response.status, durationMs: performance.now() - started });
      return response;
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : '';
      const errorClass =
        name === 'TimeoutError' || name === 'AbortError' || name === 'TypeError' ? name : 'Error';
      notify({ status: 'failed', errorClass, durationMs: performance.now() - started });
      throw cause;
    }
  };
}
async function verifiedBytes(
  file: NativeOutputFile,
  url: string,
  maxBytes: number,
  fetchFile: NativeOutputFileFetch,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || file.bytes > maxBytes)
    throw error('native_output_file_size_limit');
  let response: Response;
  try {
    response = await fetchFile(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw error('native_output_file_unavailable');
  }
  if (!response.ok || !response.body) throw error('native_output_file_unavailable');
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
      file.mime_type.toLowerCase() ||
    (response.headers.has('content-length') &&
      Number(response.headers.get('content-length')) !== file.bytes)
  ) {
    await response.body.cancel();
    throw error('native_output_file_content_mismatch');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > maxBytes || count > file.bytes)
        throw error('native_output_file_content_mismatch');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (count !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw error('native_output_file_content_mismatch');
  return bytes;
}
function attachment(row: NativeOutputStoredFile): NativeOutputAttachment {
  return {
    user: String(row.user),
    file_id: row.file_id,
    filename: row.filename,
    filepath: row.filepath,
    bytes: row.bytes,
    type: row.type,
    source: row.source,
    object: 'file',
  };
}

function fileFingerprint(envelope: NativeOutputFiles, file: NativeOutputFile): string {
  return createHash('sha256')
    .update(JSON.stringify([
      envelope.owner_id, envelope.conversation_id, envelope.message_id, envelope.stream_id,
      envelope.agent_id, envelope.logical_turn_id, envelope.logical_turn_revision,
      envelope.request_id, envelope.run_id, envelope.attempt_id,
      file.filename, file.mime_type, file.bytes, file.sha256,
    ]))
    .digest('hex');
}

/** One canonical File proof serves initial import and retained owned-file delivery. */
export function nativeOutputStoredFileMatches(
  envelope: NativeOutputFiles, file: NativeOutputFile, identity: NativeOutputFileIdentity,
  row: NativeOutputStoredFile | null,
): row is NativeOutputStoredFile {
  const fingerprint = fileFingerprint(envelope, file);
  return Boolean(row && String(row.user) === identity.userId &&
    row.file_id === `native_${fingerprint}` && row.conversationId === identity.conversationId &&
    row.messageId === identity.responseMessageId &&
    row.metadata?.fileIdentifier === `native_output_sha256:${fingerprint}` &&
    row.bytes === file.bytes && row.type === file.mime_type && row.filename === file.filename);
}

export interface RetainedNativeOutputMessage {
  user: unknown; conversationId: string; messageId: string; isCreatedByUser: boolean;
  unfinished?: boolean; error?: boolean; deletedAt?: unknown; expiredAt?: unknown;
  nativeResponse?: NativeResponseAdmission;
  attachments?: NativeOutputDeliveryAttachment[];
}

/** Core has checked this original callback against its accepted-operation owner. */
export interface RetainedNativeCallbackOutputSource {
  envelope: NativeOutputFiles;
  identity: NativeOutputFileIdentity;
  sourceDigest: string;
}

/** Retained grants are usable only through their canonical completed native source and Files. */
export function retainedNativeOutputFilesForMessage(
  row: RetainedNativeOutputMessage, storedFiles: readonly NativeOutputStoredFile[],
  references: readonly string[], destination: {
    userId: string; conversationId: string; responseMessageId: string; agentId: string;
  },
  acceptedCallback?: RetainedNativeCallbackOutputSource,
): { envelope: NativeOutputFiles; identity: NativeOutputFileIdentity & Partial<NativeOutputFilePublisherIdentity>;
     sourceFiles: NativeOutputStoredFile[]; sourceMessageId: string; candidateSha256: string } | undefined {
  const admission = row.nativeResponse;
  if (String(row.user) !== destination.userId || row.conversationId !== destination.conversationId ||
      row.isCreatedByUser !== false || row.unfinished === true || row.error === true || row.deletedAt ||
      (row.expiredAt && (!Number.isFinite(new Date(String(row.expiredAt)).getTime()) ||
        new Date(String(row.expiredAt)).getTime() <= Date.now())))
    throw error('native_output_files_retained_source_invalid');
  let sourceIdentity: NativeOutputFileIdentity;
  let source: NativeOutputFiles | undefined;
  let sourceDigest: string;
  if (!admission && acceptedCallback) {
    sourceIdentity = acceptedCallback.identity;
    if (sourceIdentity.userId !== destination.userId ||
        sourceIdentity.conversationId !== row.conversationId ||
        sourceIdentity.responseMessageId !== row.messageId ||
        !/^[a-f0-9]{64}$/.test(acceptedCallback.sourceDigest))
      throw error('native_output_files_retained_source_invalid');
    source = normalizeNativeOutputFiles(acceptedCallback.envelope, sourceIdentity);
    sourceDigest = acceptedCallback.sourceDigest;
  } else {
    if (!admission || admission.status !== 'completed' || admission.userId !== destination.userId ||
        admission.conversationId !== row.conversationId || admission.responseMessageId !== row.messageId)
      throw error('native_output_files_retained_source_invalid');
    let candidate: NativeResponseCandidate;
    let response: { id?: unknown; glasshive?: { output_files?: unknown } };
    try {
      candidate = JSON.parse(admission.candidateJson || '');
      response = JSON.parse(candidate.responseJson);
    } catch { throw error('native_output_files_retained_source_invalid'); }
    if (nativeResponseDigest(candidate) !== admission.candidateSha256 ||
        candidate.authoritySha256 !== admission.authoritySha256 || response.id !== candidate.requestId)
      throw error('native_output_files_retained_source_invalid');
    sourceIdentity = { ...admission, requestId: candidate.requestId, runId: candidate.runId };
    source = normalizeNativeOutputFiles(response.glasshive?.output_files, sourceIdentity);
    sourceDigest = admission.candidateSha256!;
  }
  if (!source) return undefined;
  const sourceEnvelope = source;
  const selected = new Set(references);
  const sourceFiles: NativeOutputStoredFile[] = [];
  const files = sourceEnvelope.files.filter((file) => {
    if (!selected.has(file.download_url)) return false;
    const attachment = row.attachments?.find((item) => item.nativeOutputFile?.status === 'available' &&
      item.nativeOutputFile.messageId === row.messageId && item.nativeOutputFile.downloadUrl === file.download_url &&
      'file_id' in item && storedFiles.some((stored) => stored.file_id === item.file_id &&
        nativeOutputStoredFileMatches(sourceEnvelope, file, sourceIdentity, stored)));
    if (!attachment || !('file_id' in attachment)) throw error('native_output_files_retained_source_invalid');
    sourceFiles.push(storedFiles.find((stored) => stored.file_id === attachment.file_id)!);
    return true;
  });
  if (!files.length) return undefined;
  if (!admission) {
    const identity = { ...sourceIdentity, responseMessageId: destination.responseMessageId,
      streamId: destination.responseMessageId, agentId: destination.agentId,
      logicalTurnId: '', revision: 1 };
    return { envelope: { ...source, message_id: identity.responseMessageId,
      stream_id: identity.streamId, agent_id: identity.agentId, logical_turn_id: '',
      logical_turn_revision: 1, files }, identity, sourceFiles,
      sourceMessageId: row.messageId, candidateSha256: sourceDigest };
  }
  const capture: NativeFollowUpOutputFiles = {
    identity: sourceIdentity, envelope: { ...source, files }, presentationAgentId: destination.agentId,
    publisher: publisherIdentity.parse({ providerId: admission.providerId, originSha256: admission.originSha256 }),
  };
  const rebound = nativeFollowUpOutputFilesForMessage(capture, { ...destination, sourceMessageId: row.messageId });
  return { ...rebound, sourceFiles, sourceMessageId: row.messageId, candidateSha256: sourceDigest };
}

/** Capture before SDK concatenation; a merged stream ID is not an invocation identity. */
export function inspectNativeOutputFileCarrier(value: unknown):
  | {
      envelope: unknown;
      requestId: string;
    }
  | undefined {
  const record = (item: unknown): Record<string, unknown> | undefined =>
    item != null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined;
  const root = record(value);
  const additional = record(root?.additional_kwargs);
  const raw = record(additional?.__raw_response) || record(root?.__raw_response) || root;
  if (
    !raw ||
    !['chat.completion', 'chat.completion.chunk'].includes(String(raw.object)) ||
    typeof raw.id !== 'string' ||
    !raw.id
  )
    return undefined;
  const canonical = record(raw.glasshive)?.output_files;
  const choice = Array.isArray(raw.choices) ? record(raw.choices[0]) : undefined;
  const message = record(choice?.message) || record(choice?.delta);
  const envelope =
    canonical ?? record(record(message?.provider_specific_fields)?.viventium)?.output_files;
  if (envelope == null) return undefined;
  if (record(envelope)?.request_id !== raw.id) throw error('native_output_files_request_invalid');
  return { envelope, requestId: raw.id };
}

/** No prose scanning, workspace reads, or provider work occurs in this host courier. */
export async function importNativeOutputFiles(
  value: unknown,
  identity: NativeOutputFileIdentity,
  options: {
    artifactBaseURL: string;
    maxBytes: number;
    maxFiles?: number;
    maxTotalBytes?: number;
    store: NativeOutputFileStore;
    fetchFile?: NativeOutputFileFetch;
    recoverUnavailable?: boolean;
  },
): Promise<NativeOutputDeliveryAttachment[]> {
  const unavailable = (cause: unknown, filename = 'File'): NativeOutputUnavailableAttachment => {
    const code = (cause as { code?: unknown })?.code;
    return {
      filename,
      messageId: identity.responseMessageId,
      nativeOutputFile: {
        version: 1,
        status: 'unavailable',
        code: new Set([
          'native_output_files_invalid',
          'native_output_files_identity_invalid',
          'native_output_file_origin_invalid',
          'native_output_file_size_limit',
          'native_output_file_content_mismatch',
          'native_output_file_storage_conflict',
          'native_output_file_storage_unavailable',
          'native_output_file_unavailable',
          'native_output_file_source_root_unsupported',
          'native_output_file_not_deliverable',
          'native_output_file_unreadable',
          'native_output_file_count_limit',
          'native_output_file_total_size_limit',
        ]).has(String(code))
          ? String(code)
          : 'native_output_file_unavailable',
      },
    };
  };
  let normalizedEnvelope: NativeOutputFiles | undefined;
  try {
    normalizedEnvelope = normalizeNativeOutputFiles(value, identity);
  } catch (cause) {
    if (!options.recoverUnavailable) throw cause;
    return [unavailable(cause)];
  }
  const envelope = normalizedEnvelope;
  if (!envelope) return [];
  // Validate every URL and limit before any network/storage work. One unavailable file does
  // not suppress another verified file or the model's useful answer.
  let acceptedCount = 0;
  let acceptedBytes = 0;
  const prepared = envelope.files.map((file) => {
    try {
      if (
        !Number.isSafeInteger(options.maxBytes) ||
        options.maxBytes < 0 ||
        file.bytes > options.maxBytes
      )
        throw error('native_output_file_size_limit');
      if (
        options.maxFiles != null &&
        (!Number.isSafeInteger(options.maxFiles) ||
          options.maxFiles < 0 ||
          acceptedCount >= options.maxFiles)
      )
        throw error('native_output_file_count_limit');
      if (
        options.maxTotalBytes != null &&
        (!Number.isSafeInteger(options.maxTotalBytes) ||
          options.maxTotalBytes < 0 ||
          acceptedBytes + file.bytes > options.maxTotalBytes)
      )
        throw error('native_output_file_total_size_limit');
      const url = signedURL(file.download_url, options.artifactBaseURL);
      acceptedCount += 1;
      acceptedBytes += file.bytes;
      return { url };
    } catch (cause) {
      if (!options.recoverUnavailable) throw cause;
      return { unavailable: unavailable(cause, file.filename) };
    }
  });
  const result: NativeOutputDeliveryAttachment[] = [];
  const returned = new Set<string>();
  for (const [index, file] of envelope.files.entries()) {
    const preparation = prepared[index];
    if (preparation.unavailable) {
      result.push(preparation.unavailable);
      continue;
    }
    try {
      const fingerprint = fileFingerprint(envelope, file);
      const keys = {
        fileId: `native_${fingerprint}`,
        objectId: fingerprint.slice(0, 24),
        fingerprint,
      };
      const matches = (row: NativeOutputStoredFile) =>
        nativeOutputStoredFileMatches(envelope, file, identity, row);
      let row = await options.store.find(keys.fileId);
      if (!row) {
        const bytes = await verifiedBytes(
          file,
          preparation.url!,
          options.maxBytes,
          options.fetchFile || fetch,
        );
        try {
          row = await options.store.save(file, bytes, identity, keys);
        } catch (cause) {
          // Deterministic _id uses Mongo's existing unique key across concurrent processes.
          if ((cause as { code?: number })?.code !== 11000) throw cause;
          row = await options.store.find(keys.fileId);
          if (!row) throw cause;
        }
      }
      if (!matches(row)) throw error('native_output_file_storage_conflict');
      if (!returned.has(row.file_id)) {
        // UI binds this exact verified grant to its existing owner File. Authored history stays intact.
        result.push({
          ...attachment(row),
          nativeOutputFile: {
            version: 1,
            status: 'available',
            messageId: identity.responseMessageId,
            downloadUrl: preparation.url!,
          },
        });
        returned.add(row.file_id);
      }
    } catch (cause) {
      if (!options.recoverUnavailable) throw cause;
      result.push(unavailable(cause, file.filename));
    }
  }
  for (const rejected of envelope.rejected || []) {
    result.push(unavailable(error(`native_output_file_${rejected.code}`), rejected.name));
  }
  return result;
}
/* === VIVENTIUM END === */
