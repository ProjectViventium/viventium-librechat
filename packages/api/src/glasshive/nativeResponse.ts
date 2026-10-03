import { GenerationJobManager } from '../stream/GenerationJobManager';
import { getVerifiedNativeSources, stripNativePredecessorSupersession } from './nativeSupersession';
/* === VIVENTIUM START === Exact native invocation binding and saved-result recovery. === */
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import {
  NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
  nativeIdentityJson,
} from '../stream/implementations/nativeResponse';
import { logger, nativeResponseDigest } from '@librechat/data-schemas';
import { ContentTypes } from 'librechat-data-provider';
import {
  nativeGraphToolEvidenceContent,
  nativeToolEvidenceForMemory,
  nativeToolEvidenceUnavailableContent,
} from './nativeToolEvidence';
import { convertHarnessActivityParts } from '../utils/content';
import type { MainContinuityFetch } from '../continuity/mainContinuity';
import type {
  NativeResponseIdentity,
  NativeResponseAdmission,
  NativeResponseSource,
  NativeResponseCommit,
  NativeResponseCandidate,
  NativeResponseDeliveryContext,
  NativeResponseMessageProjection,
  createNativeResponseMethods,
} from '@librechat/data-schemas';

type Methods = ReturnType<typeof createNativeResponseMethods>;

/* === VIVENTIUM START ===
 * Fix: Phase B writes its cortex lifecycle parts onto the same answer row while the answer's
 * evidence is read. They are not the answer, so they cannot make an unchanged answer look replaced.
 * === VIVENTIUM END === */
const CORTEX_LIFECYCLE_PARTS = new Set<string>([
  ContentTypes.CORTEX_ACTIVATION,
  ContentTypes.CORTEX_BREWING,
  ContentTypes.CORTEX_INSIGHT,
]);
function nativeAnswerDigest(row: { text?: unknown; content?: unknown }): string {
  const content = Array.isArray(row.content)
    ? row.content.filter((part) => !CORTEX_LIFECYCLE_PARTS.has(part?.type))
    : row.content;
  return nativeResponseDigest({ text: row.text, content });
}
type Transaction = <T>(operation: () => Promise<T>) => Promise<T>;
type NativeResult = {
  version: number;
  object: string;
  state: string;
  invocation_id: string;
  stream_id: string;
  message_id: string;
  body_sha256: string;
  authority_sha256: string;
  agent_id: string;
  conversation_id: string;
  request_id: string;
  run_id: string;
  graph_tool_evidence?: unknown;
  failure_class?: string;
  response?: {
    id: string;
    object: string;
    glasshive?: { output_files?: unknown };
    choices: Array<{
      finish_reason: string;
      message: { role: string; content: string | null; tool_calls?: object[] };
    }>;
  };
};

export interface NativeResponseRoute {
  baseURL: string;
  headers: HeadersInit;
}
export interface NativeResponseDependencies {
  db: Pick<
    Methods,
    | 'getNativeResponse'
    | 'nativeResponseSourceMatches'
    | 'listNativeResponses'
    | 'admitNativeResponse'
    | 'prepareNativeResponse'
    | 'materializeNativeResponse'
    | 'materializeNativeResponseTerminal'
    | 'settleNativeResponse'
  >;
  transaction: Transaction;
  bind: (identity: NativeResponseIdentity) => Promise<boolean>;
  commit: (identity: NativeResponseIdentity, digest: string) => Promise<NativeResponseCommit>;
  revoke: (identity: NativeResponseIdentity) => Promise<NativeResponseCommit>;
  isCurrent: (identity: NativeResponseIdentity) => Promise<boolean>;
  authorizeTerminal: (identity: NativeResponseIdentity) => Promise<boolean>;
  release?: (identity: NativeResponseIdentity) => Promise<boolean>;
  resolveRoute: (identity: NativeResponseIdentity) => Promise<NativeResponseRoute>;
  prepareAttachments?: (
    identity: NativeResponseIdentity,
    response: NonNullable<NativeResult['response']>,
    candidate: NativeResponseCandidate,
  ) => Promise<NativeResponseMessageProjection['attachments']>;
  projectMessage?: (
    identity: NativeResponseIdentity,
    response: NonNullable<NativeResult['response']>,
    message: NativeResponseMessageProjection,
    purpose: 'persist' | 'transmit' | 'terminal',
    candidate?: Pick<NativeResponseCandidate, 'requestId' | 'runId'>,
  ) => NativeResponseMessageProjection;
  fetch?: MainContinuityFetch;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}

