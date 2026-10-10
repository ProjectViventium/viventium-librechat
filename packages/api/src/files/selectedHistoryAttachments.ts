import { z } from 'zod';
import type { IMongoFile } from '@librechat/data-schemas';
import { getThreadData } from '~/utils/message';

type Attachment = Pick<IMongoFile, 'file_id' | 'filename' | 'type' | 'bytes' | 'source' | 'context' | 'text'>;
type ThreadMessage = Parameters<typeof getThreadData>[0][number] & { attachments?: unknown };
type HistoryScope = { userId: string; conversationId?: string; parentMessageId?: string };
type Dependencies = {
  getMessages: (filter: { user: string; conversationId: string }, select: string) => Promise<ThreadMessage[] | null>;
  getFiles: (filter: { user: string; file_id: { $in: string[] } }, sort: null, select: string) => Promise<Attachment[] | null>;
};
const uuid = z.string().uuid();
const fileRef = z.object({ file_id: z.union([uuid, z.string().regex(/^native_[a-f0-9]{64}$/)]) });

/** Reuse selected-branch traversal, then resolve current File ownership and deletion state. */
export async function resolveSelectedHistoryAttachments(scope: HistoryScope, db: Dependencies): Promise<Attachment[]> {
  const conversationId = uuid.safeParse(scope.conversationId);
  const parentMessageId = uuid.safeParse(scope.parentMessageId);
  if (!scope.userId || !conversationId.success || !parentMessageId.success) {
    return [];
  }
  const messages = await db.getMessages(
    { user: scope.userId, conversationId: conversationId.data },
    'messageId parentMessageId files attachments',
  );
  const history = (messages || []).map((message) => ({
    ...message,
    files: [message.files, message.attachments].flatMap((entries) =>
      Array.isArray(entries) ? entries.flatMap((entry) => {
        const parsed = fileRef.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }) : [],
    ),
  }));
  const ids = getThreadData(history, parentMessageId.data).fileIds.slice(0, 64);
  if (!ids.length) return [];
  const files = await db.getFiles(
    { user: scope.userId, file_id: { $in: ids } }, null,
    'file_id filename type bytes source context text',
  );
  const byId = new Map((files || []).map((file) => [file.file_id, file]));
  return ids.flatMap((id) => {
    const file = byId.get(id);
    return file ? [file] : [];
  });
}
