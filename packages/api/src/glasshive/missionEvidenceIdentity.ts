import * as crypto from 'crypto';
import type { GlassHiveMissionCallbackBody } from './missionAdjudication';

function safeText(value: unknown, maxLength = 512): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

export function legacyEvidenceId(body: GlassHiveMissionCallbackBody = {}): string {
  const callbackId = safeText(body.callback_id, 160);
  if (callbackId) return callbackId;
  return `ghe_${crypto
    .createHash('sha256')
    .update(
      [body.origin_ref, body.work_ref, body.worker_id, body.run_id, body.event, body.callback_ts]
        .map((value) => safeText(value, 4096))
        .join('\0'),
    )
    .digest('hex')
    .slice(0, 32)}`;
}

export function evidenceId({
  ownerId,
  originRef,
  body = {},
}: {
  ownerId: string;
  originRef: string;
  body?: GlassHiveMissionCallbackBody;
}): string {
  // A GlassHive callback id is stable within its producer, but it is not a global tenant-scoped
  // identity. Hash it with the verified Core owner/origin so one tenant cannot suppress another
  // tenant's terminal evidence by reusing the same vendor callback id.
  return `ghe_${crypto
    .createHash('sha256')
    .update([safeText(ownerId, 160), safeText(originRef, 160), legacyEvidenceId(body)].join('\0'))
    .digest('hex')
    .slice(0, 32)}`;
}
