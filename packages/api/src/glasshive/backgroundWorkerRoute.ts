/* === VIVENTIUM START: Persisted background preferences; independent of the foreground route. === */
import { MAIN_DELEGATION_PROFILES } from './conversationOrchestration';
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
const bounded = (value: unknown, max = 160): string =>
  typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
const fields = {
  workerProfile: 'worker_profile',
  workerModel: 'worker_model',
  workerReasoningEffort: 'worker_reasoning_effort',
  fallbackWorkerProfile: 'fallback_worker_profile',
  fallbackWorkerModel: 'fallback_worker_model',
  fallbackWorkerReasoningEffort: 'fallback_worker_reasoning_effort',
} as const;

export function configuredBackgroundWorkerRoute(agent: unknown): Record<string, string> {
  const descriptor = record(agent);
  const full = record(record(descriptor.glasshive_options).orchestration);
  const settings = Object.keys(full).length ? full : record(descriptor.orchestration);
  return Object.fromEntries(
    Object.entries(fields).flatMap(([camel, snake]) => {
      const value = bounded(settings[snake]);
      if (
        !value ||
        (camel.endsWith('Profile') &&
          !(MAIN_DELEGATION_PROFILES as readonly string[]).includes(value))
      )
        return [];
      return [[camel, value]];
    }),
  );
}

export function backgroundWorkerResources(route: unknown): Record<string, string> {
  const values = record(route);
  return Object.fromEntries(
    Object.entries(fields).flatMap(([camel, snake]) => {
      const value = bounded(values[camel]);
      return value ? [[snake, value]] : [];
    }),
  );
}

/** Preferences default new work only. Explicit task profile/effort remain authoritative. */
export function resolveBackgroundWorkerRoute(args: RecordValue, resources: RecordValue) {
  const preferredProfile = bounded(resources.worker_profile);
  const profile = bounded(args.profile) || preferredProfile;
  const usesPreferredProfile = !!preferredProfile && profile === preferredProfile;
  const effort =
    bounded(args.effort) ||
    (usesPreferredProfile ? bounded(resources.worker_reasoning_effort) : '');
  const authority: Record<string, string> = {};
  if (usesPreferredProfile && bounded(resources.worker_model))
    authority.worker_model = bounded(resources.worker_model);
  if (effort) authority.worker_reasoning_effort = effort;
  for (const key of [
    'fallback_worker_profile',
    'fallback_worker_model',
    'fallback_worker_reasoning_effort',
  ]) {
    const value = bounded(resources[key]);
    if (value) authority[key] = value;
  }
  return {
    args: { ...args, ...(profile ? { profile } : {}), ...(effort ? { effort } : {}) },
    authority,
  };
}
/* === VIVENTIUM END === */
