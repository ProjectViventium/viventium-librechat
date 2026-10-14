import { ChatModelStreamHandler } from '@librechat/agents';
import { getTrustedInteractionContext } from '../agents/interactionContext';
import { nativeIdentityJson } from '../stream/implementations/nativeResponse';
import type { NativeResponseIdentity, createNativeResponseMethods } from '@librechat/data-schemas';
import type { PublicPartOwner } from '../stream/interfaces/IJobStore';

interface AudioDeliveryRequest {
  readonly _viventiumTelegram?: boolean;
  readonly viventiumCallSession?: { readonly callSessionId?: string };
  readonly body?: { readonly telegramAudioRequested?: boolean; readonly voiceMode?: boolean };
}

/** Audio eligibility comes from an authenticated adapter, never a client surface label. */
export function isAudioDeliveryRequested(
  request: AudioDeliveryRequest | null | undefined,
): boolean {
  if (request?._viventiumTelegram === true && request.body?.telegramAudioRequested === true) {
    return true;
  }
  return (
    request?.body?.voiceMode === true &&
    (getTrustedInteractionContext(request)?.surface === 'voice' ||
      Boolean(request.viventiumCallSession?.callSessionId))
  );
}

export type DeliveryDispositionAudio = 'skip' | 'eligible';

export type DeliveryDispositionSource =
  'model' | 'legacy_marker' | 'required_missing' | 'required_malformed';

export interface DeliveryDisposition {
  version: 1;
  audio: DeliveryDispositionAudio;
  required: boolean;
  valid: boolean;
  source: DeliveryDispositionSource;
}

export type DeliveryDispositionCapture =
  | { status: 'missing' }
  | { status: 'malformed' }
  | { status: 'valid'; disposition: DeliveryDisposition };

const contractKeys = ['audio', 'required', 'source', 'valid', 'version'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const recordAt = (value: unknown, key: string): Record<string, unknown> | null => {
  if (!isRecord(value)) {
    return null;
  }
  const nested = value[key];
  return isRecord(nested) ? nested : null;
};

export function validateDeliveryDisposition(value: unknown): DeliveryDisposition | null {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== contractKeys.join(',')) {
    return null;
  }
  if (
    value.version !== 1 ||
    (value.audio !== 'skip' && value.audio !== 'eligible') ||
    value.required !== true ||
    value.valid !== true ||
    value.source !== 'model'
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    audio: value.audio,
    required: true,
    valid: true,
    source: 'model',
  });
}

function dispositionCandidate(envelope: unknown): { found: boolean; value?: unknown } {
  const providerFields = recordAt(envelope, 'provider_specific_fields');
  const viventium = recordAt(providerFields, 'viventium');
  if (!viventium || !Object.prototype.hasOwnProperty.call(viventium, 'delivery_disposition')) {
    return { found: false };
  }
  return { found: true, value: viventium.delivery_disposition };
}

export function inspectProviderDeliveryDisposition(value: unknown): DeliveryDispositionCapture {
  const root = isRecord(value) ? value : null;
  const additional = recordAt(root, 'additional_kwargs');
  const raw = recordAt(additional, '__raw_response') ?? recordAt(root, '__raw_response') ?? root;
  const rawChoices = raw?.choices;
  const choices = Array.isArray(rawChoices) ? rawChoices : [];
  const candidates = [dispositionCandidate(additional), dispositionCandidate(root)];

  for (const choice of choices) {
    candidates.push(
      dispositionCandidate(recordAt(choice, 'message')),
      dispositionCandidate(recordAt(choice, 'delta')),
    );
  }

  const present = candidates.filter((candidate) => candidate.found);
  if (present.length === 0) {
    return { status: 'missing' };
  }
  const dispositions = present.map((candidate) => validateDeliveryDisposition(candidate.value));
  if (dispositions.some((candidate) => candidate == null)) {
    return { status: 'malformed' };
  }
  const validDispositions = dispositions.filter(
    (candidate): candidate is DeliveryDisposition => candidate != null,
  );
  const disposition =
    validDispositions.find((candidate) => candidate.audio === 'skip') ??
    validDispositions[validDispositions.length - 1];
  return disposition ? { status: 'valid', disposition } : { status: 'malformed' };
}

