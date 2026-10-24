/* === VIVENTIUM START === Bind the generic clock to the existing cognitive entry and presenter. === */
import { createHash } from 'crypto';
import { isNoResponseOnly } from '../agents/noResponseTag';
import { getRequiredPromptText } from '../prompts/runtime';
import {
  createScheduleDueDispatcher,
  createScheduleDueReceiver,
  ensureScheduledConversationBinding,
  verifyScheduleDueSignature,
  ScheduleDueError,
} from './scheduleDueReceiver';
import type {
  ScheduledTaskSource,
  ScheduledTaskSourceInput,
  ScheduledTaskSourceSegment,
} from './scheduledTaskSource';
import type {
  ScheduleDueAdmission,
  ScheduleDueStore,
  ScheduledConversationBinding,
  ScheduledDestination,
} from './scheduleDueReceiver';

export interface ScheduledMainRequest {
  userId: string;
  text: string;
  titleText: string;
  conversationId: string;
  idempotencyKey: string;
  scheduleId: string;
  scheduleRunId: string;
  source_event_id: string;
  externalWorkRequired: boolean;
  viventiumSchedulerDeliveryChannels: string[];
  viventiumTelegramMessageThreadId?: string;
}
interface DueHostStore extends ScheduleDueStore {
  claim(): Promise<ScheduleDueAdmission | null>;
  update(admission: ScheduleDueAdmission, patch: Partial<ScheduleDueAdmission>): Promise<void>;
  release(admission: ScheduleDueAdmission): Promise<void>;
  wakeStream(streamId: string): Promise<void>;
}
interface DueHostSource {
  user?: { id?: string; _id?: object | string };
  requestBody?: {
    conversationId?: string;
    conversation_id?: string;
    messageId?: string;
    viventiumSourceEventId?: string;
    viventiumSchedulerDueAdmissionId?: string;
    viventiumStreamId?: string;
    text?: string;
    viventiumTriggeringSourceSegments?: ScheduledTaskSourceSegment[];
    viventiumSurface?: string;
    viventiumTelegramMessageThreadId?: string;
    viventiumScheduleConversationIds?: string[];
  };
}
interface DueHostDependencies {
  store: DueHostStore;
  ensureDestination(input: {
    ownerId: string;
    name: string;
    url: string;
    secret: string;
    payload_mode: 'envelope';
    max_body_bytes: number;
    idempotency_key: string;
  }): Promise<{ destination_id: string }>;
  readDestination?(input: {
    ownerId: string;
    destinationId: string;
  }): Promise<{ url_sha256: string } | null>;
  updateDestination?(input: {
    ownerId: string;
    destinationId: string;
    secret: string;
    max_body_bytes: number;
  }): Promise<unknown>;
  readDestinationSchedules?(input: { ownerId: string; destinationId: string }): Promise<
    Array<{
      definition_id: string;
      version: number;
      target: { kind: string; destination_id?: string; request_data?: object };
    }>
  >;
  retargetSchedule?(input: {
    ownerId: string;
    definitionId: string;
    expected_version: number;
    target: { kind: 'webhook'; destination_id: string; request_data: object };
  }): Promise<unknown>;
  readBindingOwners?(): Promise<string[]>;
  prepareTaskSource(input: ScheduledTaskSourceInput): Promise<ScheduledTaskSource>;
  readBindingTaskText(binding: ScheduledConversationBinding): Promise<string>;
  environment: { [key: string]: string | undefined };
  readOwner(ownerId: string): Promise<boolean>;
  readConversation(ownerId: string, conversationId: string): Promise<{ endpoint?: string } | null>;
  readTelegram(
    ownerId: string,
  ): Promise<{ telegramChatId?: string; telegramUserId?: string } | null>;
  readActiveCall(
    ownerId: string,
    conversationId: string,
  ): Promise<{
    callSessionId?: string;
    userId?: string;
    conversationId?: string;
    mode?: string;
  } | null>;
  dispatch(
    request: ScheduledMainRequest,
  ): Promise<{ streamId: string; conversationId: string; deferred?: boolean }>;
  readJob(streamId: string): Promise<{ status: string } | null>;
  readRetainedResult?(
    admission: ScheduleDueAdmission,
  ): Promise<
    { state: 'complete'; messageId: string } | { state: 'failed'; failureCode: string } | null
  >;
  readResume(streamId: string): Promise<{
    responseMessageId?: string;
    finalEvent?: { responseMessage?: { messageId?: string } };
  } | null>;
  subscribe(streamId: string, onDone: () => void): Promise<{ unsubscribe(): void } | null>;
  readMessage(
    admission: ScheduleDueAdmission,
    messageId: string,
  ): Promise<{ messageId: string; text?: string; attachments?: object[] } | null>;
  enqueue(input: {
    body: { event: 'main.followup'; callback_id: string; origin_ref: string };
    message: object;
    text: string;
    deliveryContext: {
      ownerId: string;
      conversationId: string;
      originRef: string;
      destinations: ScheduledDestination[];
      mainGenerationPresentation: { streamId: string; admissionId: string };
    };
  }): Promise<{ unresolved: number; enqueued: number; configured: number }>;
  onRecoveryError(code: string): void;
  onTiming?(input: { stage: string; durationMs: number; admissionId?: string }): void;
}

