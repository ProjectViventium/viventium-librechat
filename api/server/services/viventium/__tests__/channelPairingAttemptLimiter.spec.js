/**
 * === VIVENTIUM START ===
 * Feature: Atomic channel pairing-attempt windows.
 * Purpose: Prove concurrent first guesses cannot reset the durable brute-force counter.
 * === VIVENTIUM END ===
 */

const { reservePairingAttempt } = require('../channelPairingAttemptLimiter');

function createModel() {
  let record = null;
  const matches = (filter) => {
    if (!record || record.scopeKey !== filter.scopeKey) {
      return false;
    }
    if (filter.attempts?.$lt != null && !(record.attempts < filter.attempts.$lt)) {
      return false;
    }
    if (filter.windowExpiresAt?.$gt && !(record.windowExpiresAt > filter.windowExpiresAt.$gt)) {
      return false;
    }
    if (filter.$or) {
      return filter.$or.some((candidate) => {
        if (candidate.windowExpiresAt?.$lte) {
          return record.windowExpiresAt <= candidate.windowExpiresAt.$lte;
        }
        if (candidate.windowExpiresAt?.$exists === false) {
          return record.windowExpiresAt == null;
        }
        return false;
      });
    }
    return true;
  };
  return {
    read: () => record,
    findOneAndUpdate: (filter, update) => ({
      lean: async () => {
        if (!matches(filter)) {
          return null;
        }
        if (update.$inc?.attempts) {
          record.attempts += update.$inc.attempts;
        }
        Object.assign(record, update.$set || {});
        return { ...record };
      },
    }),
    updateOne: async (filter, update, options) => {
      if (record?.scopeKey === filter.scopeKey) {
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!options?.upsert) {
        return { matchedCount: 0, upsertedCount: 0 };
      }
      record = { ...update.$setOnInsert };
      return { matchedCount: 0, upsertedCount: 1 };
    },
  };
}

describe('reservePairingAttempt', () => {
  it('atomically admits only the configured maximum during the first concurrent window', async () => {
    const model = createModel();
    const now = new Date('2026-07-22T12:00:00.000Z');
    const windowExpiresAt = new Date('2026-07-22T12:15:00.000Z');

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        reservePairingAttempt({
          model,
          scopeKey: 'a'.repeat(64),
          maximumAttempts: 6,
          now,
          windowExpiresAt,
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(6);
    expect(model.read()).toMatchObject({ attempts: 6, windowExpiresAt });
  });

  it('starts exactly one new counter after the old window expires', async () => {
    const model = createModel();
    const firstNow = new Date('2026-07-22T12:00:00.000Z');
    const firstExpiry = new Date('2026-07-22T12:15:00.000Z');
    await reservePairingAttempt({
      model,
      scopeKey: 'b'.repeat(64),
      maximumAttempts: 1,
      now: firstNow,
      windowExpiresAt: firstExpiry,
    });
    await expect(
      reservePairingAttempt({
        model,
        scopeKey: 'b'.repeat(64),
        maximumAttempts: 1,
        now: firstNow,
        windowExpiresAt: firstExpiry,
      }),
    ).resolves.toBe(false);

    const nextNow = new Date('2026-07-22T12:16:00.000Z');
    const nextExpiry = new Date('2026-07-22T12:31:00.000Z');
    await expect(
      reservePairingAttempt({
        model,
        scopeKey: 'b'.repeat(64),
        maximumAttempts: 1,
        now: nextNow,
        windowExpiresAt: nextExpiry,
      }),
    ).resolves.toBe(true);
    expect(model.read()).toMatchObject({ attempts: 1, windowExpiresAt: nextExpiry });
  });
});
