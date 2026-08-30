/* === VIVENTIUM START ===
 * Feature: Public-safe runtime error logging.
 * Purpose: Log bounded structural diagnostics without serializing provider messages, URLs,
 * machine paths, request bodies, credentials, or nested causes.
 * === VIVENTIUM END === */

const SAFE_ERROR_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/;

type UnknownRecord = Record<string, unknown>;

export interface SafeErrorLogFields {
  name: string;
  code: string;
  status?: number;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeToken(value: unknown, fallback: string): string {
  let candidate = '';
  if (typeof value === 'number') {
    candidate = String(value);
  } else if (typeof value === 'string') {
    candidate = value;
  }
  const normalized = candidate.trim();
  return SAFE_ERROR_TOKEN.test(normalized) ? normalized : fallback;
}

export function safeErrorCode(error: unknown, fallbackCode = 'operation_failed'): string {
  const safeFallback = safeToken(fallbackCode, 'operation_failed');
  return safeToken(isRecord(error) ? error.code : undefined, safeFallback);
}

export function safeErrorLogFields(
  error: unknown,
  fallbackCode = 'operation_failed',
): SafeErrorLogFields {
  const value = isRecord(error) ? error : {};
  const fields: SafeErrorLogFields = {
    name: safeToken(value.name, 'Error'),
    code: safeErrorCode(error, fallbackCode),
  };
  const status = Number(value.status ?? value.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    fields.status = status;
  }
  return fields;
}
