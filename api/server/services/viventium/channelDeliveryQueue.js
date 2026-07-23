/* === VIVENTIUM START ===
 * Feature: Durable staged channel delivery queue.
 * Purpose: Serialize turns, persist replies before egress, and fence ambiguous provider delivery.
 * === VIVENTIUM END === */

const crypto = require('crypto');

function partitionKeyForEnvelope(envelope) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        envelope.channel,
        envelope.accountId,
        envelope.externalUserId,
        envelope.externalConversationId,
        envelope.externalThreadId,
      ]),
    )
    .digest('hex');
}

class ChannelDeliveryQueue {
  constructor({
    model,
    dedupe,
    logger,
    getConnectionState = async () => 'connected',
    admit = async (envelope) => envelope,
    rateLimiter,
    validateAuthorization = async () => true,
    pollMs = 1000,
    lockMs = 60 * 1000,
    heartbeatMs = 15 * 1000,
    maxConcurrentPartitions = 4,
    maxClaimCandidates = 100,
    maxAttempts,
    maxAgentAttempts = maxAttempts ?? 3,
    maxDeliveryAttempts = maxAttempts ?? 288,
  }) {
    this.model = model;
    this.dedupe = dedupe;
    this.logger = logger;
    this.getConnectionState = getConnectionState;
    this.admit = admit;
    this.rateLimiter = rateLimiter;
    this.validateAuthorization = validateAuthorization;
    this.pollMs = pollMs;
    this.lockMs = lockMs;
    this.heartbeatMs = heartbeatMs;
    this.maxConcurrentPartitions = maxConcurrentPartitions;
    this.maxClaimCandidates = maxClaimCandidates;
    this.maxAgentAttempts = Math.max(1, maxAgentAttempts);
    this.maxDeliveryAttempts = Math.max(1, maxDeliveryAttempts);
    this.consumers = new Map();
  }

