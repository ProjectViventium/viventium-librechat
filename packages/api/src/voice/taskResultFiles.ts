/* === VIVENTIUM START === Saved task results expose filenames through the existing call scope. === */
import { z } from 'zod';
import type { IMessage } from '@librechat/data-schemas';
import type { TFile } from 'librechat-data-provider';
import type { DeliveryAcknowledgementResult } from '../stream/interfaces/IJobStore';

type ResultIdentity = {
  user: string;
  conversationId: string;
  messageId: string;
};
type ResultMessageFilter = ResultIdentity & {
  isCreatedByUser: false;
  unfinished: { $ne: true };
  error: { $ne: true };
  'metadata.viventium.visibility': { $ne: 'internal' };
};
type ResultFileFilter = ResultIdentity & { file_id: { $in: string[] } };
type Dependencies = {
  conversationExists: (filter: Omit<ResultIdentity, 'messageId'>) => Promise<boolean>;
  getResultMessage: (filter: ResultMessageFilter) => Promise<Pick<IMessage, 'files' | 'attachments'> | null>;
  getResultFiles: (filter: ResultFileFilter) => Promise<Pick<TFile, 'file_id' | 'filename'>[]>;
};
type ResultScope = {
  userId: string;
  callSessionId: string;
  task: {
    taskId: string;
    userId: string;
    callSessionId: string;
    conversationId?: string;
  };
  event: {
    taskId: string;
    callSessionId: string;
    conversationId?: string;
    state: string;
    resultMessageId?: string;
  };
};
const fileRef = z.object({ file_id: z.string().min(1) });

export async function resolveVoiceTaskResultFilenames(
  { userId, callSessionId, task, event }: ResultScope,
  db: Dependencies,
): Promise<string[]> {
  if (
    !userId ||
    !callSessionId ||
    !task.taskId ||
    task.userId !== userId ||
    task.callSessionId !== callSessionId ||
    event.taskId !== task.taskId ||
    event.callSessionId !== callSessionId ||
    event.state !== 'completed' ||
    !event.resultMessageId ||
    !task.conversationId ||
    event.conversationId !== task.conversationId
  )
    return [];
  const identity = {
    user: userId,
    conversationId: task.conversationId,
    messageId: event.resultMessageId,
  };
  if (
    !(await db.conversationExists({
      user: userId,
      conversationId: task.conversationId,
    }))
  )
    return [];
  const message = await db.getResultMessage({
    ...identity,
    isCreatedByUser: false,
    unfinished: { $ne: true },
    error: { $ne: true },
    'metadata.viventium.visibility': { $ne: 'internal' },
  });
  if (!message) return [];
  const ids = [
    ...new Set(
      [message.files, message.attachments].flatMap((entries) =>
        Array.isArray(entries) ? entries.flatMap((entry) => {
          const parsed = fileRef.safeParse(entry);
          return parsed.success ? [parsed.data.file_id] : [];
        }) : [],
      ),
    ),
  ];
  if (!ids.length) return [];
  const files = await db.getResultFiles({ ...identity, file_id: { $in: ids } });
  const byId = new Map(files.map((file) => [file.file_id, file.filename]));
  return ids.flatMap((id) => {
    const filename = byId.get(id);
    return typeof filename === 'string' && filename.trim() ? [filename] : [];
  });
}

type PresentationTask = ResultScope['task'] & {
  state: string;
  streamId?: string;
  logicalTurnId?: string;
  suppressed?: boolean;
  owner: { kind: string; id?: string };
  current?: { resultMessageId?: string; error?: { code?: string } };
};

export function voiceTaskCommittedPresentationKey(
  result: DeliveryAcknowledgementResult,
  task: PresentationTask | null | undefined,
): string | null {
  const acknowledgement = result?.acknowledgement;
  const presentation = result?.presentation;
  const context = presentation?.interactionContext;
  if (
    result?.status !== 'recorded' ||
    result.transportOnly === true ||
    !acknowledgement ||
    !['committed', 'committed_effect'].includes(acknowledgement.state) ||
    !Number.isSafeInteger(acknowledgement.revision) ||
    acknowledgement.revision < 1 ||
    context?.surface !== 'voice' ||
    context.conversation_id !== presentation?.conversationId ||
    !context.logical_turn_id ||
    acknowledgement.logical_turn_id !== context.logical_turn_id ||
    acknowledgement.revision !== context.revision ||
    !result.ownerStreamId ||
    !presentation?.userId ||
    !presentation.conversationId ||
    !presentation.responseMessageId ||
    !task?.taskId ||
    !task.callSessionId ||
    task.suppressed === true ||
    task.state !== 'completed' ||
    task.current?.error ||
    task.userId !== presentation.userId ||
    task.conversationId !== presentation.conversationId ||
    task.logicalTurnId !== context.logical_turn_id ||
    task.streamId !== result.ownerStreamId ||
    task.owner.id !== task.streamId ||
    !['generation_job', 'remote_generation'].includes(task.owner.kind) ||
    task.current?.resultMessageId !== presentation.responseMessageId
  )
    return null;
  return `voice_presentation:${acknowledgement.revision}:${presentation.responseMessageId}`;
}
/* === VIVENTIUM END === */
