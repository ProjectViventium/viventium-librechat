/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Shared Telegram admin notifier
 *
 * Responsibilities:
 * - Send admin notifications to Telegram (registration approvals, credits requests)
 * - Support optional inline keyboard buttons
 * - Fail softly (never break user-facing flows on notification errors)
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const fetch = require('node-fetch');
const { logger } = require('@librechat/data-schemas');

function getNotifierConfig() {
  return {
    token: (process.env.VIVENTIUM_ADMIN_TELEGRAM_BOT_TOKEN || '').trim(),
    chatId: (process.env.VIVENTIUM_ADMIN_TELEGRAM_CHAT_ID || '').trim(),
  };
}

async function sendAdminMessage({ text, parseMode, inlineKeyboard } = {}) {
  const { token, chatId } = getNotifierConfig();
  if (!token || !chatId || !text) {
    return false;
  }

  const payload = {
    chat_id: chatId,
    text: String(text),
    disable_web_page_preview: true,
  };

  if (parseMode) {
    payload.parse_mode = parseMode;
  }

  if (Array.isArray(inlineKeyboard) && inlineKeyboard.length > 0) {
    payload.reply_markup = {
      inline_keyboard: inlineKeyboard,
    };
  }

  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      logger.warn('[VIVENTIUM][telegramNotifier] Telegram request failed', {
        status: response.status,
        responseText,
      });
      return false;
    }

    const body = await response.json().catch(() => ({}));
    if (body?.ok !== true) {
      logger.warn('[VIVENTIUM][telegramNotifier] Telegram API returned ok=false', body);
      return false;
    }
    return true;
  } catch (error) {
    logger.warn('[VIVENTIUM][telegramNotifier] Failed to send Telegram admin notification', error);
    return false;
  }
}

module.exports = {
  sendAdminMessage,
};
