/* === VIVENTIUM START ===
 * Feature: One truthful visible-text projection for structured assistant content.
 * Purpose: Keep participant and invocation boundaries in legacy text, recall, exports, and
 * provider-history consumers without changing the exact text of an ordinary single-part answer.
 * === VIVENTIUM END === */

export const VISIBLE_CONTENT_SEPARATOR = '\n\n';

export interface VisibleContentTextValue {
  value?: string;
  text?: string;
}

export interface VisibleContentPart {
  type?: string;
  text?: string | VisibleContentTextValue;
}

export function textFromVisibleContentPart(part?: VisibleContentPart | null): string {
  if (part?.type !== 'text') {
    return '';
  }
  if (typeof part.text === 'string') {
    return part.text;
  }
  if (typeof part.text?.value === 'string') {
    return part.text.value;
  }
  if (typeof part.text?.text === 'string') {
    return part.text.text;
  }
  return '';
}

export function visibleTextSegmentsFromContentParts(
  content?: readonly VisibleContentPart[] | null,
): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(textFromVisibleContentPart).filter((text) => text.trim().length > 0);
}

export function projectVisibleTextFromContentParts(
  content?: readonly VisibleContentPart[] | null,
  { trim = false }: { trim?: boolean } = {},
): string {
  const projected = visibleTextSegmentsFromContentParts(content).join(VISIBLE_CONTENT_SEPARATOR);
  return trim ? projected.trim() : projected;
}
