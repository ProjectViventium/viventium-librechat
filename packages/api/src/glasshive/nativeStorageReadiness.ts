/* === VIVENTIUM START === Native admission follows the existing byte capacity owner. === */
interface NativeStorageFact {
  version: number;
  healthy: boolean;
  availableBytes: number | null;
  requiredBytes: number;
  errorCode?: string;
}

interface NativeStorageReadiness {
  valid: boolean;
  ready: boolean;
  reason: string;
}

export function nativeStorageReadiness(value: unknown): NativeStorageReadiness {
  const invalid = { valid: false, ready: false, reason: 'storage_capability_invalid' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid;
  const fact = value as NativeStorageFact;
  if (
    fact.version !== 1 ||
    typeof fact.healthy !== 'boolean' ||
    !Number.isSafeInteger(fact.requiredBytes) ||
    fact.requiredBytes < 0 ||
    (fact.availableBytes !== null &&
      (!Number.isSafeInteger(fact.availableBytes) || fact.availableBytes < 0)) ||
    (fact.errorCode !== undefined &&
      (fact.errorCode !== 'storage_probe_unavailable' || fact.availableBytes !== null))
  )
    return invalid;
  const ready = fact.availableBytes !== null && fact.availableBytes >= fact.requiredBytes;
  if (fact.healthy !== ready) return invalid;
  return {
    valid: true,
    ready,
    reason: ready
      ? ''
      : fact.availableBytes === null
        ? 'storage_pressure_unavailable'
        : 'host_capacity',
  };
}
/* === VIVENTIUM END === */
