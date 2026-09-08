/* === VIVENTIUM START === Internal, durable authority for removed predecessor replies. === */
import type { SerializableJobData } from '../stream/interfaces/IJobStore';

export type NativeAcceptedSource = { id: string; sha256: string };
export type NativePredecessor = {
  streamId: string;
  createdAt: number;
  responseMessageId: string;
  invocationId: string;
};
const verifiedSources = new WeakMap<RequestInit, NativeAcceptedSource[]>();
export function retainVerifiedNativeSources(
  init: RequestInit,
  chain: Array<NativeAcceptedSource & { role: string; accepted_source?: boolean }>,
): void {
  verifiedSources.set(
    init,
    chain
      .filter((item) => item.role === 'user' && item.accepted_source === true)
      .map(({ id, sha256 }) => ({ id, sha256 })),
  );
}
export function getVerifiedNativeSources(init?: RequestInit): NativeAcceptedSource[] | undefined {
  return init ? verifiedSources.get(init)?.map((item) => ({ ...item })) : undefined;
}

export function nativePredecessorSupersession(
  current: SerializableJobData,
  previous: SerializableJobData | null | undefined,
  sources: NativeAcceptedSource[],
) {
  const ref = current.nativePredecessor;
  const old = previous?.nativeResponse;
  const ack = previous?.deliveryAcknowledgement;
  const turn = current.interactionContext;
  const retained = previous?.nativeAcceptedSources;
  if (
    !ref ||
    !previous ||
    !old ||
    !ack ||
    !turn ||
    !retained ||
    previous.streamId !== ref.streamId ||
    previous.createdAt !== ref.createdAt ||
    previous.responseMessageId !== ref.responseMessageId ||
    old.responseMessageId !== ref.responseMessageId ||
    old.invocationId !== ref.invocationId ||
    retained.invocationId !== ref.invocationId ||
    previous.userId !== current.userId ||
    previous.conversationId !== current.conversationId ||
    previous.status !== 'superseded' ||
    ack.state !== 'partial_removed' ||
    ack.logical_turn_id !== old.logicalTurnId ||
    ack.revision !== old.revision ||
    turn.logical_turn_id !== old.logicalTurnId ||
    turn.revision !== old.revision + 1 ||
    retained.sources.length === 0
  )
    return undefined;
  const currentSources = new Map(sources.map((source) => [source.id, source.sha256]));
  if (retained.sources.some((source) => currentSources.get(source.id) !== source.sha256))
    return undefined;
  return {
    version: 1 as const,
    previous_response_message_id: ref.responseMessageId,
    logical_turn_id: turn.logical_turn_id,
    previous_revision: old.revision,
    revision: turn.revision,
    disposition: 'partial_removed' as const,
    accepted_sources: retained.sources.map((source) => ({ ...source })),
  };
}

export function stripNativePredecessorSupersession(init?: RequestInit): RequestInit | undefined {
  if (typeof init?.body !== 'string') return init;
  let payload: { metadata?: { native_predecessor_supersession?: object; [key: string]: unknown } };
  try {
    payload = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (
    !payload?.metadata ||
    !Object.prototype.hasOwnProperty.call(payload.metadata, 'native_predecessor_supersession')
  )
    return init;
  delete payload.metadata.native_predecessor_supersession;
  const headers = new Headers(init.headers);
  headers.delete('content-length');
  return { ...init, headers, body: JSON.stringify(payload) };
}
/* === VIVENTIUM END === */
