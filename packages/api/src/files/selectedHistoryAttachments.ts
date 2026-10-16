import { z } from 'zod';
import type { IMongoFile } from '@librechat/data-schemas';
import { getThreadData } from '~/utils/message';

/* === VIVENTIUM START === Retained files preserve owned source-local position. === */
type Attachment = Pick<IMongoFile, 'file_id' | 'filename' | 'type' | 'bytes' | 'source' | 'context' | 'text' | 'messageId'> & { media_group_index?: number };
type ThreadMessage = Parameters<typeof getThreadData>[0][number] & { attachments?: unknown };
type HistoryScope = { userId: string; conversationId?: string; parentMessageId?: string };
type Dependencies = {
  getMessages: (filter: { user: string; conversationId: string }, select: string) => Promise<ThreadMessage[] | null>;
  getFiles: (filter: { user: string; file_id: { $in: string[] } }, sort: null, select: string) => Promise<Attachment[] | null>;
};
const uuid = z.string().uuid();
const fileRef = z.object({
  file_id: z.union([uuid, z.string().regex(/^native_[a-f0-9]{64}$/)]),
  media_group_index: z.unknown().optional(),
  viventium_media_group_index: z.unknown().optional(),
});

// One invocation may cost its selected files before signed capability refresh. Reuse that exact
// owner/branch/selection read; another request always resolves current ownership/deletion again.
const requestHistoryAttachments = new WeakMap<object, Map<string, {
  getMessages: Dependencies['getMessages']; getFiles: Dependencies['getFiles']; promise: Promise<Attachment[]>;
}>>();

/** Reuse selected-branch traversal, then resolve current File ownership and deletion state. */
export async function resolveSelectedHistoryAttachments(
  scope: HistoryScope, db: Dependencies, fileIds?: string[], request?: object,
): Promise<Attachment[]> {
  if (request && typeof request === 'object') {
    let cachedEntries = requestHistoryAttachments.get(request);
    if (!cachedEntries) { cachedEntries = new Map(); requestHistoryAttachments.set(request, cachedEntries); }
    const entries = cachedEntries;
    const key = JSON.stringify([scope.userId, scope.conversationId, scope.parentMessageId, fileIds ?? null]);
    const prior = entries.get(key);
    if (prior?.getMessages === db.getMessages && prior.getFiles === db.getFiles) return prior.promise;
    const promise = resolveSelectedHistoryAttachments(scope, db, fileIds).catch(error => {
      if (entries.get(key)?.promise === promise) entries.delete(key);
      throw error;
    });
    entries.set(key, { getMessages: db.getMessages, getFiles: db.getFiles, promise });
    return promise;
  }

  const conversationId = uuid.safeParse(scope.conversationId);
  const parentMessageId = uuid.safeParse(scope.parentMessageId);
  if (!scope.userId || !conversationId.success || !parentMessageId.success) {
    return [];
  }
  const messages = await db.getMessages(
    { user: scope.userId, conversationId: conversationId.data },
    'messageId parentMessageId files attachments',
  );
  const sourcePositions = new Map<string, Map<string, number>>();
  const history = (messages || []).map((message) => {
    const positions = new Map<string, number>();
    const explicitPositions = new Set<string>();
    const files = [message.files, message.attachments].flatMap((entries) =>
      Array.isArray(entries) ? entries.flatMap((entry, index) => {
        const parsed = fileRef.safeParse(entry);
        if (!parsed.success) return [];
        const originalIndex = [parsed.data.media_group_index, parsed.data.viventium_media_group_index]
          .find((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
        const ref = parsed.data.file_id;
        if (!positions.has(ref) || (originalIndex !== undefined && !explicitPositions.has(ref))) {
          positions.set(ref, originalIndex ?? index);
          if (originalIndex !== undefined) explicitPositions.add(ref);
        }
        return [{ file_id: parsed.data.file_id }];
      }) : [],
    );
    sourcePositions.set(message.messageId, positions);
    return { ...message, files };
  });
  const selectedIds = fileIds === undefined ? undefined : new Set(fileIds);
  const thread = getThreadData(history, parentMessageId.data);
  const historyIds = thread.fileIds;
  const originalPositions = new Map<string, number>();
  for (const messageId of [...thread.messageIds].reverse()) {
    for (const [fileId, position] of sourcePositions.get(messageId) || []) {
      if (!originalPositions.has(fileId)) originalPositions.set(fileId, position);
    }
  }
  const selectedMessages = new Set(thread.messageIds);
  const ids = (selectedIds ? historyIds.filter((id) => selectedIds.has(id)) : historyIds).slice(0, 64);
  if (!ids.length) return [];
  const files = await db.getFiles(
    { user: scope.userId, file_id: { $in: ids } }, null,
    'file_id filename type bytes source context text messageId',
  );
  const byId = new Map((files || []).map((file) => [file.file_id, file]));
  return ids.flatMap((id) => {
    const file = byId.get(id);
    if (!file) return [];
    const boundPosition = file.messageId && selectedMessages.has(file.messageId)
      ? sourcePositions.get(file.messageId)?.get(id) : undefined;
    const position = boundPosition ?? originalPositions.get(id);
    return position === undefined ? [file] : [{ ...file, media_group_index: position }];
  });
}

/* === VIVENTIUM START === Exact mission file selection reuses owned selected-branch ancestry. === */
export async function resolveSelectedDelegationAttachments(
  scope: HistoryScope,
  currentFiles: Attachment[],
  fileIds: string[] | undefined,
  db: Dependencies,
  allCurrentFiles: Attachment[] = currentFiles,
): Promise<{ files: Attachment[] } | { error: 'delegation_file_selection_unauthorized' }> {
  if (fileIds === undefined) return { files: currentFiles };
  const currentById = new Map(currentFiles.map((file) => [file.file_id, file]));
  const currentTurnIds = new Set(allCurrentFiles.map((file) => file.file_id));
  if (fileIds.some((id) => currentTurnIds.has(id) && !currentById.has(id))) {
    return { error: 'delegation_file_selection_unauthorized' };
  }
  const currentIds = fileIds.filter((id) => currentById.has(id));
  const currentRows = currentIds.length
    ? await db.getFiles({ user: scope.userId, file_id: { $in: currentIds } }, null,
      'file_id filename type bytes source context text')
    : [];
  const verifiedCurrentIds = new Set((currentRows || []).map((file) => file.file_id));
  const history = fileIds.some((id) => !currentById.has(id))
    ? await resolveSelectedHistoryAttachments(scope, db, fileIds)
    : [];
  const historyById = new Map(history.map((file) => [file.file_id, file]));
  if (fileIds.some((id) => currentById.has(id) ? !verifiedCurrentIds.has(id) : !historyById.has(id))) {
    return { error: 'delegation_file_selection_unauthorized' };
  }
  const files = [...currentFiles, ...fileIds.flatMap((id) => {
    const file = currentById.has(id) ? undefined : historyById.get(id);
    return file ? [file] : [];
  })];
  return files.length > 64 ? { error: 'delegation_file_selection_unauthorized' } : { files };
}
/* === VIVENTIUM END === */
