import { Constants, ContentTypes } from 'librechat-data-provider';
import type { Agents, TMessageContentParts } from 'librechat-data-provider';
import { isNoResponseOnlyText } from '~/utils/noResponseTag';
import { GLASSHIVE_MCP_SERVER_NAME } from '~/utils/viventiumGlassHive';

export type RenderableContentInput =
  | Array<TMessageContentParts | string | null | undefined>
  | TMessageContentParts
  | string
  | null
  | undefined;

type FilterRenderableContentPartsOptions = {
  visibleFallbackText?: string | null;
};

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

function toolCallOutput(part: TMessageContentParts | undefined): string {
  if (part?.type !== ContentTypes.TOOL_CALL) {
    return '';
  }
  const toolCall = part[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
  return typeof toolCall?.output === 'string' ? toolCall.output : '';
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch (_error) {
    return undefined;
  }
}

function parseGlassHiveToolOutput(part: TMessageContentParts | undefined): Record<string, unknown> {
  const direct = parseJsonObject(toolCallOutput(part).trim());
  if (direct) {
    return direct;
  }

  try {
    const wrapped = JSON.parse(toolCallOutput(part).trim());
    if (!Array.isArray(wrapped)) {
      return {};
    }
    for (const entry of wrapped) {
      const text = (entry as { text?: unknown })?.text;
      if (typeof text !== 'string') {
        continue;
      }
      const parsedText = parseJsonObject(text.trim());
      if (parsedText) {
        return parsedText;
      }
    }
  } catch (_error) {
    return {};
  }

  return {};
}

function isRoutineGlassHiveDelegatePart(part: TMessageContentParts | undefined): boolean {
  if (glassHiveToolName(part) !== 'worker_delegate_once') {
    return false;
  }
  const output = parseGlassHiveToolOutput(part);
  return output.status === 'dispatched' && output.callback_ready === true;
}

const RUNTIME_HOLD_TEXT_FLAG = 'viventium_runtime_hold';
const LATE_STREAM_TERMINATION_FLAG = 'viventium_late_stream_termination';

function textPartValue(part: TMessageContentParts | undefined): string {
  if (!part || part.type !== ContentTypes.TEXT) {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  const textValue = (part as unknown as { text?: { value?: unknown } }).text?.value;
  return typeof textValue === 'string' ? textValue : '';
}

function errorPartValue(part: TMessageContentParts | undefined): string {
  if (!part || part.type !== ContentTypes.ERROR) {
    return '';
  }
  const errorValue = (part as unknown as Record<string, unknown>)[ContentTypes.ERROR];
  if (typeof errorValue === 'string') {
    return errorValue;
  }
  const textValue = (part as unknown as { text?: unknown }).text;
  if (typeof textValue === 'string') {
    return textValue;
  }
  const nestedTextValue = (part as unknown as { text?: { value?: unknown } }).text?.value;
  return typeof nestedTextValue === 'string' ? nestedTextValue : '';
}

function isLateStreamTerminationErrorPart(part: TMessageContentParts | undefined): boolean {
  const record = part as unknown as Record<string, unknown>;
  if (
    record?.[LATE_STREAM_TERMINATION_FLAG] === true ||
    record?.error_class === 'late_stream_termination' ||
    record?.errorClass === 'late_stream_termination'
  ) {
    return true;
  }
  const message = errorPartValue(part).trim().toLowerCase();
  return (
    message === 'terminated' ||
    message === 'an error occurred while processing the request: terminated'
  );
}

function hasVisibleAssistantTextPart(content: Array<TMessageContentParts | undefined>): boolean {
  return content.some((part) => {
    if (!part || part.type !== ContentTypes.TEXT || part.tool_call_ids != null) {
      return false;
    }
    if ((part as unknown as Record<string, unknown>)[RUNTIME_HOLD_TEXT_FLAG] === true) {
      return false;
    }
    return textPartValue(part).trim().length > 0;
  });
}

function hasVisibleFallbackAssistantText(value: string | null | undefined): boolean {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 && !isNoResponseOnlyText(text);
}

function hideLateTerminationErrorAfterText(
  content: Array<TMessageContentParts | undefined>,
  options: FilterRenderableContentPartsOptions = {},
): Array<TMessageContentParts | undefined> {
  if (
    !hasVisibleAssistantTextPart(content) &&
    !hasVisibleFallbackAssistantText(options.visibleFallbackText)
  ) {
    return content;
  }

  let changed = false;
  const filtered = content.filter((part) => {
    const keep = !isLateStreamTerminationErrorPart(part);
    changed ||= !keep;
    return keep;
  });
  return changed ? filtered : content;
}

function isRuntimeHoldNoResponsePart(part: TMessageContentParts | undefined): boolean {
  return (
    part != null &&
    part.type === ContentTypes.TEXT &&
    (part as unknown as Record<string, unknown>)[RUNTIME_HOLD_TEXT_FLAG] === true &&
    isNoResponseOnlyText(textPartValue(part))
  );
}

function hideRuntimeHoldNoResponseParts(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  let changed = false;
  const filtered = content.filter((part) => {
    const keep = !isRuntimeHoldNoResponsePart(part);
    changed ||= !keep;
    return keep;
  });
  return changed ? filtered : content;
}

function hideRoutineGlassHiveDelegateParts(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  if (!hasVisibleAssistantTextPart(content)) {
    return content;
  }

  let changed = false;
  const filtered = content.filter((part) => {
    const keep = !isRoutineGlassHiveDelegatePart(part);
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
    const currentGlassHiveToolName = glassHiveToolName(part);
    const previousGlassHiveToolName = glassHiveToolName(previous);
    const currentToolCall = part?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
    const previousToolCall = previous?.[ContentTypes.TOOL_CALL] as Agents.ToolCall | undefined;
    const currentToolCallId = currentToolCall?.id;
    const previousToolCallId = previousToolCall?.id;
    const hasDistinctToolCallIds =
      typeof currentToolCallId === 'string' &&
      currentToolCallId.length > 0 &&
      typeof previousToolCallId === 'string' &&
      previousToolCallId.length > 0 &&
      currentToolCallId !== previousToolCallId;
    if (
      currentGlassHiveToolName != null &&
      previousGlassHiveToolName != null &&
      currentGlassHiveToolName === previousGlassHiveToolName &&
      !hasDistinctToolCallIds
    ) {
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
  options: FilterRenderableContentPartsOptions = {},
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
  const withoutLateTerminationError = hideLateTerminationErrorAfterText(deduped, options);
  const withoutRuntimeHoldNoResponse = hideRuntimeHoldNoResponseParts(withoutLateTerminationError);
  const withoutRoutineGlassHiveDelegate = hideRoutineGlassHiveDelegateParts(
    withoutRuntimeHoldNoResponse,
  );
  const collapsed = collapseConsecutiveGlassHiveToolCalls(withoutRoutineGlassHiveDelegate);
  return mergeAdjacentTextParts(collapsed);
}

// VIVENTIUM START
// Purpose: Keep Vite/HMR and older local module graphs compatible when this helper is imported as a default.
export default filterRenderableContentParts;
// VIVENTIUM END
