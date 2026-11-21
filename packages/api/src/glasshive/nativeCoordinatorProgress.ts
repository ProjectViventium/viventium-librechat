/* === VIVENTIUM START === Main authors and verifies current Native progress. === */
import { createHash } from 'node:crypto';
import isEqual from 'lodash/isEqual';
import { buildCortexInsightDeliveryCandidates } from '../cortex/insightDeliveryService';
import { buildMainGenerationPresentation } from './mainGenerationPresentation';
import type { IViventiumCortexInsightDelivery } from '@librechat/data-schemas';
import type { createCortexInsightDeliveryService } from '../cortex/insightDeliveryService';
import type { NativeCoordinatorBinding, NativeCoordinatorSource } from './nativeCoordinator';
import type { NativeCoordinatorPreparedContext } from './nativeCoordinatorContext';
import type {
  MainGenerationMessage,
  MainGenerationPresentation,
  NativeCoordinatorProgressSource,
} from './mainGenerationPresentation';

type DeliveryService = ReturnType<typeof createCortexInsightDeliveryService>;
type ClaimedBatch = Awaited<ReturnType<DeliveryService['claimPendingByParent']>>;
type ProgressRow = Pick<
  IViventiumCortexInsightDelivery,
  | 'deliveryId'
  | 'userId'
  | 'conversationId'
  | 'parentMessageId'
  | 'publicationId'
  | 'status'
  | 'persistedMessageId'
  | 'graphResultHash'
  | 'insightHash'
  | 'insight'
