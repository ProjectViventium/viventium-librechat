'use strict';

const fs = require('fs');
const path = require('path');

const RECEIPT_RELATIVE_PATH = path.join('state', 'continuity', 'postcommit-api-finalization.json');
const REQUIRED_STAGES = Object.freeze([
  'database-connected',
  'database-seed-ready',
  'startup-checks-ready',
  'interface-permissions-ready',
  'mcp-runtime-ready',
  'oauth-reconnect-ready',
  'channel-persistence-ready',
  'permission-migration-inspection',
  'stale-cortex-recovery',
  'generation-runtime-ready',
]);
const DERIVED_SEARCH_DEGRADED = Object.freeze({
  stage: 'derived-search-index',
  code: 'best-effort-derived-state',
});
const RUN_ID_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_ID_PATTERN = /^[0-9a-f]{40,64}$/;

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value || '')
      .trim()
      .toLowerCase(),
  );
}

function createUpgradeFinalization({ env = process.env } = {}) {
  const runId = String(env.VIVENTIUM_POSTCOMMIT_FINALIZATION_ID || '').trim();
  const sourceId = String(env.VIVENTIUM_POSTCOMMIT_SOURCE_ID || '').trim();
  const appSupportDir = String(env.VIVENTIUM_APP_SUPPORT_DIR || '').trim();
  const quiesced = enabled(env.VIVENTIUM_QUIESCED_API_STARTUP);
  const armed = Boolean(runId || sourceId);

  if (armed) {
    if (!RUN_ID_PATTERN.test(runId) || !SOURCE_ID_PATTERN.test(sourceId)) {
      throw new Error('Post-commit API finalization identity is incomplete or invalid');
    }
    if (!path.isAbsolute(appSupportDir)) {
      throw new Error('Post-commit API finalization requires an absolute App Support directory');
    }
  }

  const receiptPath = armed ? path.join(appSupportDir, RECEIPT_RELATIVE_PATH) : '';
  let state = null;

  function assertOwnedDirectory(directory, { create = false } = {}) {
    if (create) {
      try {
        fs.mkdirSync(directory, { mode: 0o700 });
      } catch (error) {
        if (error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    const metadata = fs.lstatSync(directory);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isDirectory() ||
      (metadata.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
      throw new Error('Post-commit API finalization directory is unsafe');
    }
  }

  function ensureReceiptDirectory() {
    assertOwnedDirectory(appSupportDir);
    const stateDir = path.join(appSupportDir, 'state');
    assertOwnedDirectory(stateDir, { create: true });
    const continuityDir = path.join(stateDir, 'continuity');
    assertOwnedDirectory(continuityDir, { create: true });
    return continuityDir;
  }

  function readReceipt() {
    if (!armed) {
      return null;
    }
    let metadata;
    try {
      metadata = fs.lstatSync(receiptPath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
      throw new Error('Post-commit API finalization receipt is unsafe');
    }
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    } catch (_error) {
      throw new Error('Post-commit API finalization receipt is unreadable');
    }
    if (!payload || payload.schemaVersion !== 1) {
      throw new Error('Post-commit API finalization receipt is invalid');
    }
    return payload;
  }

  function writeReceipt(payload) {
    const directory = ensureReceiptDirectory();
    readReceipt();
    const temporaryPath = path.join(
      directory,
      `.postcommit-api-finalization.${process.pid}.${Date.now()}.tmp`,
    );
    const removeTemporary = () => {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
    };
    let descriptor;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, receiptPath);
      fs.chmodSync(receiptPath, 0o600);
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    } finally {
      if (descriptor !== undefined) {
        fs.closeSync(descriptor);
      }
      removeTemporary();
    }
  }

  function beginAttempt() {
    if (!armed) {
      return 0;
    }
    const previous = readReceipt();
    const sameRun = previous?.runId === runId && previous?.sourceId === sourceId;
    const previousAttempt =
      sameRun && Number.isSafeInteger(previous?.attempt) && previous.attempt > 0
        ? previous.attempt
        : 0;
    state = {
      schemaVersion: 1,
      runId,
      sourceId,
      status: 'running',
      stage: 'starting',
      attempt: previousAttempt + 1,
      completed: [],
      degraded: [{ ...DERIVED_SEARCH_DEGRADED }],
    };
    writeReceipt(state);
    return state.attempt;
  }

  function recordCompleted(stage) {
    if (!armed) {
      return;
    }
    if (!state) {
      throw new Error('Post-commit API finalization attempt has not started');
    }
    if (!REQUIRED_STAGES.includes(stage)) {
      throw new Error('Unknown post-commit API finalization stage');
    }
    const firstMissing = REQUIRED_STAGES.find((required) => !state.completed.includes(required));
    if (firstMissing !== stage) {
      throw new Error('Post-commit API finalization stage order is invalid');
    }
    state = {
      ...state,
      stage,
      completed: [...state.completed, stage],
    };
    writeReceipt(state);
  }

  function markFailed(_error) {
    if (!armed) {
      return;
    }
    if (!state) {
      beginAttempt();
    }
    const failedStage =
      REQUIRED_STAGES.find((required) => !state.completed.includes(required)) || 'ready';
    state = {
      ...state,
      status: 'failed',
      stage: failedStage,
      failure: {
        code: 'required-stage-failed',
        stage: failedStage,
      },
    };
    writeReceipt(state);
  }

  function markReady() {
    if (!armed) {
      return;
    }
    if (!state || REQUIRED_STAGES.some((stage) => !state.completed.includes(stage))) {
      throw new Error('Post-commit API finalization cannot become ready before every stage');
    }
    state = {
      ...state,
      status: 'ready',
      stage: 'ready',
    };
    delete state.failure;
    writeReceipt(state);
  }

  function isReady() {
    if (!armed) {
      return true;
    }
    if (state) {
      return Boolean(
        state.status === 'ready' &&
        state.stage === 'ready' &&
        REQUIRED_STAGES.every((stage) => state.completed.includes(stage)),
      );
    }
    const receipt = readReceipt();
    return Boolean(
      receipt &&
      receipt.runId === runId &&
      receipt.sourceId === sourceId &&
      receipt.status === 'ready' &&
      receipt.stage === 'ready' &&
      REQUIRED_STAGES.every((stage) => receipt.completed?.includes(stage)),
    );
  }

  function health(_req, res) {
    if (armed && !isReady()) {
      return res.status(503).send('STARTING');
    }
    return res.status(200).send('OK');
  }

  function requireReady(_req, res, next) {
    if (quiesced) {
      return res.status(503).json({
        code: 'viventium_startup_quiesced',
        status: 'starting',
      });
    }
    if (armed && !isReady()) {
      return res.status(503).json({
        code: 'viventium_postcommit_finalization_pending',
        status: 'starting',
      });
    }
    return next();
  }

  return Object.freeze({
    beginAttempt,
    health,
    isArmed: () => armed,
    isQuiesced: () => quiesced,
    isReady,
    markFailed,
    markReady,
    recordCompleted,
    requireReady,
  });
}

const upgradeFinalization = createUpgradeFinalization();

module.exports = {
  ...upgradeFinalization,
  DERIVED_SEARCH_DEGRADED,
  RECEIPT_RELATIVE_PATH,
  REQUIRED_STAGES,
  createUpgradeFinalization,
};
