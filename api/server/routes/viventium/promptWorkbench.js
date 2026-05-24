/* === VIVENTIUM START ===
 * Feature: Prompt Workbench local launcher route.
 * Purpose: Let local LibreChat admins open the standalone Prompt Workbench from the account menu
 * without hardcoding the managed workbench port in the browser bundle.
 * === VIVENTIUM END === */

const path = require('path');
const express = require('express');
const { execFile } = require('child_process');
const { isEnabled } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { checkAdmin, requireJwtAuth } = require('~/server/middleware');

const router = express.Router();
const COMMAND_TIMEOUT_MS = 120_000;
const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'SHELL',
  'TMPDIR',
  'USER',
  'VIVENTIUM_APP_SUPPORT_DIR',
  'VIVENTIUM_CONFIG_FILE',
  'VIVENTIUM_ENV_FILE',
  'VIVENTIUM_ENV_LOCAL_FILE',
  'VIVENTIUM_PROMPT_WORKBENCH_PORT',
  'VIVENTIUM_REPO_ROOT',
  'VIVENTIUM_RUNTIME_DIR',
];

function repoRoot() {
  if (process.env.VIVENTIUM_REPO_ROOT) {
    return path.resolve(process.env.VIVENTIUM_REPO_ROOT);
  }
  return path.resolve(__dirname, '../../../../../..');
}

function promptWorkbenchEnabled() {
  return (
    isEnabled(process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH) &&
    !isEnabled(process.env.VIVENTIUM_PROMPT_WORKBENCH_LINK_DISABLED)
  );
}

function promptWorkbenchChildEnv() {
  return CHILD_ENV_ALLOWLIST.reduce((env, key) => {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
    return env;
  }, {});
}

function parseJsonPayload(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function safeErrorMessage() {
  return 'Prompt Workbench could not be opened from this local runtime.';
}

async function runPromptWorkbench(action) {
  const root = repoRoot();
  const cliPath = path.join(root, 'bin', 'viventium');
  const stdout = await new Promise((resolve, reject) => {
    execFile(
      cliPath,
      ['prompt-workbench', action, '--json'],
      {
        cwd: root,
        env: promptWorkbenchChildEnv(),
        maxBuffer: 1024 * 1024,
        timeout: COMMAND_TIMEOUT_MS,
      },
      (error, commandStdout, commandStderr) => {
        if (error) {
          error.stderr = commandStderr;
          error.stdout = commandStdout;
          reject(error);
          return;
        }
        resolve(commandStdout);
      },
    );
  });
  const payload = parseJsonPayload(stdout);
  if (!payload) {
    throw new Error('prompt_workbench_invalid_response');
  }
  return payload;
}

async function promptWorkbenchHandler(action, res) {
  if (!promptWorkbenchEnabled()) {
    return res.status(404).json({ error: 'prompt_workbench_not_enabled' });
  }

  try {
    const payload = await runPromptWorkbench(action);
    if (payload.status === 'running' && payload.url) {
      return res.status(200).json({
        status: 'running',
        started: payload.started === true,
        url: payload.url,
      });
    }
    return res.status(200).json({ status: payload.status || 'stopped' });
  } catch (error) {
    logger.error('[Viventium][PromptWorkbench] Failed to resolve local workbench URL', {
      action,
      error: error?.message,
    });
    return res.status(500).json({
      error: 'prompt_workbench_unavailable',
      message: safeErrorMessage(),
    });
  }
}

router.get('/status', requireJwtAuth, checkAdmin, (_req, res) =>
  promptWorkbenchHandler('status', res),
);
router.post('/start', requireJwtAuth, checkAdmin, (_req, res) =>
  promptWorkbenchHandler('start', res),
);

module.exports = router;