export function nativeResponseSha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function nativeResponseOrigin(baseURL: string): string {
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash)
    throw new Error('native_response_origin_invalid');
  return nativeResponseSha256(url.href.replace(/\/$/, ''));
}

export function createNativeResponseRecoveryService(deps: NativeResponseDependencies) {
  let recoveryPass: Promise<void> | undefined;

  function scanRecoverable(handle: (admission: NativeResponseAdmission) => Promise<void>) {
    if (recoveryPass) return recoveryPass;
    recoveryPass = (async () => {
      const cursor = deps.db.listNativeResponses(0).cursor({ batchSize: 100 });
      try {
        for await (const row of cursor) {
          if (row.nativeResponse) await handle(row.nativeResponse);
        }
      } finally {
        await cursor.close();
      }
    })().finally(() => {
      recoveryPass = undefined;
    });
    return recoveryPass;
  }

  async function currentRoute(identity: NativeResponseIdentity) {
    const route = await deps.resolveRoute(identity);
    if (nativeResponseOrigin(route.baseURL) !== identity.originSha256) {
      throw new Error('native_response_route_changed');
    }
    return route;
  }
  async function releaseUnsupported(identity: NativeResponseIdentity, alreadyUnsupported = false) {
    if (!alreadyUnsupported) {
      const revoked = await deps.revoke(identity);
      if (revoked.status !== 'revoked') throw new Error('native_response_handoff_unavailable');
      const settled = await deps.db.settleNativeResponse(identity, 'unsupported');
      if (settled.matchedCount !== 1) throw new Error('native_response_handoff_unavailable');
    }
    if (!deps.release || !(await deps.release(identity)))
      throw new Error('native_response_handoff_unavailable');
  }
  async function admit(identity: NativeResponseIdentity): Promise<boolean> {
    await currentRoute(identity);
    const previous = await deps.db.getNativeResponse(identity.userId, identity.responseMessageId);
    if (previous?.nativeResponse?.status === 'unsupported') {
      await releaseUnsupported(previous.nativeResponse, true);
      return false;
    }
    if (
      previous?.nativeResponse &&
      previous.nativeResponse.invocationId !== identity.invocationId
    ) {
      await releaseUnsupported(previous.nativeResponse);
      return false;
    }
    if (!(await deps.bind(identity))) throw new Error('native_response_job_revoked');
    try {
      await deps.db.admitNativeResponse(identity, deps.transaction);
    } catch (error) {
      const revoked = await deps.revoke(identity);
      // No provider request has been dispatched. Release only a proven absent admission;
      // an uncertain transaction remains fenced for recovery instead of ordinary publication.
      const retained = await deps.db.getNativeResponse(identity.userId, identity.responseMessageId);
      if (revoked.status === 'revoked' && !retained?.nativeResponse && deps.release) {
        await deps.release(identity);
        // This failed before provider dispatch; preserve the cause without blaming the model.
        throw Object.assign(
          new Error(error instanceof Error ? error.message : 'native_response_admission_failed'),
          { code: 'source_context_unavailable', cause: error },
        );
      }
      throw error;
    }
    if (!(await deps.bind(identity))) {
      await deps.db.settleNativeResponse(identity, 'cancelled');
      throw new Error('native_response_job_revoked');
    }
    return true;
  }

  async function readResult(
    identity: NativeResponseIdentity,
    includeToolEvidence = false,
  ): Promise<NativeResult | null> {
    const route = await currentRoute(identity);
    const base = route.baseURL.replace(/\/$/, '');
    const url = new URL(
      `${base}/requests/by-invocation/${encodeURIComponent(identity.invocationId)}/result`,
    );
    url.searchParams.set('stream_id', identity.streamId);
    url.searchParams.set('message_id', identity.responseMessageId);
    url.searchParams.set('body_sha256', identity.bodySha256);
    if (includeToolEvidence) url.searchParams.set('include_tool_evidence', 'true');
    const response = await (deps.fetch || fetch)(url, {
      method: 'GET',
      headers: route.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`native_response_lookup_${response.status}`);
    const result = (await response.json()) as NativeResult;
    if (
      result.version !== 1 ||
      result.object !== 'glasshive.request.result' ||
      result.invocation_id !== identity.invocationId ||
      result.stream_id !== identity.streamId ||
      result.message_id !== identity.responseMessageId ||
      result.body_sha256 !== identity.bodySha256 ||
      result.agent_id !== identity.agentId ||
      result.conversation_id !== identity.conversationId
    ) {
      throw new Error('native_response_identity_mismatch');
    }
    return result;
  }

  async function readToolEvidence(
    userId: string,
    conversationId: string,
    responseMessageId: string,
  ) {
    const row = await deps.db.getNativeResponse(userId, responseMessageId);
    const identity = row?.nativeResponse;
    if (!identity) return [];
    if (
      identity.userId !== userId ||
      identity.conversationId !== conversationId ||
      identity.responseMessageId !== responseMessageId ||
      String(row.user) !== userId ||
      row.conversationId !== conversationId ||
      row.messageId !== responseMessageId
    ) {
      throw new Error('native_graph_tool_evidence_identity_mismatch');
    }
    if (
      row.unfinished !== false ||
      row.error === true ||
      !['completed', 'unsupported'].includes(identity.status)
    ) {
      throw Object.assign(new Error('native_graph_tool_evidence_parent_unfinished'), {
        code: 'native_graph_tool_evidence_parent_unfinished',
      });
    }
    if (!(await deps.db.nativeResponseSourceMatches(identity))) {
      throw new Error('native_graph_tool_evidence_source_changed');
    }
    const result = await readResult(identity, true);
    if (
      result &&
      ((result.state !== 'completed' && identity.status !== 'unsupported') ||
        (result.state === 'completed' && !result.authority_sha256))
    ) {
      throw new Error('native_graph_tool_evidence_unavailable');
    }
    const current = await deps.db.getNativeResponse(userId, responseMessageId);
    if (
      !current?.nativeResponse ||
      nativeIdentityJson(current.nativeResponse) !== nativeIdentityJson(identity) ||
      current.nativeResponse.status !== identity.status ||
      current.unfinished !== false ||
      current.error === true ||
      nativeAnswerDigest(current) !== nativeAnswerDigest(row)
    ) {
      throw new Error('native_graph_tool_evidence_parent_changed');
    }
    if (!(await deps.db.nativeResponseSourceMatches(identity))) {
      throw new Error('native_graph_tool_evidence_source_changed');
    }
    if (identity.status === 'unsupported' && result && result.state !== 'completed') {
      return nativeToolEvidenceUnavailableContent(identity, 'native_attempt_incomplete');
    }
    if (result?.graph_tool_evidence == null) {
      const retained =
        identity.status === 'completed'
          ? nativeToolEvidenceForMemory({ ...row, user: String(row.user) }, identity).map(
              (part) => ({ type: 'text' as const, text: JSON.stringify(part) }),
            )
          : [];
      return [
        ...retained,
        ...nativeToolEvidenceUnavailableContent(
          identity,
          result ? 'graph_evidence_missing' : 'saved_result_missing',
        ),
      ];
    }
    return nativeGraphToolEvidenceContent(identity, result.graph_tool_evidence);
  }

  // Native publication and external presentation can finish after Main generation. Wait for
  // their exact persisted completion; never read a pending or unfinished parent's graph evidence.
  async function readToolEvidenceForPresentation(
    userId: string,
    conversationId: string,
    responseMessageId: string,
    waitMs: number,
  ) {
    const now = deps.now || Date.now;
    const wait =
      deps.wait || ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + Math.max(0, Number.isFinite(waitMs) ? waitMs : 0);
    for (;;) {
      try {
        return await readToolEvidence(userId, conversationId, responseMessageId);
      } catch (error) {
        if ((error as { code?: string }).code !== 'native_graph_tool_evidence_parent_unfinished')
          throw error;
        const row = await deps.db.getNativeResponse(userId, responseMessageId);
        const identity = row?.nativeResponse;
        if (
          !identity ||
          identity.userId !== userId ||
          identity.conversationId !== conversationId ||
          identity.responseMessageId !== responseMessageId ||
          String(row.user) !== userId ||
          row.conversationId !== conversationId ||
          row.messageId !== responseMessageId
        )
          throw error;
        if (
          row.error === true ||
          !['pending', 'prepared', 'completed', 'unsupported'].includes(identity.status)
        )
          throw error;
        if (!(await deps.db.nativeResponseSourceMatches(identity)))
          throw new Error('native_graph_tool_evidence_source_changed');
        if (row.unfinished === false && ['completed', 'unsupported'].includes(identity.status))
          continue;
        const acknowledgement = (
          row as unknown as {
            metadata?: {
              viventium?: {
                deliveryAcknowledgement?: { state?: string };
              };
            };
          }
        ).metadata?.viventium?.deliveryAcknowledgement?.state;
        if (
          now() >= deadline ||
          acknowledgement === 'failed' ||
          acknowledgement === 'partial_removed'
        )
          return nativeToolEvidenceUnavailableContent(identity, 'parent_uncommitted');
        await wait(Math.min(100, Math.max(1, deadline - now())));
      }
    }
  }

  async function recover(
    identity: NativeResponseIdentity,
    onTerminal?: (status: 'failed' | 'cancelled') => void,
  ) {
    const row = await deps.db.getNativeResponse(identity.userId, identity.responseMessageId);
    const admission = row?.nativeResponse;
    if (!admission || nativeIdentityJson(admission) !== nativeIdentityJson(identity)) return null;
    if (
      admission.status === 'cancelled' &&
      typeof admission.stopSnapshotStoredAt === 'number' &&
      admission.stopSnapshotStoredAt > 0 &&
      admission.recoverUntil > Date.now()
    )
      return visible(row);
    if (admission.stopSnapshotStoredAt !== undefined) return null;
    if (
      typeof admission.terminalSnapshotStoredAt === 'number' &&
      admission.terminalSnapshotStoredAt > 0 &&
      ['failed', 'cancelled'].includes(admission.status) &&
      admission.recoverUntil > Date.now()
    ) {
      onTerminal?.(admission.status as 'failed' | 'cancelled');
      return visible(row);
    }
    if (admission.terminalSnapshotStoredAt !== undefined) return null;
    if (admission.status === 'unsupported') {
      await releaseUnsupported(identity, true);
      return null;
    }
    if (admission.status === 'completed') return visible(row);
    if (!['pending', 'prepared', 'failed', 'cancelled'].includes(admission.status)) return null;
    if (identity.recoverUntil <= Date.now()) {
      await deps.revoke(identity);
      await deps.db.settleNativeResponse(identity, 'failed');
      return null;
    }
    if (['failed', 'cancelled'].includes(admission.status) && !(await deps.isCurrent(identity)))
      return null;
    let candidateForFiles: NativeResponseCandidate | undefined = admission.candidateJson
      ? JSON.parse(admission.candidateJson)
      : undefined;
    let digest = ['pending', 'prepared'].includes(admission.status)
      ? admission.candidateSha256
      : undefined;
    if (digest) await currentRoute(identity);
    if (!digest) {
      const result = await readResult(identity);
      if (!result || ['queued', 'running'].includes(result.state)) return null;
      if (['failed', 'cancelled'].includes(result.state)) {
        const status = result.state === 'cancelled' ? 'cancelled' : 'failed';
        const saved = await deps.db.materializeNativeResponseTerminal(
          identity,
          status,
          deps.authorizeTerminal,
          deps.transaction,
          (message: NativeResponseMessageProjection) => {
            const projected = { ...message, content: convertHarnessActivityParts(message.content) };
            return deps.projectMessage
              ? deps.projectMessage(
                  identity,
                  { id: result.request_id, object: 'chat.completion', choices: [] },
                  projected,
                  'terminal',
                )
              : projected;
          },
          result.failure_class,
        );
        if (saved?.nativeResponse?.terminalSnapshotStoredAt) onTerminal?.(status);
        return visible(saved);
      }
      if (!['pending', 'prepared'].includes(admission.status)) return null;
      const choice = result.response?.choices?.[0];
      if (
        result.state !== 'completed' ||
        !result.authority_sha256 ||
        !result.response ||
        result.response.object !== 'chat.completion' ||
        result.response.id !== result.request_id ||
        result.response.choices.length !== 1 ||
        choice?.finish_reason !== 'stop' ||
        choice.message.role !== 'assistant' ||
        typeof choice.message.content !== 'string' ||
        choice.message.tool_calls?.length
      ) {
        // Host graph continuations retain their existing host owner; a native tool call is not
        // a completed Main answer and must never be flattened into one during recovery.
        await releaseUnsupported(identity);
        return null;
      }
      candidateForFiles = {
        text: choice.message.content,
        authoritySha256: result.authority_sha256,
        requestId: result.request_id,
        runId: result.run_id,
        responseJson: JSON.stringify(result.response),
      };
      digest = await deps.db.prepareNativeResponse(identity, candidateForFiles, deps.transaction);
    }
    if (
      (identity.deliveryDispositionRequired || identity.deliveryContext) &&
      !deps.projectMessage
    ) {
      throw new Error('native_response_delivery_projection_unavailable');
    }
    const fileResponse = candidateForFiles ? JSON.parse(candidateForFiles.responseJson) : undefined;
    if (
      fileResponse?.glasshive?.output_files != null &&
      nativeResponseDigest(candidateForFiles!) !== digest
    )
      throw new Error('native_response_candidate_mismatch');
    const prepareFiles =
      fileResponse?.glasshive?.output_files != null && deps.prepareAttachments
        ? () => deps.prepareAttachments!(identity, fileResponse, candidateForFiles!)
        : undefined;
    return visible(
      await deps.db.materializeNativeResponse(
        identity,
        digest,
        deps.commit,
        deps.transaction,
        (candidate: NativeResponseCandidate, message: NativeResponseMessageProjection) => {
          const projected = { ...message, content: convertHarnessActivityParts(message.content) };
          return deps.projectMessage
            ? deps.projectMessage(
                identity,
                JSON.parse(candidate.responseJson),
                projected,
                'persist',
                candidate,
              )
            : projected;
        },
        ...(prepareFiles ? [prepareFiles] : []),
      ),
    );
  }

  async function projectForTransmit<T extends NativeResponseMessageProjection>(
    identity: NativeResponseIdentity,
    message: T,
  ): Promise<T | null> {
    const row = await deps.db.getNativeResponse(identity.userId, identity.responseMessageId);
    const admission = row?.nativeResponse;
    if (!admission || nativeIdentityJson(admission) !== nativeIdentityJson(identity)) return null;
    if (
      ((admission.status === 'cancelled' &&
        typeof admission.stopSnapshotStoredAt === 'number' &&
        admission.stopSnapshotStoredAt > 0) ||
        (['failed', 'cancelled'].includes(admission.status) &&
          typeof admission.terminalSnapshotStoredAt === 'number' &&
          admission.terminalSnapshotStoredAt > 0)) &&
      admission.recoverUntil > Date.now()
    ) {
      return {
        ...message,
        text: row.text,
        content: row.content,
        metadata: row.metadata,
        unfinished: row.unfinished,
        error: row.error,
        finish_reason: row.finish_reason,
        attachments: row.attachments,
      };
    }
    if (admission.status !== 'completed') return null;
    const candidate = JSON.parse(admission.candidateJson || '') as NativeResponseCandidate;
    if (nativeResponseDigest(candidate) !== admission.candidateSha256) {
      throw new Error('native_response_candidate_mismatch');
    }
    const publicMessage = {
      text: candidate.text,
      content: convertHarnessActivityParts([
        { type: 'text', text: candidate.text },
        ...(row.content || []).filter(
          (part: unknown) => !['text', 'error'].includes(String((part as { type?: string })?.type)),
        ),
      ]),
      metadata: row.metadata,
      attachments: row.attachments,
    };
    const projected = deps.projectMessage
      ? deps.projectMessage(
          admission,
          JSON.parse(candidate.responseJson),
          publicMessage,
          'transmit',
          candidate,
        )
      : publicMessage;
    return {
      ...message,
      text: projected.text,
      content: projected.content,
      metadata: projected.metadata,
      attachments: projected.attachments,
    };
  }

  return {
    admit,
    readResult,
    readToolEvidence,
    readToolEvidenceForPresentation,
    recover,
    projectForTransmit,
    scanRecoverable,
  };
}

function visible<T extends { nativeResponse?: object; savedMemoryWrite?: object }>(
  row: T | null,
): Omit<T, 'nativeResponse' | 'savedMemoryWrite'> | null {
  if (!row) return null;
  const { nativeResponse: _native, savedMemoryWrite: _memory, ...result } = row;
  return result;
}

export interface NativeResponseFetchContext {
  userId: string;
  conversationId: string;
  responseMessageId: string;
  streamId: string;
  jobCreatedAt: number;
  logicalTurnId: string;
  revision: number;
  sourceOrderScope?: string;
  sourceSequence?: number;
  deliveryDispositionRequired?: boolean;
  deliveryContext?: NativeResponseDeliveryContext;
  providerId: string;
  agentId: string;
  source: NativeResponseSource;
}

/**
 * The current logical-turn revision owns the native conversation only after its superseded
 * predecessors release. Both hooks are owned by the host adapter, which knows the provider route.
 */
export interface NativeResponseRelease {
  /** Wait for superseded native Main operations of this logical turn to release. */
  beforeDispatch: (context: NativeResponseFetchContext) => Promise<void>;
  /**
   * The native session reported typed occupancy before admission. Resolve true to dispatch the
   * same invocation again (still current, not stopped), false to return the typed condition.
   */
  whileOccupied: (context: NativeResponseFetchContext) => Promise<boolean>;
  /** Whether this revision still owns its running logical turn. */
  isCurrent: (context: NativeResponseFetchContext) => Promise<boolean>;
}

function nativeDispatchSupersededError(): Error {
  return Object.assign(new Error('operation was aborted'), {
    name: 'AbortError',
    code: 'superseded',
  });
}

const NATIVE_SESSION_OCCUPIED = 'conversation_session_authority_conflict';
const NATIVE_CAPACITY_WAIT_MS = 30_000;

async function nativeCapacityRetryDelay(response: Response): Promise<number | null> {
  if (response.status !== 503) return null;
  const seconds = Number(response.headers.get('Retry-After'));
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  try {
    const body = (await response.clone().json()) as { error?: { code?: string } };
    return body?.error?.code === 'host_capacity' ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

interface NativeCapacityRecovery {
  waitUntil: number;
  startedAt: number;
  signal?: AbortSignal | null;
  isCurrent?: () => Promise<boolean>;
  streamId?: string;
  invocationId?: string;
  role?: 'main' | 'cortex';
}

async function recoverNativeCapacityResponse(
  response: Response,
  dispatch: () => Promise<Response>,
  recovery: NativeCapacityRecovery,
): Promise<Response> {
  while (true) {
    const capacityDelay = await nativeCapacityRetryDelay(response);
    if (capacityDelay === null || Date.now() + capacityDelay > recovery.waitUntil) return response;
    if (recovery.isCurrent && !(await recovery.isCurrent())) throw nativeDispatchSupersededError();
    const timing = {
      role: recovery.role || 'unspecified',
      streamHash: recovery.streamId ? nativeResponseSha256(recovery.streamId).slice(0, 16) : null,
      retryAfterMs: capacityDelay,
      waitedMs: Date.now() - recovery.startedAt,
    };
    // The shared log formatter renders message text. Keep timing visible without raw identities.
    logger.info(
      `[VIVENTIUM][native-response] Host capacity admission wait ${JSON.stringify(timing)}`,
    );
    await wait(capacityDelay, undefined, { signal: recovery.signal || undefined });
    if (recovery.isCurrent && !(await recovery.isCurrent())) throw nativeDispatchSupersededError();
    response = await dispatch();
  }
}

export function createNativeCapacityFetch(
  baseFetch: MainContinuityFetch,
  {
    signal,
    deadlineAt,
    streamId,
    role,
  }: {
    signal: AbortSignal;
    deadlineAt?: number;
    streamId?: string;
    role?: 'main' | 'cortex';
  },
): MainContinuityFetch {
  return async (input, init) => {
    const requestUrl =
      typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    if (!new URL(requestUrl).pathname.endsWith('/chat/completions')) return baseFetch(input, init);
    if (input instanceof Request && init?.body == null) {
      init = { ...init, headers: init?.headers || input.headers, body: await input.clone().text() };
    }
    const signals = [signal, init?.signal].filter((value): value is AbortSignal => Boolean(value));
    const dispatch = {
      ...init,
      signal: (
        AbortSignal as typeof AbortSignal & { any(signals: AbortSignal[]): AbortSignal }
      ).any(signals),
    };
    const startedAt = Date.now();
    return recoverNativeCapacityResponse(
      await baseFetch(input, dispatch),
      () => baseFetch(input, dispatch),
      {
        signal: dispatch.signal,
        startedAt,
        waitUntil: Math.min(startedAt + NATIVE_CAPACITY_WAIT_MS, deadlineAt ?? Infinity),
        streamId,
        role,
      },
    );
  };
}

async function isNativeSessionOccupied(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body = (await response.clone().json()) as { error?: { code?: unknown } };
    return body?.error?.code === NATIVE_SESSION_OCCUPIED;
  } catch {
    return false;
  }
}

export function createNativeResponseFetch(
  baseFetch: MainContinuityFetch,
  getContext: () => Promise<NativeResponseFetchContext | null>,
  admit: (identity: NativeResponseIdentity) => Promise<boolean>,
  onBound: (identity: NativeResponseIdentity) => void,
  release?: NativeResponseRelease,
): MainContinuityFetch {
  let bound: NativeResponseIdentity | undefined;
  let boundPredecessor: Awaited<
    ReturnType<typeof GenerationJobManager.getNativePredecessorSupersession>
  >;
  return async (input, init) => {
    const verifiedSources = getVerifiedNativeSources(init);
    if (input instanceof Request && init?.body == null && !['GET', 'HEAD'].includes(input.method)) {
      init = { ...init, headers: init?.headers || input.headers, body: await input.clone().text() };
    }
    init = stripNativePredecessorSupersession(init);
    const requestUrl =
      typeof input === 'string' || input instanceof URL ? String(input) : input.url;
    const url = new URL(requestUrl);
    if (!url.pathname.endsWith('/chat/completions')) return baseFetch(input, init);
    const suppliedContext = await getContext();
    if (!suppliedContext) return baseFetch(input, init);
    const context = {
      ...suppliedContext,
      source: Object.freeze({
        ...suppliedContext.source,
        ...(suppliedContext.source.parent
          ? { parent: Object.freeze({ ...suppliedContext.source.parent }) }
          : {}),
      }),
      ...(suppliedContext.deliveryContext
        ? { deliveryContext: Object.freeze({ ...suppliedContext.deliveryContext }) }
        : {}),
    };
    if (typeof init?.body !== 'string') throw new Error('native_response_serialized_body_required');
    if (!bound && release) await release.beforeDispatch(context);
    const predecessor = bound
      ? boundPredecessor
      : verifiedSources
        ? await GenerationJobManager.getNativePredecessorSupersession(context, verifiedSources)
        : undefined;
    {
      const payload = JSON.parse(init.body);
      payload.metadata = {
        ...payload.metadata,
        ...(predecessor ? { native_predecessor_supersession: predecessor } : {}),
        // The revision's absolute deadline starts when it began, however long it waited.
        response_started_at: new Date(context.jobCreatedAt).toISOString(),
      };
      init = { ...init, body: JSON.stringify(payload) };
    }
    const bodySha256 = nativeResponseSha256(init.body as string);
    const origin = new URL(url.href);
    origin.pathname = origin.pathname.slice(0, -'/chat/completions'.length);
    const originSha256 = nativeResponseOrigin(origin.href);
    const invocationId = nativeResponseSha256(
      JSON.stringify({ ...context, bodySha256, originSha256 }),
    );
    const admittedAt = bound?.admittedAt || Date.now();
    const identity =
      bound?.invocationId === invocationId
        ? bound
        : {
            ...context,
            bodySha256,
            originSha256,
            invocationId,
            admittedAt,
            recoverUntil: admittedAt + NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
          };
    if (!(await admit(identity))) {
      // A later invocation of the current revision continues unbound; a revision replaced after
      // its release check makes no provider call.
      if (release && !(await release.isCurrent(context))) throw nativeDispatchSupersededError();
      return baseFetch(input, stripNativePredecessorSupersession(init));
    }
    if (verifiedSources)
      await GenerationJobManager.retainNativeAcceptedSources(identity, verifiedSources);
    bound = identity;
    boundPredecessor = predecessor;
    onBound(identity);
    const headers = new Headers(
      init.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set('X-Viventium-Native-Invocation-Id', invocationId);
    headers.set('X-Viventium-Native-Body-SHA256', bodySha256);
    const dispatch = { ...init, headers };
    let response = await baseFetch(input, dispatch);
    const capacityWaitUntil = Date.now() + NATIVE_CAPACITY_WAIT_MS;
    // Typed occupancy is refused before native admission, so the identical invocation may be
    // offered again once released. Its anchored deadline still ends the wait truthfully.
    while (true) {
      if (release && (await isNativeSessionOccupied(response))) {
        if (dispatch.signal?.aborted || !(await release.whileOccupied(context))) break;
        response = await baseFetch(input, dispatch);
        continue;
      }
      const recovered = await recoverNativeCapacityResponse(
        response,
        () => baseFetch(input, dispatch),
        {
          waitUntil: capacityWaitUntil,
          startedAt: capacityWaitUntil - NATIVE_CAPACITY_WAIT_MS,
          signal: dispatch.signal,
          isCurrent: release ? () => release.isCurrent(context) : undefined,
          streamId: context.streamId,
          invocationId,
          role: 'main',
        },
      );
      if (recovered === response) break;
      response = recovered;
    }
    return response;
  };
}
/* === VIVENTIUM END === */
