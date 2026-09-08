/* === VIVENTIUM START === Typed, private memory failure presentation. === */
import { alternateName } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

export const memoryWriterAuthErrorTypes = new Set([
  'provider_auth',
  'provider_auth_missing',
  'provider_unauthorized',
  'provider_access_denied',
  'authentication_error',
]);
export const memoryWriterQuotaErrorTypes = new Set([
  'usage_limit_reached',
  'insufficient_quota',
  'billing_hard_limit_reached',
  'provider_quota_exhausted',
]);
const transientErrorTypes = new Set([
  'provider_rate_limited',
  'rate_limit_exceeded',
  'rate_limit_error',
  'provider_temporarily_unavailable',
  'server_is_overloaded',
]);
const providerNames = new Map(
  Object.entries(alternateName).map(([id, label]) => [id.toLowerCase(), label]),
);

export function memoryProviderFailureCopy(errorType?: string): TranslationKeys | undefined {
  if (errorType === 'host_capacity') {
    return 'com_ui_memory_host_capacity';
  }
  if (memoryWriterQuotaErrorTypes.has(errorType ?? '')) {
    return 'com_ui_memory_provider_limit';
  }
  if (errorType === 'provider_access_denied') {
    return 'com_ui_memory_provider_access_denied';
  }
  if (memoryWriterAuthErrorTypes.has(errorType ?? '')) {
    return 'com_ui_memory_provider_sign_in';
  }
  if (transientErrorTypes.has(errorType ?? '')) {
    return 'com_ui_memory_provider_temporary';
  }
  if (errorType === 'provider_unavailable') {
    return 'com_ui_memory_provider_unavailable';
  }
  return undefined;
}

export function memoryProviderLabel(provider?: string): string | undefined {
  return typeof provider === 'string' ? providerNames.get(provider.toLowerCase()) : undefined;
}
/* === VIVENTIUM END === */