>;
export interface NativeCoordinatorProgressData {
  conversation_id: string;
  request_ref: string;
  source_turn_id: string;
  goal_id?: string;
  turn_id?: string;
  request_id?: string;
  run_id: string;
  attempt_id: string;
  progress_id: string;
  progress_digest: string;
  progress_text: string;
}
interface ProgressMessage extends Omit<MainGenerationMessage, 'metadata'> {
  metadata?: {
    viventium?: {
      mainGenerationPresentation?: MainGenerationPresentation;
      cortexInsightDeliveryIds?: string[];
    };
  };
}
interface ProgressInsight {
  cortexId: string;
  insight: string;
  authority: {
    kind: 'native_coordinator_progress';
    runId: string;
    source: NativeCoordinatorProgressSource;
  };
}
interface ProgressParent {
  ownerId: string;
  conversationId: string;
  parentMessageId: string;
  publicationId?: string;
  surface?: string;
  message?: ProgressMessage;
}
interface ProgressPublication {
  event_id: string;
  type: string;
  source_turn_id: string;
  data: NativeCoordinatorProgressData;
}
interface ProgressSubject {
  source_turn_id: string;
  run_id: string;
  intent_state: string;
  restore_hold?: boolean;
  state: string;
  turn_id?: string;
  request_id?: string;
  goal_id?: string;
}
interface ProgressRun {
  run_id: string;
  tenant_id: string;
  state: string;
  active_attempt_id: string;
}
interface ProgressInput {
  binding: NativeCoordinatorBinding;
  data: NativeCoordinatorProgressData;
  eventId: string;
}
interface ProgressTrace {
  stage: string;
  sourceDigest: string;
  reason?: string;
  ownership?: boolean;
  subjectPresent?: boolean;
  runPresent?: boolean;
  sourceMatches?: boolean;
  subjectRunMatches?: boolean;
  acceptedIntent?: boolean;
  restoreHold?: boolean;
  subjectState?: string;
  runState?: string;
  runMatches?: boolean;
  tenantMatches?: boolean;
  attemptMatches?: boolean;
  turnMatches?: boolean;
  goalMatches?: boolean;
  rowCount?: number;
  statuses?: string[];
  found?: boolean;
  authorityVersion?: number | null;
  superseded?: boolean;
  configured?: number;
  enqueued?: number;
  unresolved?: number;
  publicationPresent?: boolean;
}
export interface NativeCoordinatorProgressDependencies {
  trace?(record: ProgressTrace): void;
  tenantId(): string;
  readBinding(ref: string): Promise<NativeCoordinatorBinding | null>;
  readSource(ref: string, turnId: string): Promise<NativeCoordinatorSource | null>;
  readSubject(
    binding: NativeCoordinatorBinding,
    value: NativeCoordinatorProgressSource,
  ): Promise<ProgressSubject | null>;
  readRun(ownerId: string, runId: string): Promise<ProgressRun | null>;
  claimPending(parent: ProgressParent): Promise<Pick<ClaimedBatch, 'claimed'>>;
  markDropped(input: {
    ownerId: string;
    claims: ClaimedBatch['claimed'];
    dropReason: 'semantic_suppression';
  }): Promise<object>;
  readRows(parent: ProgressParent & { deliveryIds: string[] }): Promise<ProgressRow[]>;
  readMessage(
    parent: ProgressParent & { deliveryIds: string[]; rows: ProgressRow[] },
  ): Promise<ProgressMessage | null>;
  prepare(
    input: Omit<ProgressInput, 'data'> & { source: NativeCoordinatorSource },
  ): Promise<Pick<NativeCoordinatorPreparedContext, 'presentationContext'>>;
  createFollowUp(
    input: ProgressInput & {
      context: object;
      source: NativeCoordinatorSource;
      parentMessageId: string;
      insights: ProgressInsight[];
    },
  ): Promise<object | null>;
  enqueue(
    input: ProgressInput & { source: NativeCoordinatorSource; message: ProgressMessage },
  ): Promise<{ configured?: number; enqueued?: number; unresolved?: number }>;
  readPublications(binding: NativeCoordinatorBinding): Promise<ProgressPublication[]>;
  readBindings(ownerId: string, conversationId: string): Promise<NativeCoordinatorBinding[]>;
  settleRows(
    parent: ProgressParent,
    message: ProgressMessage,
    surface: 'web',
    receipt: string,
  ): Promise<boolean>;
}
const digest = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const failure = (code: string) => Object.assign(new Error(code), { code, status: 503 });
const parentId = (source: NativeCoordinatorSource) => {
  const value = source.requestBody.messageId || source.requestBody.parentMessageId;
  return typeof value === 'string' ? value : '';
};
const progressSource = (
  binding: NativeCoordinatorBinding,
  source: NativeCoordinatorSource,
  data: NativeCoordinatorProgressData,
): NativeCoordinatorProgressSource => {
  if (!binding.nativeConversationId || (!data.goal_id && (!data.turn_id || !data.request_id)))
    throw failure('coordinator_progress_identity_invalid');
  const callSession =
    source.requestBody.viventiumCallSessionId ||
    source.requestBody.viventiumVoiceCallSessionId ||
    '';
  return {
    kind: 'native_coordinator_progress',
    bindingRef: binding._id,
    nativeConversationId: binding.nativeConversationId,
    ...(data.goal_id
      ? { goalId: data.goal_id }
      : { turnId: data.turn_id!, requestId: data.request_id! }),
    runId: data.run_id,
    attemptId: data.attempt_id,
    progressId: data.progress_id,
    progressDigest: data.progress_digest,
    sourceTurnId: source.turnId,
    sourceCallSessionId: typeof callSession === 'string' ? callSession : '',
  };
};
export function createNativeCoordinatorProgressService(
  deps: NativeCoordinatorProgressDependencies,
) {
  function trace(
    stage: string,
    value: NativeCoordinatorProgressSource | undefined,
    details: Partial<ProgressTrace> = {},
  ) {
    try {
      deps.trace?.({ stage, sourceDigest: digest(JSON.stringify(value || {})), ...details });
    } catch {
      /* Diagnostics must not change publication or authorization. */
    }
  }
  function rejected(reason: string, value: NativeCoordinatorProgressSource | undefined) {
    trace('verify.reject', value, { reason });
    return false;
  }
  function source(
    binding: NativeCoordinatorBinding,
    original: NativeCoordinatorSource,
    data: NativeCoordinatorProgressData,
  ) {
    if (
      data.conversation_id !== binding.nativeConversationId ||
      data.request_ref !== binding._id ||
      data.source_turn_id !== original.turnId
    )
      throw failure('coordinator_progress_scope_invalid');
    const value = progressSource(binding, original, data);
    if (
      !buildMainGenerationPresentation({ nativeCoordinatorProgress: value }, 'progress-source', '')
    )
      throw failure('coordinator_progress_identity_invalid');
    return value;
  }

  async function ownership(value?: NativeCoordinatorProgressSource) {
    if (
      !value ||
      !buildMainGenerationPresentation({ nativeCoordinatorProgress: value }, 'progress-source', '')
    )
      return null;
    const binding = await deps.readBinding(value.bindingRef);
    if (
      !binding ||
      !binding.active ||
      binding.tenantId !== deps.tenantId() ||
      binding.nativeConversationId !== value.nativeConversationId
    )
      return null;
    const original = await deps.readSource(binding._id, value.sourceTurnId);
    if (
      !original ||
      original.bindingRef !== binding._id ||
      original.turnId !== value.sourceTurnId ||
      original.requestBody?.conversationId !== binding.conversationId ||
      !parentId(original)
    )
      return null;
    return { binding, original };
  }

  async function current(value?: NativeCoordinatorProgressSource) {
    const owned = await ownership(value);
    if (!owned || !value) {
      trace('current.reject', value, { ownership: false });
      return false;
    }
    const { binding } = owned;
    const [subject, run] = await Promise.all([
      deps.readSubject(binding, value),
      deps.readRun(binding.ownerId, value.runId),
    ]);
    const accepted = Boolean(
      subject &&
      run &&
      subject.source_turn_id === value.sourceTurnId &&
      subject.run_id === value.runId &&
      subject.intent_state === 'accepted' &&
      !subject.restore_hold &&
      ['running', 'streaming'].includes(subject.state) &&
      run.run_id === value.runId &&
      run.tenant_id === binding.tenantId &&
      run.state === 'running' &&
      run.active_attempt_id === value.attemptId &&
      (!value.turnId ||
        (subject.turn_id === value.turnId && subject.request_id === value.requestId)) &&
      (!value.goalId || subject.goal_id === value.goalId),
    );
    if (!accepted)
      trace('current.reject', value, {
        ownership: true,
        subjectPresent: Boolean(subject),
        runPresent: Boolean(run),
        sourceMatches: subject?.source_turn_id === value.sourceTurnId,
        subjectRunMatches: subject?.run_id === value.runId,
        acceptedIntent: subject?.intent_state === 'accepted',
        restoreHold: Boolean(subject?.restore_hold),
        subjectState: subject?.state || undefined,
        runState: run?.state || undefined,
        runMatches: run?.run_id === value.runId,
        tenantMatches: run?.tenant_id === binding.tenantId,
        attemptMatches: run?.active_attempt_id === value.attemptId,
        turnMatches:
          !value.turnId ||
          (subject?.turn_id === value.turnId && subject?.request_id === value.requestId),
        goalMatches: !value.goalId || subject?.goal_id === value.goalId,
      });
    return accepted;
  }

  async function insightsCurrent(
    insights: readonly {
      authority?: { kind?: string; source?: NativeCoordinatorProgressSource };
    }[],
  ) {
    for (const insight of insights || []) {
      if (insight.authority?.kind !== 'native_coordinator_progress') continue;
      if (!(await current(insight.authority.source))) return false;
    }
    return true;
  }

  function evidence(
    value: NativeCoordinatorProgressSource,
    data: NativeCoordinatorProgressData,
    eventId: string,
  ): ProgressInsight {
    if (
      typeof data.progress_text !== 'string' ||
      !data.progress_text.trim() ||
      digest(data.progress_text) !== data.progress_digest
    )
      throw failure('coordinator_progress_digest_invalid');
    // Preserve the native public report verbatim. This is evidence, never a ready-to-send reply.
    return {
      cortexId: eventId,
      insight: JSON.stringify({
        type: 'work_progress',
        state: 'running',
        report: data.progress_text,
        source: value,
      }),
      authority: { kind: 'native_coordinator_progress', runId: value.runId, source: value },
    };
  }

  function bind(message: ProgressMessage, value: NativeCoordinatorProgressSource): ProgressMessage {
    const authority = buildMainGenerationPresentation(
      { nativeCoordinatorProgress: value },
      message.messageId,
      message.text || '',
    );
    const previous = message.metadata?.viventium?.mainGenerationPresentation;
    if (!authority || (previous && !isEqual(previous, authority)))
      throw failure('coordinator_progress_authority_conflict');
    return {
      ...message,
      metadata: {
        ...message.metadata,
        viventium: { ...message.metadata?.viventium, mainGenerationPresentation: authority },
      },
    };
  }

  async function bindForSave(
    message: ProgressMessage,
    binding: NativeCoordinatorBinding,
    original: NativeCoordinatorSource,
    data: NativeCoordinatorProgressData,
  ) {
    const value = source(binding, original, data);
    if (!(await current(value))) throw failure('coordinator_progress_superseded');
    return bind(message, value);
  }

  async function drop(parent: ProgressParent) {
    const batch = await deps.claimPending(parent);
    if (batch.claimed?.length)
      await deps.markDropped({
        ownerId: parent.ownerId,
        claims: batch.claimed,
        dropReason: 'semantic_suppression',
      });
  }

  async function publish({ binding, data, eventId }: ProgressInput) {
    const original = await deps.readSource(binding._id, data.source_turn_id);
    if (!original) throw failure('coordinator_progress_original_unavailable');
    const value = source(binding, original, data);
    const owned = await ownership(value);
    if (
      !owned ||
      owned.binding.ownerId !== binding.ownerId ||
      owned.binding.conversationId !== binding.conversationId ||
      owned.binding.tenantId !== binding.tenantId
    )
      throw failure('coordinator_progress_scope_invalid');
    const insight = evidence(value, data, eventId);
    const parent: ProgressParent = {
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      parentMessageId: parentId(original),
      publicationId: eventId,
      surface:
        original.requestBody.viventiumSurface === 'voice'
          ? 'web'
          : String(original.requestBody.viventiumSurface || 'web'),
    };
    if (!(await current(value))) {
      await drop(parent);
      return { suppressed: true };
    }
    const candidates = buildCortexInsightDeliveryCandidates({
      ...parent,
      surface: parent.surface,
      insights: [insight],
    });
    if (candidates.length !== 1) throw failure('coordinator_progress_evidence_invalid');
    const deliveryIds = candidates.map((candidate) => candidate.deliveryId);
    const rows = await deps.readRows({ ...parent, deliveryIds });
    trace('publish.rows', value, {
      rowCount: rows.length,
      statuses: rows.map((row) => row.status),
    });
    if (rows.length && rows.every((row) => row.status === 'sent' || row.status === 'dropped'))
      return { duplicate: true };
    let message = await deps.readMessage({ ...parent, deliveryIds, rows });
    trace('publish.read_message', value, {
      found: Boolean(message),
      authorityVersion: message?.metadata?.viventium?.mainGenerationPresentation?.version || null,
    });
    if (!message) {
      const context = await deps.prepare({ binding, source: original, eventId });
      try {
        await deps.createFollowUp({
          context: context.presentationContext,
          binding,
          source: original,
          parentMessageId: parent.parentMessageId,
          eventId,
          insights: [insight],
          data,
        });
        trace('publish.after_author', value);
      } catch (error) {
        trace('publish.author_rejected', value, {
          superseded:
            error instanceof Error &&
            'code' in error &&
            error.code === 'coordinator_progress_superseded',
        });
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'coordinator_progress_superseded'
        ))
          throw error;
        await drop(parent);
        return { suppressed: true };
      }
      message = await deps.readMessage({
        ...parent,
        deliveryIds,
        rows: await deps.readRows({ ...parent, deliveryIds }),
      });
      trace('publish.read_authored_message', value, {
        found: Boolean(message),
        authorityVersion: message?.metadata?.viventium?.mainGenerationPresentation?.version || null,
      });
    }
    // When the current Main accepted this evidence, its own reply and receipt remain the owner.
    // Never turn a new foreground reply into a second standalone progress presentation.
    if (!message || message.metadata?.viventium?.mainGenerationPresentation?.version !== 3)
      return { pending: true };
    if (!(await current(value))) {
      await drop(parent);
      return { suppressed: true };
    }
    trace('publish.before_enqueue', value);
    const receipt = await deps.enqueue({ binding, source: original, eventId, message, data });
    trace('publish.enqueued', value, {
      configured: Number(receipt?.configured || 0),
      enqueued: Number(receipt?.enqueued || 0),
      unresolved: Number(receipt?.unresolved || 0),
    });
    if (
      Number(receipt?.unresolved || 0) ||
      (Number(receipt?.configured || 0) && !Number(receipt?.enqueued || 0))
    )
      throw failure('coordinator_progress_delivery_unconfirmed');
    return { accepted: true };
  }

  async function verify({
    source: value,
    ownerId,
    conversationId,
    message,
  }: {
    source: NativeCoordinatorProgressSource;
    ownerId: string;
    conversationId: string;
    message: ProgressMessage;
  }) {
    const owned = await ownership(value);
    if (
      !owned ||
      owned.binding.ownerId !== ownerId ||
      owned.binding.conversationId !== conversationId ||
      !(await current(value)) ||
      !isEqual(
        buildMainGenerationPresentation(
          { nativeCoordinatorProgress: value },
          message.messageId,
          message.text || '',
        ),
        message.metadata?.viventium?.mainGenerationPresentation,
      )
    )
      return rejected('scope_current_or_authority', value);
    const deliveryIds = message.metadata?.viventium?.cortexInsightDeliveryIds;
    if (!Array.isArray(deliveryIds) || deliveryIds.length !== 1)
      return rejected('delivery_ids', value);
    const rows = await deps.readRows({
      ownerId,
      conversationId,
      parentMessageId: parentId(owned.original),
      deliveryIds,
    });
    if (
      rows.length !== 1 ||
      rows[0].persistedMessageId !== message.messageId ||
      rows[0].userId !== ownerId ||
      rows[0].conversationId !== conversationId ||
      rows[0].parentMessageId !== parentId(owned.original) ||
      rows[0].status === 'dropped' ||
      rows[0].graphResultHash !== rows[0].insightHash ||
      rows[0].insightHash !== digest(rows[0].insight).slice(7)
    )
      return rejected('ledger_proof', value);
    let retained: {
      type: string;
      state: string;
      report: string;
      source: NativeCoordinatorProgressSource;
    };
    try {
      retained = JSON.parse(rows[0].insight);
    } catch {
      return rejected('ledger_json', value);
    }
    if (
      retained.type !== 'work_progress' ||
      retained.state !== 'running' ||
      typeof retained.report !== 'string' ||
      !isEqual(retained.source, value) ||
      digest(retained.report) !== value.progressDigest
    )
      return rejected('ledger_report', value);
    const publication = (await deps.readPublications(owned.binding)).find(
      (item) => item.event_id === rows[0].publicationId,
    );
    const verified = Boolean(
      publication?.type === 'coordinator.progress_ready' &&
      publication.data?.request_ref === owned.binding._id &&
      publication.data.conversation_id === value.nativeConversationId &&
      publication.data.source_turn_id === value.sourceTurnId &&
      publication.source_turn_id === value.sourceTurnId &&
      isEqual(source(owned.binding, owned.original, publication.data), value) &&
      publication.data.progress_text === retained.report,
    );
    trace(verified ? 'verify.accepted' : 'verify.reject', value, {
      ...(verified ? {} : { reason: 'native_publication' }),
      publicationPresent: Boolean(publication),
    });
    return verified;
  }

  async function persistAuthority(
    message: ProgressMessage,
    binding: NativeCoordinatorBinding,
    original: NativeCoordinatorSource,
    data: NativeCoordinatorProgressData,
  ) {
    const value = source(binding, original, data);
    if (
      !(await verify({
        source: value,
        ownerId: binding.ownerId,
        conversationId: binding.conversationId,
        message,
      }))
    )
      throw failure('coordinator_progress_superseded');
    return message;
  }

  async function recover(parent: ProgressParent) {
    if (!parent.publicationId) return false;
    for (const binding of await deps.readBindings(parent.ownerId, parent.conversationId)) {
      const publication = (await deps.readPublications(binding)).find(
        (item) => item.event_id === parent.publicationId,
      );
      if (publication?.type !== 'coordinator.progress_ready') continue;
      if (
        publication.data.request_ref !== binding._id ||
        publication.data.conversation_id !== binding.nativeConversationId
      )
        throw failure('coordinator_progress_publication_invalid');
      await publish({ binding, data: publication.data, eventId: publication.event_id });
      return true;
    }
    return false;
  }

  return {
    source,
    publish,
    verify,
    recover,
    insightsCurrent,
    bindForSave,
    persistAuthority,
    voiceTurnId: (value: NativeCoordinatorProgressSource, messageId: string) =>
      `native-progress-${createHash('sha256')
        .update(JSON.stringify([value, messageId]))
        .digest('hex')}`,
    settleLinkedWeb: async (parent: ProgressParent) => {
      const message = parent.message;
      const authority = message?.metadata?.viventium?.mainGenerationPresentation;
      if (
        !message ||
        authority?.version !== 3 ||
        !(await verify({
          source: authority.nativeCoordinatorProgress,
          ownerId: parent.ownerId,
          conversationId: parent.conversationId,
          message,
        }))
      )
        return false;
      return deps.settleRows(parent, message, 'web', `message:${message.messageId}`);
    },
  };
}

/* === VIVENTIUM END === */