export function resolveEffectiveDeliveryDisposition({
  audioEligible,
  legacySkipVoice,
  captured,
}: {
  audioEligible: boolean;
  legacySkipVoice: boolean;
  captured: DeliveryDispositionCapture;
}): DeliveryDisposition | null {
  if (legacySkipVoice) {
    return {
      version: 1,
      audio: 'skip',
      required: audioEligible,
      valid: true,
      source: 'legacy_marker',
    };
  }
  if (!audioEligible) {
    return null;
  }
  if (captured.status === 'valid') {
    return captured.disposition;
  }
  return {
    version: 1,
    audio: 'skip',
    required: true,
    valid: false,
    source: captured.status === 'malformed' ? 'required_malformed' : 'required_missing',
  };
}

export function supportsMessagingDeliveryDisposition(capability: unknown): boolean {
  return (
    isRecord(capability) &&
    capability.messaging_delivery_disposition === true &&
    capability.messaging_delivery_disposition_version === 1
  );
}

/* === VIVENTIUM START === Complete public parts close audio input, not cognition. === */
export interface PublicPartCompletion {
  readonly version: 1;
  readonly complete: true;
  readonly request_id: string;
  readonly run_id: string;
  readonly part_id: string;
  readonly message_id: string;
  readonly stream_id: string;
}

const publicPartCompletionKeys = [
  'complete',
  'message_id',
  'part_id',
  'request_id',
  'run_id',
  'stream_id',
  'version',
];

function validatePublicPartCompletion(value: unknown): PublicPartCompletion | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== publicPartCompletionKeys.join(',') ||
    value.version !== 1 ||
    value.complete !== true
  )
    return null;
  const identifiers = [value.request_id, value.run_id, value.message_id, value.stream_id];
  if (
    !identifiers.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 512) ||
    typeof value.part_id !== 'string' ||
    value.part_id.length > 1024
  )
    return null;
  const prefix = `${value.run_id}:`;
  if (!value.part_id.startsWith(prefix)) return null;
  const index = value.part_id.slice(prefix.length);
  if (!Number.isSafeInteger(Number(index)) || Number(index) < 0 || String(Number(index)) !== index)
    return null;
  return Object.freeze({
    version: 1,
    complete: true,
    request_id: value.request_id as string,
    run_id: value.run_id as string,
    part_id: value.part_id,
    message_id: value.message_id as string,
    stream_id: value.stream_id as string,
  });
}

/* === VIVENTIUM START === A released native handoff can close only its current Core audio part. === */
export function publicPartEventMatchesOwner(
  event: unknown,
  identity: NativeResponseIdentity,
): boolean {
  if (!isRecord(event) || event.event !== 'on_public_content_part_complete') return false;
  const data = recordAt(event, 'data');
  const completion = validatePublicPartCompletion(data?.completion);
  const disposition = validateDeliveryDisposition(data?.deliveryDisposition);
  return Boolean(
    completion &&
    disposition?.audio === 'eligible' &&
    completion.stream_id === identity.streamId &&
    completion.message_id === identity.responseMessageId,
  );
}

export function createReleasedMainPublicPartOwner(
  identity: NativeResponseIdentity,
  db: Pick<
    ReturnType<typeof createNativeResponseMethods>,
    'getNativeResponse' | 'nativeResponseSourceMatches'
  >,
): PublicPartOwner {
  return {
    identity,
    verifySource: async () => {
      try {
        const row = await db.getNativeResponse(identity.userId, identity.responseMessageId);
        if (
          !row ||
          String(row.user) !== identity.userId ||
          row.deletedAt ||
          row.isCreatedByUser !== false ||
          row.conversationId !== identity.conversationId ||
          row.messageId !== identity.responseMessageId ||
          row.parentMessageId !== identity.source.messageId ||
          row.nativeResponse?.status !== 'unsupported' ||
          nativeIdentityJson(row.nativeResponse) !== nativeIdentityJson(identity)
        )
          return false;
        return await db.nativeResponseSourceMatches(identity);
      } catch {
        return false;
      }
    },
  };
}
/* === VIVENTIUM END === */

