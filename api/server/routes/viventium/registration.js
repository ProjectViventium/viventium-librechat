/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Registration approval decision endpoint
 *
 * Endpoint:
 * - GET /api/viventium/registration/decision?token=...&action=approve|deny
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { applyRegistrationDecision } = require('~/server/services/viventium/registrationApprovalService');

const router = express.Router();

function renderHtml({ title, message }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
      .card { max-width: 720px; margin: 64px auto; padding: 24px; border-radius: 12px; background: #111827; border: 1px solid #1f2937; }
      h1 { font-size: 22px; margin: 0 0 12px; }
      p { margin: 0; line-height: 1.5; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${message}</p>
    </div>
  </body>
</html>`;
}

router.get('/decision', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const action = typeof req.query.action === 'string' ? req.query.action : '';
  if (!token || !action) {
    return res
      .status(400)
      .type('html')
      .send(
        renderHtml({
          title: 'Invalid Request',
          message: 'Missing token or action.',
        }),
      );
  }

  try {
    const result = await applyRegistrationDecision({ token, action });
    return res
      .status(200)
      .type('html')
      .send(
        renderHtml({
          title: 'Decision Applied',
          message: `User ${result.userId} marked as ${result.status}.`,
        }),
      );
  } catch (error) {
    logger.warn('[VIVENTIUM][registration] Failed to apply decision', error);
    return res
      .status(400)
      .type('html')
      .send(
        renderHtml({
          title: 'Decision Failed',
          message: error?.message || 'Could not process decision.',
        }),
      );
  }
});

module.exports = router;
