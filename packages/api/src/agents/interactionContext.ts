/* === VIVENTIUM START ===
 * Feature: Trusted interaction provenance.
 * Purpose: Keep actor, origin, source, reply, and presentation authority server-authored while
 * carrying bounded rapid-input evidence without persisting raw source text in message metadata.
 * === VIVENTIUM END === */

import { createHash } from 'crypto';

import {
  normalizeInteractionSourceSegments,
  type InteractionSourceFile,
  type InteractionSourceSegment,
} from '../glasshive/interactionSourceSegments';
import { isNoResponseOnly } from './noResponseTag';

type UnknownRecord = Record<string, unknown>;

export type InteractionActorKind = 'external_user' | 'system' | 'worker';
export type InteractionOrigin = 'interactive' | 'scheduler' | 'callback';
export type InteractionSurface = 'web' | 'telegram' | 'voice' | 'workbench';
export type InteractionSegmentStability = 'immediate' | 'provisional';
export type InteractionSupersedeScope = 'response_and_authoring' | 'response_only';
export type InteractionTurnScope = 'conversation' | 'source_event';
export type InteractionCommitAuthority = 'server' | 'external_adapter';
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

export interface TrustedInteractionContext {
  readonly actor_kind: InteractionActorKind;
  readonly origin: InteractionOrigin;
  readonly surface: InteractionSurface;
  readonly conversation_id: string;
  readonly logical_turn_id?: string;
  readonly revision: number;
  readonly source_event_id: string;
  readonly source_order_scope?: string;
  readonly source_sequence?: number;
  readonly turn_scope?: InteractionTurnScope;
  readonly schedule_id?: string;
  readonly schedule_run_id?: string;
  readonly qa_run?: true;
  readonly qa_run_id?: string;
  readonly reply_context?: InteractionReplyContext;
  readonly source_segments?: readonly InteractionSourceSegment[];
  readonly source_segments_overflow_count?: number;
}

export interface InteractionContextInput {
  actor_kind?: unknown;
  origin?: unknown;
  surface?: unknown;
  conversation_id?: unknown;
  logical_turn_id?: unknown;
  revision?: unknown;
  source_event_id?: unknown;
  source_order_scope?: unknown;
  source_sequence?: unknown;
  turn_scope?: unknown;
  schedule_id?: unknown;
  schedule_run_id?: unknown;
  qa_run?: unknown;
  qa_run_id?: unknown;
  reply_context?: unknown;
  source_segments?: unknown;
  source_segments_overflow_count?: unknown;
  segment_stability?: unknown;
  supersede_scope?: unknown;
}

export interface TrustedInteractionAdapterCapabilities {
  readonly segment_stability: InteractionSegmentStability;
  readonly supersede_scope: InteractionSupersedeScope;
}

export interface InteractionAdapterCapabilitiesInput {
  segment_stability?: unknown;
  supersede_scope?: unknown;
}

export interface TrustedInteractionDeliveryPolicy {
  readonly commit_authority: InteractionCommitAuthority;
}

export interface InteractionDeliveryPolicyInput {
  commit_authority?: unknown;
}

export interface InteractionFactoryInput {
  conversation_id?: unknown;
  source_event_id?: unknown;
}

export interface TelegramInteractionFactoryInput extends InteractionFactoryInput {
  source_order_scope?: unknown;
  source_sequence?: unknown;
  reply_context?: unknown;
}

export interface SchedulerInteractionFactoryInput extends InteractionFactoryInput {
  schedule_id?: unknown;
  schedule_run_id?: unknown;
  qa_run?: unknown;
  qa_run_id?: unknown;
}

export interface TelegramSourceOrderInput {
  librechat_owner_id?: unknown;
  telegram_user_id?: unknown;
  telegram_chat_id?: unknown;
  message_thread_id?: unknown;
  source_domain?: unknown;
}

