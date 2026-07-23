/* === VIVENTIUM START ===
 * Feature: Connected Channels persistence readiness.
 * Purpose: Create only channel-owned indexes when global Mongo auto-indexing is disabled.
 * === VIVENTIUM END === */

const UNIQUE_KEYS = [
  ['ChannelConnection', ['channel']],
  ['ChannelConnection', ['callbackId']],
  [
    'ChannelThread',
    ['channel', 'accountId', 'externalConversationId', 'externalThreadId', 'libreChatUserId'],
  ],
  ['ChannelPairingCode', ['tokenHash']],
  ['ChannelPairingAttempt', ['scopeKey']],
  ['GatewayUserMapping', ['channel', 'accountId', 'externalUserId']],
  ['GatewayLinkToken', ['tokenHash']],
  ['ViventiumGatewayIngressEvent', ['dedupeKey']],
  ['ChannelWorkerLease', ['channel', 'accountId']],
  ['ChannelDelivery', ['dedupeKey']],
  ['ChannelIngressQuota', ['quotaKey']],
];

async function findDuplicate(model, fields) {
  const id = Object.fromEntries(fields.map((field) => [field, `$${field}`]));
  const duplicates = await model.aggregate([
    { $group: { _id: id, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 1 },
  ]);
  return duplicates.length > 0;
}

async function ensureChannelPersistenceIndexes(models) {
  for (const [name, fields] of UNIQUE_KEYS) {
    const model = models[name];
    if (!model) {
      throw new Error(`Channel persistence model is unavailable: ${name}`);
    }
    if (await findDuplicate(model, fields)) {
      const error = new Error(`Channel persistence has duplicate ${name} records`);
      error.code = 'channel_index_conflict';
      throw error;
    }
  }
  const names = [...new Set(UNIQUE_KEYS.map(([name]) => name))];
  for (const name of names) {
    await models[name].createIndexes();
  }
}

function createRetryableReadiness(initializer) {
  let cached;
  return function ensureReady() {
    if (!cached) {
      let attempt;
      attempt = Promise.resolve()
        .then(initializer)
        .catch((error) => {
          if (cached === attempt) {
            cached = undefined;
          }
          throw error;
        });
      cached = attempt;
    }
    return cached;
  };
}

function createChannelWorkerReconciler({
  reconcile,
  logger,
  setIntervalImpl = setInterval,
  intervalMs = 30_000,
}) {
  let timer;

  async function run(logMethod, message) {
    try {
      await reconcile();
    } catch (error) {
      logger[logMethod](message, { error: error?.name || 'Error' });
    }
  }

  return async function restoreChannelWorkers() {
    if (!timer) {
      timer = setIntervalImpl(() => {
        void run('warn', '[VIVENTIUM][channels] Worker reconciliation failed');
      }, intervalMs);
      timer.unref?.();
    }
    await run('error', '[VIVENTIUM][channels] Failed to restore channel workers after restart');
  };
}

module.exports = {
  createChannelWorkerReconciler,
  createRetryableReadiness,
  ensureChannelPersistenceIndexes,
};
