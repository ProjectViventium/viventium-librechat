/* === VIVENTIUM START === Opt-in call preparation reuses scheduler Main and job lifecycle. === */
export const CALL_PREPARATION_LABEL = 'Waking up - gathering context.';

export interface CallPreparationBinding {
  version: 1;
  promptId: string;
  deadlineAt: string;
  timeoutSeconds: number;
  idempotencyKey: string;
  streamId?: string;
  releasedStreamId?: string;
}

export interface CallPreparationSession {
  callSessionId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  mode?: string;
  status?: string;
  contextPreparation?: CallPreparationBinding;
}

export function createCallPreparationBinding(
  enabled: boolean,
  callSessionId: string,
  promptId: string,
  timeoutSeconds: number,
): CallPreparationBinding | undefined {
  if (!enabled) return undefined;
  if (!promptId || !Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600)
    throw new Error('Invalid call preparation configuration');
  return {
    version: 1,
    promptId,
    deadlineAt: '',
    timeoutSeconds,
    idempotencyKey: `call-context:${callSessionId}:v1`,
  };
}

export function callPreparationFailure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, status: 409, retryable: false });
}

export type PreparationResult = { prepared: true; responseMessageId: string } | { prepared: false };

interface PreparationWaitDependencies {
  readSession: (callSessionId: string) => Promise<CallPreparationSession | null>;
  waitForResult: (
    session: CallPreparationSession,
    signal: AbortSignal,
  ) => Promise<PreparationResult>;
  cancel: (session: CallPreparationSession) => Promise<boolean>;
  failure?: (session: CallPreparationSession, error: Error) => Promise<void>;
}

/** A pending source stays with the existing ingress caller until this exact dependency settles. */
export async function waitForCallPreparation(
  session: CallPreparationSession,
  dependencies: PreparationWaitDependencies,
  requestSignal?: AbortSignal,
): Promise<CallPreparationSession> {
  if (!session.contextPreparation || session.mode === 'listen_only') return session;
  const remaining = new Date(session.contextPreparation.deadlineAt).getTime() - Date.now();
  const controller = new AbortController();
  let rejectAbandoned!: (error: Error) => void;
  const abandoned = new Promise<never>((_, reject) => { rejectAbandoned = reject; });
  const onAbandon = () => {
    controller.abort('request_abandoned');
    rejectAbandoned(callPreparationFailure('call_context_wait_abandoned', 'This waiting call input disconnected.'));
  };
  requestSignal?.addEventListener('abort', onAbandon, { once: true });
  if (requestSignal?.aborted) onAbandon();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        controller.abort('call_context_deadline');
        reject(
          callPreparationFailure(
            'call_context_deadline',
            'Context gathering exceeded its time limit.',
          ),
        );
      },
      Math.max(0, remaining),
    );
  });
  try {
    await Promise.race([dependencies.waitForResult(session, controller.signal), expired, abandoned]);
    const current = await dependencies.readSession(session.callSessionId);
    if (!current || current.userId !== session.userId || current.status === 'ended')
      throw callPreparationFailure('call_ended', 'This call has ended.');
    if (current.contextPreparation?.idempotencyKey !== session.contextPreparation.idempotencyKey)
      throw callPreparationFailure('call_context_changed', 'The call context changed.');
    return current;
  } catch (error) {
    if (requestSignal?.aborted)
      throw callPreparationFailure('call_context_wait_abandoned', 'This waiting call input disconnected.');
    const code = (error as Error & { code?: string }).code;
    if (
      !controller.signal.aborted &&
      !['call_context_failed', 'call_context_unavailable', 'call_context_interrupted'].includes(
        code || '',
      )
    )
      throw error;
    if (code === 'call_context_deadline' || controller.signal.reason === 'call_context_deadline')
      await dependencies.failure?.(session, callPreparationFailure('call_context_deadline',
        'Context gathering reached its time limit. Voice continues with available context.'));
    const stopped = await dependencies.cancel(session);
    if (!stopped)
      throw callPreparationFailure('call_context_busy', 'Context gathering is still stopping.');
    const current = await dependencies.readSession(session.callSessionId);
    if (!current || current.userId !== session.userId || current.status === 'ended')
      throw callPreparationFailure('call_ended', 'This call has ended.');
    return current;
  } finally {
    clearTimeout(timer);
    requestSignal?.removeEventListener('abort', onAbandon);
    controller.abort();
  }
}

