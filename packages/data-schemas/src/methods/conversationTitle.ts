import type { Model } from 'mongoose';
import type { IConversation } from '~/types/convo';

export function omitUserTitleMarker<T extends object>(fields: T): Omit<T, 'titleSetByUser'> {
  const result = { ...fields };
  Reflect.deleteProperty(result, 'titleSetByUser');
  return result;
}

/** Record explicit title authority atomically without changing retention or creating a conversation. */
export async function saveUserConversationTitle(
  Conversation: Model<IConversation>,
  user: string,
  conversationId: string,
  title: string,
): Promise<IConversation | null> {
  return Conversation.findOneAndUpdate(
    { user, conversationId },
    { $set: { title, titleSetByUser: true } },
    { new: true },
  );
}

/** Persist an automatic title only while its owner-scoped conversation is still untitled. */
export async function saveGeneratedConversationTitle(
  Conversation: Model<IConversation>,
  user: string,
  conversationId: string,
  title: string,
): Promise<string | null> {
  const owner = { user, conversationId };
  const saved = await Conversation.findOneAndUpdate(
    { ...owner, title: { $in: [null, '', 'New Chat'] }, titleSetByUser: { $ne: true } },
    { $set: { title } },
    { new: true },
  );
  const current = saved ?? (await Conversation.findOne(owner, 'title').lean());
  return current?.title ?? null;
}
