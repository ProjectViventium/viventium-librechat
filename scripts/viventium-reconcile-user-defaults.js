#!/usr/bin/env node
/* === VIVENTIUM START ===
 * Reconcile installer-managed user defaults into fresh local accounts.
 * Purpose: clean-machine users can register after runtime config was compiled. When their
 * conversation-recall preference has never been written, seed it from the generated installer
 * contract without overwriting later user edits.
 * === VIVENTIUM END === */
'use strict';

const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const { loadLocalRuntimeEnv } = require('./viventium-runtime-env');

loadLocalRuntimeEnv(ROOT_DIR);
require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });

const { connectDb } = require('../api/db/connect');
const { User } = require('../api/db/models');

function envFlagEnabled(name, { env = process.env } = {}) {
  const normalized = String(env[name] ?? '')
    .trim()
    .toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function buildMissingConversationRecallUpdate({ env = process.env } = {}) {
  const desired = envFlagEnabled('VIVENTIUM_DEFAULT_CONVERSATION_RECALL', { env });
  return {
    conversation_recall: desired,
    filter: {
      $or: [
        { personalization: { $exists: false } },
        { 'personalization.conversation_recall': { $exists: false } },
        /* === VIVENTIUM START ===
         * Only accounts that never wrote the preference receive the installer default. A stored
         * `false` is left alone even when no explicit-choice marker exists: older accounts could
         * have opted out before the marker existed, and consent must never be overwritten by a
         * default.
         * === VIVENTIUM END === */
      ],
    },
    update: {
      $set: {
        'personalization.conversation_recall': desired,
      },
    },
  };
}

async function reconcileUserDefaults({ env = process.env } = {}) {
  const { conversation_recall, filter, update } = buildMissingConversationRecallUpdate({ env });
  await connectDb();
  const result = await User.updateMany(filter, update);

  return {
    conversation_recall,
    matchedCount: result?.matchedCount ?? result?.n ?? 0,
    modifiedCount: result?.modifiedCount ?? result?.nModified ?? 0,
  };
}

async function closeDbConnection() {
  const mongoose = require('mongoose');
  const { ioredisClient, keyvRedisClient } = require('@librechat/api');
  // connectDb imports the API barrel, which also opens cache sockets. This one-shot
  // command must release all of its connections before native startup can continue.
  const closed = await Promise.allSettled([
    Promise.resolve().then(() => mongoose.connection?.readyState === 1 && mongoose.disconnect()),
    Promise.resolve().then(() => ioredisClient?.disconnect()),
    Promise.resolve().then(() => keyvRedisClient?.isOpen && keyvRedisClient.disconnect()),
  ]);
  const failed = closed.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
}

async function run() {
  const summary = await reconcileUserDefaults();
  process.stdout.write(
    JSON.stringify({
      action: 'reconcile-user-defaults',
      ...summary,
    }),
  );
}

if (require.main === module) {
  run()
    .then(() => closeDbConnection())
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error || 'Unknown error');
      process.stderr.write(`${message}\n`);
      try {
        await closeDbConnection();
      } catch (closeError) {
        const closeMessage =
          closeError instanceof Error ? closeError.message : String(closeError || 'Unknown error');
        process.stderr.write(`${closeMessage}\n`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  envFlagEnabled,
  buildMissingConversationRecallUpdate,
  reconcileUserDefaults,
  closeDbConnection,
};
