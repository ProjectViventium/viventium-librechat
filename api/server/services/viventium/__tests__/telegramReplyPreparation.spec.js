/* === VIVENTIUM START ===
 * Feature: Telegram reply evidence from a retained input's durable ingress preparation.
 * Purpose: Only an explicit reply becomes quoted evidence; its sender kind comes from what Telegram
 * reported, and the adapter's descriptor can add nothing beyond extracted document text.
 * === VIVENTIUM END === */
const {
  preparedTelegramReplyDescriptor,
  quotedAttachmentTexts,
} = require('../telegramReplyPreparation');

const OWNER = '424242';

function preparation(message) {
  return {
    message: {
      message_id: 20,
      date: 1790665900,
      text: 'Does that still hold?',
      from: { id: Number(OWNER), is_bot: false },
      ...message,
    },
  };
}

describe('preparedTelegramReplyDescriptor', () => {
  test('the passage the user selected is the quote, not the whole replied message', () => {
    expect(
      preparedTelegramReplyDescriptor(
        preparation({
          quote: { text: 'Elm is 7 over', position: 34, is_manual: true },
          reply_to_message: {
            message_id: 12,
            date: 1790665800,
            text: 'Willow fits 450 with 8 left; Elm is 7 over.',
            from: { id: 9, is_bot: true },
          },
        }),
        OWNER,
      ),
    ).toMatchObject({ repliedTelegramMessageId: '12', quoteText: 'Elm is 7 over' });
  });

  test('a continued input keeps its ready record’s document text without any request descriptor', () => {
    const quoted = preparation({
      reply_to_message: {
        message_id: 12,
        date: 1790665800,
        caption: 'Rate card',
        from: { id: 9, is_bot: true },
        document: { file_id: 'doc-1', file_name: 'rates.pdf' },
      },
    });
    const adapter = {
      repliedTelegramMessageId: '12',
      attachments: [{ kind: 'document', fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' }],
    };
    // What the ready record keeps from the first admission's adapter descriptor.
    const stored = quotedAttachmentTexts(quoted, adapter);
    expect(stored).toEqual([{ fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' }]);
    // The actual identity-only continuation carries no descriptor.
    expect(preparedTelegramReplyDescriptor(quoted, OWNER, undefined, stored).attachments).toEqual([
      { kind: 'document', fileId: 'doc-1', filename: 'rates.pdf', extractedText: 'Willow 4.10 per booklet' },
    ]);
    // Stored text of another file never attaches to this one.
    expect(
      preparedTelegramReplyDescriptor(quoted, OWNER, undefined, [
        { fileId: 'doc-2', extractedText: 'Unrelated' },
      ]).attachments,
    ).toEqual([{ kind: 'document', fileId: 'doc-1', filename: 'rates.pdf' }]);
  });

  test('a forum topic message that replies to nothing is not a reply to its topic root', () => {
    expect(
      preparedTelegramReplyDescriptor(
        preparation({
          message_thread_id: 7,
          is_topic_message: true,
          reply_to_message: { message_id: 7, date: 1790665000, from: { id: 1, is_bot: false } },
        }),
        OWNER,
      ),
    ).toBeNull();
  });

  test('an explicit reply inside a forum topic is a reply', () => {
    expect(
      preparedTelegramReplyDescriptor(
        preparation({
          message_thread_id: 7,
          is_topic_message: true,
          reply_to_message: {
            message_id: 12,
            date: 1790665800,
            text: 'Willow fits.',
            from: { id: 9, is_bot: true },
          },
        }),
        OWNER,
      ),
    ).toMatchObject({
      repliedTelegramMessageId: '12',
      quoteText: 'Willow fits.',
      senderKind: 'unknown',
    });
  });

  test.each([
    ['the owner', { id: Number(OWNER), is_bot: false }, undefined, 'owner_candidate'],
    ['another person', { id: 77, is_bot: false }, undefined, 'external_candidate'],
    [
      'a bot the adapter says is not itself',
      { id: 78, is_bot: true },
      'external_candidate',
      'external_candidate',
    ],
    ['a bot that may be the assistant', { id: 79, is_bot: true }, 'assistant_candidate', 'unknown'],
    [
      'a bot the adapter falsely calls the owner',
      { id: 80, is_bot: true },
      'owner_candidate',
      'unknown',
    ],
  ])(
    'classifies a reply to %s from Telegram’s own sender data',
    (_name, from, adapterKind, expected) => {
      const descriptor = preparedTelegramReplyDescriptor(
        preparation({
          reply_to_message: { message_id: 12, date: 1790665800, text: 'Quoted.', from },
        }),
        OWNER,
        adapterKind ? { repliedTelegramMessageId: '12', senderKind: adapterKind } : undefined,
      );
      expect(descriptor.senderKind).toBe(expected);
    },
  );

  test('a channel-signed message stays unknown', () => {
    expect(
      preparedTelegramReplyDescriptor(
        preparation({
          reply_to_message: {
            message_id: 12,
            date: 1790665800,
            text: 'Channel post.',
            from: { id: Number(OWNER), is_bot: false },
            sender_chat: { id: -100, type: 'channel' },
          },
        }),
        OWNER,
      ).senderKind,
    ).toBe('unknown');
  });

  test('the adapter adds extracted text only for that same replied file', () => {
    const descriptor = preparedTelegramReplyDescriptor(
      preparation({
        reply_to_message: {
          message_id: 12,
          date: 1790665800,
          caption: 'Rate card',
          from: { id: 9, is_bot: true },
          document: { file_id: 'doc-1', file_name: 'rates.pdf' },
        },
      }),
      OWNER,
      {
        repliedTelegramMessageId: '12',
        attachments: [
          { kind: 'document', fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' },
          { kind: 'document', fileId: 'doc-2', extractedText: 'Unrelated' },
        ],
      },
    );
    expect(descriptor.attachments).toEqual([
      {
        kind: 'document',
        fileId: 'doc-1',
        filename: 'rates.pdf',
        extractedText: 'Willow 4.10 per booklet',
      },
    ]);
    const otherMessage = preparedTelegramReplyDescriptor(
      preparation({
        reply_to_message: {
          message_id: 12,
          date: 1790665800,
          from: { id: 9, is_bot: true },
          document: { file_id: 'doc-1' },
        },
      }),
      OWNER,
      {
        repliedTelegramMessageId: '13',
        attachments: [{ kind: 'document', fileId: 'doc-1', extractedText: 'Other message text' }],
      },
    );
    expect(otherMessage.attachments).toEqual([{ kind: 'document', fileId: 'doc-1' }]);
  });
});
/* === VIVENTIUM END === */
