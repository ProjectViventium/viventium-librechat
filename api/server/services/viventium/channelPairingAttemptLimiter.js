/* === VIVENTIUM START ===
 * Feature: Atomic channel pairing-attempt windows.
 * Purpose: Reserve brute-force attempts without a read/reset race on the first request.
 * === VIVENTIUM END === */

async function incrementActiveWindow(model, scopeKey, maximumAttempts, now) {
  return await model
    .findOneAndUpdate(
      {
        scopeKey,
        attempts: { $lt: maximumAttempts },
        windowExpiresAt: { $gt: now },
      },
      { $inc: { attempts: 1 } },
      { new: true },
    )
    .lean();
}

async function reservePairingAttempt({
  model,
  scopeKey,
  maximumAttempts,
  now = new Date(),
  windowExpiresAt,
}) {
  if (await incrementActiveWindow(model, scopeKey, maximumAttempts, now)) {
    return true;
  }

  // Only one caller can atomically replace an expired window. Other callers
  // subsequently increment that new window through the conditional path above.
  const reset = await model
    .findOneAndUpdate(
      {
        scopeKey,
        $or: [{ windowExpiresAt: { $lte: now } }, { windowExpiresAt: { $exists: false } }],
      },
      { $set: { attempts: 1, windowExpiresAt } },
      { new: true },
    )
    .lean();
  if (reset) {
    return true;
  }

  // The unique scopeKey closes the first-window race. If another caller wins
  // the insert, retry the bounded atomic increment instead of resetting.
  try {
    const inserted = await model.updateOne(
      { scopeKey },
      {
        $setOnInsert: {
          scopeKey,
          attempts: 1,
          windowExpiresAt,
        },
      },
      { upsert: true, runValidators: true, setDefaultsOnInsert: true },
    );
    if (inserted.upsertedCount === 1) {
      return true;
    }
  } catch (error) {
    if (Number(error?.code) !== 11000) {
      throw error;
    }
  }

  return Boolean(await incrementActiveWindow(model, scopeKey, maximumAttempts, now));
}

module.exports = { reservePairingAttempt };
