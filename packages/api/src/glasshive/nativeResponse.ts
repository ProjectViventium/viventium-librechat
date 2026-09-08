import { GenerationJobManager } from '../stream/GenerationJobManager';
import { getVerifiedNativeSources, stripNativePredecessorSupersession } from './nativeSupersession';
/* === VIVENTIUM START === Exact native invocation binding and saved-result recovery. === */
import { createHash } from 'node:crypto';
import {
  NATIVE_RESPONSE_RECOVERY_WINDOW_MS,
  nativeIdentityJson,
} from '../stream/implementations/nativeResponse';
import { nativeResponseDigest } from '@librechat/data-schemas';
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
  response?: {
    id: string;
    object: string;
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
  projectMessage?: (
    identity: NativeResponseIdentity,
    response: NonNullable<NativeResult['response']>,
    message: NativeResponseMessageProjection,
    purpose: 'persist' | 'transmit' | 'terminal',
    candidate?: Pick<NativeResponseCandidate, 'requestId' | 'runId'>,
  ) => NativeResponseMessageProjection;
  fetch?: MainContinuityFetch;
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
    if (result && (result.state !== 'completed' || !result.authority_sha256)) {
      throw new Error('native_graph_tool_evidence_unavailable');
    }
    const current = await deps.db.getNativeResponse(userId, responseMessageId);
    if (
      !current?.nativeResponse ||
      nativeIdentityJson(current.nativeResponse) !== nativeIdentityJson(identity) ||
      current.nativeResponse.status !== identity.status ||
      current.unfinished !== false ||
      current.error === true ||
      nativeResponseDigest({ text: current.text, content: current.content }) !==
        nativeResponseDigest({ text: row.text, content: row.content })
    ) {
      throw new Error('native_graph_tool_evidence_parent_changed');
    }
    if (!(await deps.db.nativeResponseSourceMatches(identity))) {
      throw new Error('native_graph_tool_evidence_source_changed');
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
      digest = await deps.db.prepareNativeResponse(
        identity,
        {
          text: choice.message.content,
          authoritySha256: result.authority_sha256,
          requestId: result.request_id,
          runId: result.run_id,
          responseJson: JSON.stringify(result.response),
        },
        deps.transaction,
      );
    }
    if (
      (identity.deliveryDispositionRequired || identity.deliveryContext) &&
      !deps.projectMessage
    ) {
      throw new Error('native_response_delivery_projection_unavailable');
    }
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
    };
  }

  return { admit, readResult, readToolEvidence, recover, projectForTransmit, scanRecoverable };
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

export function createNativeResponseFetch(
  baseFetch: MainContinuityFetch,
  getContext: () => Promise<NativeResponseFetchContext | null>,
  admit: (identity: NativeResponseIdentity) => Promise<boolean>,
  onBound: (identity: NativeResponseIdentity) => void,
): MainContinuityFetch {
  let bound: NativeResponseIdentity | undefined;
  let boundPredecessor: Awaited<ReturnType<typeof GenerationJobManager.getNativePredecessorSupersession>>;
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
    const predecessor = bound ? boundPredecessor : verifiedSources
      ? await GenerationJobManager.getNativePredecessorSupersession(context, verifiedSources)
      : undefined;
    if (predecessor) {
      const payload = JSON.parse(init.body);
      payload.metadata = { ...payload.metadata, native_predecessor_supersession: predecessor };
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
    if (!(await admit(identity))) return baseFetch(input, stripNativePredecessorSupersession(init));
    if (verifiedSources) await GenerationJobManager.retainNativeAcceptedSources(identity, verifiedSources);
    bound = identity;
    boundPredecessor = predecessor;
    onBound(identity);
    const headers = new Headers(
      init.headers || (input instanceof Request ? input.headers : undefined),
    );
    headers.set('X-Viventium-Native-Invocation-Id', invocationId);
    headers.set('X-Viventium-Native-Body-SHA256', bodySha256);
    return baseFetch(input, { ...init, headers });
  };
}
/* === VIVENTIUM END === */
