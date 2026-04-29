import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

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
