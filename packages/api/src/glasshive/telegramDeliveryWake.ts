import { InMemoryEventTransport } from '../stream/implementations/InMemoryEventTransport';

const transport = new InMemoryEventTransport();
const channel = 'viventium:telegram:delivery-ready';
const maximumWaitMs = 5_000;

/** A wake hint carries no delivery data or authority; the durable claim remains the owner. */
export function notifyTelegramDeliveryReady(): void {
  transport.emitChunk(channel, { type: 'delivery-ready' });
}

/** Subscribe before checking the outbox so a commit between check and wait cannot be lost. */
export async function claimTelegramDeliveriesWhenReady<T>(
  claim: () => Promise<T[]>,
  requestedWaitMs = 0,
  signal?: AbortSignal,
): Promise<T[]> {
  const waitMs = Number.isFinite(requestedWaitMs)
    ? Math.max(0, Math.min(requestedWaitMs, maximumWaitMs))
    : 0;
  if (!waitMs || signal?.aborted) return signal?.aborted ? [] : claim();

  let finish: () => void = () => {};
  const ready = new Promise<void>((resolve) => { finish = resolve; });
  const subscription = transport.subscribe(channel, { onChunk: finish });
  const timer = setTimeout(finish, waitMs);
  timer.unref?.();
  signal?.addEventListener('abort', finish, { once: true });
  try {
    const deliveries = await claim();
    if (deliveries.length || signal?.aborted) return deliveries;
    await ready;
    return signal?.aborted ? [] : await claim();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', finish);
    subscription.unsubscribe();
  }
}