function isPublicTextEnvelope(envelope: unknown): boolean {
  if (!isRecord(envelope)) return true;
  if (envelope.role != null && envelope.role !== 'assistant') return false;
  if (envelope.type === 'tool' || envelope.type === 'human' || envelope.error != null) return false;
  if (
    ['tool_calls', 'tool_call_chunks'].some((key) => {
      const value = envelope[key];
      return Array.isArray(value) && value.length > 0;
    })
  )
    return false;
  if (
    ['function_call', 'reasoning_content', 'reasoning', 'thinking'].some(
      (key) => envelope[key] != null && envelope[key] !== '',
    )
  )
    return false;
  return (
    !Array.isArray(envelope.content) ||
    envelope.content.every(
      (part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string',
    )
  );
}

/** Only the unmerged native chunk binds completion to its request and public part. */
export function inspectProviderPublicPartCompletion(value: unknown): PublicPartCompletion | null {
  const root = isRecord(value) ? value : null;
  const additional = recordAt(root, 'additional_kwargs');
  const raw = recordAt(additional, '__raw_response') ?? recordAt(root, '__raw_response') ?? root;
  if (
    !raw ||
    raw.object !== 'chat.completion.chunk' ||
    typeof raw.id !== 'string' ||
    !Array.isArray(raw.choices) ||
    raw.choices.length !== 1 ||
    raw.error != null
  )
    return null;
  const choice = isRecord(raw.choices[0]) ? raw.choices[0] : null;
  if (!choice || choice.index !== 0 || choice.finish_reason != null) return null;
  const envelopes = [root, additional, recordAt(choice, 'delta'), recordAt(choice, 'message')];
  if (!envelopes.every(isPublicTextEnvelope)) return null;
  const candidates = envelopes
    .map((envelope) => recordAt(recordAt(envelope, 'provider_specific_fields'), 'viventium'))
    .filter(
      (carrier) => carrier && Object.prototype.hasOwnProperty.call(carrier, 'public_part_complete'),
    );
  if (!candidates.length) return null;
  const completions = candidates.map((carrier) =>
    validatePublicPartCompletion(carrier?.public_part_complete),
  );
  const completion = completions[0];
  if (
    !completion ||
    completions.some(
      (candidate) =>
        !candidate ||
        candidate.request_id !== raw.id ||
        JSON.stringify(candidate) !== JSON.stringify(completion),
    )
  )
    return null;
  return completion;
}

/** The SDK awaits text dispatch; completion-only chunks still reach the ordered hook. */
export function createDeliveryDispositionStreamHandler({
  required,
  beforeHandle,
  afterHandle,
}: {
  required: (...args: Parameters<ChatModelStreamHandler['handle']>) => boolean;
  beforeHandle: ChatModelStreamHandler['handle'];
  afterHandle?: ChatModelStreamHandler['handle'];
}): ChatModelStreamHandler {
  return new (class extends ChatModelStreamHandler {
    async handle(...args: Parameters<ChatModelStreamHandler['handle']>): Promise<void> {
      await beforeHandle(...args);
      if (!args[3]) return;
      const metadata = required(...args) ? { ...args[2] } : args[2];
      if (metadata !== args[2] && metadata) {
        const disposition = resolveEffectiveDeliveryDisposition({
          audioEligible: true,
          legacySkipVoice: false,
          captured: inspectProviderDeliveryDisposition(args[1]?.chunk),
        });
        if (disposition) streamDeliveryDispositions.set(metadata, disposition);
      }
      await super.handle(args[0], args[1], metadata, args[3]);
      await afterHandle?.(args[0], args[1], metadata, args[3]);
    }
  })();
}
/* === VIVENTIUM END === */

const streamDeliveryDispositions = new WeakMap<object, DeliveryDisposition>();

export function getStreamDeliveryDisposition(
  metadata?: Record<string, unknown>,
): DeliveryDisposition | null {
  return metadata ? (streamDeliveryDispositions.get(metadata) ?? null) : null;
}

export interface DeliveryDispositionRange {
  /** Offsets use JavaScript UTF-16 string indices, including for non-BMP text. */
  start: number;
  end: number;
  disposition: DeliveryDisposition;
}

/** Project exact native public-part choices onto the accepted display text. */
export function inspectProviderDeliveryRanges(
  response: unknown,
  publicText: string,
  projectText: (text: string) => string = (text) => text,
): DeliveryDispositionRange[] | null {
  const envelope = isRecord(response) ? response : null;
  const additional = recordAt(envelope, 'additional_kwargs');
  const root = recordAt(additional, '__raw_response') ?? recordAt(envelope, '__raw_response') ?? envelope;
  const choices = root?.choices;
  const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
  const message = recordAt(choice, 'message') ?? recordAt(choice, 'delta');
  const carrier = recordAt(recordAt(message, 'provider_specific_fields'), 'viventium');
  if (!carrier || !Object.prototype.hasOwnProperty.call(carrier, 'deliveryDispositionRanges'))
    return null;
  const source = typeof carrier.delivery_range_text === 'string'
    ? carrier.delivery_range_text : message?.content;
  const ranges = carrier.deliveryDispositionRanges;
  if ((message?.role != null && message.role !== 'assistant') || typeof source !== 'string')
    return [];
  return projectDeliveryDispositionRanges(ranges, source, publicText, projectText);
}

/** Validate already accepted canonical ranges using the same native projection contract. */
export function projectDeliveryDispositionRanges(
  ranges: unknown,
  source: string,
  publicText: string = source,
  projectText: (text: string) => string = (text) => text,
): DeliveryDispositionRange[] {
  if (!Array.isArray(ranges) || !ranges.length || projectText(source) !== publicText) return [];
  const result: DeliveryDispositionRange[] = [];
  let cursor = 0;
  let projected = 0;
  for (const range of ranges) {
    if (
      !isRecord(range) ||
      Object.keys(range).sort().join(',') !== 'disposition,end,start' ||
      range.start !== cursor ||
      typeof range.end !== 'number' ||
      !Number.isInteger(range.end) ||
      range.end <= cursor ||
      range.end > source.length
    )
      return [];
    const disposition = validateDeliveryDisposition(range.disposition);
    if (
      !disposition ||
      (range.end < source.length &&
        source.charCodeAt(range.end) >= 0xdc00 &&
        source.charCodeAt(range.end) <= 0xdfff)
    )
      return [];
    const prefix = projectText(source.slice(0, range.end));
    if (!publicText.startsWith(prefix) || prefix.length < projected) return [];
    if (prefix.length > projected)
      result.push({ start: projected, end: prefix.length, disposition });
    cursor = range.end;
    projected = prefix.length;
  }
  return cursor === source.length && projected === publicText.length ? result : [];
}

/** Accept Core's fail-closed outcomes as well as validated model choices. */
function retainedDeliveryDisposition(value: unknown): DeliveryDisposition | null {
  const model = validateDeliveryDisposition(value);
  if (model) return model;
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== contractKeys.join(',')) {
    return null;
  }
  if (value.version !== 1 || value.audio !== 'skip' || typeof value.required !== 'boolean') {
    return null;
  }
  if (
    (value.source === 'legacy_marker' && value.valid === true) ||
    ((value.source === 'required_missing' || value.source === 'required_malformed') &&
      value.required === true &&
      value.valid === false)
  ) {
    return {
      version: 1,
      audio: 'skip',
      required: value.required,
      valid: value.valid,
      source: value.source,
    };
  }
  return null;
}

