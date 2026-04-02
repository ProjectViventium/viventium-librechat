/* === VIVENTIUM START ===
 * Feature: Telegram account linking endpoint
 *
 * Route:
 * - GET /api/viventium/telegram/link/:token
 *   -> Links the Telegram user for this token to the currently logged-in LibreChat user.
 * === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { getUserById } = require('~/models');
const {
  resolveUserIdFromCookies,
  consumeLinkToken,
  upsertTelegramMapping,
} = require('~/server/services/TelegramLinkService');

const router = express.Router();

function renderLinkResult({ ok, message }) {
  const status = ok ? 'Linked' : 'Link failed';
  const body = message || (ok ? 'Your Telegram account is now linked.' : 'Unable to link.');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${status}</title>
  </head>
  <body>
    <h2>${status}</h2>
    <p>${body}</p>
    <p>You can return to Telegram.</p>
  </body>
</html>`;
}

router.get('/link/:token', async (req, res) => {
  try {
    const token = typeof req.params.token === 'string' ? req.params.token.trim() : '';
    if (!token) {
      return res.status(400).send(renderLinkResult({ ok: false, message: 'Invalid link.' }));
    }

    const userId = resolveUserIdFromCookies(req);
    if (!userId) {
      return res
        .status(401)
        .send(
          renderLinkResult({
            ok: false,
            message: 'Please log in to LibreChat, then reopen this link.',
          }),
        );
    }

    const user = await getUserById(userId, '-password -__v -totpSecret -backupCodes');
    if (!user) {
      return res.status(401).send(renderLinkResult({ ok: false, message: 'User not found.' }));
    }

    const linkToken = await consumeLinkToken(token);
    if (!linkToken) {
      return res
        .status(400)
        .send(
          renderLinkResult({ ok: false, message: 'This link has expired or was already used.' }),
        );
    }

    await upsertTelegramMapping({
      telegramUserId: linkToken.telegramUserId,
      libreChatUserId: user._id,
      telegramUsername: linkToken.telegramUsername,
    });

    return res.status(200).send(renderLinkResult({ ok: true }));
  } catch (err) {
    logger.error('[VIVENTIUM][telegram/link] Failed to link Telegram account:', err);
    return res
      .status(500)
      .send(renderLinkResult({ ok: false, message: 'Unexpected error linking account.' }));
  }
});

module.exports = router;
