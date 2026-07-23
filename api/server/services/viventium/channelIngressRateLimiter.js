/* === VIVENTIUM START ===
 * Feature: Durable channel ingress quotas.
 * Purpose: Apply idempotent paired/unpaired identity and account backpressure with bounded atomic buckets.
 * === VIVENTIUM END === */

const crypto = require('crypto');

class ChannelIngressRateLimiter {
  constructor({
    model,
    resolveTier,
    windowMs = 5 * 60_000,
    limits = {},
    accountLimits = {},
    now = () => Date.now(),
  }) {
    this.model = model;
    this.resolveTier = resolveTier;
    this.windowMs = windowMs;
    this.limits = { paired: limits.paired || 20, unpaired: limits.unpaired || 5 };
    this.accountLimits = {
      paired: accountLimits.paired || 200,
      unpaired: accountLimits.unpaired || 50,
    };
    this.now = now;
  }

  async reserve(envelope, dedupeKey) {
    const timestamp = this.now();
    const tier = await this.resolveTier(envelope);
    const windowId = Math.floor(timestamp / this.windowMs);
    const expiresAt = new Date((windowId + 2) * this.windowMs);
    const identityHash = crypto
      .createHash('sha256')
      .update(JSON.stringify([envelope.channel, envelope.accountId, envelope.externalUserId]))
      .digest('hex');
    const accountHash = crypto
      .createHash('sha256')
      .update(JSON.stringify([envelope.channel, envelope.accountId]))
      .digest('hex');

    const bucketKey = (scope, subjectHash) =>
      crypto
        .createHash('sha256')
        .update(`${scope}:${subjectHash}:${tier}:${windowId}`)
        .digest('hex');
    const reserveBucket = async (scope, subjectHash, limit) => {
      const quotaKey = bucketKey(scope, subjectHash);

      // Create exactly one bucket per scope/window. The unique quotaKey closes the
      // first-writer race; conditional updates below are atomic on that document.
      try {
        await this.model.updateOne(
          { quotaKey },
          {
            $setOnInsert: {
              quotaKey,
              channel: envelope.channel,
              accountId: envelope.accountId,
              identityHash: subjectHash,
              tier,
              scope,
              count: 0,
              eventKeys: [],
              rejectedDedupeKey: null,
              expiresAt,
            },
          },
          { upsert: true },
        );
      } catch (error) {
        if (Number(error?.code) !== 11000) {
          throw error;
        }
      }

      // Mongo re-evaluates this predicate while holding the document lock. Exactly
      // `limit` distinct events can increment the bucket, even under Promise.all
      // floods; a provider retry is idempotent because its key is already present.
      const acceptedReservation = await this.model.findOneAndUpdate(
        { quotaKey, eventKeys: { $ne: dedupeKey }, count: { $lt: limit } },
        { $inc: { count: 1 }, $push: { eventKeys: dedupeKey } },
        { new: true },
      );
      if (acceptedReservation) {
        return { accepted: true, notify: false };
      }

      const current = await this.model.findOne({ quotaKey }).lean();
      if (current?.eventKeys?.includes(dedupeKey)) {
        return {
          accepted: current.rejectedDedupeKey !== dedupeKey,
          notify: false,
        };
      }

      // Persist at most one rejected event per bucket. The caller that wins this
      // atomic transition alone emits the paid provider notice; later unique floods
      // and duplicate retries create no documents and no repeated notifications.
      const rejectedReservation = await this.model.findOneAndUpdate(
        {
          quotaKey,
          eventKeys: { $ne: dedupeKey },
          count: { $eq: limit },
          rejectedDedupeKey: null,
        },
        {
          $inc: { count: 1 },
          $push: { eventKeys: dedupeKey },
          $set: { rejectedDedupeKey: dedupeKey },
        },
        { new: true },
      );
      return { accepted: false, notify: Boolean(rejectedReservation) };
    };

    // Once the shared cap is already full, reject there before creating more
    // identity receipts. Until then, reserve the stricter identity bucket first
    // so one exhausted identity cannot consume capacity needed by other users.
    const currentAccount = await this.model
      .findOne({
        quotaKey: bucketKey('account', accountHash),
      })
      .lean();
    if (currentAccount && currentAccount.count >= this.accountLimits[tier]) {
      const account = await reserveBucket('account', accountHash, this.accountLimits[tier]);
      if (!account.accepted) {
        return {
          accepted: false,
          notify: account.notify,
          retryAfterMs: Math.max(1_000, (windowId + 1) * this.windowMs - timestamp),
        };
      }
    }
    const identity = await reserveBucket('identity', identityHash, this.limits[tier]);
    if (!identity.accepted) {
      return {
        accepted: false,
        notify: identity.notify,
        retryAfterMs: Math.max(1_000, (windowId + 1) * this.windowMs - timestamp),
      };
    }
    const account = await reserveBucket('account', accountHash, this.accountLimits[tier]);
    return {
      accepted: identity.accepted && account.accepted,
      notify: identity.notify || account.notify,
      retryAfterMs: Math.max(1_000, (windowId + 1) * this.windowMs - timestamp),
    };
  }
}

module.exports = { ChannelIngressRateLimiter };
