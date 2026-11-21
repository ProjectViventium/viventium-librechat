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
/** Model observations distinguish completed execution from a delivered result message.
 * Original content stays with the existing exact owner-scoped result reader.
 */
export function projectWorkResultObservation(value: unknown) {
  const item =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const delivery =
    item.delivery && typeof item.delivery === 'object' && !Array.isArray(item.delivery)
      ? (item.delivery as Record<string, unknown>)
      : {};
  const scope = normalizeWorkDeliveryScope(item.deliveryScope);
  const workRef = identifier(item.workRef);
  return {
    execution: {
      state: typeof item.state === 'string' ? item.state : 'unknown',
      ...(typeof item.statusSummary === 'string' && item.statusSummary
        ? { status: item.statusSummary }
        : {}),
    },
    result: {
      bodyIncluded: false as const,
      ...(workRef
        ? {
            readerArguments: {
              scope: 'result' as const,
              workRef,
              ...(scope?.resultRunId ? { runId: scope.resultRunId } : {}),
            },
          }
        : {}),
      ...(scope?.resultRevision ? { revision: scope.resultRevision } : {}),
    },
    presentationReceipt: {
      scope: 'result_message' as const,
      state: typeof delivery.state === 'string' ? delivery.state : 'unknown',
      unreadTerminal: delivery.unreadTerminal === true,
      ...(scope ? { deliveryScope: scope } : {}),
    },
    artifactDelivery: { state: 'unknown' as const },
  };
}
/* === VIVENTIUM END === */
