/* === VIVENTIUM START === Persisted Main replies use their own admission evidence. === */
import { createHash } from 'crypto';
import type {
  ScheduleDueAdmission,
  ScheduledConversationBinding,
} from '../scheduling/scheduleDueReceiver';

export interface ScheduledMainGenerationPresentation {
  version: 1;
  streamId: string;
  admissionId: string;
  responseMessageId: string;
  responseDigest: string;
}

export interface NativeCoordinatorResultSource {
  kind: 'native_coordinator_goal';
  bindingRef: string;
  nativeConversationId: string;
  goalId: string;
  runId: string;
  resultRevision: number;
  resultDigest: string;
  sourceTurnId: string;
  sourceCallSessionId: string;
}

export interface NativeCoordinatorTurnResultSource extends Omit<
  NativeCoordinatorResultSource,
  'kind' | 'goalId'
> {
  kind: 'native_coordinator_turn';
  turnId: string;
  requestId: string;
}

export type NativeCoordinatorPublicationSource =
  NativeCoordinatorResultSource | NativeCoordinatorTurnResultSource;

export interface NativeCoordinatorMainPresentation {
  version: 2;
  nativeCoordinatorResult: NativeCoordinatorPublicationSource;
  responseMessageId: string;
  responseDigest: string;
}

export type MainGenerationPresentation =
  ScheduledMainGenerationPresentation | NativeCoordinatorMainPresentation;
type NativeResultInput =
  | (Omit<NativeCoordinatorResultSource, 'kind'> & { kind?: 'native_coordinator_goal' })
  | NativeCoordinatorTurnResultSource;

export interface MainGenerationDelivery {
  userId?: string;
  conversationId?: string;
  callbackMessageId?: string;
  originRef?: string;
  event?: string;
  surface: string;
  text?: string;
  telegramChatId?: string;
  telegramUserId?: string;
  telegramMessageThreadId?: string;
  voiceCallSessionId?: string;
  mainGenerationPresentation?: MainGenerationPresentation | null;
}

export interface MainGenerationMessage {
  messageId: string;
  user: string;
  conversationId: string;
  isCreatedByUser?: boolean;
  text?: string;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

const textDigest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const boundedId = (value: string) =>
  typeof value === 'string' && value.length > 0 && value.length <= 512;

export function nativeCoordinatorResultSource(
  value: unknown,
): NativeCoordinatorPublicationSource | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as NativeCoordinatorPublicationSource;
  const turn = source.kind === 'native_coordinator_turn';
  if (turn ? 'goalId' in source : 'turnId' in source || 'requestId' in source) return null;
  if (
    (source.kind !== 'native_coordinator_goal' && !turn) ||
    ![
      source.bindingRef,
      source.nativeConversationId,
      ...(turn ? [source.turnId, source.requestId] : [source.goalId]),
      source.runId,
      source.sourceTurnId,
    ].every(boundedId) ||
    typeof source.sourceCallSessionId !== 'string' ||
    source.sourceCallSessionId.length > 512 ||
    !Number.isSafeInteger(source.resultRevision) ||
    source.resultRevision < 1 ||
    !/^sha256:[a-f0-9]{64}$/.test(source.resultDigest)
  )
    return null;
  return source;
}

export function nativeCoordinatorResultVoiceTurnId(
  source: NativeResultInput,
  responseMessageId: string,
) {
  if (source.kind === 'native_coordinator_turn') {
    return `native-turn-result-${createHash('sha256')
      .update(
        JSON.stringify([
          source.bindingRef,
          source.nativeConversationId,
          source.turnId,
          source.requestId,
          source.runId,
          source.resultRevision,
          source.resultDigest,
          responseMessageId,
        ]),
      )
      .digest('hex')}`;
  }
  return `native-result-${createHash('sha256')
    .update(
      JSON.stringify([
        source.bindingRef,
        source.nativeConversationId,
        source.goalId,
        source.runId,
        source.resultRevision,
        source.resultDigest,
        responseMessageId,
      ]),
    )
    .digest('hex')}`;
}

export function nativeCoordinatorResultCortexId(
  source: NativeCoordinatorPublicationSource,
): string {
  return source.kind === 'native_coordinator_turn'
    ? `native-turn-result:${source.nativeConversationId}:${source.turnId}:${source.requestId}:${source.runId}:${source.resultRevision}`
    : `native-result:${source.nativeConversationId}:${source.goalId}:${source.runId}:${source.resultRevision}`;
}