export interface TelegramSourceEventInput {
  source_order_scope?: unknown;
  source_sequence?: unknown;
}

export interface InteractionContextMetadata {
  readonly actor_kind: InteractionActorKind;
  readonly origin: InteractionOrigin;
  readonly surface: InteractionSurface;
  readonly conversation_id: string;
  readonly logical_turn_id?: string;
  readonly revision: number;
  readonly source_event_id: string;
  readonly schedule_id?: string;
  readonly schedule_run_id?: string;
  readonly qa_run?: true;
  readonly qa_run_id?: string;
  readonly reply_context?: InteractionReplyContext;
}

export interface TrustedClientPresentation {
  readonly version: 1;
  readonly glasshiveViewOrigin: 'loopback';
}

const ACTORS = new Set<InteractionActorKind>(['external_user', 'system', 'worker']);
const ORIGINS = new Set<InteractionOrigin>(['interactive', 'scheduler', 'callback']);
const SURFACES = new Set<InteractionSurface>(['web', 'telegram', 'voice', 'workbench']);
const SEGMENT_STABILITY = new Set<InteractionSegmentStability>(['immediate', 'provisional']);
const SUPERSEDE_SCOPES = new Set<InteractionSupersedeScope>([
  'response_and_authoring',
  'response_only',
]);
const TURN_SCOPES = new Set<InteractionTurnScope>(['conversation', 'source_event']);
const COMMIT_AUTHORITIES = new Set<InteractionCommitAuthority>(['server', 'external_adapter']);
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
const TRUSTED_SLOT = '_viventiumInteractionContext';
const LOCAL_PRESENTATION_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const LOCAL_PRESENTATION_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_WEB_PRESENTATION: TrustedClientPresentation = Object.freeze({
  version: 1,
  glasshiveViewOrigin: 'loopback',
});
const trustedContexts = new WeakMap<object, TrustedInteractionContext>();
const trustedAdapterCapabilities = new WeakMap<object, TrustedInteractionAdapterCapabilities>();
const trustedDeliveryPolicies = new WeakMap<object, TrustedInteractionDeliveryPolicy>();
const trustedClientPresentations = new WeakMap<object, TrustedClientPresentation>();

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordFrom(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function objectKey(value: unknown): object | null {
  return value !== null && typeof value === 'object' ? value : null;
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

export function buildTelegramSourceOrderScope(input: TelegramSourceOrderInput = {}): string {
  const ownerId = boundedIdentifier(input.librechat_owner_id, 160);
  const telegramUserId = boundedIdentifier(input.telegram_user_id, 160);
  const telegramChatId = boundedIdentifier(input.telegram_chat_id, 160);
  const messageThreadId = boundedIdentifier(input.message_thread_id, 160);
  const sourceDomain = boundedIdentifier(input.source_domain || 'telegram-interactive-v1', 160);
  if (!ownerId || !telegramUserId || !telegramChatId || !sourceDomain) return '';
  return createHash('sha256')
    .update(
      [
        'viventium.telegram-source-order.v2',
        sourceDomain,
        ownerId,
        telegramUserId,
        telegramChatId,
        messageThreadId,
      ].join('\0'),
    )
    .digest('hex');
}

export function buildTelegramSourceEventId(input: TelegramSourceEventInput = {}): string {
  const sourceOrderScope = String(input.source_order_scope || '');
  const sourceSequence = Number(input.source_sequence);
  if (
    !/^[a-f0-9]{64}$/.test(sourceOrderScope) ||
    !Number.isSafeInteger(sourceSequence) ||
    sourceSequence <= 0
  ) {
    return '';
  }
  return createHash('sha256')
    .update(
      ['viventium.telegram-source-event.v1', sourceOrderScope, String(sourceSequence)].join('\0'),
    )
    .digest('hex');
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

export function normalizeInteractionContext(
  context: InteractionContextInput = {},
): TrustedInteractionContext {
  const logicalTurnId = boundedIdentifier(context.logical_turn_id);
  const normalizedSourceSegments = normalizeInteractionSourceSegments(
    context.source_segments,
    context.source_segments_overflow_count,
  );
  const replyContext = normalizeInteractionReplyContext(context.reply_context);
  const sourceOrderScope = /^[a-f0-9]{64}$/.test(String(context.source_order_scope || ''))
    ? String(context.source_order_scope)
    : '';
  const sourceSequence = Number(context.source_sequence);
  const hasSourceOrder =
    Boolean(sourceOrderScope) && Number.isSafeInteger(sourceSequence) && sourceSequence > 0;
  const normalized: TrustedInteractionContext = {
    actor_kind: enumValue(context.actor_kind, ACTORS, 'external_user'),
    origin: enumValue(context.origin, ORIGINS, 'interactive'),
    surface: enumValue(context.surface, SURFACES, 'web'),
    conversation_id: boundedIdentifier(context.conversation_id),
    ...(logicalTurnId ? { logical_turn_id: logicalTurnId } : {}),
    revision: Math.max(1, Math.floor(Number(context.revision) || 1)),
    source_event_id: boundedIdentifier(context.source_event_id),
    ...(hasSourceOrder
      ? { source_order_scope: sourceOrderScope, source_sequence: sourceSequence }
      : {}),
    ...(context.turn_scope
      ? { turn_scope: enumValue(context.turn_scope, TURN_SCOPES, 'conversation') }
      : {}),
    ...(boundedIdentifier(context.schedule_id, 256)
      ? { schedule_id: boundedIdentifier(context.schedule_id, 256) }
      : {}),
    ...(boundedIdentifier(context.schedule_run_id, 256)
      ? { schedule_run_id: boundedIdentifier(context.schedule_run_id, 256) }
      : {}),
    ...(context.qa_run === true ? { qa_run: true } : {}),
    ...(context.qa_run === true && boundedIdentifier(context.qa_run_id, 128)
      ? { qa_run_id: boundedIdentifier(context.qa_run_id, 128) }
      : {}),
    ...(replyContext ? { reply_context: replyContext } : {}),
    ...(normalizedSourceSegments.segments.length
      ? { source_segments: normalizedSourceSegments.segments }
      : {}),
    ...(normalizedSourceSegments.overflowCount > 0
      ? { source_segments_overflow_count: normalizedSourceSegments.overflowCount }
      : {}),
  };
  return Object.freeze(normalized);
}

export function normalizeAdapterCapabilities(
  capabilities: InteractionAdapterCapabilitiesInput = {},
): TrustedInteractionAdapterCapabilities {
  return Object.freeze({
    segment_stability: enumValue(capabilities.segment_stability, SEGMENT_STABILITY, 'immediate'),
    supersede_scope: enumValue(
      capabilities.supersede_scope,
      SUPERSEDE_SCOPES,
      'response_and_authoring',
    ),
  });
}

export function normalizeDeliveryPolicy(
  policy: InteractionDeliveryPolicyInput = {},
): TrustedInteractionDeliveryPolicy {
  return Object.freeze({
    commit_authority: enumValue(policy.commit_authority, COMMIT_AUTHORITIES, 'server'),
  });
}

export function createWebInteractionContext(
  input: InteractionFactoryInput = {},
): TrustedInteractionContext {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'web',
    conversation_id: input.conversation_id,
    source_event_id: input.source_event_id,
  });
}

export function createTelegramInteractionContext(
  input: TelegramInteractionFactoryInput = {},
): TrustedInteractionContext {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'telegram',
    conversation_id: input.conversation_id,
    source_event_id: input.source_event_id,
    source_order_scope: input.source_order_scope,
    source_sequence: input.source_sequence,
    reply_context: input.reply_context,
  });
}

