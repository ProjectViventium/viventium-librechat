/* === VIVENTIUM START ===
 * Feature: Durable channel transport control replies.
 * Purpose: Resolve trusted transport markers only after the owning ingress path admits identity.
 * === VIVENTIUM END === */

const TELEGRAM_UNSUPPORTED_MEDIA_TYPES = new Set([
  'photo',
  'document',
  'voice note',
  'video',
  'audio',
  'animation',
  'sticker',
  'video message',
]);

function resolveChannelControlReply(envelope) {
  if (
    envelope?.channel !== 'telegram' ||
    envelope.authorizationSnapshot?.kind !== 'paired' ||
    !envelope.authorizationSnapshot.libreChatUserId ||
    !Array.isArray(envelope.attachments)
  ) {
    return '';
  }
  const marker = envelope.attachments.find(
    (attachment) => attachment?.kind === 'telegram_unsupported_media',
  );
  const mediaType = typeof marker?.mediaType === 'string' ? marker.mediaType : '';
  if (!TELEGRAM_UNSUPPORTED_MEDIA_TYPES.has(mediaType)) {
    return '';
  }
  return `I can’t process this ${mediaType} in this Channels connection yet. Open Viventium to upload it safely.`;
}

module.exports = { resolveChannelControlReply };