export function mainGenerationPresentation(
  row: MainGenerationDelivery | null | undefined,
): MainGenerationPresentation | null {
  if (!row) return null;
  const value = row.mainGenerationPresentation;
  if (
    !value ||
    row.event !== 'main.followup' ||
    !boundedId(value.responseMessageId) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.responseDigest) ||
    value.responseMessageId !== row.callbackMessageId
  )
    return null;
  if (value.version === 2)
    return nativeCoordinatorResultSource(value.nativeCoordinatorResult) ? value : null;
  if (value.version !== 1 || !boundedId(value.streamId) || !boundedId(value.admissionId))
    return null;
  return value;
}

export function buildMainGenerationPresentation(
  context:
    { streamId: string; admissionId: string } | { nativeCoordinatorResult: NativeResultInput },
  messageId: string,
  text: string,
): MainGenerationPresentation | null {
  const value: MainGenerationPresentation =
    'nativeCoordinatorResult' in context
      ? {
          version: 2,
          nativeCoordinatorResult:
            context.nativeCoordinatorResult.kind === 'native_coordinator_turn'
              ? { ...context.nativeCoordinatorResult }
              : { ...context.nativeCoordinatorResult, kind: 'native_coordinator_goal' },
          responseMessageId: messageId,
          responseDigest: textDigest(text),
        }
      : {
          version: 1,
          streamId: context.streamId,
          admissionId: context.admissionId,
          responseMessageId: messageId,
          responseDigest: textDigest(text),
        };
  return mainGenerationPresentation({
    event: 'main.followup',
    surface: '',
    callbackMessageId: messageId,
    mainGenerationPresentation: value,
  });
}

export interface MainGenerationPresentationDependencies {
  readAdmission(id: string, session?: object): Promise<ScheduleDueAdmission | null>;
  readBinding(id: string, session?: object): Promise<ScheduledConversationBinding | null>;
  readMessage(
    ownerId: string,
    conversationId: string,
    messageId: string,
    session?: object,
  ): Promise<MainGenerationMessage | null>;
  readOwner(ownerId: string): Promise<boolean>;
  readConversation(ownerId: string, conversationId: string): Promise<{ endpoint?: string } | null>;
  readTelegram(
    ownerId: string,
  ): Promise<{ telegramChatId?: string; telegramUserId?: string } | null>;
  readCall(
    id: string,
  ): Promise<{ userId: string; conversationId: string; status: string; mode?: string } | null>;
  readActiveCall?(
    ownerId: string,
    conversationId: string,
  ): Promise<{ callSessionId: string } | null>;
  readNativeCoordinatorResult?(input: {
    source: NativeCoordinatorPublicationSource;
    ownerId: string;
    conversationId: string;
    message: MainGenerationMessage;
    destination: MainGenerationDelivery;
    session?: object;
  }): Promise<boolean>;
}

