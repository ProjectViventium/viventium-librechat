/* === VIVENTIUM START ===
 * Feature: Telegram reply evidence from a retained input's durable ingress preparation.
 * Purpose: A retained input's reply is read from the Telegram message Core saved at ingress, so its
 * first admission and every replay present the same quote: the passage the user selected when
 * Telegram reports one, otherwise the replied message. Sender kind comes from what Telegram reported
 * for the replied message. Text extracted from a quoted document comes from the input's ready record
 * (kept from the adapter's first descriptor) or, on first admission, from the adapter's descriptor of
 * that same message; the adapter may otherwise only mark a bot sender as not itself.
 * === VIVENTIUM END === */
const { normalizeTelegramReplyDescriptor } = require('@librechat/api');

const QUOTED_TELEGRAM_MEDIA = ['document', 'audio', 'video', 'voice', 'animation', 'sticker'];

function preparedTelegramReplyDescriptor(
  preparation,
  ownerTelegramUserId,
  adapterDescriptor,
  storedAttachmentTexts = [],
) {
  const message = preparation?.message;
  const replied = message?.reply_to_message;
  const repliedTelegramMessageId = String(replied?.message_id ?? '').trim();
  if (
    !replied ||
    typeof replied !== 'object' ||
    !/^[1-9]\d{0,18}$/.test(repliedTelegramMessageId)
  ) {
    return null;
  }
  // A forum topic message that replies to nothing still points at its topic's first message.
  if (
    message.is_topic_message === true &&
    String(message.message_thread_id ?? '').trim() === repliedTelegramMessageId
  ) {
    return null;
  }
  const adapter = normalizeTelegramReplyDescriptor(adapterDescriptor);
  const sameReply = adapter?.repliedTelegramMessageId === repliedTelegramMessageId ? adapter : null;
  const senderId = String(replied.from?.id ?? '').trim();
  let senderKind = 'unknown';
  if (!replied.sender_chat && senderId) {
    if (senderId === String(ownerTelegramUserId ?? '').trim()) {
      senderKind = 'owner_candidate';
    } else if (replied.from?.is_bot !== true || sameReply?.senderKind === 'external_candidate') {
      senderKind = 'external_candidate';
    }
  }
  const extractedTexts = [
    ...(Array.isArray(storedAttachmentTexts) ? storedAttachmentTexts : []),
    ...(sameReply?.attachments || []),
  ];
  const attachments = [];
  for (const kind of QUOTED_TELEGRAM_MEDIA) {
    const fileId = String(replied[kind]?.file_id ?? '').trim();
    if (!fileId) continue;
    const extracted = extractedTexts.find(
      (attachment) => attachment?.fileId === fileId && attachment.extractedText,
    );
    attachments.push({
      kind,
      fileId,
      ...(replied[kind].file_name ? { filename: String(replied[kind].file_name) } : {}),
      ...(extracted ? { extractedText: extracted.extractedText } : {}),
    });
  }
  const photo = Array.isArray(replied.photo) ? replied.photo[replied.photo.length - 1] : null;
  if (photo?.file_id) attachments.push({ kind: 'photo', fileId: String(photo.file_id) });
  const date = Number(replied.date);
  const selectedQuote = String(message.quote?.text ?? '');
  return normalizeTelegramReplyDescriptor({
    repliedTelegramMessageId,
    quoteText: selectedQuote || String(replied.text ?? replied.caption ?? ''),
    senderKind,
    ...(Number.isSafeInteger(date) && date > 0
      ? { timestamp: new Date(date * 1000).toISOString() }
      : {}),
    ...(attachments.length ? { attachments } : {}),
  });
}

/** The adapter's extracted text of this input's own quoted files, kept with its ready record. */
function quotedAttachmentTexts(preparation, adapterDescriptor) {
  const descriptor = preparedTelegramReplyDescriptor(preparation, '', adapterDescriptor);
  return (descriptor?.attachments || [])
    .filter((attachment) => attachment.fileId && attachment.extractedText)
    .map(({ fileId, extractedText }) => ({ fileId, extractedText }));
}

module.exports = { preparedTelegramReplyDescriptor, quotedAttachmentTexts };