export function createVoiceInteractionContext(
  input: InteractionFactoryInput = {},
): TrustedInteractionContext {
  return normalizeInteractionContext({
    actor_kind: 'external_user',
    origin: 'interactive',
    surface: 'voice',
    conversation_id: input.conversation_id,
    source_event_id: input.source_event_id,
  });
}

export function createSchedulerInteractionContext(
  input: SchedulerInteractionFactoryInput = {},
): TrustedInteractionContext {
  return normalizeInteractionContext({
    actor_kind: 'system',
    origin: 'scheduler',
    surface: 'workbench',
    conversation_id: input.conversation_id,
    source_event_id: input.source_event_id,
    schedule_id: input.schedule_id,
    schedule_run_id: input.schedule_run_id,
    qa_run: input.qa_run,
    qa_run_id: input.qa_run_id,
  });
}

export function setTrustedInteractionContext(
  request: object | null | undefined,
  context: InteractionContextInput,
  adapterCapabilities: InteractionAdapterCapabilitiesInput = context,
  deliveryPolicy: InteractionDeliveryPolicyInput = { commit_authority: 'server' },
): TrustedInteractionContext {
  const req = objectKey(request);
  if (!req) return normalizeInteractionContext(context);
  const existing = trustedContexts.get(req);
  if (existing) return existing;
  const normalized = normalizeInteractionContext(context);
  trustedContexts.set(req, normalized);
  trustedAdapterCapabilities.set(req, normalizeAdapterCapabilities(adapterCapabilities));
  trustedDeliveryPolicies.set(req, normalizeDeliveryPolicy(deliveryPolicy));
  Object.defineProperty(req, TRUSTED_SLOT, {
    configurable: false,
    enumerable: false,
    get: () => trustedContexts.get(req),
  });
  trustedLoopbackWebPresentation(req, normalized);
  return normalized;
}