/**
 * The upstream aggregator replaces text parts and can join different native model
 * envelopes at one content index. Retain their choices on that existing part so
 * memory and Redis resume use the same text and audio decisions as live delivery.
 */
export function retainAggregatedDeliveryDisposition(
  contentParts: unknown[],
  beforeParts: readonly unknown[],
  event: unknown,
): void {
  if (!isRecord(event) || event.event !== 'on_message_delta') return;
  const data = recordAt(event, 'data');
  const delta = recordAt(data, 'delta');
  const deltaParts = delta?.content;
  const first = Array.isArray(deltaParts) ? deltaParts[0] : null;
  if (!isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') return;
  if (!first.text) return;
  const disposition = retainedDeliveryDisposition(
    recordAt(recordAt(delta, 'metadata'), 'viventium')?.deliveryDisposition,
  );

  for (let index = 0; index < contentParts.length; index++) {
    const part = contentParts[index];
    if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
    const before = beforeParts[index];
    if (part === before) continue;
    const samePartition =
      isRecord(before) &&
      before.type === 'text' &&
      before.agentId === part.agentId &&
      before.groupId === part.groupId;
    const previousText = samePartition && typeof before.text === 'string' ? before.text : '';
    if (!part.text.startsWith(previousText)) continue;
    const appended = part.text.slice(previousText.length) === first.text;
    const ranges: DeliveryDispositionRange[] = [];
    if (samePartition && Array.isArray(before.deliveryDispositionRanges)) {
      for (const range of before.deliveryDispositionRanges) {
        if (!isRecord(range)) continue;
        const saved = retainedDeliveryDisposition(range.disposition);
        if (
          !saved ||
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          typeof range.start !== 'number' ||
          typeof range.end !== 'number' ||
          range.start < 0 ||
          range.end <= range.start ||
          range.end > previousText.length ||
          range.start < (ranges.at(-1)?.end ?? 0)
        )
          continue;
        ranges.push({ start: range.start, end: range.end, disposition: saved });
      }
    }
    if (appended && disposition) {
      const last = ranges.at(-1);
      if (
        last?.end === previousText.length &&
        last.disposition.audio === disposition.audio &&
        last.disposition.source === disposition.source &&
        last.disposition.required === disposition.required &&
        last.disposition.valid === disposition.valid
      ) {
        last.end = part.text.length;
      } else {
        ranges.push({ start: previousText.length, end: part.text.length, disposition });
      }
    }
    if (ranges.length) part.deliveryDispositionRanges = ranges;
  }
}
