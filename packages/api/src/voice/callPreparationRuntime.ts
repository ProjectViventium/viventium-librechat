/* === VIVENTIUM START === Call-start context preparation composes existing native owners. === */
import { GenerationJobManager } from '../stream/GenerationJobManager';
import { createCallPreparationService, callPreparationFailure, CALL_PREPARATION_LABEL } from './callPreparation';
import type { ServerSentEvent } from '../types/events';
import type { CallPreparationSession, PreparationResult } from './callPreparation';

interface PreparationTask {
  taskId: string;
  state: string;
}
interface PreparationSnapshot {
  resultMessageId?: string;
}
interface TaskScope {
  callSessionId: string;
  userId: string;
  requireDurable?: boolean;
}
interface TaskCreation extends TaskScope {
  conversationId: string;
  turnId: string;
  streamId: string;
  label?: string;
  owner: { kind: string; id: string };
}
interface PreparationTasks {
  hydrateVoiceTaskByStreamId: (
    streamId: string,
    scope: TaskScope,
  ) => Promise<PreparationTask | null>;
  snapshotEvent: (taskId: string) => PreparationSnapshot | null;
  createVoiceTask: (input: TaskCreation) => PreparationTask;
  bindVoiceTaskStream: (
    taskId: string,
    streamId: string,
    scope: TaskScope & { conversationId: string },
  ) => object | null;
  completeVoiceTask: (taskId: string, outcome: { resultMessageId: string }) => object | null;
  cancelVoiceTask: (taskId: string, scope: { userId: string }) => object | null;
  settleVoiceTaskCancellation: (
    taskId: string,
    outcome: { confirmed: boolean; detail: string },
  ) => Promise<object | null>;
  observeGenerationEvent: (taskId: string, event: ServerSentEvent) => object | null;
  failVoiceTask: (taskId: string, error: { code: string; message: string }) => object | null;
  flushVoiceTaskPersistence: () => Promise<void>;
}
export interface CallPreparationRuntimeBridge {
  calls: {
    getCallSession: (id: string) => Promise<CallPreparationSession | null>;
    materializeCallSessionConversationId: (
      id: string,
      conversationId: string,
    ) => Promise<CallPreparationSession | null>;
  };
  tasks: PreparationTasks;
  environment: { PORT?: string; VIVENTIUM_SCHEDULER_SECRET?: string };
  getRequiredPromptText: (id: string) => string;
  begin: (session: CallPreparationSession) => Promise<CallPreparationSession>;
  bindStream: (session: CallPreparationSession, streamId: string) => Promise<void>;
  recordRelease: (session: CallPreparationSession) => Promise<boolean>;
  readResultMessage: (
    session: CallPreparationSession,
    messageId: string,
  ) => Promise<{ messageId: string } | null>;
}

interface CallPreparationDispatch {
  callSessionId: string;
  userId: string;
  conversationId: string;
  agentId: string;
  idempotencyKey: string;
  authoringDeadlineAt: string;
}

export function isCurrentCallPreparationDispatch(
  session: CallPreparationSession | null,
  dispatch: CallPreparationDispatch,
  now = Date.now(),
): boolean {
  const binding = session?.contextPreparation;
  return Boolean(
    session && binding?.version === 1 &&
    session.status !== 'ended' && session.mode !== 'listen_only' &&
    session.callSessionId === dispatch.callSessionId &&
    session.userId === dispatch.userId &&
    session.conversationId === dispatch.conversationId &&
    session.agentId === dispatch.agentId &&
    binding.idempotencyKey === dispatch.idempotencyKey &&
    binding.deadlineAt === dispatch.authoringDeadlineAt &&
    new Date(binding.deadlineAt).getTime() > now &&
    !binding.releasedStreamId,
  );
}