export function getTrustedInteractionContext(
  request: object | null | undefined,
): TrustedInteractionContext | null {
  const req = objectKey(request);
  return req ? trustedContexts.get(req) || null : null;
}

export function getTrustedAdapterCapabilities(
  request: object | null | undefined,
): TrustedInteractionAdapterCapabilities | null {
  const req = objectKey(request);
  return req ? trustedAdapterCapabilities.get(req) || null : null;
}

export function getTrustedDeliveryPolicy(
  request: object | null | undefined,
): TrustedInteractionDeliveryPolicy | null {
  const req = objectKey(request);
  return req ? trustedDeliveryPolicies.get(req) || null : null;
}

export function trustedLoopbackWebPresentation(
  request: object | null | undefined,
  interactionContext: TrustedInteractionContext | null = getTrustedInteractionContext(request),
): TrustedClientPresentation | null {
  if (interactionContext?.surface !== 'web') return null;
  const req = objectKey(request);
  if (!req) return null;
  const pinned = trustedClientPresentations.get(req);
  if (pinned) return pinned;
  const requestRecord = recordFrom(req);
  const hostname = String(requestRecord.hostname || '')
    .trim()
    .toLowerCase();
  const socket = recordFrom(requestRecord.socket);
  const remoteAddress = String(socket.remoteAddress || '')
    .trim()
    .toLowerCase();
  if (!LOCAL_PRESENTATION_HOSTS.has(hostname) || !LOCAL_PRESENTATION_PEERS.has(remoteAddress)) {
    return null;
  }
  trustedClientPresentations.set(req, LOOPBACK_WEB_PRESENTATION);
  return LOOPBACK_WEB_PRESENTATION;
}

export function projectTrustedClientPresentation(
  requestBody: UnknownRecord | null | undefined,
  request: object | null | undefined,
): UnknownRecord {
  const projected = { ...recordFrom(requestBody) };
  delete projected.viventiumClientPresentation;
  const presentation = trustedLoopbackWebPresentation(request);
  if (presentation) projected.viventiumClientPresentation = presentation;
  return projected;
}

