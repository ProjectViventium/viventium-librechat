import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';

/* === VIVENTIUM START ===
 * The native hydrated-media formatter needs authored text as a string. Keep its media bytes and
 * unknown content intact; the existing legacy coercer owns persisted text shapes.
 */
type HydratedUserMessage = Pick<Partial<TMessage>, 'sender'> & {
  role?: string;
  content?:
    | string
    | readonly (
        | string
        | {
            type?: string;
            text?: unknown;
            input_text?: unknown;
            output_text?: unknown;
          }
      )[];
  image_urls?: readonly object[];
  documents?: readonly object[];
  audios?: readonly object[];
  videos?: readonly object[];
};
const nativeMediaFields = {
  image_url: 'image_urls',
  file: 'documents',
  input_audio: 'audios',
  video: 'videos',
} as const;
type NativeMediaField = (typeof nativeMediaFields)[keyof typeof nativeMediaFields];

export function normalizeHydratedMediaText<T extends HydratedUserMessage | null | undefined>(
  message: T,
  coerceText: (text: unknown) => string,
): T {
  const role =
    message?.role ??
    (typeof message?.sender === 'string' && message.sender.toLowerCase() === 'user'
      ? 'user'
      : 'assistant');
  if (
    role !== 'user' ||
    !Array.isArray(message?.content) ||
    ![message.image_urls, message.documents, message.audios, message.videos].some(
      (media) => media?.length,
    )
  ) {
    return message;
  }
  const text: string[] = [];
  const carried: Partial<Pick<HydratedUserMessage, NativeMediaField>> = {};
  for (const part of message.content) {
    if (typeof part === 'string') {
      if (part) text.push(part);
      continue;
    }
    if (![ContentTypes.TEXT, 'input_text', 'output_text'].includes(part?.type)) {
      if (!Object.prototype.hasOwnProperty.call(nativeMediaFields, part?.type ?? '')) return message;
      const field = nativeMediaFields[part?.type as keyof typeof nativeMediaFields];
      if (!field || !part || typeof part !== 'object') return message;
      const media = carried[field] ?? message[field] ?? [];
      const bytes = JSON.stringify(part);
      if (!media.some((item) => item === part || JSON.stringify(item) === bytes)) {
        carried[field] = [...media, part];
      }
      continue;
    }
    const value = coerceText(part.text ?? part.input_text ?? part.output_text);
    if (value) text.push(value);
  }
  return { ...message, ...carried, content: text.join('\n') };
}
/* === VIVENTIUM END === */

/**
 * Filters out malformed tool call content parts that don't have the required tool_call property.
 * This handles edge cases where tool_call content parts may be created with only a type property
 * but missing the actual tool_call data.
 *
 * It also collapses duplicate streamed snapshots for the same tool_call.id, keeping the latest
 * snapshot. Tool streams can emit partial argument snapshots before the final output-bearing part;
 * rendering every snapshot after completion makes stale partials look like separate cancelled calls.
 *
 * @param contentParts - Array of content parts to filter
 * @returns Filtered array with malformed tool calls removed and duplicate snapshots collapsed
 *
 * @example
 * // Removes malformed tool_call without the tool_call property
 * const parts = [
 *   { type: 'tool_call', tool_call: { id: '123', name: 'test' } }, // valid - kept
 *   { type: 'tool_call' }, // invalid - filtered out
 *   { type: 'text', text: 'Hello' }, // valid - kept (other types pass through)
 * ];
 * const filtered = filterMalformedContentParts(parts);
 * // Returns all parts except the malformed tool_call
 */
export function filterMalformedContentParts(
  contentParts: TMessageContentParts[],
): TMessageContentParts[];
export function filterMalformedContentParts<T>(contentParts: T): T;
export function filterMalformedContentParts<T>(
  contentParts: T | TMessageContentParts[],
): T | TMessageContentParts[] {
  if (!Array.isArray(contentParts)) {
    return contentParts;
  }

  const filtered = contentParts.filter((part) => {
    if (!part || typeof part !== 'object') {
      return false;
    }

    const { type } = part;

    if (type === ContentTypes.TOOL_CALL) {
      return 'tool_call' in part && part.tool_call != null && typeof part.tool_call === 'object';
    }

    if (type === ContentTypes.THINK) {
      return typeof part.think === 'string' && part.think.trim().length > 0;
    }

    return true;
  });

  const lastToolCallIndexById = new Map<string, number>();
  for (let index = 0; index < filtered.length; index++) {
    const part = filtered[index];
    if (part?.type !== ContentTypes.TOOL_CALL) {
      continue;
    }
    const toolCallId = part.tool_call?.id;
    if (typeof toolCallId === 'string' && toolCallId.length > 0) {
      lastToolCallIndexById.set(toolCallId, index);
    }
  }

  if (lastToolCallIndexById.size === 0) {
    return filtered;
  }

  return filtered.filter((part, index) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return true;
    }
    const toolCallId = part.tool_call?.id;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return true;
    }
    return lastToolCallIndexById.get(toolCallId) === index;
  });
}

/* === VIVENTIUM START ===
 * Feature: Shared harness activity projection.
 * Purpose: A proven harness caller uses legacy think parts for activity summaries. Preserve the
 *          existing in-place conversion across ordinary finalization and native recovery.
 */
export function convertHarnessActivityParts<T>(contentParts: T): T {
  if (!Array.isArray(contentParts)) return contentParts;
  for (let index = 0; index < contentParts.length; index++) {
    const part = contentParts[index] as
      { type?: string; think?: string | { value?: string } } | null | undefined;
    if (part?.type !== ContentTypes.THINK) continue;
    contentParts[index] = {
      type: ContentTypes.HARNESS_ACTIVITY,
      harness_activity: {
        event: 'reasoning-summary',
        summary: typeof part.think === 'string' ? part.think : String(part.think?.value || ''),
      },
    };
  }
  return contentParts;
}
/* === VIVENTIUM END === */
