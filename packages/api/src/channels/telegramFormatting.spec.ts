/**
 * === VIVENTIUM START ===
 * Feature: Telegram-safe Agent output.
 * Purpose: Preserve common Agent Markdown without exposing placeholders or invalid table syntax.
 * === VIVENTIUM END ===
 */

import { renderTelegramMarkdown, splitTelegramText } from './telegramFormatting';

describe('Telegram formatting', () => {
  it('renders nested inline code inside emphasis without leaking internal placeholders', () => {
    const rendered = renderTelegramMarkdown('**Use `x < y` safely**');

    expect(rendered).toBe('<b>Use <code>x &lt; y</code> safely</b>');
    expect(rendered).not.toContain('\u0000');
  });

  it('turns Markdown tables into readable Telegram-safe rows', () => {
    const rendered = renderTelegramMarkdown(
      '| Channel | State |\n| --- | --- |\n| Telegram | Ready |',
    );

    expect(rendered).toContain('• <b>Channel:</b> Telegram; <b>State:</b> Ready');
    expect(rendered).not.toContain('| --- |');
  });

  it('preserves every Unicode code point while preferring readable boundaries', () => {
    const input = `${'a'.repeat(3499)} 😀 paragraph\n\nnext`;
    const chunks = splitTelegramText(input);

    expect(chunks.join('')).toBe(input);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 3500)).toBe(true);
  });

  it('does not trim meaningful leading or trailing whitespace from plain replies', () => {
    expect(renderTelegramMarkdown(' leading text\n')).toBe(' leading text\n');
  });
});