export interface CallPreparationAdmission {
  streamId: string;
  conversationId: string;
}

export interface CallPreparationDependencies extends PreparationWaitDependencies {
  admit: (session: CallPreparationSession) => Promise<CallPreparationAdmission>;
  bind: (
    session: CallPreparationSession,
    admission: CallPreparationAdmission,
  ) => Promise<CallPreparationSession>;
  readResult: (session: CallPreparationSession) => Promise<PreparationResult | null>;
  begin: (session: CallPreparationSession) => Promise<CallPreparationSession>;
  observe: (session: CallPreparationSession) => Promise<void>;
  failure: (session: CallPreparationSession, error: Error) => Promise<void>;
}

/** Only deduplicates local subscription handles; the existing durable job owns execution. */
export function createCallPreparationService(dependencies: CallPreparationDependencies) {
  const admissions = new Map<string, Promise<CallPreparationSession>>();
  const observers = new Map<string, Promise<void>>();
  const start = async (session: CallPreparationSession): Promise<CallPreparationSession> => {
    if (!session.contextPreparation || session.mode === 'listen_only') return session;
    let current = await dependencies.readSession(session.callSessionId);
    if (!current || current.userId !== session.userId || current.status === 'ended')
      throw callPreparationFailure('call_ended', 'This call has ended.');
    if (current.mode === 'listen_only') return current;
    current = await dependencies.begin(current);
    if (current.userId !== session.userId || current.status === 'ended')
      throw callPreparationFailure('call_ended', 'This call has ended.');
    if (current.mode === 'listen_only') return current;
    if (current.contextPreparation?.streamId || (await dependencies.readResult(current)))
      return current;
    const key = session.contextPreparation.idempotencyKey;
    const existing = admissions.get(key);
    if (existing) return existing;
    const admission = (async () => {
      if (Date.now() >= new Date(current!.contextPreparation!.deadlineAt).getTime())
        throw callPreparationFailure(
          'call_context_deadline',
          'Context gathering exceeded its time limit.',
        );
      const accepted = await dependencies.admit(current!);
      return dependencies.bind(current!, accepted);
    })();
    admissions.set(key, admission);
    try {
      return await admission;
    } catch (error) {
      await dependencies.failure(
        current!,
        error instanceof Error ? error : new Error('Preparation failed'),
      );
      const retained = await dependencies.readSession(session.callSessionId);
      if (!retained || retained.status === 'ended')
        throw callPreparationFailure('call_ended', 'This call has ended.');
      return retained;
    } finally {
      admissions.delete(key);
    }
  };
  const observe = (session: CallPreparationSession): void => {
    const key = session.contextPreparation?.streamId;
    if (!key || observers.has(key)) return;
    const watching = dependencies
      .observe(session)
      .catch(async (error: Error) => {
        await dependencies.failure(session, error);
      })
      .finally(() => observers.delete(key));
    observers.set(key, watching);
    // Error recording may itself be unavailable. The durable job remains the authority.
    void watching.catch(() => undefined);
  };
  return {
    start: async (session: CallPreparationSession) => {
      const accepted = await start(session);
      if (accepted.mode === 'listen_only') return accepted;
      observe(accepted);
      return accepted;
    },
    wait: async (session: CallPreparationSession, requestSignal?: AbortSignal) => {
      if (!session.contextPreparation || session.mode === 'listen_only') return session;
      if (requestSignal?.aborted)
        throw callPreparationFailure('call_context_wait_abandoned', 'This waiting call input disconnected.');
      const accepted = await start(session);
      if (requestSignal?.aborted)
        throw callPreparationFailure('call_context_wait_abandoned', 'This waiting call input disconnected.');
      if (accepted.mode === 'listen_only') return accepted;
      observe(accepted);
      if (await dependencies.readResult(accepted)) {
        const current = await dependencies.readSession(accepted.callSessionId);
        if (!current || current.status === 'ended')
          throw callPreparationFailure('call_ended', 'This call has ended.');
        return current;
      }
      return waitForCallPreparation(accepted, dependencies, requestSignal);
    },
    cancel: dependencies.cancel,
  };
}
