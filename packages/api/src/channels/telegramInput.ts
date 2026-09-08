/* VIVENTIUM START: preparation lifecycle in the existing authenticated ingress owner. */
import { createHash, randomUUID } from 'crypto';

import type { DeliveryAcknowledgementResult } from '../stream/interfaces/IJobStore';

import { createTelegramInteractionContext } from '../agents/interactionContext';

export type TelegramInputState =
  'preparing' | 'ready' | 'admitted' | 'failed' | 'completed' | 'cancelled';
export interface TelegramInputIdentity {
  sourceEventId: string;
  sourceOrderScope: string;
  sourceSequence: number;
  libreChatUserId: string;
  telegramUserId: string;
  telegramChatId: string;
  telegramMessageThreadId: string;
  conversationId: string;
  requestedConversationId: string;
  conversationGeneration: string;
  sourceMessageId: string;
  mediaGroupId: string;
}
export interface TelegramInputClaim {
  sourceEventId: string;
  claimToken: string;
}
export interface TelegramInputRecord extends TelegramInputIdentity {
  state: TelegramInputState;
  claimToken: string;
  leaseUntil: number;
  retryAt: number;
  attempts: number;
  streamId: string;
  failureCode: string;
  preparedDigest: string;
  registrationId: string;
  primarySourceEventId: string;
  relatedSourceEventIds: string[];
  failures: Array<{ code: string; at: number }>;
}
export interface TelegramPreparedInput {
  text: string;
  fileIds: string[];
  imageUrls: string[];
}
export interface TelegramInputSourceReference {
  source_event_id: string;
  source_message_id: string;
  source_sequence: number;
}
export interface TelegramInputDeliveryCoverage {
  logical_turn_id: string;
  revision: number;
  source_order_scope: string;
  source_conversation_generation: string;
  sources: TelegramInputSourceReference[];
}

/** Only the authenticated Main presentation owner can attest which accepted inputs it covered. */
export function telegramInputDeliveryCoverage(
  result: DeliveryAcknowledgementResult,
): TelegramInputDeliveryCoverage | null {
  const acknowledgement = result.acknowledgement;
  const presentation = result.presentation;
  const context = presentation?.interactionContext;
  if (
    result.status !== 'recorded' || result.transportOnly || presentation?.cortexPresentation ||
    acknowledgement?.state !== 'committed' ||
    (acknowledgement.source_kind && acknowledgement.source_kind !== 'assistant_message') ||
    !presentation?.userId || !presentation.responseMessageId ||
    context?.actor_kind !== 'external_user' || context.origin !== 'interactive' ||
    context.surface !== 'telegram' || context.conversation_id !== presentation.conversationId ||
    context.logical_turn_id !== acknowledgement.logical_turn_id ||
    context.revision !== acknowledgement.revision ||
    !/^[a-f0-9]{64}$/.test(context.source_order_scope || '') ||
    !/^[a-f0-9]{64}$/.test(context.source_conversation_generation || '')
  ) return null;
  const sources: TelegramInputSourceReference[] = [];
  for (const segment of context.source_segments || []) {
    if (
      segment.source_persisted !== true || !segment.source_message_id ||
      !/^[a-f0-9]{64}$/.test(segment.source_event_id) ||
      !Number.isSafeInteger(segment.source_sequence) || (segment.source_sequence || 0) < 1
    ) continue;
    sources.push({ source_event_id: segment.source_event_id,
      source_message_id: segment.source_message_id, source_sequence: segment.source_sequence! });
  }
  return sources.length ? {
    logical_turn_id: acknowledgement.logical_turn_id, revision: acknowledgement.revision,
    source_order_scope: context.source_order_scope!,
    source_conversation_generation: context.source_conversation_generation!, sources,
  } : null;
}

