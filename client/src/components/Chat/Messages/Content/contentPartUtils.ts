import { Constants, ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessageContentParts } from 'librechat-data-provider';
import { GLASSHIVE_MCP_SERVER_NAME } from '~/utils/viventiumGlassHive';

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

function glassHiveToolName(part: TMessageContentParts | undefined): string | undefined {
  if (part?.type !== ContentTypes.TOOL_CALL) {
    return undefined;
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
  const name = typeof toolCall?.name === 'string' ? toolCall.name : '';
  if (!name.includes(Constants.mcp_delimiter)) {
    return undefined;
  }
  const [toolName, serverName] = name.split(Constants.mcp_delimiter);
  return serverName === GLASSHIVE_MCP_SERVER_NAME ? toolName : undefined;
}

function isGlassHiveToolCall(part: TMessageContentParts | undefined): boolean {
  return glassHiveToolName(part) != null;
}

function isRoutineGlassHiveDelegateToolCall(part: TMessageContentParts | undefined): boolean {
  return glassHiveToolName(part) === 'worker_delegate_once';
}

function parseGlassHiveToolOutput(rawOutput: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(rawOutput) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (Array.isArray(parsed)) {
      const textEnvelope = parsed.find((item) => {
        return (
          item &&
          typeof item === 'object' &&
          (item as { type?: unknown; text?: unknown }).type === ContentTypes.TEXT &&
          typeof (item as { text?: unknown }).text === 'string'
        );
      }) as { text?: string } | undefined;
      if (textEnvelope?.text) {
        const nested = JSON.parse(textEnvelope.text) as unknown;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          return nested as Record<string, unknown>;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function routineGlassHiveDelegateCanBeHidden(part: TMessageContentParts | undefined): boolean {
  if (!isRoutineGlassHiveDelegateToolCall(part)) {
    return false;
  }
  const toolCall = part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
  const rawOutput = typeof toolCall?.output === 'string' ? toolCall.output.trim() : '';
  if (!rawOutput) {
    return false;
  }
  const parsed = parseGlassHiveToolOutput(rawOutput);
  return parsed?.status === 'dispatched' && parsed?.callback_ready === true;
}

function hideRoutineGlassHiveDelegateToolCalls(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  let changed = false;
  const filtered = content.filter((part) => {
    const keep = !routineGlassHiveDelegateCanBeHidden(part);
    changed ||= !keep;
    return keep;
  });
  return changed ? filtered : content;
}

function collapseConsecutiveGlassHiveToolCalls(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  let changed = false;
  const collapsed: Array<TMessageContentParts | undefined> = [];

  content.forEach((part) => {
    const previous = collapsed[collapsed.length - 1];
    if (isGlassHiveToolCall(part) && isGlassHiveToolCall(previous)) {
      collapsed[collapsed.length - 1] = part;
      changed = true;
      return;
    }
    collapsed.push(part);
  });

  return changed ? collapsed : content;
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
  const withoutRoutineDelegation = hideRoutineGlassHiveDelegateToolCalls(deduped);
  const collapsed = collapseConsecutiveGlassHiveToolCalls(withoutRoutineDelegation);
  return mergeAdjacentTextParts(collapsed);
}

// VIVENTIUM START
// Purpose: Keep Vite/HMR and older local module graphs compatible when this helper is imported as a default.
export default filterRenderableContentParts;
// VIVENTIUM END
