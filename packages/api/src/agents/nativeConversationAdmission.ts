/* === VIVENTIUM START ===
 * Detached cortex turns can overlap. A workspace session may change authority only after its
 * previous attempt settles, so serialize that session before assembling invocation-fresh grants.
 * The native provider remains the authority guard across processes and after restarts.
 * === VIVENTIUM END === */
const sessionTails = new Map<string, Promise<void>>();

interface NativeConversationAdmissionOptions {
  sessionKey: string;
  timeoutMs: number;
  signals: readonly AbortSignal[];
  isCancelled: () => boolean;
}

export async function withNativeConversationAdmission<T>(
  { sessionKey, timeoutMs, signals, isCancelled }: NativeConversationAdmissionOptions,
  invoke: () => Promise<T>,
): Promise<T> {
  const previous = sessionTails.get(sessionKey) || Promise.resolve();
  let expired = false;
  const abortError = () => {
    const error = new Error(
      expired ? 'Native session admission timed out' : 'Native session admission cancelled',
    );
    error.name = 'AbortError';
    return Object.assign(error, {
      code: expired ? 'native_session_admission_timeout' : 'native_session_admission_cancelled',
    });
  };
  let rejectWaiting: (error: Error) => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectWaiting = reject;
  });
  const abort = () => {
    if (isCancelled()) rejectWaiting(abortError());
  };
  for (const signal of signals) signal.addEventListener('abort', abort);
  const timer = setTimeout(() => {
    expired = true;
    rejectWaiting(abortError());
  }, timeoutMs);
  timer.unref?.();
  const execution = previous.then(async () => {
    if (expired || isCancelled()) throw abortError();
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener('abort', abort);
    return invoke();
  });
  const tail = execution.then(
    () => {},
    () => {},
  );
  sessionTails.set(sessionKey, tail);
  void tail.finally(() => {
    if (sessionTails.get(sessionKey) === tail) sessionTails.delete(sessionKey);
  });
  try {
    abort();
    return await Promise.race([execution, cancelled]);
  } finally {
    clearTimeout(timer);
    for (const signal of signals) signal.removeEventListener('abort', abort);
  }
}
