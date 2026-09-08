/* === VIVENTIUM START ===
 * Optional LIFE setup uses the same owner as the Mac helper. Source choices are intent only.
 * === VIVENTIUM END === */
const express = require('express');
const { z } = require('zod');
const { runLifeSetup } = require('@librechat/api');
const { checkAdmin, requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
router.use(requireJwtAuth, checkAdmin);
const intentSchema = z.object({ text: z.string().min(1).max(2000) }).strict();
const enabledSchema = z.object({ enabled: z.boolean() }).strict();

async function respond(res, action, text) {
  try {
    return res.json(await runLifeSetup(action, text));
  } catch {
    return res.status(409).json({
      error: 'life_setup_unavailable',
      message: 'Life settings are unavailable. Open Life on your Mac to check the folder.',
    });
  }
}

router.get('/setup', (_req, res) => respond(res, 'status'));
router.post('/setup', express.json({ limit: '8kb' }), (req, res) => {
  const parsed = enabledSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_life_setting' });
  }
  return respond(res, parsed.data.enabled ? 'enable' : 'disable');
});
router.post('/intent', express.json({ limit: '8kb' }), (req, res) => {
  const parsed = intentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_intent' });
  }
  return respond(res, 'save', parsed.data.text);
});
router.delete('/intent', (_req, res) => respond(res, 'clear'));
module.exports = router;
