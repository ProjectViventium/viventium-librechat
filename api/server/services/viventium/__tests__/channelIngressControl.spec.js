/**
 * === VIVENTIUM START ===
 * Feature: Durable channel transport control replies.
 * Purpose: Keep unsupported-media replies fixed, synthetic, and behind identity admission.
 * === VIVENTIUM END ===
 */

const { resolveChannelControlReply } = require('../channelIngressControl');

describe('resolveChannelControlReply', () => {
  it.each([
    'photo',
    'document',
    'voice note',
    'video',
    'audio',
    'animation',
    'sticker',
    'video message',
  ])('returns the fixed Telegram unsupported-media reply for %s', (mediaType) => {
    expect(
      resolveChannelControlReply({
        channel: 'telegram',
        authorizationSnapshot: { kind: 'paired', libreChatUserId: 'synthetic-user' },
        attachments: [{ kind: 'telegram_unsupported_media', mediaType }],
      }),
    ).toBe(
      `I can’t process this ${mediaType} in this Channels connection yet. Open Viventium to upload it safely.`,
    );
  });

  it.each([
    { channel: 'telegram', attachments: [] },
    {
      channel: 'telegram',
      authorizationSnapshot: { kind: 'unpaired' },
      attachments: [{ kind: 'telegram_unsupported_media', mediaType: 'photo' }],
    },
    {
      channel: 'telegram',
      authorizationSnapshot: { kind: 'paired', libreChatUserId: 'synthetic-user' },
      attachments: [{ kind: 'telegram_unsupported_media', mediaType: 'arbitrary input' }],
    },
    {
      channel: 'slack',
      authorizationSnapshot: { kind: 'paired', libreChatUserId: 'synthetic-user' },
      attachments: [{ kind: 'telegram_unsupported_media', mediaType: 'photo' }],
    },
  ])('rejects malformed or cross-provider control markers', (envelope) => {
    expect(resolveChannelControlReply(envelope)).toBe('');
  });
});