export function createCallPreparationRuntime(bridge: CallPreparationRuntimeBridge) {
  const { calls, tasks } = bridge;
  // Retain the exact native stop receipt across bounded ingress retries.
  const cancellations = new Map<string, Promise<boolean>>();
  const scope = (session: CallPreparationSession) => ({
    callSessionId: session.callSessionId,
    userId: session.userId,
  });
  const taskFor = async (session: CallPreparationSession) =>
    tasks.hydrateVoiceTaskByStreamId(
      session.contextPreparation!.streamId || session.contextPreparation!.idempotencyKey,
      { ...scope(session), requireDurable: true },
    );

  async function readResult(session: CallPreparationSession) {
    const task = await taskFor(session);
    if (task?.state === 'completed' && tasks.snapshotEvent(task.taskId)?.resultMessageId) {
      const message = await bridge.readResultMessage(
        session,
        tasks.snapshotEvent(task.taskId)!.resultMessageId!,
      );
      if (message) return { prepared: true as const, responseMessageId: message.messageId };
    }
    if (
      task &&
      ['failed', 'cancelled_confirmed', 'cancelled_unenforceable', 'cancelling'].includes(
        task.state,
      )
    ) {
      if (!session.contextPreparation?.streamId || (await cancel(session)))
        return { prepared: false as const };
      throw callPreparationFailure('call_context_busy', 'Context gathering is still stopping.');
    }
    return null;
  }

  async function cancel(session: CallPreparationSession) {
    const streamId = session.contextPreparation?.streamId;
    if (!streamId) return false;
    const current = await calls.getCallSession(session.callSessionId);
    if (!current || current.userId !== session.userId ||
      current.conversationId !== session.conversationId ||
      current.contextPreparation?.idempotencyKey !== session.contextPreparation?.idempotencyKey ||
      current.contextPreparation?.streamId !== streamId) return false;
    // Absence of a job is not release proof. The exact native acknowledgement survives restart.
    if (current.contextPreparation.releasedStreamId === streamId) return true;
    const job = await GenerationJobManager.getJob(streamId);
    let receipt = cancellations.get(streamId);
    if (!receipt) {
      if (!job) {
        const task = await taskFor(session);
        return Boolean(task && ['completed', 'cancelled_confirmed'].includes(task.state));
      }
      if (job.metadata?.userId !== session.userId ||
        job.metadata?.conversationId !== session.conversationId) return false;
      if (job.status === 'complete') return bridge.recordRelease(session);
      receipt = (async () => {
        const task = await taskFor(session);
        // Suppress progress/final failure before stopping the existing generation owner.
        if (task) tasks.cancelVoiceTask(task.taskId, { userId: session.userId });
        await tasks.flushVoiceTaskPersistence();
        const result = await GenerationJobManager.abortJob(streamId, 'user_cancelled', session.userId);
        if (task)
          await tasks.settleVoiceTaskCancellation(task.taskId, {
            confirmed: result?.success === true,
            detail: result?.success === true
              ? 'Context gathering stopped.'
              : 'Stopping context gathering could not be confirmed.',
          });
        return result?.success === true;
      })();
      cancellations.set(streamId, receipt);
      void receipt.then((confirmed) => {
        if (!confirmed) cancellations.delete(streamId);
      }).catch(() => cancellations.delete(streamId));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Match the existing scheduler's native stop acknowledgement budget, without archiving chat.
      const stopped = await Promise.race([receipt, new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 8000);
      })]);
      if (!stopped) return false;
      // Failure remains failure. Keep this exact receipt until its durable release write succeeds.
      const recorded = await bridge.recordRelease(session);
      if (recorded) cancellations.delete(streamId);
      return recorded;
    } finally {
      clearTimeout(timer);
    }
  }

  async function waitForResult(
    session: CallPreparationSession,
    signal: AbortSignal,
    progress = false,
  ): Promise<PreparationResult> {
    const saved = await readResult(session);
    if (saved) return saved;
    const streamId = session.contextPreparation!.streamId!;
    const job = await GenerationJobManager.getJob(streamId);
    if (
      !job ||
      job.metadata?.userId !== session.userId ||
      job.metadata?.conversationId !== session.conversationId
    )
      throw callPreparationFailure('call_context_unavailable', 'Context gathering is unavailable.');
    const task = await taskFor(session);
    return new Promise<PreparationResult>((resolve, reject) => {
      let subscription: { unsubscribe: () => void } | null | undefined;
      let settled = false;
      const onAbort = () => {
        subscription?.unsubscribe();
        reject(
          callPreparationFailure('call_context_interrupted', 'Context gathering was interrupted.'),
        );
      };
      signal.addEventListener('abort', onAbort, { once: true });
      const finish = async (event: ServerSentEvent) => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        signal.removeEventListener('abort', onAbort);
        const response = (
          event as ServerSentEvent & {
            responseMessage?: { messageId?: string; error?: boolean; unfinished?: boolean };
          }
        ).responseMessage;
        if (!response?.messageId || response.error === true || response.unfinished === true) {
          if (task)
            tasks.failVoiceTask(task.taskId, {
              code: 'call_context_failed',
              message: 'Context gathering did not finish. Voice continues with available context.',
            });
          if (await cancel(session)) resolve({ prepared: false });
          else
            reject(
              callPreparationFailure('call_context_busy', 'Context gathering is still stopping.'),
            );
          return;
        }
        // The existing controller publishes final only after canonical result persistence.
        if (task) tasks.completeVoiceTask(task.taskId, { resultMessageId: response.messageId });
        await tasks.flushVoiceTaskPersistence();
        resolve({ prepared: true, responseMessageId: response.messageId });
      };
      GenerationJobManager.subscribe(
        streamId,
        (event) => {
          // Display progress does not publish audio follow-up sources from this silent lineage.
          if (
            progress &&
            task &&
            [
              'on_run_step',
              'on_run_step_completed',
              'on_tool_start',
              'on_tool_end',
              'on_source',
              'source',
              'on_citation',
              'citation',
            ].includes(event?.event || '')
          ) {
            // This is a display projection only. Keep native tool/source fields unchanged.
            const presented = ['on_run_step', 'on_run_step_completed'].includes(event.event || '')
              ? { ...event, data: { ...(event.data as Record<string, unknown>), name: CALL_PREPARATION_LABEL } }
              : event;
            tasks.observeGenerationEvent(task.taskId, presented as ServerSentEvent);
          }
        },
        (event) => {
          void finish(event).catch(reject);
        },
        () => {
          subscription?.unsubscribe();
          signal.removeEventListener('abort', onAbort);
          reject(
            callPreparationFailure(
              'call_context_failed',
              'Context gathering did not finish. Voice continues with available context.',
            ),
          );
        },
        signal,
      )
        .then((result) => {
          subscription = result;
          if (!result)
            reject(
              callPreparationFailure(
                'call_context_unavailable',
                'Context gathering is unavailable.',
              ),
            );
          if (settled) subscription?.unsubscribe();
          if (signal.aborted) onAbort();
        })
        .catch(reject);
    });
  }

  const failure = async (session: CallPreparationSession, error: Error) => {
    const task = await taskFor(session);
    if (task)
      tasks.failVoiceTask(task.taskId, {
        code: (error as Error & { code?: string }).code || 'call_context_failed',
        message: (error as Error & { code?: string }).code === 'call_context_deadline'
          ? 'Context gathering reached its time limit. Voice continues with available context.'
          : 'Context gathering did not finish. Voice continues with available context.',
      });
    await tasks.flushVoiceTaskPersistence();
  };

  return createCallPreparationService({
    begin: bridge.begin,
    readSession: calls.getCallSession,
    readResult,
    cancel,
    waitForResult,
    admit: async (session) => {
      const current = await calls.getCallSession(session.callSessionId);
      if (!current || current.status === 'ended' || current.mode === 'listen_only')
        throw callPreparationFailure('call_ended', 'This call is no longer requesting context.');
      const binding = session.contextPreparation!;
      const deadline = new Date(binding.deadlineAt).getTime();
      const port = Number(bridge.environment.PORT || 3080);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw callPreparationFailure(
          'call_context_unavailable',
          'Context gathering is unavailable.',
        );
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/viventium/scheduler/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-VIVENTIUM-SCHEDULER-SECRET': bridge.environment.VIVENTIUM_SCHEDULER_SECRET || '',
          },
          body: JSON.stringify({
            userId: session.userId,
            agentId: session.agentId,
            conversationId: session.conversationId,
            callPreparation: { callSessionId: session.callSessionId },
            text: bridge.getRequiredPromptText(binding.promptId),
            titleText: 'Conversation context',
            idempotencyKey: binding.idempotencyKey,
            sourceEventId: binding.idempotencyKey,
            authoringDeadlineAt: binding.deadlineAt,
            externalWorkRequired: false,
            deliveryChannels: ['librechat'],
          }),
          signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))),
        });
      } catch {
        response = await fetch(
          `http://127.0.0.1:${port}/api/viventium/scheduler/dispatches/${encodeURIComponent(binding.idempotencyKey)}?userId=${encodeURIComponent(session.userId)}`,
          {
            headers: {
              'X-VIVENTIUM-SCHEDULER-SECRET': bridge.environment.VIVENTIUM_SCHEDULER_SECRET || '',
            },
            signal: AbortSignal.timeout(5000),
          },
        );
      }
      if (!response.ok)
        throw callPreparationFailure(
          'call_context_unavailable',
          'Context gathering could not start.',
        );
      const accepted = (await response.json()) as { streamId?: string; conversationId?: string };
      if (!accepted.streamId || !accepted.conversationId || accepted.conversationId === 'new')
        throw callPreparationFailure(
          'call_context_busy',
          'This conversation is busy. Start a new call after its response finishes.',
        );
      return { streamId: accepted.streamId, conversationId: accepted.conversationId };
    },
    bind: async (session, accepted) => {
      const claimed = await calls.materializeCallSessionConversationId(
        session.callSessionId,
        accepted.conversationId,
      );
      if (
        !claimed ||
        claimed.conversationId !== accepted.conversationId ||
        claimed.status === 'ended' ||
        claimed.mode === 'listen_only'
      ) {
        await GenerationJobManager.abortJob(accepted.streamId, 'user_cancelled', session.userId);
        throw callPreparationFailure('call_ended', 'This call has ended.');
      }
      const pending = await taskFor(session);
      const task =
        pending ||
        tasks.createVoiceTask({
          ...scope(session),
          conversationId: accepted.conversationId,
          label: CALL_PREPARATION_LABEL,
          turnId: session.contextPreparation!.idempotencyKey,
          streamId: accepted.streamId,
          owner: { kind: 'generation_job', id: accepted.streamId },
        });
      const bound = tasks.bindVoiceTaskStream(task.taskId, accepted.streamId, {
        ...scope(session),
        conversationId: accepted.conversationId,
      });
      if (!bound) {
        const stopped = await GenerationJobManager.abortJob(
          accepted.streamId,
          'user_cancelled',
          session.userId,
        );
        await tasks.settleVoiceTaskCancellation(task.taskId, {
          confirmed: stopped?.success === true,
          detail: 'Context gathering stopped.',
        });
        throw callPreparationFailure(
          'call_context_interrupted',
          'Context gathering was interrupted.',
        );
      }
      await bridge.bindStream(session, accepted.streamId);
      await tasks.flushVoiceTaskPersistence();
      const current = await calls.getCallSession(session.callSessionId);
      if (!current || current.status === 'ended' || current.mode === 'listen_only')
        throw callPreparationFailure('call_ended', 'This call has ended.');
      return current;
    },
    observe: async (session) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => {
          void (async () => {
            await failure(session, callPreparationFailure('call_context_deadline',
              'Context gathering reached its time limit. Voice continues with available context.'));
            controller.abort('call_context_deadline');
            await cancel(session);
          })().catch(() => undefined);
        },
        Math.max(0, new Date(session.contextPreparation!.deadlineAt).getTime() - Date.now()),
      );
      try {
        await waitForResult(session, controller.signal, true);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    },
    failure,
  });
}
