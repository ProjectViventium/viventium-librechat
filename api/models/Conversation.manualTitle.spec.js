jest.mock('./Message', () => ({ getMessages: jest.fn().mockResolvedValue([]) }));
jest.mock('~/db/models', () => ({
  Conversation: { findOneAndUpdate: jest.fn(), bulkWrite: jest.fn() },
}));
jest.mock('~/server/services/viventium/conversationRecallService', () => ({}));

const { Conversation } = require('~/db/models');
const { saveConvo, bulkSaveConvos } = require('./Conversation');

describe('general conversation saves preserve explicit title authority', () => {
  it.each([true, false])(
    'ignores client marker %j while saving ordinary fields and unsets',
    async (value) => {
      Conversation.findOneAndUpdate.mockResolvedValue({ toObject: () => ({ model: 'new-model' }) });
      const unsetFields = { titleSetByUser: 1, temperature: 1 };
      await saveConvo(
        { user: { id: 'owner' }, body: {} },
        { conversationId: 'conversation', titleSetByUser: value, model: 'new-model' },
        { unsetFields },
      );
      expect(Conversation.findOneAndUpdate).toHaveBeenCalledWith(
        { user: 'owner', conversationId: 'conversation' },
        {
          $set: { model: 'new-model', messages: [], user: 'owner', expiredAt: null },
          $unset: { temperature: 1 },
        },
        { new: true, upsert: true },
      );
      expect(unsetFields).toEqual({ titleSetByUser: 1, temperature: 1 });
    },
  );

  it('does not accept title authority from imported or duplicated conversation payloads', async () => {
    const input = {
      user: 'owner',
      conversationId: 'conversation',
      title: 'New Chat',
      titleSetByUser: false,
    };
    Conversation.bulkWrite.mockResolvedValue({ modifiedCount: 1 });
    await bulkSaveConvos([input]);
    expect(Conversation.bulkWrite).toHaveBeenCalledWith([
      {
        updateOne: {
          filter: { conversationId: 'conversation', user: 'owner' },
          update: { user: 'owner', conversationId: 'conversation', title: 'New Chat' },
          upsert: true,
          timestamps: false,
        },
      },
    ]);
    expect(input.titleSetByUser).toBe(false);
  });
});
