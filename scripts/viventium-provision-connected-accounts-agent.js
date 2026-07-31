#!/usr/bin/env node
'use strict';

/* === VIVENTIUM START ===
 * Feature: Canonical managed-agent provisioning compatibility entrypoint.
 * Purpose: Keep older operational invocations working without duplicating agent models, prompts,
 * tools, permissions, or edges outside the source-of-truth bundle and canonical seed path.
 * === VIVENTIUM END === */
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SEED_SCRIPT = path.join(__dirname, 'viventium-seed-agents.js');
const DEFAULT_BUNDLE_PATH = path.join(
  ROOT_DIR,
  'viventium',
  'source_of_truth',
  'local.viventium-agents.yaml',
);

function buildProvisionArgs({ argv = process.argv.slice(2), env = process.env } = {}) {
  const args = [SEED_SCRIPT, ...argv];
  const hasOwnerSelection = argv.some(
    (arg) => arg.startsWith('--owner-id=') || arg.startsWith('--email='),
  );
  const ownerId = String(env.VIVENTIUM_PROVISION_OWNER_ID || '').trim();
  if (!hasOwnerSelection && ownerId) {
    args.push(`--owner-id=${ownerId}`);
  }
  if (!argv.some((arg) => arg.startsWith('--bundle='))) {
    args.push(`--bundle=${DEFAULT_BUNDLE_PATH}`);
  }
  if (!argv.some((arg) => arg.startsWith('--managed-baseline='))) {
    const appSupportDir = String(
      env.VIVENTIUM_APP_SUPPORT_DIR ||
        path.join(os.homedir(), 'Library', 'Application Support', 'Viventium'),
    ).trim();
    args.push(
      `--managed-baseline=${path.join(appSupportDir, 'state', 'agent-managed-baseline.json')}`,
    );
  }
  return args;
}

function runProvision() {
  const child = spawn(process.execPath, buildProvisionArgs(), {
    env: process.env,
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error(
      '[viventium-provision-connected-accounts-agent] canonical seeder could not start:',
      error.message,
    );
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = Number.isInteger(code) ? code : 1;
  });
  return child;
}

if (require.main === module) {
  runProvision();
}

module.exports = {
  DEFAULT_BUNDLE_PATH,
  buildProvisionArgs,
  runProvision,
};
