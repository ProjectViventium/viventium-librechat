/* === VIVENTIUM START === One projection for exact server-committed work receipts. === */
import type { DurableEffectReceipt } from './interfaces/IJobStore';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function isDurableEffectReceipt(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DurableEffectReceipt {
  return (
    (value.effect_kind === 'durable_work_accepted' ||
      value.effect_kind === 'durable_work_action_accepted') &&
    typeof value.effect_ref === 'string' &&
    typeof value.source_event_id === 'string' &&
    typeof value.response_message_id === 'string' &&
    typeof value.committed_at === 'number' &&
    (value.confirmation_pending === undefined || typeof value.confirmation_pending === 'boolean')
  );
}

export function resolveCurrentDurableWorkReceipt({
  job,
  responseMessageId,
  sourceEventId,
  requireSuperseded = true,
}: {
  job: unknown;
  responseMessageId: string;
  sourceEventId?: string;
  requireSuperseded?: boolean;
}): { receipt: DurableEffectReceipt | null; rejectionReason: string | null } {
  const owner = record(job);
  const contract = record(owner.metadata ?? job);
  const receipt = record(owner.durableEffectReceipt ?? contract.durableEffectReceipt);
  const checks: Array<[string, boolean]> = [
    ['message_missing', Boolean(responseMessageId)],
    ['source_missing', Boolean(sourceEventId)],
    ['status_mismatch', !requireSuperseded || owner.status === 'superseded'],
    [
      'supersede_scope_mismatch',
      record(contract.adapterCapabilities).supersede_scope === 'response_only',
    ],
    [
      'delivery_policy_mismatch',
      record(contract.deliveryPolicy).commit_authority === 'external_adapter',
    ],
    [
      'effect_kind_mismatch',
      ['durable_work_accepted', 'durable_work_action_accepted'].includes(
        String(receipt.effect_kind),
      ),
    ],
    [
      'effect_ref_missing',
      typeof receipt.effect_ref === 'string' && Boolean(receipt.effect_ref.trim()),
    ],
    [
      'commit_time_invalid',
      typeof receipt.committed_at === 'number' &&
        Number.isFinite(receipt.committed_at) &&
        receipt.committed_at > 0,
    ],
    ['job_response_mismatch', contract.responseMessageId === responseMessageId],
    ['receipt_response_mismatch', receipt.response_message_id === responseMessageId],
    ['job_source_mismatch', record(contract.interactionContext).source_event_id === sourceEventId],
    ['receipt_source_mismatch', receipt.source_event_id === sourceEventId],
  ];
  const rejected = checks.find(([, accepted]) => !accepted);
  if (rejected) return { receipt: null, rejectionReason: rejected[0] };
  return isDurableEffectReceipt(receipt)
    ? { receipt, rejectionReason: null }
    : { receipt: null, rejectionReason: 'receipt_shape_invalid' };
}

export function publicDurableWorkReceipt(receipt: DurableEffectReceipt) {
  return {
    effect_ref: receipt.effect_ref,
    effect_kind: receipt.effect_kind,
    ...(receipt.confirmation_pending === true ? { confirmation_pending: true } : {}),
  };
}
/* === VIVENTIUM END === */
