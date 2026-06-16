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

const RAW_TOOL_TRANSCRIPT_LINE_RE = /^\s*Tool:\s+(.*)$/i;
/* === VIVENTIUM START ===
 * Feature: User-facing GlassHive plumbing hygiene.
 * Purpose: Strip accidental raw GlassHive tool transcripts from assistant text while preserving
 * normal examples and visible product-language tool rows.
 * === VIVENTIUM END === */
const RAW_TOOL_XML_INVOKE_BLOCK_RE =
  /<(?:invoke|tool_call)\b[^>]*>[\s\S]*?<\/(?:invoke|tool_call)>/gi;
const RAW_TOOL_JSON_FENCE_RE =
  /```(?:json|tool|tool_call)?\s*\n\s*\{[\s\S]*?"(?:tool_call|tool|arguments|args)"[\s\S]*?\}\s*```/gi;
const GLASSHIVE_RAW_TOOL_NAMES = new Set([
  'workspace_launch',
  'workspace_schedule',
  'workspace_status',
  'workspace_wait',
  'workspace_continue',
  'workspace_pause',
  'workspace_resume',
  'workspace_terminate',
  'worker_delegate_once',
  'worker_create',
  'worker_find_or_resume',
  'worker_get',
  'worker_live',
  'worker_run',
  'worker_message',
  'worker_pause',
  'worker_resume',
  'worker_interrupt',
  'worker_terminate',
  'worker_desktop_action',
  'worker_takeover',
  'run_get',
  'projects_list',
  'workers_list',
  'workspace_artifacts',
  'workspace_artifact_download',
  'workspace_preferences_get',
  'workspace_preferences_set',
  'metrics_summary',
]);
const GLASSHIVE_RAW_TOOL_TOKEN_RE = /\b[A-Za-z0-9_.-]+\b/g;
const GLASSHIVE_MCP_SERVER_TOKEN = '_mcp_glasshive-workers-projects';

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

const RUNTIME_HOLD_TEXT_FLAG = 'viventium_runtime_hold';
const LATE_STREAM_TERMINATION_FLAG = 'viventium_late_stream_termination';
const RECOVERABLE_PROVIDER_ERROR_CLASSES = new Set([
  'late_stream_termination',
  'provider_rate_limited',
  'provider_temporarily_unavailable',
  'recoverable_provider_error',
]);

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

function sanitizeRawToolTranscriptText(value: string): string {
  if (!value) {
    return '';
  }
  let cleaned = value;
  cleaned = stripRawToolTranscriptLines(cleaned);
  cleaned = cleaned.replace(RAW_TOOL_XML_INVOKE_BLOCK_RE, (block) =>
    containsGlassHiveRawToolName(block) ? '' : block,
  );
  cleaned = cleaned.replace(RAW_TOOL_JSON_FENCE_RE, (block) =>
    containsGlassHiveRawToolName(block) ? '' : block,
  );
  if (cleaned === value) {
    return value;
  }
  return cleaned
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function containsGlassHiveRawToolName(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes(GLASSHIVE_MCP_SERVER_TOKEN)) {
    return true;
  }
  GLASSHIVE_RAW_TOOL_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = GLASSHIVE_RAW_TOOL_TOKEN_RE.exec(value)) != null) {
    if (GLASSHIVE_RAW_TOOL_NAMES.has(match[0].toLowerCase())) {
      return true;
    }
  }
  return false;
}

function stripRawToolTranscriptLines(value: string): string {
  const segments = value.match(/[^\r\n]*(?:\r?\n|$)/g) ?? [];
  const kept: string[] = [];
  for (const segment of segments) {
    if (!segment) {
      continue;
    }
    const newline = segment.match(/\r?\n$/)?.[0] ?? '';
    const line = newline ? segment.slice(0, -newline.length) : segment;
    const match = RAW_TOOL_TRANSCRIPT_LINE_RE.exec(line);
    if (match && containsGlassHiveRawToolName(match[1] ?? '')) {
      continue;
    }
    kept.push(segment);
  }
  return kept.join('');
}

function sanitizeRawToolTranscriptTextParts(
  content: Array<TMessageContentParts | undefined>,
): Array<TMessageContentParts | undefined> {
  let changed = false;
  const sanitized = content.map((part) => {
    const text = plainTextPartValue(part);
    if (text == null || !part) {
      return part;
    }
    const cleaned = sanitizeRawToolTranscriptText(text);
    if (cleaned === text) {
      return part;
    }
    changed = true;
    if (!cleaned.trim()) {
      return undefined;
    }
    return {
      ...part,
      text: cleaned,
      [ContentTypes.TEXT]: cleaned,
    } as TMessageContentParts;
  });
  return changed ? sanitized : content;
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

/* === VIVENTIUM START ===
 * Feature: Recovered provider-error card rendering.
 * Purpose: When a provider failure is already represented by visible assistant text, the chat UI
 * should not render a second fatal error card in the same assistant message.
 * === VIVENTIUM END === */
function isStructuredRecoverableProviderErrorPart(part: TMessageContentParts | undefined): boolean {
  if (!part || part.type !== ContentTypes.ERROR) {
    return false;
  }
  const record = part as unknown as Record<string, unknown>;
  const errorClass = String(record.error_class || record.errorClass || record.code || '')
    .trim()
    .toLowerCase();
  return RECOVERABLE_PROVIDER_ERROR_CLASSES.has(errorClass);
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

function hideRecoverableProviderErrorsAfterText(
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
    const keep = !isStructuredRecoverableProviderErrorPart(part);
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
  const withoutRawToolTranscriptText = sanitizeRawToolTranscriptTextParts(deduped);
  const withoutLateTerminationError = hideLateTerminationErrorAfterText(
    withoutRawToolTranscriptText,
    options,
  );
  const withoutRecoverableProviderErrors = hideRecoverableProviderErrorsAfterText(
    withoutLateTerminationError,
    options,
  );
  const withoutRuntimeHoldNoResponse = hideRuntimeHoldNoResponseParts(
    withoutRecoverableProviderErrors,
  );
  const collapsed = collapseConsecutiveGlassHiveToolCalls(withoutRuntimeHoldNoResponse);
  return mergeAdjacentTextParts(collapsed);
}

// VIVENTIUM START
// Purpose: Keep Vite/HMR and older local module graphs compatible when this helper is imported as a default.
export default filterRenderableContentParts;
// VIVENTIUM END
