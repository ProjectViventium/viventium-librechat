/* VIVENTIUM START: compatible defaults for the three independent Telegram voice controls. */
const mongoose = require('mongoose');
const createTelegramUserMapping = require('./telegramUserMapping');
const Mapping = createTelegramUserMapping(mongoose.createConnection());

const identity = {
  telegramUserId: 'synthetic-telegram-user',
  libreChatUserId: new mongoose.Types.ObjectId(),
};

test('new mappings default every optional voice control to enabled', () => {
  const mapping = new Mapping(identity);
  expect(mapping.alwaysVoiceResponse).toBe(true);
  expect(mapping.replyVoiceWithVoice).toBe(true);
  expect(mapping.voiceResponsesEnabled).toBe(true);
});

test.each([true, false])('explicit legacy voice values %s survive the new default', (saved) => {
  const mapping = new Mapping({
    ...identity,
    alwaysVoiceResponse: saved,
    voiceResponsesEnabled: saved,
  });
  expect(mapping.alwaysVoiceResponse).toBe(saved);
  expect(mapping.voiceResponsesEnabled).toBe(saved);
  expect(mapping.replyVoiceWithVoice).toBe(true);
});
/* VIVENTIUM END */