export function bindInteractionSourceSegments(
  request: object | null | undefined,
  text: unknown,
  sourceFiles: readonly InteractionSourceFile[] = [],
): TrustedInteractionContext | null {
  const req = objectKey(request);
  const current = req ? trustedContexts.get(req) || null : null;
  if (!req || !current || current.logical_turn_id) return current;
  let values: string[] = [];
  if (Array.isArray(text)) {
    values = text.filter((value): value is string => typeof value === 'string');
  } else if (typeof text === 'string') {
    values = [text];
  } else if (sourceFiles.length) {
    values = [''];
  }
  const incoming = values.map((value, sourceIndex) => ({
    source_event_id: current.source_event_id,
    source_index: sourceIndex,
    text: value,
    ...(sourceIndex === 0 && sourceFiles.length ? { source_files: sourceFiles } : {}),
  }));
  const normalized = normalizeInteractionContext({
    ...current,
    source_segments: [...(current.source_segments || []), ...incoming],
  });
  trustedContexts.set(req, normalized);
  return normalized;
}

export function bindCanonicalInteractionConversation(
  request: object | null | undefined,
  conversationId: unknown,
): TrustedInteractionContext | null {
  const req = objectKey(request);
  const current = req ? trustedContexts.get(req) || null : null;
  const canonicalConversationId = boundedIdentifier(conversationId);
  if (
    !req ||
    !current ||
    !canonicalConversationId ||
    current.logical_turn_id ||
    current.conversation_id === canonicalConversationId
  ) {
    return current;
  }
  const normalized = normalizeInteractionContext({
    ...current,
    conversation_id: canonicalConversationId,
  });
  trustedContexts.set(req, normalized);
  return normalized;
}

export function bindLogicalTurnContext(
  request: object | null | undefined,
  claimedContext: InteractionContextInput,
): TrustedInteractionContext | null {
  const req = objectKey(request);
  const current = req ? trustedContexts.get(req) || null : null;
  const claimed = normalizeInteractionContext({
    ...claimedContext,
    ...(current?.reply_context && !claimedContext.reply_context
      ? { reply_context: current.reply_context }
      : {}),
  });
  if (!req || !current || !claimed.logical_turn_id) return current;
  const preservesAuthority =
    current.actor_kind === claimed.actor_kind &&
    current.origin === claimed.origin &&
    current.surface === claimed.surface &&
    current.conversation_id === claimed.conversation_id &&
    current.source_event_id === claimed.source_event_id;
  if (!preservesAuthority) return current;
  const claimedSegments = claimed.source_segments || [];
  const preservesCurrentSegments = (current.source_segments || []).every((segment) =>
    claimedSegments.some(
      (candidate) =>
        candidate.source_event_id === segment.source_event_id &&
        candidate.source_index === segment.source_index &&
        candidate.text === segment.text &&
        candidate.truncated === segment.truncated &&
        candidate.original_sha256 === segment.original_sha256,
    ),
  );
  if (!preservesCurrentSegments) return current;
  trustedContexts.set(req, claimed);
  return claimed;
}

export function isInternalOrigin(request: object | null | undefined): boolean {
  const context = getTrustedInteractionContext(request);
  return context?.actor_kind === 'system' && context.origin === 'scheduler';
}

export function shouldSkipAutomaticMemoryWriter(request: object | null | undefined): boolean {
  return isInternalOrigin(request);
}

export function shouldSkipEmotionalReaction(request: object | null | undefined): boolean {
  return isInternalOrigin(request);
}