  async enqueue(envelope) {
    const admittedEnvelope = await this.admit(envelope);
    const dedupeKey = this.dedupe(admittedEnvelope);
    if (typeof this.model.exists === 'function' && (await this.model.exists({ dedupeKey }))) {
      return { accepted: true, notify: false };
    }
    const quota = await this.rateLimiter?.reserve(admittedEnvelope, dedupeKey);
    if (quota && !quota.accepted) {
      return {
        ...quota,
        replyText: quota.notify
          ? 'Too many messages right now. Wait a few minutes, then try again.'
          : '',
      };
    }
    const now = new Date();
    const partitionKey = partitionKeyForEnvelope(admittedEnvelope);
    await this.model.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          dedupeKey,
          channel: admittedEnvelope.channel,
          accountId: admittedEnvelope.accountId,
          partitionKey,
          envelope: admittedEnvelope,
          state: 'inbound_pending',
          attempts: 0,
          nextAttemptAt: now,
          expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
        },
      },
      { upsert: true },
    );
    return { accepted: true, notify: false };
  }

  async markExpiredSendingUncertain(channel, accountId, processor) {
    const delivery = await this.model
      .findOneAndUpdate(
        { channel, accountId, state: 'egress_sending', lockedUntil: { $lte: new Date() } },
        {
          $set: {
            state: 'delivery_uncertain',
            lockedUntil: null,
            lockToken: null,
            lastErrorCode: 'delivery_uncertain',
          },
        },
        { new: true, sort: { createdAt: 1 } },
      )
      .lean();
    if (delivery) {
      await processor.onUncertain?.(delivery.envelope);
    }
  }

  async claim(channel, accountId, activePartitions = new Set()) {
    const now = new Date();
    const match = {
      channel,
      accountId,
      state: { $in: ['inbound_pending', 'agent_processing', 'reply_ready', 'egress_sending'] },
      ...(activePartitions.size ? { partitionKey: { $nin: [...activePartitions] } } : {}),
    };
    const candidates = await this.model.aggregate([
      { $match: match },
      { $sort: { partitionKey: 1, createdAt: 1, _id: 1 } },
      { $group: { _id: '$partitionKey', delivery: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$delivery' } },
      {
        $match: {
          state: { $ne: 'egress_sending' },
          $and: [
            { $or: [{ nextAttemptAt: { $exists: false } }, { nextAttemptAt: { $lte: now } }] },
            {
              $or: [
                { lockToken: null },
                { lockToken: { $exists: false } },
                { lockedUntil: { $lte: now } },
              ],
            },
          ],
        },
      },
      { $sort: { createdAt: 1, _id: 1 } },
      { $limit: this.maxClaimCandidates },
    ]);
    for (const oldest of candidates) {
      const partitionKey = oldest.partitionKey || partitionKeyForEnvelope(oldest.envelope || {});
      if (
        activePartitions.has(partitionKey) ||
        oldest.state === 'egress_sending' ||
        (oldest.nextAttemptAt && oldest.nextAttemptAt > now) ||
        (oldest.lockToken && oldest.lockedUntil && oldest.lockedUntil > now)
      ) {
        continue;
      }
      const lockToken = crypto.randomUUID();
      const nextState = oldest.state === 'reply_ready' ? 'reply_ready' : 'agent_processing';
      const delivery = await this.model
        .findOneAndUpdate(
          {
            _id: oldest._id,
            state: oldest.state,
            $or: [
              { lockToken: null },
              { lockToken: { $exists: false } },
              { lockedUntil: { $lte: now } },
            ],
          },
          {
            $set: {
              lockedUntil: new Date(now.getTime() + this.lockMs),
              lockToken,
              partitionKey,
              state: nextState,
            },
            $inc: { attempts: 1 },
          },
          { new: true },
        )
        .lean();
      if (delivery) {
        return { delivery, lockToken, partitionKey };
      }
    }
    return null;
  }

  heartbeat(claimState, deliveryId, lockToken) {
    const timer = setInterval(() => {
      void this.model
        .updateOne(
          {
            _id: deliveryId,
            lockToken,
            state: { $in: ['agent_processing', 'reply_ready', 'egress_sending'] },
          },
          { $set: { lockedUntil: new Date(Date.now() + this.lockMs) } },
        )
        .then((result) => {
          if (!result.matchedCount) {
            claimState.lost = true;
            clearInterval(timer);
          }
        })
        .catch(() => {
          claimState.lost = true;
          clearInterval(timer);
        });
    }, this.heartbeatMs);
    timer.unref?.();
    return timer;
  }

  retryDelay(attempts) {
    return Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(attempts || 1, 8));
  }

  retryUpdate(delivery, state, errorCode, extra = {}) {
    const attemptLimit =
      errorCode === 'agent_processing_failed' ? this.maxAgentAttempts : this.maxDeliveryAttempts;
    if ((delivery.attempts || 0) >= attemptLimit) {
      return {
        $set: {
          state: 'cancelled',
          envelope: null,
          replyText: null,
          lockedUntil: null,
          lockToken: null,
          lastErrorCode: `${errorCode}_retry_exhausted`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          ...extra,
        },
      };
    }
    return {
      $set: {
        state,
        lockedUntil: null,
        lockToken: null,
        nextAttemptAt: new Date(Date.now() + this.retryDelay(delivery.attempts)),
        lastErrorCode: errorCode,
        ...extra,
      },
    };
  }

  async processClaim(consumer, claim) {
    const { delivery, lockToken } = claim;
    const claimState = { lost: false };
    const heartbeat = this.heartbeat(claimState, delivery._id, lockToken);
    let replyPersisted = delivery.state === 'reply_ready';
    try {
      let replyText = delivery.replyText;
      let authorizationChanged = false;
      if (delivery.state === 'agent_processing') {
        authorizationChanged = !(await this.validateAuthorization(delivery.envelope));
        if (authorizationChanged) {
          replyText = 'Your channel account link changed. Please send that message again.';
        } else {
          const reply = await consumer.processor.prepare(delivery.envelope);
          replyText = typeof reply?.text === 'string' ? reply.text : '';
        }
        const persisted = await this.model.updateOne(
          { _id: delivery._id, lockToken, state: 'agent_processing' },
          {
            $set: {
              state: 'reply_ready',
              replyText,
              lockedUntil: new Date(Date.now() + this.lockMs),
              lastErrorCode: authorizationChanged ? 'authorization_changed' : null,
            },
          },
        );
        if (!persisted.matchedCount) {
          return;
        }
        replyPersisted = true;
      }

      if (claimState.lost) {
        return;
      }
      const connectionState = await this.getConnectionState(delivery.channel, delivery.accountId);
      if (connectionState === 'disconnected' || !connectionState) {
        await this.model.updateOne(
          { _id: delivery._id, lockToken },
          {
            $set: {
              state: 'cancelled',
              lockedUntil: null,
              lockToken: null,
              lastErrorCode: 'connection_stopped',
            },
          },
        );
        return;
      }
      if (consumer.stopRequested) {
        await this.model.updateOne(
          { _id: delivery._id, lockToken, state: 'reply_ready' },
          {
            $set: {
              lockedUntil: null,
              lockToken: null,
              nextAttemptAt: new Date(),
              lastErrorCode: 'worker_handoff',
            },
          },
        );
        return;
      }
      if (connectionState !== 'connected') {
        await this.model.updateOne(
          { _id: delivery._id, lockToken, state: 'reply_ready' },
          this.retryUpdate(delivery, 'reply_ready', 'repair_required'),
        );
        return;
      }
      if (!(await this.validateAuthorization(delivery.envelope))) {
        authorizationChanged = true;
        replyText = 'Your channel account link changed. Please send that message again.';
        const sanitized = await this.model.updateOne(
          { _id: delivery._id, lockToken, state: 'reply_ready' },
          { $set: { replyText, lastErrorCode: 'authorization_changed' } },
        );
        if (!sanitized.matchedCount) {
          return;
        }
      }

      const sending = await this.model.updateOne(
        { _id: delivery._id, lockToken, state: 'reply_ready' },
        { $set: { state: 'egress_sending', lockedUntil: new Date(Date.now() + this.lockMs) } },
      );
      if (!sending.matchedCount) {
        return;
      }
      let providerResult;
      try {
        providerResult = await consumer.processor.send(
          delivery.envelope,
          replyText || '',
          delivery.egressCursor || 0,
        );
      } catch (error) {
        const providerResponded = error?.providerResponded === true;
        const confirmedChunks = Number.isFinite(error?.confirmedChunks)
          ? error.confirmedChunks
          : delivery.egressCursor || 0;
        let uncertainTransitionWon = false;
        if (authorizationChanged) {
          await this.model.updateOne(
            { _id: delivery._id, lockToken, state: 'egress_sending' },
            {
              $set: {
                state: 'cancelled',
                envelope: null,
                replyText: null,
                lockedUntil: null,
                lockToken: null,
                lastErrorCode: 'authorization_changed_delivery_failed',
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
              },
            },
          );
        } else {
          const transition = await this.model.updateOne(
            { _id: delivery._id, lockToken, state: 'egress_sending' },
            providerResponded
              ? this.retryUpdate(delivery, 'reply_ready', 'provider_rejected', {
                  egressCursor: confirmedChunks,
                })
              : {
                  $set: {
                    state: 'delivery_uncertain',
                    lockedUntil: null,
                    lockToken: null,
                    lastErrorCode: 'delivery_uncertain',
                  },
                },
          );
          uncertainTransitionWon = !providerResponded && transition.matchedCount > 0;
        }
        if (uncertainTransitionWon) {
          await consumer.processor.onUncertain?.(delivery.envelope);
        } else if (providerResponded) {
          await consumer.processor.onRejected?.(delivery.envelope, error);
        }
        return;
      }
      if (consumer.stopRequested || claimState.lost) {
        const transition = await this.model.updateOne(
          { _id: delivery._id, lockToken, state: 'egress_sending' },
          {
            $set: {
              state: 'delivery_uncertain',
              lastErrorCode: 'delivery_uncertain',
              lockedUntil: null,
              lockToken: null,
            },
          },
        );
        if (transition.matchedCount > 0) {
          await consumer.processor.onUncertain?.(delivery.envelope);
        }
        return;
      }
      await this.model.updateOne(
        { _id: delivery._id, lockToken, state: 'egress_sending' },
        {
          $set: {
            state: 'completed',
            envelope: null,
            replyText: null,
            providerMessageId: providerResult?.providerMessageId || null,
            lockedUntil: null,
            lockToken: null,
            lastErrorCode: null,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        },
      );
    } catch (error) {
      if (claimState.lost) {
        return;
      }
      await this.model
        .updateOne(
          {
            _id: delivery._id,
            lockToken,
            state: replyPersisted ? 'reply_ready' : 'agent_processing',
          },
          this.retryUpdate(
            delivery,
            replyPersisted ? 'reply_ready' : 'inbound_pending',
            replyPersisted ? 'delivery_check_failed' : 'agent_processing_failed',
          ),
        )
        .catch(() => undefined);
      this.logger.warn('[VIVENTIUM][channels] Durable delivery attempt failed', {
        channel: delivery.channel,
        error: error?.name || 'Error',
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  start(channel, accountId, processor) {
    const key = `${channel}:${accountId}`;
    this.stop(channel, accountId);
    const consumer = {
      stopRequested: false,
      timer: null,
      processor,
      activeCount: 0,
      activePartitions: new Set(),
    };
    const run = async () => {
      if (consumer.stopRequested) {
        return;
      }
      try {
        await this.markExpiredSendingUncertain(channel, accountId, processor);
        while (consumer.activeCount < this.maxConcurrentPartitions) {
          const claim = await this.claim(channel, accountId, consumer.activePartitions);
          if (!claim) {
            break;
          }
          consumer.activeCount += 1;
          consumer.activePartitions.add(claim.partitionKey);
          void this.processClaim(consumer, claim).finally(() => {
            consumer.activeCount -= 1;
            consumer.activePartitions.delete(claim.partitionKey);
          });
        }
      } catch (error) {
        this.logger.warn('[VIVENTIUM][channels] Durable queue polling failed', {
          channel,
          error: error?.name || 'Error',
        });
      }
      if (!consumer.stopRequested) {
        consumer.timer = setTimeout(() => void run(), this.pollMs);
        consumer.timer.unref?.();
      }
    };
    this.consumers.set(key, consumer);
    void run();
  }

  stop(channel, accountId) {
    const key = `${channel}:${accountId}`;
    const consumer = this.consumers.get(key);
    if (consumer) {
      consumer.stopRequested = true;
      clearTimeout(consumer.timer);
      this.consumers.delete(key);
    }
  }
}

module.exports = { ChannelDeliveryQueue };