export function createMainGenerationPresentationVerifier(
  deps: MainGenerationPresentationDependencies,
) {
  return async (row: MainGenerationDelivery, session?: object): Promise<boolean> => {
    const presentation = mainGenerationPresentation(row);
    if (!presentation || !row.userId || !row.conversationId || !row.originRef) return false;
    if (presentation.version === 2) {
      const source = presentation.nativeCoordinatorResult;
      if (
        row.originRef !== source.bindingRef ||
        !['voice', 'telegram', 'librechat'].includes(row.surface) ||
        !deps.readNativeCoordinatorResult
      )
        return false;
      const [message, owner, conversation] = await Promise.all([
        deps.readMessage(row.userId, row.conversationId, presentation.responseMessageId, session),
        deps.readOwner(row.userId),
        deps.readConversation(row.userId, row.conversationId),
      ]);
      if (
        !owner ||
        conversation?.endpoint !== 'agents' ||
        !message ||
        message.messageId !== presentation.responseMessageId ||
        message.user !== row.userId ||
        message.conversationId !== row.conversationId ||
        message.isCreatedByUser !== false ||
        typeof message.text !== 'string' ||
        !message.text.trim() ||
        textDigest(message.text) !== presentation.responseDigest ||
        message.text.trim() !== row.text?.trim()
      )
        return false;
      if (row.surface === 'voice') {
        if (
          !source.sourceCallSessionId ||
          row.voiceCallSessionId !== source.sourceCallSessionId ||
          !deps.readActiveCall
        )
          return false;
        const [call, activeCall] = await Promise.all([
          deps.readCall(source.sourceCallSessionId),
          deps.readActiveCall(row.userId, row.conversationId),
        ]);
        if (
          !call ||
          call.status === 'ended' ||
          call.mode !== 'call' ||
          call.userId !== row.userId ||
          call.conversationId !== row.conversationId ||
          activeCall?.callSessionId !== source.sourceCallSessionId
        )
          return false;
      } else if (row.surface === 'telegram') {
        const mapping = await deps.readTelegram(row.userId);
        if (
          !mapping ||
          (mapping.telegramChatId || mapping.telegramUserId) !== row.telegramChatId ||
          mapping.telegramUserId !== row.telegramUserId
        )
          return false;
      }
      return deps.readNativeCoordinatorResult({
        source,
        ownerId: row.userId,
        conversationId: row.conversationId,
        message,
        destination: row,
        session,
      });
    }
    const admission = await deps.readAdmission(presentation.admissionId, session);
    if (
      !admission ||
      admission.kind !== 'schedule_due' ||
      admission.status !== 'accepted' ||
      !['running', 'delivery_queued'].includes(admission.dueState) ||
      admission.userId !== row.userId ||
      admission.conversationId !== row.conversationId ||
      admission.streamId !== presentation.streamId ||
      admission.bindingRef !== row.originRef ||
      admission.resultMessageId !== presentation.responseMessageId
    )
      return false;
    const [binding, message, owner, conversation] = await Promise.all([
      deps.readBinding(admission.bindingRef, session),
      deps.readMessage(row.userId, row.conversationId, presentation.responseMessageId, session),
      deps.readOwner(row.userId),
      deps.readConversation(row.userId, row.conversationId),
    ]);
    if (
      !binding?.active ||
      binding.ownerId !== row.userId ||
      (binding.conversationPolicy !== 'new' && binding.conversationId !== row.conversationId) ||
      binding.tenantId !== admission.envelope?.principal?.tenant_id ||
      admission.envelope?.principal?.owner_id !== row.userId ||
      !owner ||
      conversation?.endpoint !== 'agents' ||
      !message ||
      message.messageId !== presentation.responseMessageId ||
      message.user !== row.userId ||
      message.conversationId !== row.conversationId ||
      message.isCreatedByUser !== false ||
      typeof message.text !== 'string' ||
      (!message.text.trim() && !message.attachments?.length) ||
      textDigest(message.text) !== presentation.responseDigest ||
      message.text.trim() !== row.text?.trim()
    )
      return false;
    const sourceConversationId = binding.sourceConversationId || binding.conversationId;
    if (
      sourceConversationId !== row.conversationId &&
      (await deps.readConversation(row.userId, sourceConversationId))?.endpoint !== 'agents'
    )
      return false;
    if (row.surface === 'librechat')
      return binding.destinations.some((target) => target.surface === 'librechat');
    if (row.surface === 'telegram') {
      const mapping = await deps.readTelegram(row.userId);
      return Boolean(
        mapping &&
        (mapping.telegramChatId || mapping.telegramUserId) === row.telegramChatId &&
        mapping.telegramUserId === row.telegramUserId &&
        binding.destinations.some(
          (target) =>
            target.surface === 'telegram' &&
            target.telegramChatId === row.telegramChatId &&
            target.telegramUserId === row.telegramUserId &&
            (target.telegramMessageThreadId || '') === (row.telegramMessageThreadId || ''),
        ),
      );
    }
    if (row.surface === 'voice' && row.voiceCallSessionId) {
      const call = await deps.readCall(row.voiceCallSessionId);
      return Boolean(
        call &&
        call.status !== 'ended' &&
        call.mode === 'call' &&
        call.userId === row.userId &&
        call.conversationId === row.conversationId &&
        binding.destinations.some((target) => target.surface === 'librechat'),
      );
    }
    return false;
  };
}
/* === VIVENTIUM END === */
