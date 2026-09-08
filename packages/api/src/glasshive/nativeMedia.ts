/* === VIVENTIUM START === Verified native image evidence for existing Main synthesis. === */
import { createHash } from 'crypto';
import { z } from 'zod';
import { normalizeGlassHiveRunInput } from './missionInput';
import type { GlassHiveRunInput } from './missionInput';

export const GLASSHIVE_NATIVE_MEDIA_MAX_IMAGES = 24;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
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

/** Resolve model-selected input references through this synthesis's verified artifact scope. */
export function renderGlassHiveNativeMediaLinks(
  text: string,
  insights: readonly GlassHiveNativeMediaInsight[],
  { artifactBaseUrl = process.env.GLASSHIVE_ARTIFACT_BASE_URL || '' } = {},
): string {
  if (!text.includes('artifact_sha256:')) return text;
  const links = new Map<string, string>();
  for (const insight of insights) {
    if (!insight.nativeMedia) continue;
    if (insight.authority?.kind !== 'durable_terminal_callback') {
      throw mediaError('native_media_authority_invalid');
    }
    const media = normalizeGlassHiveNativeMedia(insight.nativeMedia, insight.authority.runId || '');
    for (const item of media?.observations || []) {
      links.set(item.artifact_ref, signedArtifactUrl(item.download_url, artifactBaseUrl));
    }
  }
  return text.replace(
    /(!?\[(?:\\.|[^\]\r\n])*\])\(\s*<?(artifact_sha256:[^<>\s()]*)>?\s*\)/g,
    (_match, label: string, reference: string) => {
      const url = links.get(reference);
      if (!url) throw mediaError('native_media_selection_unavailable');
      return `${label}(${url})`;
    },
  );
}

async function verifiedImage(
  item: GlassHiveNativeMedia['observations'][number],
  url: string,
  fetchImage: typeof fetch,
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
    fetchImage = fetch,
  }: { artifactBaseUrl?: string; fetchImage?: typeof fetch } = {},
): Promise<string | MediaContent[]> {
  const content: MediaContent[] = [{ type: 'text', text: prompt }];
  let imageCount = 0;
  let totalBytes = 0;
  for (const insight of insights) {
    if (insight.runInput) {
      if (insight.authority?.kind !== 'durable_terminal_callback') {
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
    for (const item of observations) {
      const url = await verifiedImage(item, item.download_url, fetchImage);
      content.push({ type: 'image_url', image_url: { url } });
    }
  }
  return content.length === 1 ? prompt : content;
}
/* === VIVENTIUM END === */