export function createScheduleDueHost(deps: DueHostDependencies) {
  const { store, environment } = deps;
  const tenantId = () => environment.VIVENTIUM_TENANT_ID || 'local';
  const destinations = new Map<string, { configuration: string; ready: Promise<string> }>();
  const watched = new Map<string, { unsubscribe(): void } | null>();
  let recoverRequested = false;
  function recordTiming(stage: string, startedAt: number, admissionId?: string) {
    try {
      deps.onTiming?.({
        stage,
        durationMs: performance.now() - startedAt,
        ...(admissionId ? { admissionId } : {}),
      });
    } catch {
      /* Diagnostic output cannot change admission or execution. */
    }
  }
  function secrets() {
    if (environment.VIVENTIUM_XPERFECT_SCHEDULED_WAKES_ENABLED !== 'true') return [];
    const previousUntil = Date.parse(
      environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_PREVIOUS_UNTIL || '',
    );
    return [
      environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_SECRET,
      ...(previousUntil > Date.now()
        ? [environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_PREVIOUS_SECRET]
        : []),
    ].filter((value): value is string => Boolean(value));
  }
  async function authorizeBinding(binding: ScheduledConversationBinding) {
    const [owner, conversation] = await Promise.all([
      deps.readOwner(binding.ownerId),
      deps.readConversation(binding.ownerId, binding.conversationId),
    ]);
    if (!owner || conversation?.endpoint !== 'agents') return false;
    if (
      binding.sourceConversationId &&
      binding.sourceConversationId !== binding.conversationId &&
      (await deps.readConversation(binding.ownerId, binding.sourceConversationId))?.endpoint !==
        'agents'
    )
      return false;
    const telegram = binding.destinations.filter((target) => target.surface === 'telegram');
    if (!telegram.length) return true;
    const mapping = await deps.readTelegram(binding.ownerId);
    return Boolean(
      mapping &&
      telegram.every(
        (target) =>
          String(mapping.telegramChatId || mapping.telegramUserId || '') ===
            target.telegramChatId && String(mapping.telegramUserId || '') === target.telegramUserId,
      ),
    );
  }
  async function receive({
    rawBody,
    eventId,
    timestamp,
    signature,
  }: {
    rawBody: Buffer;
    eventId: string;
    timestamp: string;
    signature: string;
  }) {
    const startedAt = performance.now();
    if (secrets().length && deps.readBindingOwners && !destinationRefreshReady) {
      refreshDestinations().catch(() =>
        deps.onRecoveryError('schedule_destination_refresh_unavailable'),
      );
      throw new ScheduleDueError('schedule_destination_refresh_pending', 503);
    }
    if (!Buffer.isBuffer(rawBody))
      throw new ScheduleDueError('schedule_due_raw_body_unavailable', 400);
    verifyScheduleDueSignature({ rawBody, eventId, timestamp, signature, secrets: secrets() });
    recordTiming('receiver_signature_ms', startedAt);
    const admissionStartedAt = performance.now();
    const result = await createScheduleDueReceiver({
      store,
      tenantId: tenantId(),
      authorizeBinding,
    }).admit(rawBody, eventId);
    recordTiming('receiver_admission_ms', admissionStartedAt, result.admission._id);
    recordTiming('receiver_total_ms', startedAt, result.admission._id);
    return result;
  }
  function destinationConflict(error: unknown) {
    const value = error as {
      status?: number;
      body?: { detail?: { code?: string; destination_id?: string; changed_fields?: string[] } };
    };
    const detail = value?.body?.detail;
    return value?.status === 409 &&
      detail?.code === 'webhook_destination_create_conflict' &&
      typeof detail.destination_id === 'string' &&
      Array.isArray(detail.changed_fields)
      ? detail
      : null;
  }
  async function ensureDestination(ownerId: string) {
    const configured = environment.VIVENTIUM_XPERFECT_SCHEDULE_DESTINATION_ID;
    const url = environment.VIVENTIUM_XPERFECT_SCHEDULE_WEBHOOK_URL;
    const secret = secrets()[0];
    if (!url || !secret) return configured || null;
    const integrationIdentity = createHash('sha256')
      .update(JSON.stringify([tenantId(), ownerId, 'scheduled-main-v1']))
      .digest('hex');
    const runtimeIdentity = createHash('sha256')
      .update(JSON.stringify([integrationIdentity, configured, url, secret]))
      .digest('hex');
    if (destinations.get(integrationIdentity)?.configuration !== runtimeIdentity) {
      const startedAt = performance.now();
      const pending = (async () => {
        const rotate = async (destinationId: string) => {
          if (!deps.updateDestination)
            throw new ScheduleDueError('schedule_destination_rotation_unavailable', 503);
          await deps.updateDestination({ ownerId, destinationId, secret, max_body_bytes: 65536 });
          return destinationId;
        };
        const create = (key: string) =>
          deps.ensureDestination({
            ownerId,
            name: 'Scheduled Main',
            url,
            secret,
            payload_mode: 'envelope',
            max_body_bytes: 65536,
            idempotency_key: key,
          });
        const key = `scheduled-main:${integrationIdentity}`;
        const replacement = async (previousId: string) => {
          const replacementKey = `${key}:${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
          let replacementId: string;
          try {
            replacementId = (await create(replacementKey)).destination_id;
          } catch (replacementError) {
            const conflict = destinationConflict(replacementError);
            if (!conflict || conflict.changed_fields!.includes('url')) throw replacementError;
            replacementId = await rotate(conflict.destination_id!);
          }
          if (!deps.readDestinationSchedules || !deps.retargetSchedule)
            throw new ScheduleDueError('schedule_destination_retarget_unavailable', 503);
          // Only future configuration moves. Accepted generations and immutable occurrence
          // snapshots retain their own identities and are never replayed during setup.
          while (true) {
            const definitions = await deps.readDestinationSchedules({
              ownerId,
              destinationId: previousId,
            });
            if (!definitions.length) break;
            for (const definition of definitions) {
              if (
                definition.target?.kind !== 'webhook' ||
                definition.target.destination_id !== previousId
              )
                throw new ScheduleDueError('schedule_destination_scope_mismatch', 503);
              await deps.retargetSchedule({
                ownerId,
                definitionId: definition.definition_id,
                expected_version: definition.version,
                target: {
                  kind: 'webhook',
                  destination_id: replacementId,
                  request_data: definition.target.request_data || {},
                },
              });
            }
          }
          return replacementId;
        };
        if (configured) {
          const current = await deps.readDestination?.({ ownerId, destinationId: configured });
          if (!current?.url_sha256)
            throw new ScheduleDueError('schedule_destination_metadata_unavailable', 503);
          return current.url_sha256 === createHash('sha256').update(url).digest('hex')
            ? rotate(configured)
            : replacement(configured);
        }
        try {
          return (await create(key)).destination_id;
        } catch (error) {
          const conflict = destinationConflict(error);
          if (!conflict) throw error;
          return conflict.changed_fields!.includes('url')
            ? replacement(conflict.destination_id!)
            : rotate(conflict.destination_id!);
        }
      })().finally(() => recordTiming('scheduled_destination_setup_ms', startedAt));
      destinations.set(integrationIdentity, { configuration: runtimeIdentity, ready: pending });
      pending.catch(() => {
        if (destinations.get(integrationIdentity)?.ready === pending)
          destinations.delete(integrationIdentity);
      });
    }
    return destinations.get(integrationIdentity)!.ready;
  }
  async function ensureTargets({ user, requestBody }: DueHostSource) {
    if (!secrets().length) return [];
    const preparationStartedAt = performance.now();
    try {
      const ownerId = String(user?.id || user?._id || '');
      const conversationId = String(
        requestBody?.conversationId || requestBody?.conversation_id || '',
      );
      let sourceEventId = String(
        requestBody?.viventiumSourceEventId || requestBody?.messageId || '',
      );
      // Native Main carries the exact selected originals in the existing source ledger,
      // not in a duplicate top-level text field. Direct receiver setup also accepts text.
      const sources = requestBody?.viventiumTriggeringSourceSegments;
      let taskText =
        Array.isArray(sources) && sources.length
          ? sources
              .map((source) => (typeof source?.text === 'string' ? source.text : ''))
              .join('\n\n')
          : typeof requestBody?.text === 'string'
            ? requestBody.text
            : '';
      if (!ownerId || !conversationId || conversationId === 'new') return [];
      const authorityStartedAt = performance.now();
      if ((await deps.readConversation(ownerId, conversationId))?.endpoint !== 'agents') return [];
      let sourceConversationId = conversationId;
      let taskSource: ScheduledTaskSource | undefined;
      let originalSources = sources;
      const dueAdmissionId = requestBody?.viventiumSchedulerDueAdmissionId;
      if (dueAdmissionId) {
        const admission = await store.readAdmission(dueAdmissionId);
        if (
          admission?.kind !== 'schedule_due' ||
          admission.status !== 'accepted' ||
          admission.userId !== ownerId ||
          admission.conversationId !== conversationId ||
          admission.streamId !== requestBody?.viventiumStreamId ||
          admission.envelope.principal.tenant_id !== tenantId() ||
          admission.envelope.principal.owner_id !== ownerId
        )
          return [];
        const binding = await store.readBinding(admission.bindingRef);
        if (
          !binding?.active ||
          binding.ownerId !== ownerId ||
          binding.tenantId !== tenantId() ||
          !(await authorizeBinding(binding))
        )
          return [];
        sourceEventId = binding.sourceEventId;
        taskText = await deps.readBindingTaskText(binding);
        taskSource = binding.taskSource;
        originalSources = undefined;
        sourceConversationId = binding.sourceConversationId || binding.conversationId;
      }
      if (!sourceEventId || !taskText) return [];
      taskSource ||= await deps.prepareTaskSource({
        ownerId,
        conversationId: sourceConversationId,
        sourceEventId,
        taskText,
        sources: originalSources,
      });
      recordTiming('scheduled_target_authority_ms', authorityStartedAt);
      const metadataStartedAt = performance.now();
      const [destinationId, mapping] = await Promise.all([
        ensureDestination(ownerId),
        deps.readTelegram(ownerId),
      ]);
      recordTiming('scheduled_target_destination_and_channel_ms', metadataStartedAt);
      if (!destinationId) return [];
      const chat: ScheduledDestination[] = [{ surface: 'librechat' }];
      const telegram: ScheduledDestination[] = mapping?.telegramUserId
        ? [
            {
              surface: 'telegram',
              telegramChatId: String(mapping.telegramChatId || mapping.telegramUserId),
              telegramUserId: String(mapping.telegramUserId),
              ...(requestBody?.viventiumTelegramMessageThreadId
                ? {
                    telegramMessageThreadId: String(requestBody.viventiumTelegramMessageThreadId),
                  }
                : {}),
            },
          ]
        : [];
      const defaultTelegram = requestBody?.viventiumSurface === 'telegram';
      if (defaultTelegram && !telegram.length) return [];
      const channelChoices = telegram.length
        ? defaultTelegram
          ? [
              { label: 'Telegram', destinations: telegram },
              { label: 'Web chat', destinations: chat },
              { label: 'Web chat and Telegram', destinations: [...chat, ...telegram] },
            ]
          : [
              { label: 'Web chat', destinations: chat },
              { label: 'Telegram', destinations: telegram },
              { label: 'Web chat and Telegram', destinations: [...chat, ...telegram] },
            ]
        : [{ label: 'Web chat', destinations: chat }];
      const conversations: Array<{
        label: string;
        conversationId: string;
        conversationPolicy: 'same' | 'new';
      }> = [
        { label: 'Same conversation', conversationId, conversationPolicy: 'same' },
        { label: 'New conversation when due', conversationId, conversationPolicy: 'new' },
      ];
      const requested = requestBody?.viventiumScheduleConversationIds;
      const selected = Array.isArray(requested) ? [...new Set(requested)].slice(0, 8) : [];
      const selectedConversations = await Promise.all(
        selected
          .filter((id) => typeof id === 'string' && id !== conversationId)
          .map(async (id) => ({ id, conversation: await deps.readConversation(ownerId, id) })),
      );
      for (const { id, conversation } of selectedConversations) {
        if (conversation?.endpoint === 'agents') {
          conversations.push({
            label: `Selected conversation ${id}`,
            conversationId: id,
            conversationPolicy: 'same',
          });
        }
      }
      const bindingsStartedAt = performance.now();
      const targets = await Promise.all(
        conversations.flatMap((conversation) =>
          channelChoices.map(async (choice) => {
            const binding = await ensureScheduledConversationBinding({
              store,
              tenantId: tenantId(),
              ownerId,
              conversationId: conversation.conversationId,
              conversationPolicy: conversation.conversationPolicy,
              sourceConversationId,
              sourceEventId,
              taskText,
              taskSource,
              destinations: choice.destinations,
            });
            if (!binding.active) return null;
            return {
              kind: 'webhook' as const,
              destination_id: destinationId,
              request_data: { request_ref: binding._id },
              label: `${conversation.label} · ${choice.label}`,
            };
          }),
        ),
      );
      recordTiming('scheduled_target_bindings_ms', bindingsStartedAt);
      return targets.filter((target): target is NonNullable<typeof target> => target !== null);
    } finally {
      recordTiming('scheduled_target_preparation_ms', preparationStartedAt);
    }
  }
  async function ensureTarget(input: DueHostSource) {
    return (await ensureTargets(input))[0] || null;
  }

  function requestRecovery() {
    recoverRequested = true;
    setImmediate(() =>
      reconcile().catch(() => deps.onRecoveryError('schedule_due_recovery_unavailable')),
    );
  }
  function watch(streamId: string) {
    if (watched.has(streamId)) return;
    watched.set(streamId, null);
    const onDone = () => {
      watched.get(streamId)?.unsubscribe();
      watched.delete(streamId);
      setImmediate(() => {
        store
          .wakeStream(streamId)
          .then(requestRecovery)
          .catch(() => deps.onRecoveryError('schedule_due_recovery_unavailable'));
      });
    };
    deps
      .subscribe(streamId, onDone)
      .then((subscription) => {
        if (watched.has(streamId)) watched.set(streamId, subscription);
        else subscription?.unsubscribe();
      })
      .catch(() => watched.delete(streamId));
  }
  const dispatcher = createScheduleDueDispatcher({
    claim: store.claim,
    readBinding: store.readBinding,
    authorizeBinding,
    update: store.update,
    release: store.release,
    dispatch: async (admission, binding) => {
      const startedAt = performance.now();
      const originalTaskText = await deps.readBindingTaskText(binding);
      const telegramDestination = binding.destinations.find((item) => item.surface === 'telegram');
      const receipt = await deps.dispatch({
        userId: admission.userId,
        text: [
          getRequiredPromptText('scheduler.run_envelope', {
            scheduled_run_context: [
              `- run_started_at_utc: ${new Date().toISOString()}`,
              `- scheduled_due_at_utc: ${admission.envelope.scheduled_at}`,
              getRequiredPromptText('scheduler.run_context_contract'),
            ].join('\n'),
          }),
          admission.envelope.instruction?.trim()
            ? admission.envelope.instruction
            : originalTaskText,
        ].join('\n\n'),
        titleText: originalTaskText,
        conversationId: admission.conversationId,
        idempotencyKey: admission.idempotencyKey,
        scheduleId: admission.envelope.schedule_id,
        scheduleRunId: admission.envelope.occurrence_id,
        source_event_id: admission.eventId,
        externalWorkRequired: true,
        viventiumSchedulerDeliveryChannels: binding.destinations.map((item) => item.surface),
        ...(telegramDestination?.telegramMessageThreadId
          ? { viventiumTelegramMessageThreadId: telegramDestination.telegramMessageThreadId }
          : {}),
      });
      recordTiming('normal_main_admission_ms', startedAt, admission._id);
      return receipt;
    },
    async readResult(admission) {
      if (admission.resultMessageId) {
        const message = await deps.readMessage(admission, admission.resultMessageId);
        return message?.messageId === admission.resultMessageId
          ? { state: 'complete', messageId: message.messageId }
          : { state: 'unknown', failureCode: 'schedule_due_result_unavailable' };
      }
      const job = await deps.readJob(admission.streamId);
      if (!job) {
        const retained = await deps.readRetainedResult?.(admission);
        return retained || { state: 'unknown', failureCode: 'schedule_due_stream_unavailable' };
      }
      if (job.status === 'running') {
        watch(admission.streamId);
        return { state: 'pending' };
      }
      if (job.status !== 'complete')
        return { state: 'failed', failureCode: 'scheduled_execution_failed' };
      const state = await deps.readResume(admission.streamId);
      const messageId = state?.finalEvent?.responseMessage?.messageId || state?.responseMessageId;
      if (!messageId) return { state: 'unknown', failureCode: 'schedule_due_result_unavailable' };
      return { state: 'complete', messageId };
    },
    async present(admission, binding, messageId) {
      const startedAt = performance.now();
      const message = await deps.readMessage(admission, messageId);
      if (!message) throw new ScheduleDueError('schedule_due_result_unavailable', 503);
      const current = await store.readBinding(binding._id);
      if (!current?.active || !(await authorizeBinding(current)))
        throw new ScheduleDueError('schedule_due_binding_revoked', 403);
      const text = message.text || '';
      if ((!text.trim() && !message.attachments?.length) || isNoResponseOnly(text))
        return { silent: true };
      await store.update(admission, { resultMessageId: message.messageId });
      const selectedDestinations = [...current.destinations];
      if (text.trim() && selectedDestinations.some((target) => target.surface === 'librechat')) {
        const call = await deps.readActiveCall(admission.userId, admission.conversationId);
        if (
          call?.mode === 'call' &&
          call.callSessionId &&
          call.userId === admission.userId &&
          call.conversationId === admission.conversationId
        ) {
          selectedDestinations.push({
            surface: 'voice',
            voiceCallSessionId: call.callSessionId,
            voiceRequestId: admission.streamId,
          });
        }
      }
      const summary = await deps.enqueue({
        body: {
          event: 'main.followup',
          callback_id: `scheduled:${admission.eventId}`,
          origin_ref: binding._id,
        },
        message,
        text,
        deliveryContext: {
          ownerId: admission.userId,
          conversationId: admission.conversationId,
          originRef: binding._id,
          destinations: selectedDestinations,
          mainGenerationPresentation: { streamId: admission.streamId, admissionId: admission._id },
        },
      });
      if (summary.unresolved || summary.enqueued < summary.configured)
        throw new ScheduleDueError('schedule_due_delivery_unavailable', 503);
      recordTiming('presenter_enqueue_ms', startedAt, admission._id);
      return { silent: false };
    },
  });
  let destinationRefresh: Promise<void> | null = null;
  let destinationRefreshReady = false;
  async function refreshDestinations() {
    if (!secrets().length || !deps.readBindingOwners) return;
    if (!destinationRefresh) {
      destinationRefresh = (async () => {
        for (const ownerId of await deps.readBindingOwners!()) {
          if (await deps.readOwner(ownerId)) await ensureDestination(ownerId);
        }
        destinationRefreshReady = true;
      })();
      destinationRefresh.catch(() => {
        destinationRefresh = null;
      });
    }
    await destinationRefresh;
  }
  async function reconcile() {
    recoverRequested = false;
    try {
      await refreshDestinations();
    } catch {
      deps.onRecoveryError('schedule_destination_refresh_unavailable');
    }
    await dispatcher.reconcile();
    if (recoverRequested) requestRecovery();
  }
  return { receive, ensureTarget, ensureTargets, reconcile };
}
/* === VIVENTIUM END === */
