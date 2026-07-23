/* === VIVENTIUM START ===
 * Feature: Distributed channel worker ownership.
 * Purpose: Fence provider consumers and coordinate credential-generation handoff across processes.
 * === VIVENTIUM END === */

function createChannelWorkerLeaseTransport({
  transport,
  leaseModel,
  connectionModel,
  logger,
  ownerId,
  leaseMs = 45_000,
  renewMs = 15_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  const workers = new Map();
  const operationTails = new Map();

  function key(accountId) {
    return `${transport.channel}:${accountId}`;
  }

  function serialize(accountId, operation) {
    const workerKey = key(accountId);
    const prior = operationTails.get(workerKey) || Promise.resolve();
    const current = prior.catch(() => undefined).then(operation);
    operationTails.set(workerKey, current);
    return current.finally(() => {
      if (operationTails.get(workerKey) === current) {
        operationTails.delete(workerKey);
      }
    });
  }

  async function claim(connection) {
    const now = new Date();
    try {
      const lease = await leaseModel
        .findOneAndUpdate(
          {
            channel: connection.channel,
            accountId: connection.accountId,
            $or: [{ ownerId }, { expiresAt: { $lte: now } }],
          },
          {
            $set: {
              ownerId,
              configGeneration: connection.configGeneration || 'legacy',
              expiresAt: new Date(now.getTime() + leaseMs),
            },
          },
          { upsert: true, new: true, runValidators: true },
        )
        .lean();
      return lease?.ownerId === ownerId;
    } catch (error) {
      if (Number(error?.code) === 11000) {
        return false;
      }
      throw error;
    }
  }

  async function release(accountId, worker, stopTransport = true) {
    const workerKey = key(accountId);
    if (worker) {
      if (workers.get(workerKey) !== worker) {
        return false;
      }
      clearIntervalImpl(worker.timer);
      workers.delete(workerKey);
    }
    if (stopTransport) {
      await transport.stop(accountId).catch(() => undefined);
    }
    await leaseModel.deleteOne({
      channel: transport.channel,
      accountId,
      ownerId,
      ...(worker?.generation ? { configGeneration: worker.generation } : {}),
    });
    return true;
  }

  async function renew(connection, worker) {
    try {
      const record = await connectionModel
        .findOne({ channel: connection.channel, accountId: connection.accountId })
        .select('state configGeneration')
        .lean();
      const expectedGeneration = connection.configGeneration || 'legacy';
      const persistedGeneration = record?.configGeneration || 'legacy';
      const allowedState =
        worker.phase === 'starting'
          ? ['verifying', 'connected'].includes(record?.state)
          : record?.state === 'connected';
      if (!allowedState || persistedGeneration !== expectedGeneration) {
        worker.revoked = true;
        await serialize(connection.accountId, () => release(connection.accountId, worker));
        return;
      }
      const renewed = await leaseModel.updateOne(
        {
          channel: connection.channel,
          accountId: connection.accountId,
          ownerId,
          configGeneration: expectedGeneration,
        },
        { $set: { expiresAt: new Date(Date.now() + leaseMs) } },
      );
      if (!renewed.matchedCount) {
        worker.revoked = true;
        await serialize(connection.accountId, () => release(connection.accountId, worker));
      }
    } catch (error) {
      worker.revoked = true;
      await serialize(connection.accountId, () => release(connection.accountId, worker)).catch(
        () => undefined,
      );
      logger.warn('[VIVENTIUM][channels] Worker lease renewal failed', {
        channel: connection.channel,
        error: error?.name || 'Error',
      });
    }
  }

  async function canReuseWorker(connection, generation) {
    const record = await connectionModel
      .findOne({ channel: connection.channel, accountId: connection.accountId })
      .select('state configGeneration')
      .lean();
    const persistedGeneration = record?.configGeneration || 'legacy';
    return persistedGeneration === generation && ['verifying', 'connected'].includes(record?.state);
  }

  return {
    channel: transport.channel,
    test: (connection) => transport.test(connection),
    send: (message) => transport.send(message),
    async start(connection, options = {}) {
      return await serialize(connection.accountId, async () => {
        const workerKey = key(connection.accountId);
        const generation = connection.configGeneration || 'legacy';
        const existing = workers.get(workerKey);
        if (existing && options.mode !== 'replace' && existing.generation === generation) {
          if (await canReuseWorker(connection, generation)) {
            return true;
          }
        }
        if (existing) {
          await release(connection.accountId, existing);
        }
        if (!(await claim(connection))) {
          return false;
        }
        const worker = { generation, phase: 'starting', revoked: false, timer: null };
        worker.timer = setIntervalImpl(() => void renew(connection, worker), renewMs);
        worker.timer?.unref?.();
        workers.set(workerKey, worker);
        try {
          await transport.start(connection);
        } catch (error) {
          await release(connection.accountId, worker);
          throw error;
        }
        if (workers.get(workerKey) !== worker || worker.revoked) {
          await release(connection.accountId, worker);
          return false;
        }
        worker.phase = 'running';
        return true;
      });
    },
    async stop(accountId, expectedGeneration) {
      await serialize(accountId, () => {
        const worker = workers.get(key(accountId));
        if (expectedGeneration && worker?.generation !== expectedGeneration) {
          return false;
        }
        return release(accountId, worker);
      });
    },
  };
}

module.exports = { createChannelWorkerLeaseTransport };
