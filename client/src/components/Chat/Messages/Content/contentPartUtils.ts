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

function plainTextPartValue(part: TMessageContentParts | undefined): string | undefined {
  if (!part || part.type !== ContentTypes.TEXT || part.tool_call_ids != null) {
    return undefined;
  }

  if (typeof part.text === 'string') {
    return part.text;
  }

  const textValue = (part as unknown as { text?: { value?: unknown } }).text?.value;
  return typeof textValue === 'string' ? textValue : undefined;
}

function mergeAdjacentTextParts(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  let changed = false;
  const merged: Array<TMessageContentParts | undefined> = [];

  content.forEach((part) => {
    const text = plainTextPartValue(part);
    const previous = merged[merged.length - 1];
    const previousText = plainTextPartValue(previous);

    if (text != null && previousText != null && previous) {
      const combined = `${previousText}${text}`;
      merged[merged.length - 1] = {
        ...previous,
        text: combined,
        [ContentTypes.TEXT]: combined,
      } as TMessageContentParts;
      changed = true;
      return;
    }

    merged.push(part);
  });

  return changed ? merged : content;
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

  const deduped = removedAny ? filtered : normalizedContent;
  return mergeAdjacentTextParts(deduped);
}

// VIVENTIUM START
// Purpose: Keep Vite/HMR and older local module graphs compatible when this helper is imported as a default.
export default filterRenderableContentParts;
// VIVENTIUM END
