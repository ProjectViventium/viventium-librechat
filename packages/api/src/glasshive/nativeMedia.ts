/* === VIVENTIUM START === Verified native image evidence for existing Main synthesis. === */
import { createHash } from 'crypto';
import { z } from 'zod';
import { normalizeGlassHiveRunInput } from './missionInput';
import { createNativeOutputFileFetch } from './nativeOutputFiles';
import { createAccountApiRoute } from './accountClient';
import { sanitizeFilename } from '../utils/files';
import type { GlassHiveRunInput } from './missionInput';
import type { ClientSession } from 'mongoose';
import type {
  IGlassHiveTerminalCallbackResult,
  GlassHiveTerminalCallbackAcceptedOperationReference,
} from '@librechat/data-schemas';
import type {
  NativeOutputFiles,
  NativeOutputFileIdentity,
  NativeOutputFile,
  NativeOutputFileFetch,
  NativeOutputDeliveryAttachment,
} from './nativeOutputFiles';

export const GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const GLASSHIVE_NATIVE_MEDIA_MAX_IMAGE_BYTES = MAX_IMAGE_BYTES;
export const GLASSHIVE_NATIVE_MEDIA_MAX_BYTES = 32 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const observationSchema = z.object({
  kind: z.literal('image'),
  source: z.literal('native_tool_result'),
  artifact_ref: z.string().regex(/^artifact_sha256:[a-f0-9]{64}$/),
  run_id: z.string().min(1).max(160),
  tool_call_id: z.string().min(1).max(512),
  tool_name: z.string().max(512).optional(),
  content_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mime_type: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  bytes: z.number().int().positive().max(MAX_IMAGE_BYTES),
  sha256: digest,
  download_url: z.string().min(1).max(8192),
  open_url: z.string().min(1).max(8192),
});
const mediaSchema = z.object({
  observations: z.array(observationSchema).max(GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES),
  omitted_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

export type GlassHiveNativeMedia = z.infer<typeof mediaSchema>;
export type GlassHiveNativeMediaSelection = Pick<
  GlassHiveNativeMedia['observations'][number],
  'run_id' | 'tool_call_id' | 'content_index' | 'artifact_ref'
> & { label?: string };

export interface GlassHiveNativeMediaInsight {
  authority?: { kind?: string; runId?: string };
  nativeMedia?: GlassHiveNativeMedia;
  runInput?: GlassHiveRunInput;
}

type MediaContent =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

function mediaError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function normalizeGlassHiveNativeMedia(
  value: unknown,
  runId: string,
): GlassHiveNativeMedia | undefined {
  if (value == null) return undefined;
  const parsed = mediaSchema.safeParse(value);
  if (!parsed.success) throw mediaError('native_media_invalid');
  let total = 0;
  const identities = new Set<string>();
  for (const item of parsed.data.observations) {
    const identity = JSON.stringify([item.run_id, item.tool_call_id, item.content_index]);
    total += item.bytes;
    if (
      !runId ||
      item.run_id !== runId ||
      item.artifact_ref !== `artifact_sha256:${item.sha256}` ||
      total > GLASSHIVE_NATIVE_MEDIA_MAX_BYTES ||
      identities.has(identity)
    )
      throw mediaError('native_media_identity_invalid');
    identities.add(identity);
  }
  return parsed.data;
}

function signedArtifactUrl(value: string, baseUrl: string): string {
  try {
    const base = new URL(baseUrl);
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      url.username ||
      url.password ||
      url.origin !== base.origin ||
      url.search ||
      url.hash ||
      !/^\/v1\/(?:link-refs\/ghr_[A-Za-z0-9_-]{12,96}|signed-links\/[A-Za-z0-9._-]{10,4096})$/.test(
        url.pathname,
      )
    )
      throw new Error();
    return url.href;
  } catch {
    throw mediaError('native_media_link_invalid');
  }
}

/** Use the existing messaging fence markers and protected inline-code range convention. */
function markdownCodeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let fence: { start: number; marker: string } | undefined;
  for (const line of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const start = line.index;
    if (start == null) continue;
    const marker = line[0].match(/^[ \t]*(`{3,}|~{3,})/);
    if (!marker) continue;
    if (!fence) {
      fence = { start, marker: marker[1] };
      continue;
    }
    if (
      marker[1][0] === fence.marker[0] &&
      marker[1].length >= fence.marker.length &&
      !line[0].slice(marker[0].length).trim()
    ) {
      ranges.push([fence.start, start + line[0].length]);
      fence = undefined;
    }
  }
  if (fence) ranges.push([fence.start, text.length]);
  for (const code of text.matchAll(/(`+)[\s\S]*?\1(?!`)/g)) {
    const start = code.index;
    if (start == null) continue;
    ranges.push([start, start + code[0].length]);
  }
  return ranges;
}

interface NativeMediaMarkdownReference {
  reference: string;
  label: string;
}

function mapNativeMediaMarkdownReferences(
  text: string,
  project: (selected: NativeMediaMarkdownReference, original: string) => string,
): string {
  const protectedRanges = markdownCodeRanges(text);
  return text.replace(
    /\\.|(!?\[(?:\\.|[^\\[\]\r\n])*\])\(\s*<?([^<>\s()]*)>?\s*\)/g,
    (_match, label: string | undefined, reference: string | undefined, offset: number) => {
      if (label === undefined || reference === undefined) return _match;
      if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return _match;
      return project(
        { reference, label: label.slice(label.startsWith('!') ? 2 : 1, -1).slice(0, 200) },
        _match,
      );
    },
  );
}

/** Only imported exact owner/message Files may turn a selected source alias into a local view. */
export function renderGlassHiveNativeMediaAttachmentLinks(
  text: string,
  attachments: NativeOutputDeliveryAttachment[] | undefined,
  { ownerId, messageId }: { ownerId: string; messageId: string },
): string {
  const links = new Map<string, string>();
  for (const attachment of attachments || []) {
    const receipt = attachment.nativeOutputFile;
    if (
      receipt?.version !== 1 ||
      receipt.status !== 'available' ||
      receipt.messageId !== messageId ||
      !('user' in attachment) ||
      attachment.user !== ownerId ||
      !/^native_[a-f0-9]{64}$/.test(attachment.file_id) ||
      !attachment.filepath ||
      !attachment.filename
    )
      continue;
    for (const reference of receipt.selectedReferences || [])
      links.set(reference, receipt.downloadUrl);
  }
  if (!links.size) return text;
  return mapNativeMediaMarkdownReferences(text, ({ reference }, original) => {
    const target = links.get(reference);
    return target ? original.replace(/\(\s*<?[^<>\s()]*>?\s*\)$/, `(${target})`) : original;
  });
}

/** Alias receipts contain only destinations actually selected from accepted evidence. */
export function bindGlassHiveNativeMediaAttachmentReferences(
  text: string,
  rows: readonly GlassHiveNativeMediaRetainedSource[],
  attachments: NativeOutputDeliveryAttachment[],
  ownerId: string,
  messageId: string,
): NativeOutputDeliveryAttachment[] {
  const aliases = new Map<string, Set<string>>();
  const observations = new Map<string, GlassHiveNativeMedia['observations'][number]>();
  for (const row of rows) {
    if (row.ownerId !== ownerId) throw mediaError('native_media_authority_invalid');
    const media = normalizeGlassHiveNativeMedia(row.nativeMedia, row.runId);
    for (const item of media?.observations || []) {
      const download = signedArtifactUrl(
        item.download_url,
        process.env.GLASSHIVE_ARTIFACT_BASE_URL || '',
      );
      const open = signedArtifactUrl(item.open_url, process.env.GLASSHIVE_ARTIFACT_BASE_URL || '');
      for (const reference of [
        item.artifact_ref,
        item.download_url,
        download,
        item.open_url,
        open,
      ]) {
        observations.set(reference, { ...item, download_url: download });
      }
    }
  }
  mapNativeMediaMarkdownReferences(text, ({ reference }, original) => {
    const item = observations.get(reference);
    if (!item) return original;
    const selected = aliases.get(item.download_url) || new Set<string>();
    selected.add(reference);
    aliases.set(item.download_url, selected);
    return original;
  });
  return attachments.map((attachment) => {
    const receipt = attachment.nativeOutputFile;
    if (
      receipt?.version !== 1 ||
      receipt.status !== 'available' ||
      receipt.messageId !== messageId ||
      !('user' in attachment) ||
      attachment.user !== ownerId ||
      !/^native_[a-f0-9]{64}$/.test(attachment.file_id)
    )
      return attachment;
    const selectedReferences = aliases.get(receipt.downloadUrl);
    return selectedReferences
      ? {
          ...attachment,
          nativeOutputFile: { ...receipt, selectedReferences: [...selectedReferences] },
        }
      : attachment;
  });
}

/** Structural selections only: typed refs or sealed grants at the configured artifact origin. */
export function collectGlassHiveNativeMediaReferences(
  text: string,
  { artifactBaseUrl = process.env.GLASSHIVE_ARTIFACT_BASE_URL || '' } = {},
): string[] {
  const references = new Set<string>();
  mapNativeMediaMarkdownReferences(text, (selected, original) => {
    if (selected.reference.startsWith('artifact_sha256:')) {
      references.add(selected.reference);
      return original;
    }
    try {
      references.add(signedArtifactUrl(selected.reference, artifactBaseUrl));
      references.add(selected.reference);
    } catch {
      return original;
    }
    return original;
  });
  return [...references];
}

/** Resolve model-selected input references through this synthesis's verified artifact scope. */
export function renderGlassHiveNativeMediaLinks(
  text: string,
  insights: readonly GlassHiveNativeMediaInsight[],
  {
    artifactBaseUrl = process.env.GLASSHIVE_ARTIFACT_BASE_URL || '',
    onSelection,
  }: {
    artifactBaseUrl?: string;
    onSelection?: (selection: GlassHiveNativeMediaSelection) => void;
  } = {},
): string {
  const links = new Map<string, GlassHiveNativeMedia['observations'][number]>();
  for (const insight of insights) {
    if (!insight.nativeMedia) continue;
    if (insight.authority?.kind !== 'durable_terminal_callback') {
      throw mediaError('native_media_authority_invalid');
    }
    const media = normalizeGlassHiveNativeMedia(insight.nativeMedia, insight.authority.runId || '');
    for (const item of media?.observations || []) {
      const downloadUrl = signedArtifactUrl(item.download_url, artifactBaseUrl);
      const openUrl = signedArtifactUrl(item.open_url, artifactBaseUrl);
      const canonical = { ...item, download_url: downloadUrl, open_url: openUrl };
      for (const reference of [
        item.artifact_ref,
        item.download_url,
        downloadUrl,
        item.open_url,
        openUrl,
      ]) {
        links.set(reference, canonical);
      }
    }
  }
  return mapNativeMediaMarkdownReferences(text, ({ reference, label }, original) => {
    const item = links.get(reference);
    if (!item) {
      if (reference.startsWith('artifact_sha256:'))
        throw mediaError('native_media_selection_unavailable');
      return original;
    }
    onSelection?.({
      run_id: item.run_id,
      tool_call_id: item.tool_call_id,
      content_index: item.content_index,
      artifact_ref: item.artifact_ref,
      label,
    });
    return original.replace(/\(\s*<?[^<>\s()]*>?\s*\)$/, `(${item.download_url})`);
  });
}

/** Rebind selection to current accepted callback evidence before the existing File import. */
export function selectGlassHiveNativeMediaFiles(
  selections: readonly GlassHiveNativeMediaSelection[],
  rows: readonly {
    ownerId: string;
    runId: string;
    terminalCallbackId: string;
    nativeMedia?: GlassHiveNativeMedia;
  }[],
  ownerId: string,
): Map<string, NativeOutputFile[]> {
  const key = (item: GlassHiveNativeMediaSelection) =>
    JSON.stringify([item.run_id, item.tool_call_id, item.content_index, item.artifact_ref]);
  const selectionSchema = observationSchema
    .pick({
      run_id: true,
      tool_call_id: true,
      content_index: true,
      artifact_ref: true,
    })
    .extend({ label: z.string().max(200).optional() })
    .strict();
  const parsed = z
    .array(selectionSchema)
    .max(GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES)
    .safeParse(selections);
  if (!parsed.success) throw mediaError('native_media_selection_unavailable');
  const pending = new Map(parsed.data.map((item) => [key(item), item]));
  const files = new Map<string, NativeOutputFile[]>();
  for (const row of rows) {
    if (!pending.size) break;
    if (row.ownerId !== ownerId) throw mediaError('native_media_authority_invalid');
    const media = normalizeGlassHiveNativeMedia(row.nativeMedia, row.runId);
    for (const item of media?.observations || []) {
      const selection = pending.get(key(item));
      if (!selection) continue;
      pending.delete(key(item));
      const extension = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
      }[item.mime_type];
      const selected = files.get(row.terminalCallbackId) || [];
      selected.push({
        filename: sanitizeFilename(`${selection.label?.trim() || 'Evidence'}${extension}`),
        mime_type: item.mime_type,
        bytes: item.bytes,
        sha256: item.sha256,
        download_url: new URL(item.download_url).href,
      });
      files.set(row.terminalCallbackId, selected);
    }
  }
  if (pending.size) throw mediaError('native_media_selection_unavailable');
  return files;
}

export interface GlassHiveNativeMediaCallbackSource {
  ownerId: string;
  runId: string;
  attemptId?: string;
  attemptNumber: number;
  terminalCallbackResultKey: string;
  terminalCallbackAcceptedOperationId: string;
  terminalCallbackId: string;
  terminalCallbackResultRevision: number;
  terminalCallbackResultDigest: string;
  terminalCallbackEffectGeneration: number;
}

const nativeMediaCallbackSourceProof = z.object({
  attemptNumber: z.number().int().positive(),
  terminalCallbackResultKey: z.string().regex(/^ghtr_[a-f0-9]{64}$/),
  terminalCallbackAcceptedOperationId: z.string().regex(/^[a-f0-9]{32}$/),
  terminalCallbackId: z.string().regex(/^cb_terminal_[a-f0-9]{64}$/),
  terminalCallbackResultRevision: z.number().int().positive(),
  terminalCallbackResultDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  terminalCallbackEffectGeneration: z.number().int().positive(),
});

/** The owning mission transaction fences this exact original accepted operation before import. */
export function nativeMediaOutputFilesForMessage(
  source: GlassHiveNativeMediaCallbackSource,
  files: NativeOutputFile[],
  identity: NativeOutputFileIdentity,
): NativeOutputFiles {
  const proof = nativeMediaCallbackSourceProof.safeParse(source);
  const attemptId = source.attemptId || '';
  if (
    !proof.success ||
    source.ownerId !== identity.userId ||
    source.runId !== identity.runId ||
    source.terminalCallbackId !== identity.requestId ||
    attemptId !== identity.attemptId
  ) {
    throw mediaError('native_media_authority_invalid');
  }
  return {
    version: 1,
    owner_id: identity.userId,
    conversation_id: identity.conversationId,
    message_id: identity.responseMessageId,
    stream_id: identity.streamId,
    agent_id: identity.agentId,
    logical_turn_id: identity.logicalTurnId,
    logical_turn_revision: identity.revision,
    request_id: source.terminalCallbackId,
    run_id: source.runId,
    attempt_id: attemptId,
    invocation_id: '',
    files,
  };
}

export interface GlassHiveNativeMediaRetainedSource extends GlassHiveNativeMediaCallbackSource {
  conversationId: string;
  originRef: string;
  workRef: string;
  nativeMedia?: GlassHiveNativeMedia;
}
interface NativeMediaEvidenceSelector {
  ownerId: string;
  conversationId: string;
  $or: Array<{ [field: string]: { $in: string[] } }>;
}
interface NativeMediaAcceptedSelector extends Pick<
  IGlassHiveTerminalCallbackResult,
  | 'ownerId'
  | 'originRef'
  | 'workRef'
  | 'runId'
  | 'attemptNumber'
  | 'callbackId'
  | 'resultRevision'
  | 'resultDigest'
  | 'acceptedOperationId'
  | 'acceptedOperationGeneration'
> {
  _id: string;
}
export interface GlassHiveNativeMediaSourceStore {
  readEvidence: (
    selector: NativeMediaEvidenceSelector,
  ) => Promise<GlassHiveNativeMediaRetainedSource[]>;
  isAccepted: (selector: NativeMediaAcceptedSelector) => Promise<boolean>;
  fenceAccepted: (
    reference: GlassHiveTerminalCallbackAcceptedOperationReference,
    session: ClientSession,
  ) => Promise<boolean>;
}

/** Current Main may select retained evidence, but only its original accepted owner/run grants. */
export async function resolveGlassHiveNativeMediaMessageSelection(
  { text, ownerId, conversationId }: { text: string; ownerId: string; conversationId: string },
  store: GlassHiveNativeMediaSourceStore,
) {
  const references = collectGlassHiveNativeMediaReferences(text);
  if (!references.length) return undefined;
  if (!ownerId || !conversationId) throw mediaError('native_media_authority_invalid');
  const rows = await store.readEvidence({
    ownerId,
    conversationId,
    $or: [
      { 'nativeMedia.observations.artifact_ref': { $in: references } },
      { 'nativeMedia.observations.download_url': { $in: references } },
      { 'nativeMedia.observations.open_url': { $in: references } },
    ],
  });
  for (const row of rows) {
    if (row.ownerId !== ownerId || row.conversationId !== conversationId)
      throw mediaError('native_media_authority_invalid');
  }
  const selected = new Map<string, GlassHiveNativeMediaSelection>();
  const projectedText = renderGlassHiveNativeMediaLinks(
    text,
    rows.map((row) => ({
      authority: { kind: 'durable_terminal_callback', runId: row.runId },
      nativeMedia: row.nativeMedia,
    })),
    {
      onSelection: (selection) =>
        selected.set(
          JSON.stringify([
            selection.run_id,
            selection.tool_call_id,
            selection.content_index,
            selection.artifact_ref,
          ]),
          selection,
        ),
    },
  );
  if (!selected.size) return undefined;
  const files = selectGlassHiveNativeMediaFiles([...selected.values()], rows, ownerId);
  const sources = rows.filter((row) => files.has(row.terminalCallbackId));
  const acceptedReferences: GlassHiveTerminalCallbackAcceptedOperationReference[] = [];
  for (const row of sources) {
    if (!nativeMediaCallbackSourceProof.safeParse(row).success)
      throw mediaError('native_media_authority_invalid');
    const accepted = await store.isAccepted({
      _id: row.terminalCallbackResultKey,
      ownerId,
      originRef: row.originRef,
      workRef: row.workRef,
      runId: row.runId,
      attemptNumber: row.attemptNumber,
      callbackId: row.terminalCallbackId,
      resultRevision: row.terminalCallbackResultRevision,
      resultDigest: row.terminalCallbackResultDigest,
      acceptedOperationId: row.terminalCallbackAcceptedOperationId,
      acceptedOperationGeneration: row.terminalCallbackEffectGeneration,
    });
    if (!accepted) throw mediaError('native_media_evidence_superseded');
    acceptedReferences.push({
      resultKey: row.terminalCallbackResultKey,
      callbackId: row.terminalCallbackId,
      acceptedOperationId: row.terminalCallbackAcceptedOperationId,
      generation: row.terminalCallbackEffectGeneration,
      resultRevision: row.terminalCallbackResultRevision,
      resultDigest: row.terminalCallbackResultDigest,
    });
  }
  return {
    rows: sources,
    selectedNativeMedia: [...selected.values()],
    projectedText,
    authorizePublication: async (session: ClientSession) => {
      for (const reference of acceptedReferences) {
        if (!(await store.fenceAccepted(reference, session)))
          throw mediaError('native_media_evidence_superseded');
      }
    },
  };
}

async function verifiedImage(
  item: GlassHiveNativeMedia['observations'][number],
  url: string,
  fetchImage: NativeOutputFileFetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchImage(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw mediaError('native_media_unavailable');
  }
  if (!response.ok || !response.body) throw mediaError('native_media_unavailable');
  const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const declaredLength = response.headers.get('content-length');
  if (
    mimeType !== item.mime_type ||
    (declaredLength != null && Number(declaredLength) !== item.bytes)
  ) {
    await response.body.cancel();
    throw mediaError('native_media_content_mismatch');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > item.bytes) throw mediaError('native_media_content_mismatch');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (size !== item.bytes || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
    throw mediaError('native_media_content_mismatch');
  }
  return `data:${item.mime_type};base64,${bytes.toString('base64')}`;
}

/** Evidence stays in model input. Only the model's authored reply is presented to the user. */
export async function buildGlassHiveNativeMediaContent(
  prompt: string,
  insights: readonly GlassHiveNativeMediaInsight[],
  {
    artifactBaseUrl = process.env.GLASSHIVE_ARTIFACT_BASE_URL || '',
    fetchImage,
    ownerId,
  }: { artifactBaseUrl?: string; fetchImage?: NativeOutputFileFetch; ownerId?: string } = {},
): Promise<string | MediaContent[]> {
  const content: MediaContent[] = [{ type: 'text', text: prompt }];
  let imageCount = 0;
  let totalBytes = 0;
  for (const insight of insights) {
    if (insight.runInput) {
      // Both accepted callback kinds carry bound input; media authority stays terminal-only below.
      if (insight.authority?.kind !== 'durable_terminal_callback' &&
          insight.authority?.kind !== 'durable_work_callback') {
        throw mediaError('mission_input_authority_invalid');
      }
      const runInput = normalizeGlassHiveRunInput(insight.runInput, insight.authority.runId || '');
      content.push({ type: 'text', text: JSON.stringify({ accepted_run_input: runInput }) });
    }
    if (!insight.nativeMedia) continue;
    if (insight.authority?.kind !== 'durable_terminal_callback') {
      throw mediaError('native_media_authority_invalid');
    }
    const media = normalizeGlassHiveNativeMedia(insight.nativeMedia, insight.authority.runId || '');
    if (!media) continue;
    imageCount += media.observations.length;
    totalBytes += media.observations.reduce((sum, item) => sum + item.bytes, 0);
    if (
      imageCount > GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES ||
      totalBytes > GLASSHIVE_NATIVE_MEDIA_MAX_BYTES
    ) {
      throw mediaError('native_media_capacity');
    }
    const observations = media.observations.map((item) => ({
      ...item,
      download_url: signedArtifactUrl(item.download_url, artifactBaseUrl),
      open_url: signedArtifactUrl(item.open_url, artifactBaseUrl),
    }));
    content.push({
      type: 'text',
      text: JSON.stringify({ native_media: { ...media, observations, visible_to_user: false } }),
    });
    const imageFetcher =
      fetchImage ||
      (ownerId
        ? createNativeOutputFileFetch(createAccountApiRoute({ ownerId }), artifactBaseUrl)
        : fetch);
    const urls = await Promise.all(
      observations.map((item) => verifiedImage(item, item.download_url, imageFetcher)),
    );
    content.push(...urls.map((url): MediaContent => ({ type: 'image_url', image_url: { url } })));
  }
  return content.length === 1 ? prompt : content;
}
/* === VIVENTIUM END === */