export function telegramInputConversationGeneration(record: TelegramInputIdentity): string {
  return createTelegramInteractionContext({ conversation_id: record.requestedConversationId,
    conversation_generation: record.conversationGeneration }).source_conversation_generation || '';
}
export interface TelegramInputRepository {
  read(
    identity: Pick<TelegramInputIdentity, 'sourceEventId' | 'libreChatUserId'>,
  ): Promise<TelegramInputRecord | null>;
  insert(record: TelegramInputRecord): Promise<TelegramInputRecord>;
  replace(previous: TelegramInputRecord, next: TelegramInputRecord): Promise<boolean>;
  due(now: number, limit: number): Promise<TelegramInputRecord[]>;
  group(record: TelegramInputRecord): Promise<TelegramInputRecord[]>;
}
export interface TelegramInputDependencies {
  repository: TelegramInputRepository;
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  verifyOwner(record: TelegramInputIdentity): Promise<boolean>;
  persistPrepared(record: TelegramInputIdentity, input: TelegramPreparedInput): Promise<void>;
  readPrepared(record: TelegramInputIdentity): Promise<TelegramPreparedInput | null>;
  verifyStream(record: TelegramInputIdentity, streamId: string): Promise<boolean>;
  hasCommittedDelivery(record: TelegramInputIdentity): Promise<boolean>;
  readStream(
    streamId: string,
    ownerId: string,
  ): Promise<'missing' | 'pending' | 'completed' | 'failed'>;
  now?: () => number;
}
export const TELEGRAM_INPUT_LEASE_MS = 120_000;
const RETRY_MS = 5_000;
export function telegramIngressDedupeTtlSeconds(): number {
  const parsed = Number.parseInt(process.env.VIVENTIUM_TELEGRAM_INGRESS_DEDUPE_TTL_S || '', 10);
  return Math.max(Number.isFinite(parsed) ? parsed : 86400, 60);
}

function inputConflict(code: string) {
  return Object.assign(new Error('The saved input changed; retry from its current state.'), {
    statusCode: 409,
    code,
    body: {
      code,
      retryable: true,
      error: 'The saved input changed; retry from its current state.',
    },
  });
}
function sameIdentity(a: TelegramInputIdentity, b: TelegramInputIdentity): boolean {
  return (Object.keys(b) as Array<keyof TelegramInputIdentity>).every((key) => a[key] === b[key]);
}
function validIdentity(record: TelegramInputIdentity): boolean {
  return (
    /^[a-f0-9]{64}$/.test(record.sourceEventId) &&
    /^[a-f0-9]{64}$/.test(record.sourceOrderScope) &&
    /^[a-f0-9]{64}$/.test(record.conversationGeneration) &&
    Number.isSafeInteger(record.sourceSequence) &&
    record.sourceSequence > 0 &&
    [
      record.libreChatUserId,
      record.telegramUserId,
      record.telegramChatId,
      record.conversationId,
      record.sourceMessageId,
    ].every((value) => typeof value === 'string' && value.length > 0)
  );
}
function digestPrepared(input: TelegramPreparedInput): string {
  return createHash('sha256')
    .update(JSON.stringify([input.text, input.fileIds, input.imageUrls]))
    .digest('hex');
}

