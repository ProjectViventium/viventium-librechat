import { ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessageContentParts } from 'librechat-data-provider';

export type RenderableContentInput =
  | Array<TMessageContentParts | string | null | undefined>
  | TMessageContentParts
  | string
  | null
  | undefined;

function textContentPart(text: string): TMessageContentParts {
  return {
    type: ContentTypes.TEXT,
    text,
    [ContentTypes.TEXT]: text,
  } as TMessageContentParts;
}

function normalizeContentPart(part: unknown): TMessageContentParts | undefined {
  if (part == null) {
    return undefined;
  }

  if (typeof part === 'string') {
    return textContentPart(part);
  }

  if (typeof part !== 'object') {
    return undefined;
  }

  const record = part as { type?: unknown; text?: unknown };
  if (typeof record.type === 'string') {
    return part as TMessageContentParts;
  }

  if (typeof record.text === 'string') {
    return textContentPart(record.text);
  }

  return undefined;
}

function normalizeRenderableContentParts(
  content: RenderableContentInput,
): Array<TMessageContentParts | undefined> | undefined {
  if (content == null) {
    return undefined;
  }

  if (!Array.isArray(content)) {
    const normalized = normalizeContentPart(content);
    return normalized ? [normalized] : [];
  }

  let changed = false;
  const normalized = content.map((part) => {
    const normalizedPart = normalizeContentPart(part);
    changed ||= normalizedPart !== part;
    return normalizedPart;
  });

  return changed ? normalized : (content as Array<TMessageContentParts | undefined>);
}

export function filterRenderableContentParts(
  content: RenderableContentInput,
): Array<TMessageContentParts | undefined> | undefined {
  const normalizedContent = normalizeRenderableContentParts(content);
  if (!normalizedContent || normalizedContent.length === 0) {
    return normalizedContent;
  }

  const lastToolCallIndexById = new Map<string, number>();
  normalizedContent.forEach((part, index) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return;
    }
    const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
    const toolCallId = toolCall?.id;
    if (typeof toolCallId === 'string' && toolCallId.length > 0) {
      lastToolCallIndexById.set(toolCallId, index);
    }
  });

  if (lastToolCallIndexById.size === 0) {
    return normalizedContent;
  }

  let removedAny = false;
  const filtered = normalizedContent.filter((part, index) => {
    if (part?.type !== ContentTypes.TOOL_CALL) {
      return true;
    }
    const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
    const toolCallId = toolCall?.id;
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      return true;
    }
    const keep = lastToolCallIndexById.get(toolCallId) === index;
    removedAny ||= !keep;
    return keep;
  });

  return removedAny ? filtered : normalizedContent;
}

// VIVENTIUM START
// Purpose: Keep Vite/HMR and older local module graphs compatible when this helper is imported as a default.
export default filterRenderableContentParts;
// VIVENTIUM END
