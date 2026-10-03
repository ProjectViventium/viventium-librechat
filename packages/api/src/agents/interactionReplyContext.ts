/* === VIVENTIUM START ===
 * Feature: Typed Telegram reply evidence.
 * Purpose: One bounded normalizer for a quoted reply, shared by a turn's trusted context and by each
 * retained source segment, so a combined turn keeps every source input's own quote.
 * === VIVENTIUM END === */

type UnknownRecord = Record<string, unknown>;

export type ReplyProvenanceStatus = 'verified' | 'platform_verified' | 'unverified';
export type ReplySenderRole = 'assistant_self' | 'owner_self' | 'third_party' | 'unknown';
export type ReplySourceKind = 'assistant_message' | 'schedule_result' | 'callback';

export interface InteractionReplyAttachment {
  readonly fileId?: string;
  readonly filename?: string;
  readonly kind?: string;
  readonly extractedText?: string;
}

export interface InteractionReplyContext {
  readonly version: 1;
  readonly provenanceStatus: ReplyProvenanceStatus;
  readonly senderRole: ReplySenderRole;
  readonly repliedTelegramMessageId: string;
  readonly quoteText: string;
  readonly logicalMessageId?: string;
  readonly conversationId?: string;
  readonly sourceKind?: ReplySourceKind;
  readonly scheduleId?: string;
  readonly scheduleRunId?: string;
  readonly attachments?: readonly InteractionReplyAttachment[];
}

const REPLY_PROVENANCE_STATUSES = new Set<ReplyProvenanceStatus>([
  'verified',
  'platform_verified',
  'unverified',
]);
const REPLY_SENDER_ROLES = new Set<ReplySenderRole>([
  'assistant_self',
  'owner_self',
  'third_party',
  'unknown',
]);
const REPLY_SOURCE_KINDS = new Set<ReplySourceKind>([
  'assistant_message',
  'schedule_result',
  'callback',
]);

function recordFrom(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function boundedIdentifier(value: unknown, maxLength = 160): string {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  for (const candidate of allowed) {
    if (candidate === normalized) return candidate;
  }
  return fallback;
}

function clipUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1] || '')) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

export function normalizeInteractionReplyContext(
  candidateValue: unknown,
): InteractionReplyContext | null {
  const candidate = recordFrom(candidateValue);
  const repliedTelegramMessageId = boundedIdentifier(candidate.repliedTelegramMessageId, 256);
  if (!repliedTelegramMessageId) return null;
  const provenanceStatus = enumValue(
    candidate.provenanceStatus,
    REPLY_PROVENANCE_STATUSES,
    'unverified',
  );
  const senderRole = enumValue(candidate.senderRole, REPLY_SENDER_ROLES, 'unknown');
  const sourceKind = enumValue(candidate.sourceKind, REPLY_SOURCE_KINDS, 'assistant_message');
  const attachments: InteractionReplyAttachment[] = [];
  for (const attachmentValue of Array.isArray(candidate.attachments)
    ? candidate.attachments.slice(0, 16)
    : []) {
    const attachment = recordFrom(attachmentValue);
    if (!Object.keys(attachment).length) continue;
    attachments.push(
      Object.freeze({
        ...(boundedIdentifier(attachment.fileId || attachment.file_id, 256)
          ? { fileId: boundedIdentifier(attachment.fileId || attachment.file_id, 256) }
          : {}),
        ...(boundedIdentifier(attachment.filename, 256)
          ? { filename: boundedIdentifier(attachment.filename, 256) }
          : {}),
        ...(boundedIdentifier(attachment.kind || attachment.type, 256)
          ? { kind: boundedIdentifier(attachment.kind || attachment.type, 256) }
          : {}),
        ...(attachment.extractedText || attachment.extracted_text
          ? {
              extractedText: clipUtf8(
                String(attachment.extractedText || attachment.extracted_text),
                32 * 1024,
              ).text,
            }
          : {}),
      }),
    );
  }
  const normalized: InteractionReplyContext = {
    version: 1,
    provenanceStatus,
    senderRole:
      provenanceStatus === 'verified' ||
      (provenanceStatus === 'platform_verified' && senderRole === 'owner_self') ||
      senderRole === 'third_party'
        ? senderRole
        : 'unknown',
    repliedTelegramMessageId,
    quoteText: clipUtf8(String(candidate.quoteText || ''), 8 * 1024).text,
    ...(boundedIdentifier(candidate.logicalMessageId, 256)
      ? { logicalMessageId: boundedIdentifier(candidate.logicalMessageId, 256) }
      : {}),
    ...(boundedIdentifier(candidate.conversationId, 256)
      ? { conversationId: boundedIdentifier(candidate.conversationId, 256) }
      : {}),
    ...(candidate.sourceKind ? { sourceKind } : {}),
    ...(boundedIdentifier(candidate.scheduleId, 256)
      ? { scheduleId: boundedIdentifier(candidate.scheduleId, 256) }
      : {}),
    ...(boundedIdentifier(candidate.scheduleRunId, 256)
      ? { scheduleRunId: boundedIdentifier(candidate.scheduleRunId, 256) }
      : {}),
    ...(attachments.length ? { attachments: Object.freeze(attachments) } : {}),
  };
  return Object.freeze(normalized);
}
