import type { Response } from 'express';

/** Transport comments keep a quiet SSE subscription alive without inventing model progress. */
export function startSseKeepAlive(
  response: Response & { flush?: () => void },
  isActive: () => boolean,
  intervalMs = 15000,
): () => void {
  const stop = () => {
    clearInterval(timer);
    response.removeListener('close', stop);
    response.removeListener('finish', stop);
  };
  const timer = setInterval(() => {
    if (response.destroyed || response.writableEnded || !isActive()) return stop();
    if (response.writableNeedDrain) return;
    try {
      response.write(': keep-alive\n\n');
      response.flush?.();
    } catch {
      stop();
    }
  }, intervalMs);
  timer.unref();
  response.once('close', stop);
  response.once('finish', stop);
  return stop;
}