export function interactionContextMetadata(
  request: object | null | undefined,
): InteractionContextMetadata | null {
  const context = getTrustedInteractionContext(request);
  if (!context) return null;
  return Object.freeze({
    actor_kind: context.actor_kind,
    origin: context.origin,
    surface: context.surface,
    conversation_id: context.conversation_id,
    ...(context.logical_turn_id ? { logical_turn_id: context.logical_turn_id } : {}),
    revision: context.revision,
    source_event_id: context.source_event_id,
    ...(context.schedule_id ? { schedule_id: context.schedule_id } : {}),
    ...(context.schedule_run_id ? { schedule_run_id: context.schedule_run_id } : {}),
    ...(context.qa_run === true ? { qa_run: true } : {}),
    ...(context.qa_run === true && context.qa_run_id ? { qa_run_id: context.qa_run_id } : {}),
    ...(context.reply_context ? { reply_context: context.reply_context } : {}),
  });
}

function logicalTurnMetadata(context: TrustedInteractionContext): InteractionContextMetadata {
  return {
    actor_kind: context.actor_kind,
    origin: context.origin,
    surface: context.surface,
    conversation_id: context.conversation_id,
    ...(context.logical_turn_id ? { logical_turn_id: context.logical_turn_id } : {}),
    revision: context.revision,
    source_event_id: context.source_event_id,
    ...(context.schedule_id ? { schedule_id: context.schedule_id } : {}),
    ...(context.schedule_run_id ? { schedule_run_id: context.schedule_run_id } : {}),
    ...(context.qa_run === true ? { qa_run: true } : {}),
    ...(context.qa_run === true && context.qa_run_id ? { qa_run_id: context.qa_run_id } : {}),
    ...(context.reply_context ? { reply_context: context.reply_context } : {}),
  };
}

export function attachLogicalTurnMetadata<T extends UnknownRecord | null | undefined>(
  payload: T,
  context: TrustedInteractionContext | null | undefined,
): T | UnknownRecord {
  if (!payload || !context?.logical_turn_id || !Number.isSafeInteger(context.revision)) {
    return payload;
  }
  const metadata = recordFrom(payload.metadata);
  const viventium = recordFrom(metadata.viventium);
  return {
    ...payload,
    logical_turn_id: context.logical_turn_id,
    revision: context.revision,
    metadata: {
      ...metadata,
      viventium: {
        ...viventium,
        interactionContext: logicalTurnMetadata(context),
      },
    },
  };
}

function messageText(message: UnknownRecord): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((value) => recordFrom(value))
    .filter((part) => part.type === 'text')
    .map((part) => {
      if (typeof part.text === 'string') return part.text;
      const text = recordFrom(part.text);
      return typeof text.value === 'string' ? text.value : '';
    })
    .join('');
}

export function attachInteractionContextMetadata<T extends UnknownRecord | null | undefined>(
  request: object | null | undefined,
  message: T,
): T | UnknownRecord {
  const interactionContext = interactionContextMetadata(request);
  if (!interactionContext || !message) return message;
  const metadata = recordFrom(message.metadata);
  const viventium = recordFrom(metadata.viventium);
  const isSchedulerInternal =
    isInternalOrigin(request) &&
    (message.isCreatedByUser === true || isNoResponseOnly(message.text || messageText(message)));
  return {
    ...message,
    metadata: {
      ...metadata,
      viventium: {
        ...viventium,
        ...(interactionContext.qa_run === true ? { qaRun: true } : {}),
        ...(interactionContext.qa_run === true && interactionContext.qa_run_id
          ? { qaRunId: interactionContext.qa_run_id }
          : {}),
        ...(isInternalOrigin(request) ? { memoryEligible: false } : {}),
        ...(isInternalOrigin(request) ? { recallEligible: !isSchedulerInternal } : {}),
        ...(isSchedulerInternal ? { visibility: 'internal' } : {}),
        interactionContext,
        adapterCapabilities: getTrustedAdapterCapabilities(request),
        deliveryPolicy: getTrustedDeliveryPolicy(request),
      },
    },
  };
}

export function isTrustedInternalMessage(message: unknown): boolean {
  const metadata = recordFrom(recordFrom(message).metadata);
  const viventium = recordFrom(metadata.viventium);
  return viventium.visibility === 'internal';
}

/* === VIVENTIUM END === */
