/* VIVENTIUM: Both callback paths resolve the saved schedule owner, never an ID prefix.
 * schedule_due admissions belong to scheduleDueReceiver/scheduleDueHost, which own
 * result reconciliation and delivery. They are not legacy Cortex occurrences and
 * must not also receive its external-work callback. Lookup errors are not absence.
 */
import crypto from 'crypto';

export function schedulerDispatchDocumentId(userId: string, idempotencyKey: string): string {
  return crypto.createHash('sha256').update(`${userId}\0${idempotencyKey}`).digest('hex');
}

export async function applicationOwnsScheduleOccurrence(
  input: { ownerId: unknown; occurrenceKey?: unknown; dispatchDocumentId?: unknown },
  readAdmission: (filter: Record<string, string>) => Promise<unknown>,
): Promise<boolean> {
  const ownerId = typeof input.ownerId === 'string' ? input.ownerId.trim() : '';
  const occurrenceKey = typeof input.occurrenceKey === 'string' ? input.occurrenceKey.trim() : '';
  const documentId = typeof input.dispatchDocumentId === 'string' ? input.dispatchDocumentId.trim() : '';
  if (!ownerId || (!documentId && !occurrenceKey)) return false;
  const admission = await readAdmission({
    userId: ownerId,
    _id: documentId || schedulerDispatchDocumentId(ownerId, occurrenceKey),
  });
  return Boolean(admission && typeof admission === 'object' &&
    'kind' in admission && admission.kind === 'schedule_due');
}