export function createTelegramInputService(deps: TelegramInputDependencies) {
  const now = deps.now ?? Date.now;
  const repository = deps.repository;
  async function exact(ownerId: string, claim: TelegramInputClaim): Promise<TelegramInputRecord> {
    if (
      !claim ||
      !/^[a-f0-9]{64}$/.test(claim.sourceEventId) ||
      typeof claim.claimToken !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(claim.claimToken)
    ) {
      throw inputConflict('source_input_claim_conflict');
    }
    const record = await repository.read({
      libreChatUserId: ownerId,
      sourceEventId: claim.sourceEventId,
    });
    if (!record || record.claimToken !== claim.claimToken || !(await deps.verifyOwner(record))) {
      throw inputConflict('source_input_claim_conflict');
    }
    return record;
  }
  async function replace(previous: TelegramInputRecord, updates: Partial<TelegramInputRecord>) {
    const next = { ...previous, ...updates };
    if (!(await repository.replace(previous, next)))
      throw inputConflict('source_input_claim_conflict');
    return next;
  }
  return {
    async register(
      identity: TelegramInputIdentity,
      registrationId: string,
    ): Promise<TelegramInputRecord> {
      if (
        !validIdentity(identity) ||
        !/^[a-f0-9-]{36}$/.test(registrationId) ||
        !(await deps.verifyOwner(identity))
      )
        throw inputConflict('invalid_source_input');
      const existing = await repository.read(identity);
      if (existing) {
        if (!sameIdentity(existing, identity))
          throw inputConflict('source_input_identity_conflict');
        return existing;
      }
      const inserted = await repository.insert({
        ...identity,
        state: 'preparing',
        claimToken: randomUUID(),
        leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
        retryAt: 0,
        attempts: 0,
        streamId: '',
        failureCode: '',
        preparedDigest: '',
        registrationId,
        failures: [],
        primarySourceEventId: identity.sourceEventId,
        relatedSourceEventIds: [],
      });
      if (!sameIdentity(inserted, identity)) throw inputConflict('source_input_identity_conflict');
      return inserted;
    },
    async ready(
      ownerId: string,
      claim: TelegramInputClaim,
      input: TelegramPreparedInput,
      relatedClaims: TelegramInputClaim[] = [],
    ) {
      if (
        !input ||
        typeof input.text !== 'string' ||
        !Array.isArray(input.fileIds) ||
        !Array.isArray(input.imageUrls) ||
        ![...input.fileIds, ...input.imageUrls].every(
          (value) => typeof value === 'string' && value.length > 0,
        ) ||
        (!input.text.trim() && !input.fileIds.length && !input.imageUrls.length)
      ) {
        throw inputConflict('source_input_preparation_empty');
      }
      return deps.transaction(async () => {
        const record = await exact(ownerId, claim);
        const preparedDigest = digestPrepared(input);
        if (['ready', 'admitted', 'completed'].includes(record.state) && record.preparedDigest) {
          if (record.preparedDigest !== preparedDigest)
            throw inputConflict('source_input_already_admitted');
          return record;
        }
        const related: TelegramInputRecord[] = [];
        for (const item of relatedClaims) {
          if (
            item.sourceEventId === claim.sourceEventId ||
            related.some((row) => row.sourceEventId === item.sourceEventId)
          )
            continue;
          const row = await exact(ownerId, item);
          if (
            !record.mediaGroupId ||
            row.mediaGroupId !== record.mediaGroupId ||
            row.telegramChatId !== record.telegramChatId ||
            row.telegramUserId !== record.telegramUserId ||
            row.telegramMessageThreadId !== record.telegramMessageThreadId ||
            row.conversationGeneration !== record.conversationGeneration ||
            row.conversationId !== record.conversationId
          ) {
            throw inputConflict('source_input_group_conflict');
          }
          related.push(row);
        }
        for (const row of [record, ...related]) {
          if (!['preparing', 'ready'].includes(row.state) || row.leaseUntil <= now())
            throw inputConflict('source_input_claim_expired');
        }
        await deps.persistPrepared(record, input);
        for (const row of related)
          await replace(row, {
            state: 'ready',
            preparedDigest,
            primarySourceEventId: record.sourceEventId,
            failureCode: '',
            retryAt: 0,
            leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
          });
        return replace(record, {
          state: 'ready',
          preparedDigest,
          failureCode: '',
          retryAt: 0,
          relatedSourceEventIds: related.map((row) => row.sourceEventId),
          leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
        });
      });
    },
    async bindStream(ownerId: string, claim: TelegramInputClaim, streamId: string) {
      return deps.transaction(async () => {
        const record = await exact(ownerId, claim);
        if (record.state === 'admitted' && record.streamId === streamId) return record;
        if (record.state !== 'ready' || !streamId) throw inputConflict('source_input_not_ready');
        if (!(await deps.verifyStream(record, streamId)))
          throw inputConflict('source_input_stream_conflict');
        for (const sourceEventId of record.relatedSourceEventIds) {
          const row = await repository.read({
            libreChatUserId: ownerId,
            sourceEventId,
          });
          if (!row || row.primarySourceEventId !== record.sourceEventId || row.state !== 'ready')
            throw inputConflict('source_input_group_conflict');
          await replace(row, {
            state: 'admitted',
            streamId,
            leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
          });
        }
        return replace(record, {
          state: 'admitted',
          streamId,
          leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
        });
      });
    },
    async defer(ownerId: string, claim: TelegramInputClaim) {
      const record = await exact(ownerId, claim);
      if (record.state !== 'ready') throw inputConflict('source_input_not_ready');
      return replace(record, { leaseUntil: 0, retryAt: now() + RETRY_MS });
    },
    async status(
      ownerId: string,
      claim: TelegramInputClaim,
      state: 'renew' | 'failed' | 'cancelled',
      failureCode = '',
      retryable = false,
    ) {
      const record = await exact(ownerId, claim);
      if (['completed', 'cancelled'].includes(record.state)) return record;
      if (state === 'renew' && record.state === 'ready' && record.leaseUntil === 0) return record;
      if (state === 'renew')
        return replace(record, { leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS });
      if (record.state === 'admitted') throw inputConflict('source_input_already_admitted');
      const code = /^[a-z0-9_]{1,80}$/.test(failureCode)
        ? failureCode
        : 'source_input_preparation_failed';
      return replace(record, {
        state,
        failureCode: state === 'failed' ? code : '',
        retryAt: state === 'failed' && retryable === true ? now() + RETRY_MS : 0,
        leaseUntil: 0,
        failures: state === 'failed' ? [...record.failures, { code, at: now() }] : record.failures,
      });
    },
    async claimPending(limit = 10) {
      const claimed: TelegramInputRecord[] = [];
      for (const record of await repository.due(now(), Math.max(1, Math.min(25, limit)))) {
        if (!(await deps.verifyOwner(record))) continue;
        if (record.state === 'ready' || record.state === 'admitted') {
          const stream = await deps.hasCommittedDelivery(record)
            ? 'completed'
            : record.state === 'admitted'
              ? await deps.readStream(record.streamId, record.libreChatUserId)
              : 'pending';
          if (stream === 'completed') {
            await deps.transaction(async () => {
              for (const sourceEventId of record.relatedSourceEventIds) {
                const row = await repository.read({
                  libreChatUserId: record.libreChatUserId,
                  sourceEventId,
                });
                if (
                  row?.primarySourceEventId === record.sourceEventId &&
                  row.streamId === record.streamId
                ) {
                  await replace(row, { state: 'completed', leaseUntil: 0 });
                }
              }
              await replace(record, { state: 'completed', leaseUntil: 0 });
            });
            continue;
          }
          // An accepted model/effect is never replayed because the stream transport disappeared.
          if (stream === 'failed' || stream === 'missing') {
            await repository.replace(record, {
              ...record,
              state: 'failed',
              failureCode: 'accepted_response_unavailable',
              retryAt: 0,
              leaseUntil: 0,
            });
            continue;
          }
        }
        if (record.state === 'failed' && (!record.retryAt || record.attempts >= 3)) continue;
        if (record.state === 'ready' && !(await deps.readPrepared(record))) {
          await repository.replace(record, {
            ...record,
            state: 'failed',
            failureCode: 'prepared_input_unavailable',
            retryAt: 0,
            leaseUntil: 0,
          });
          continue;
        }
        const group =
          record.mediaGroupId && ['preparing', 'failed'].includes(record.state)
            ? await repository.group(record)
            : [record];
        if (
          group.some(
            (row) =>
              row.leaseUntil > now() ||
              row.retryAt > now() ||
              (row.state === 'failed' && (!row.retryAt || row.attempts >= 3)),
          ) ||
          claimed.some((row) => group.some((member) => member.sourceEventId === row.sourceEventId))
        )
          continue;
        const batch = await deps.transaction(async () => {
          const acquired: TelegramInputRecord[] = [];
          for (const row of group) {
            if (!(await deps.verifyOwner(row))) throw inputConflict('source_input_owner_changed');
            const next = {
              ...row,
              claimToken: randomUUID(),
              registrationId: randomUUID(),
              leaseUntil: now() + TELEGRAM_INPUT_LEASE_MS,
              attempts: row.attempts + (row.state === 'failed' ? 1 : 0),
              state: row.state === 'failed' ? ('preparing' as const) : row.state,
            };
            if (!(await repository.replace(row, next)))
              throw inputConflict('source_input_claim_conflict');
            acquired.push(next);
          }
          return acquired;
        });
        claimed.push(...batch);
      }
      return claimed;
    },
    async read(ownerId: string, claim: TelegramInputClaim) {
      return exact(ownerId, claim);
    },
  };
}
/* VIVENTIUM END */
