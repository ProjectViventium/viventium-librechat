/* === VIVENTIUM START === Explicit control of one saved Telegram foreground failure. === */
import { timingSafeEqual } from 'node:crypto';
import { nativeIdentityJson, nativeIdentityValid } from '../stream/implementations/nativeResponse';
import { nativeResponseOrigin, nativeResponseSha256 } from './nativeResponse';
import type { NativeResponseAdmission, NativeResponseIdentity } from '@librechat/data-schemas';
import type { NativeResponseRoute, NativeResult } from './nativeResponse';

type SavedMessage = {
  user?: unknown;
  messageId?: string;
  conversationId?: string;
  error?: boolean;
  deletedAt?: unknown;
  nativeResponse?: NativeResponseAdmission;
  metadata?: unknown;
  content?: unknown;
};
export type ForegroundAttentionScope = {
  ownerId: string;
  conversationId: string;
  sourceOrderScope: string;
  responseMessageId: string;
};
type ControlResult = Pick<
  NativeResult,
  'state' | 'request_id' | 'failure_class' | 'foreground_attention_control'
>;
type Dependencies = {
  readMessage: (ownerId: string, responseMessageId: string) => Promise<SavedMessage | null>;
  readNative: (ownerId: string, responseMessageId: string) => Promise<SavedMessage | null>;
  sourceMatches: (identity: NativeResponseIdentity) => Promise<boolean>;
  readResult: (identity: NativeResponseIdentity) => Promise<ControlResult | null>;
  resolveRoute: (identity: NativeResponseIdentity) => Promise<NativeResponseRoute>;
  cancel: (
    identity: NativeResponseIdentity,
    result: ControlResult,
    route: NativeResponseRoute,
  ) => Promise<{ acknowledged?: boolean; capacityReleased?: boolean; state?: string }>;
  now?: () => number;
};
const RECEIPT_WINDOW_MS = 15 * 60 * 1000;
function unavailable(): never {
  throw Object.assign(new Error('foreground_attention_unavailable'), {
    code: 'foreground_attention_unavailable',
    status: 409,
  });
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function reference(value: unknown): string | undefined {
  const item = record(value);
  return item?.version === 1 && typeof item.responseMessageId === 'string' && item.responseMessageId
    ? item.responseMessageId
    : undefined;
}

export function createForegroundAttentionControl(deps: Dependencies) {
  const now = deps.now || Date.now;
  function matches(row: SavedMessage | null, scope: ForegroundAttentionScope, messageId: string) {
    return (
      row &&
      String(row.user) === scope.ownerId &&
      row.messageId === messageId &&
      row.conversationId === scope.conversationId &&
      !row.deletedAt
    );
  }
  async function inspect(scope: ForegroundAttentionScope) {
    if (
      !scope.ownerId ||
      !scope.conversationId ||
      !scope.responseMessageId ||
      !/^[a-f0-9]{64}$/.test(scope.sourceOrderScope)
    )
      unavailable();
    const current = await deps.readMessage(scope.ownerId, scope.responseMessageId);
    if (!matches(current, scope, scope.responseMessageId) || current?.error !== true) unavailable();
    const metadata = record(record(current.metadata)?.viventium);
    const partReferences = Array.isArray(current.content)
      ? current.content
          .filter((part) => record(part)?.type === 'error')
          .map((part) => reference(record(part)?.foregroundAttention))
          .filter(Boolean)
      : [];
    const references = new Set(
      [reference(metadata?.foregroundAttention), ...partReferences].filter(Boolean),
    );
    if (references.size > 1) unavailable();
    const targetId = references.values().next().value || scope.responseMessageId;
    const row = await deps.readNative(scope.ownerId, targetId);
    const identity = row?.nativeResponse;
    if (
      !matches(row, scope, targetId) ||
      row?.error !== true ||
      !identity ||
      identity.status !== 'failed' ||
      !(identity.terminalSnapshotStoredAt! > 0) ||
      !nativeIdentityValid(identity, now()) ||
      identity.userId !== scope.ownerId ||
      identity.conversationId !== scope.conversationId ||
      identity.responseMessageId !== targetId ||
      identity.sourceOrderScope !== scope.sourceOrderScope ||
      identity.deliveryContext?.surface !== 'telegram' ||
      identity.deliveryContext.authenticated !== true ||
      !(await deps.sourceMatches(identity))
    )
      unavailable();
    const route = await deps.resolveRoute(identity);
    if (nativeResponseOrigin(route.baseURL) !== identity.originSha256) unavailable();
    const result = await deps.readResult(identity);
    if (!result || !result.request_id || result.foreground_attention_control?.version !== 1)
      unavailable();
    const bucket = Math.floor(now() / RECEIPT_WINDOW_MS);
    const receipt = nativeResponseSha256(
      JSON.stringify({
        version: 1,
        action: 'cancel',
        scope,
        identity: nativeIdentityJson(identity),
        bucket,
      }),
    );
    return {
      identity,
      result,
      route,
      receipt,
      expiresAt: new Date(
        Math.min((bucket + 1) * RECEIPT_WINDOW_MS, identity.recoverUntil),
      ).toISOString(),
    };
  }

  async function attention(scope: ForegroundAttentionScope) {
    const proof = await inspect(scope);
    const control = proof.result.foreground_attention_control!;
    if (
      !(
        ['failed', 'cancelled'].includes(proof.result.state) &&
        proof.result.failure_class === 'provider_progress_stalled' &&
        control.can_cancel === true
      ) &&
      !(proof.result.state === 'cancelled' && control.capacity_released === true)
    )
      unavailable();
    return {
      version: 1 as const,
      action: 'cancel' as const,
      responseMessageId: scope.responseMessageId,
      receipt: proof.receipt,
      expiresAt: proof.expiresAt,
    };
  }
  async function cancel(
    scope: ForegroundAttentionScope,
    input: { receipt: string; operationId: string },
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(input.receipt || '') ||
      typeof input.operationId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.operationId)
    )
      unavailable();
    const proof = await inspect(scope);
    if (!timingSafeEqual(Buffer.from(input.receipt, 'hex'), Buffer.from(proof.receipt, 'hex')))
      unavailable();
    const control = proof.result.foreground_attention_control!;
    if (proof.result.state === 'cancelled' && control.capacity_released === true)
      return {
        version: 1,
        state: 'already_cancelled',
        capacityReleased: true,
        message: 'The earlier reply is already cancelled. Send your message again.',
      };
    if (proof.result.state === 'completed' && control.capacity_released === true)
      return {
        version: 1,
        state: 'already_completed',
        capacityReleased: true,
        message: 'The earlier reply is already complete.',
      };
    if (
      !['failed', 'cancelled'].includes(proof.result.state) ||
      proof.result.failure_class !== 'provider_progress_stalled' ||
      control.can_cancel !== true
    )
      unavailable();
    try {
      const outcome = await deps.cancel(proof.identity, proof.result, proof.route);
      if (
        outcome.acknowledged === true &&
        outcome.capacityReleased === true &&
        outcome.state === 'cancelled'
      )
        return {
          version: 1,
          state: 'cancelled',
          capacityReleased: true,
          message: 'The earlier reply is cancelled. Send your message again.',
        };
    } catch (error) {
      const failure = record(error);
      if (
        !failure?.capacityReleasePending &&
        !(
          failure?.code === 'HARNESS_CANCELLATION_DELIVERY_FAILED' &&
          (failure.status == null || Number(failure.status) >= 500)
        )
      )
        throw error;
    }
    return {
      version: 1,
      state: 'pending',
      capacityReleased: false,
      message: 'Cancellation is pending. Try /cancel again before sending another message.',
    };
  }
  return { attention, cancel };
}
/* === VIVENTIUM END === */
