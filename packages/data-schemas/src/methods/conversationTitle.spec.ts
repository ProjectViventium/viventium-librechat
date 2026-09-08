import mongoose from 'mongoose';
import type { IConversation } from '~/types/convo';
import convoSchema from '~/schema/convo';
import {
  omitUserTitleMarker,
  saveGeneratedConversationTitle,
  saveUserConversationTitle,
} from './conversationTitle';

const Conversation = mongoose.model<IConversation>('TitleOwnerUnit', convoSchema);

describe('conversation title owner', () => {
  it.each([true, false, 1])(
    'removes a general marker assignment %j without changing other fields',
    (value) => {
      const fields = { titleSetByUser: value, model: 'selected-model', temperature: 0.5 };
      expect(omitUserTitleMarker(fields)).toEqual({ model: 'selected-model', temperature: 0.5 });
      expect(fields.titleSetByUser).toBe(value);
    },
  );
  it('keeps explicit title authority out of ordinary conversation projections', () => {
    expect(convoSchema.path('titleSetByUser')?.options.select).toBe(false);
  });

  it.each(['New Chat', 'User chosen title', ''])(
    'sets user authority atomically for the explicit title %j',
    async (title) => {
      const saved = new Conversation({ user: 'owner', conversationId: 'conversation', title });
      const write = jest.spyOn(Conversation, 'findOneAndUpdate').mockResolvedValue(saved);
      expect(await saveUserConversationTitle(Conversation, 'owner', 'conversation', title)).toBe(
        saved,
      );
      expect(write).toHaveBeenCalledWith(
        { user: 'owner', conversationId: 'conversation' },
        { $set: { title, titleSetByUser: true } },
        { new: true },
      );
    },
  );

  it('does not upsert a missing explicit rename target', async () => {
    jest.spyOn(Conversation, 'findOneAndUpdate').mockResolvedValue(null);
    expect(
      await saveUserConversationTitle(Conversation, 'owner', 'missing', 'New Chat'),
    ).toBeNull();
  });

  it.each(['New Chat', 'User chosen title', ''])(
    'returns the current durable title %j after losing the generated write',
    async (title) => {
      const write = jest.spyOn(Conversation, 'findOneAndUpdate').mockResolvedValue(null);
      const query = Conversation.findOne({});
      jest.spyOn(query, 'lean').mockResolvedValue({ title });
      jest.spyOn(Conversation, 'findOne').mockReturnValue(query);
      expect(
        await saveGeneratedConversationTitle(Conversation, 'owner', 'conversation', 'Generated'),
      ).toBe(title);
      expect(write).toHaveBeenCalledWith(
        {
          user: 'owner',
          conversationId: 'conversation',
          title: { $in: [null, '', 'New Chat'] },
          titleSetByUser: { $ne: true },
        },
        { $set: { title: 'Generated' } },
        { new: true },
      );
      expect(Conversation.findOne).toHaveBeenLastCalledWith(
        { user: 'owner', conversationId: 'conversation' },
        'title',
      );
    },
  );
});
