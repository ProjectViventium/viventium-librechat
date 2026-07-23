/**
 * === VIVENTIUM START ===
 * Feature: Telegram-safe Agent output.
 * Purpose: Reuse the proven Viventium Telegram HTML strategy with Unicode-safe chunking.
 * === VIVENTIUM END ===
 */

const TELEGRAM_PRACTICAL_LIMIT = 3500;

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}

function splitTableRow(line: string): string[] {
  let normalized = line.trim();
  if (!normalized.includes('|')) {
    return [];
  }
  normalized = normalized.replace(/^\|/, '').replace(/\|$/, '');
  const cells = normalized.split('|').map((cell) => cell.trim());
  return cells.some(Boolean) ? cells : [];
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
}

function convertMarkdownTables(input: string): string {
  const lines = input.split('\n');
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const headers = splitTableRow(lines[index]);
    if (headers.length > 0 && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      let rowIndex = index + 2;
      let emitted = false;
      while (rowIndex < lines.length) {
        const row = splitTableRow(lines[rowIndex]);
        if (row.length === 0 || isTableSeparator(lines[rowIndex])) {
          break;
        }
        const parts = row.flatMap((cell, cellIndex) => {
          if (!cell) {
            return [];
          }
          const heading = headers[cellIndex] || `Column ${cellIndex + 1}`;
          return [`**${heading}:** ${cell}`];
        });
        if (parts.length > 0) {
          output.push(`- ${parts.join('; ')}`);
          emitted = true;
        }
        rowIndex += 1;
      }
      if (emitted) {
        index = rowIndex;
        continue;
      }
    }
    output.push(lines[index]);
    index += 1;
  }
  return output.join('\n');
}

export function renderTelegramMarkdown(input: string): string {
  if (!input) {
    return '';
  }
  const placeholders = new Map<string, string>();
  let placeholderIndex = 0;
  const store = (html: string): string => {
    const key = `\u0000VIVENTIUM_TELEGRAM_${placeholderIndex}\u0000`;
    placeholderIndex += 1;
    placeholders.set(key, html);
    return key;
  };

  let result = input
    .replace(/```([\w-]*)\n([\s\S]*?)```/g, (_match, language: string, code: string) => {
      const className = language ? ` class="language-${escapeAttribute(language)}"` : '';
      return store(`<pre><code${className}>${escapeHtml(code)}</code></pre>`);
    })
    .replace(/`([^`\n]+?)`/g, (_match, code: string) => store(`<code>${escapeHtml(code)}</code>`))
    .replace(/!?\[([^\]]*)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      store(`<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`),
    );

  result = escapeHtml(convertMarkdownTables(result))
    .replace(/\*\*(.+?)\*\*/gs, (_match, value: string) => store(`<b>${value}</b>`))
    .replace(/~~(.+?)~~/gs, (_match, value: string) => store(`<s>${value}</s>`))
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, (_match, value: string) =>
      store(`<i>${value}</i>`),
    )
    .replace(/^#{1,6}\s+(.+)$/gm, (_match, heading: string) => store(`<b>${heading}</b>`))
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/^---+$/gm, '─────────────────');

  for (const [key, html] of [...placeholders].reverse()) {
    result = result.replaceAll(key, html);
  }
  return result.replace(/\n{3,}/g, '\n\n');
}

export function stripTelegramHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

export function splitTelegramText(input: string, maximum = TELEGRAM_PRACTICAL_LIMIT): string[] {
  if (!input) {
    return [];
  }
  const codePoints = Array.from(input);
  if (codePoints.length <= maximum) {
    return [input];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < codePoints.length) {
    let end = Math.min(start + maximum, codePoints.length);
    if (end < codePoints.length) {
      const minimumBoundary = start + Math.floor(maximum / 2);
      const candidates = ['\n\n', '\n', '. ', ' '];
      const window = codePoints.slice(start, end).join('');
      for (const candidate of candidates) {
        const boundary = window.lastIndexOf(candidate);
        if (boundary >= 0) {
          const boundaryLength = Array.from(window.slice(0, boundary + candidate.length)).length;
          if (start + boundaryLength >= minimumBoundary) {
            end = start + boundaryLength;
            break;
          }
        }
      }
    }
    chunks.push(codePoints.slice(start, end).join(''));
    start = end;
  }
  return chunks;
}
