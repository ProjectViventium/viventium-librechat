/* === VIVENTIUM START === Preserve delivery scope without treating account-wide work as local delivery. === */
export interface WorkDeliveryScope {
  originConversationId: string | null;
  destinations: string[] | null;
  resultRunId: string | null;
  resultRevision: number | null;
}

const surfaces = new Set(['librechat', 'telegram', 'voice', 'workbench']);
const identifier = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,160}$/.test(value) ? value : null;

export function normalizeWorkDeliveryScope(value: unknown): WorkDeliveryScope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<Record<keyof WorkDeliveryScope, unknown>>;
  const originConversationId = identifier(row.originConversationId);
  const resultRunId = identifier(row.resultRunId);
  const resultRevision =
    typeof row.resultRevision === 'number' &&
    Number.isSafeInteger(row.resultRevision) &&
    row.resultRevision > 0
      ? row.resultRevision
      : null;
  const destinations =
    Array.isArray(row.destinations) &&
    row.destinations.every((item): item is string => typeof item === 'string' && surfaces.has(item))
      ? [...new Set(row.destinations as string[])]
      : null;
  if (!originConversationId && !resultRunId && !resultRevision && destinations === null)
    return null;
  return { originConversationId, destinations, resultRunId, resultRevision };
}
/* === VIVENTIUM END === */
