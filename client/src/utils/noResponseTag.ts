/* === VIVENTIUM START ===
 * Feature: No Response Tag ({NTA}) client-side filtering
 *
 * Purpose:
 * - Hide internal passive/background "nothing to add" messages from the web UI.
 * - Keep checks strict (exact-match) to avoid hiding legitimate content that references the tag.
 *
 * Added: 2026-02-07
 * === VIVENTIUM END === */

import type { TMessage } from 'librechat-data-provider';
import { ContentTypes } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';

export const NO_RESPONSE_TAG = '{NTA}';

const NO_RESPONSE_TAG_RE = /^\s*\{\s*NTA\s*\}\s*$/i;
const NO_RESPONSE_PHRASES = new Set([
  'nothing new to add.',
  'nothing new to add',
  'nothing to add.',
  'nothing to add',
]);
const NO_RESPONSE_VARIANT_MAX_LEN = 200;
// Accept short, "no-response-only" variants like "Nothing new to add for now."
// Must be the entire message (not a prefix), to avoid suppressing real content.
const NO_RESPONSE_VARIANT_RE =
  /^\s*nothing\s+(?:new\s+)?to\s+add(?:\s*(?:\(\s*)?(?:right\s+now|for\s+now|at\s+this\s+time|at\s+the\s+moment|currently|so\s+far|yet|today)(?:\s*\))?)?(?:\s*,?\s*(?:sorry|thanks|thank\s+you))?\s*[.!?]*\s*$/i;
const BREW_PROMPT_MARKER = 'viv_internal:brew_begin';
const BREW_PROMPT_HEADER = 'Background Processing (Brewing)';
const BREW_NTA_PLACEHOLDER = '-';

export type NoResponseFilterOptions = {
  brewNoResponsePlaceholder?: string | false;
};

export function isNoResponseOnlyText(text?: string | null): boolean {
  if (typeof text !== 'string') {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (NO_RESPONSE_TAG_RE.test(trimmed)) {
    return true;
  }
  const lowered = trimmed.toLowerCase();
  if (NO_RESPONSE_PHRASES.has(lowered)) {
    return true;
  }
  if (trimmed.length <= NO_RESPONSE_VARIANT_MAX_LEN && NO_RESPONSE_VARIANT_RE.test(trimmed)) {
    return true;
  }
  return false;
}

function _unwrapTextValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { value?: unknown }).value === 'string'
  ) {
    return (value as { value: string }).value;
  }
  return '';
}

function _extractTextFromContent(parts?: TMessageContentParts[] | null): string {
  if (!Array.isArray(parts) || parts.length === 0) {
    return '';
  }

  const out: string[] = [];
  for (const part of parts) {
    if (!part) {
      continue;
    }
    // Some messages store their visible text only in structured content parts.
    if (part.type === ContentTypes.TEXT || part.type === ContentTypes.ERROR) {
      const raw = (part as { text?: unknown }).text;
      const unwrapped = _unwrapTextValue(raw);
      if (unwrapped) {
        out.push(unwrapped);
      }
    }
  }
  return out.join('');
}

function _extractVisibleText(message?: TMessage | null): string {
  if (!message) {
    return '';
  }
  const directText = typeof message.text === 'string' ? message.text : '';
  const contentText = _extractTextFromContent(
    message.content as TMessageContentParts[] | undefined,
  );
  return `${directText}\n${contentText}`.trim();
}

function _isBrewPromptMessage(message?: TMessage | null): boolean {
  if (!message) {
    return false;
  }
  const text = _extractVisibleText(message);
  if (!text) {
    return false;
  }
  return text.includes(BREW_PROMPT_MARKER) || text.includes(BREW_PROMPT_HEADER);
}

function _toBrewNoResponsePlaceholder(
  message: TMessage,
  children: TMessage[] | undefined,
  placeholderText: string,
): TMessage {
  return {
    ...message,
    text: placeholderText,
    content: [
      {
        type: ContentTypes.TEXT,
        text: placeholderText,
      },
    ],
    children: children ?? [],
  };
}

export function isNoResponseMessage(message?: TMessage | null): boolean {
  if (!message) {
    return false;
  }
  if (message.isCreatedByUser) {
    return false;
  }

  const directText = typeof message.text === 'string' ? message.text : '';
  const contentText = _extractTextFromContent(
    message.content as TMessageContentParts[] | undefined,
  );

  // Prefer suppressing only when the FULL visible output is "no-response-only".
  if (isNoResponseOnlyText(directText)) {
    // Guard against edge cases where `text` is stale but content has real text.
    return !contentText || isNoResponseOnlyText(contentText);
  }
  if (!directText.trim() && isNoResponseOnlyText(contentText)) {
    return true;
  }
  return false;
}

function _filterNoResponseMessagesTree(
  messagesTree?: TMessage[] | null,
  options?: NoResponseFilterOptions,
  parent?: TMessage | null,
): TMessage[] | null {
  if (!messagesTree) {
    return messagesTree ?? null;
  }

  const showBrewNoResponsePlaceholder = options?.brewNoResponsePlaceholder !== false;
  const placeholderText =
    typeof options?.brewNoResponsePlaceholder === 'string' &&
    options.brewNoResponsePlaceholder.trim()
      ? options.brewNoResponsePlaceholder.trim()
      : BREW_NTA_PLACEHOLDER;

  let changed = false;
  const out: TMessage[] = [];

  for (const msg of messagesTree) {
    const children = Array.isArray(msg.children) ? msg.children : [];
    const nextChildren = _filterNoResponseMessagesTree(children, options, msg) ?? [];

    if (isNoResponseMessage(msg)) {
      changed = true;
      if (showBrewNoResponsePlaceholder && _isBrewPromptMessage(parent)) {
        out.push(_toBrewNoResponsePlaceholder(msg, nextChildren, placeholderText));
      } else if (nextChildren.length > 0) {
        out.push(...nextChildren);
      }
      continue;
    }

    if (nextChildren !== children) {
      changed = true;
      out.push({
        ...msg,
        children: nextChildren,
      });
      continue;
    }

    out.push(msg);
  }

  return changed ? out : messagesTree;
}

/**
 * Recursively remove internal no-response messages from a messages tree.
 *
 * The backend stores background follow-ups as real messages for persistence/auditability.
 * The UI should treat `{NTA}` as "silence" and not render it.
 */
export function filterNoResponseMessagesTree(
  messagesTree?: TMessage[] | null,
  options: NoResponseFilterOptions = { brewNoResponsePlaceholder: false },
): TMessage[] | null {
  return _filterNoResponseMessagesTree(messagesTree, options);
}
