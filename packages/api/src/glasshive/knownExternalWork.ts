/* === VIVENTIUM START ===
 * Feature: Core-local known external-work hint.
 * Purpose: Share the exact owner-scoped attention query without coupling account reads to the
 * larger callback-binding runtime.
 * === VIVENTIUM END === */

type UnknownRecord = Record<string, unknown>;

export interface KnownExternalWorkCollection {
  findOne: (filter: UnknownRecord, options?: UnknownRecord) => Promise<unknown>;
}

export async function hasKnownExternalWork({
  ownerId,
  collection,
}: {
  ownerId?: unknown;
  collection: KnownExternalWorkCollection;
}): Promise<boolean> {
  const normalizedOwnerId = String(ownerId || '')
    .trim()
    .slice(0, 512);
  if (!normalizedOwnerId) {
    return false;
  }

  const row = await collection.findOne(
    {
      ownerId: normalizedOwnerId,
      $or: [
        {
          launchState: 'not_dispatched',
          externalState: 'failed',
          attentionPending: { $ne: false },
        },
        {
          launchState: { $nin: ['prepared', 'not_dispatched'] },
          $or: [
            { externalState: { $nin: ['completed', 'failed', 'cancelled'] } },
            { attentionPending: true },
            {
              deliveryState: {
                $in: ['pending', 'enqueued', 'failed', 'unresolved', 'unknown'],
              },
            },
          ],
        },
      ],
    },
    { projection: { _id: 1 } },
  );
  return Boolean(row);
}
