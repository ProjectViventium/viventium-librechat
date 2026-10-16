/* === VIVENTIUM START ===
 * Completed current-turn insights may enter the existing native Main run. This courier never
 * cancels/replays Main or settles user presentation: a queued native ACK is not consumption.
 * The durable after-Main relevance/delivery path remains responsible for every accepted insight.
 * === VIVENTIUM END === */
import { createHash } from 'node:crypto';
import type { MainContinuityFetch } from '../continuity/mainContinuity';
import { normalizeMainBackgroundInputs } from '@librechat/data-schemas';
import type {
  IMainContinuityBackgroundInput,
  IMainContinuityBackgroundInputReceipt,
  NativeResponseAdmission,
  NativeResponseIdentity,
} from '@librechat/data-schemas';
import type {
  SerializableJobData,
  SourceOrderObservation,
  SourceOrderObservationResult,
} from '../stream/interfaces/IJobStore';
import { nativeIdentityJson, nativeJobMatches } from '../stream/implementations/nativeResponse';
import { nativeResponseOrigin } from '../glasshive/nativeResponse';
import type { NativeResponseRoute } from '../glasshive/nativeResponse';

type Insight = { cortexId?: string; cortexName?: string; insight?: string };
type Outcome = 'no_insights' | 'not_running' | 'unsupported' | 'unavailable' | 'queued' | 'pending';
export type CortexLiveMainContextReceipt = { status: Outcome; deliveryId?: string };

export async function deliverCortexBatchToRunningMain(
  input: {
    ownerId: string;
    conversationId: string;
    parentMessageId: string;
    streamId: string;
    insights: Insight[];
    context: string;
  },
  deps: {
    liveContextEnabled: boolean;
    /** Exact lane-owned background author; never a fabricated foreground job. */
    readCurrentAuthor?: () => Promise<NativeResponseAdmission | null>;
    getJob: (streamId: string) => Promise<SerializableJobData | null>;
    readAdmission: (ownerId: string, messageId: string) => Promise<NativeResponseAdmission | null>;
    resolveRoute: (identity: NativeResponseIdentity) => Promise<NativeResponseRoute>;
    isEligible: () => Promise<boolean>;
    isCurrentLogicalTurn: (streamId: string) => Promise<boolean>;
    observeSourceOrder: (context: SourceOrderObservation) => Promise<SourceOrderObservationResult>;
    prepareInput: (
      identity: NativeResponseIdentity,
      input: IMainContinuityBackgroundInput,
      mode?: 'current_main',
    ) => Promise<boolean>;
    recordInputReceipt: (
      identity: NativeResponseIdentity,
      receipt: IMainContinuityBackgroundInputReceipt,
    ) => Promise<boolean>;
    fetch?: MainContinuityFetch;
  },
): Promise<CortexLiveMainContextReceipt> {
  if (!input.insights?.length || !input.context?.trim()) return { status: 'no_insights' };
  if (!deps.liveContextEnabled) return { status: 'unsupported' };
  if (!input.ownerId || !input.streamId || !input.parentMessageId || !input.conversationId)
    return { status: 'not_running' };
  try {
    if (!(await deps.isEligible())) return { status: 'not_running' };
    const backgroundAuthor = deps.readCurrentAuthor ? await deps.readCurrentAuthor() : null;
    const job = deps.readCurrentAuthor ? null : await deps.getJob(input.streamId);
    if (
      !deps.readCurrentAuthor &&
      (!job ||
        job.status !== 'running' ||
        job.generationCompleted ||
        job.nativeResponseCancelled ||
        job.userId !== input.ownerId ||
        job.conversationId !== input.conversationId ||
        job.responseMessageId !== input.parentMessageId)
    )
      return { status: 'not_running' };
    const admission = deps.readCurrentAuthor
      ? backgroundAuthor
      : await deps.readAdmission(input.ownerId, input.parentMessageId);
    const identity = backgroundAuthor || job?.nativeResponse || admission;
    if (
      !identity ||
      !admission ||
      !['pending', 'unsupported'].includes(admission.status) ||
      identity.userId !== input.ownerId ||
      identity.conversationId !== input.conversationId ||
      identity.responseMessageId !== input.parentMessageId ||
      identity.streamId !== input.streamId ||
      (!deps.readCurrentAuthor && !nativeJobMatches(job, identity)) ||
      nativeIdentityJson(admission) !== nativeIdentityJson(identity) ||
      (!deps.readCurrentAuthor &&
        admission.status === 'pending' &&
        (!job?.nativeResponse || job.nativeResponseSettled))
    )
      return { status: 'not_running' };
    const authorMatches = async () => {
      if (!deps.readCurrentAuthor) return true;
      const current = await deps.readCurrentAuthor();
      return Boolean(
        current &&
        current.status === 'pending' &&
        nativeIdentityJson(current) === nativeIdentityJson(identity),
      );
    };
    if (!(await deps.isEligible()) || !(await authorMatches())) return { status: 'not_running' };
    if (!deps.readCurrentAuthor && !(await deps.isCurrentLogicalTurn(identity.streamId)))
      return { status: 'not_running' };
    if (identity.sourceOrderScope && identity.sourceSequence != null) {
      const source = await deps.observeSourceOrder({
        source_order_scope: identity.sourceOrderScope,
        source_sequence: identity.sourceSequence,
      });
      if (source.stale || source.latest_source_sequence !== identity.sourceSequence)
        return { status: 'not_running' };
    }
    const preparing = deps.readCurrentAuthor ? null : await deps.getJob(input.streamId);
    if (
      !deps.readCurrentAuthor &&
      (!preparing ||
        preparing.status !== 'running' ||
        preparing.generationCompleted ||
        preparing.nativeResponseCancelled ||
        !nativeJobMatches(preparing, identity) ||
        (preparing.nativeResponse &&
          nativeIdentityJson(preparing.nativeResponse) !== nativeIdentityJson(identity)))
    )
      return { status: 'not_running' };
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    const deliveryId = digest(
      JSON.stringify({
        parent: input.parentMessageId,
        insights: input.insights.map(({ cortexId, insight }) => [cortexId, insight]).sort(),
        context: input.context,
      }),
    );
    const textSha256 = digest(input.context);
    const [backgroundInput] = normalizeMainBackgroundInputs([
      {
        version: 1,
        invocationId: identity.invocationId,
        deliveryId,
        text: input.context,
        textSha256,
        sources: input.insights.map(({ cortexId, cortexName, insight }) => ({
          cortexId,
          ...(cortexName ? { cortexName } : {}),
          insightSha256: typeof insight === 'string' ? digest(insight) : '',
        })),
      },
    ]);
    if (!(await deps.prepareInput(identity, backgroundInput, 'current_main')))
      return { status: 'unavailable', deliveryId };
    const finish = async (status: Outcome, nativeReceipt?: Record<string, string>) => {
      let recorded = false;
      try {
        recorded = await deps.recordInputReceipt(identity, {
          deliveryId,
          textSha256,
          status: status === 'queued' || status === 'pending' ? status : 'unavailable',
          ...(nativeReceipt
            ? {
                runId: nativeReceipt.run_id,
                attemptId: nativeReceipt.attempt_id,
                messageId: nativeReceipt.message_id,
              }
            : {}),
        });
      } catch {
        /* The source remains offered; keep the durable follow-up path. */
      }
      return { status: recorded ? status : ('unavailable' as Outcome), deliveryId };
    };
    // Preserve accepted data independently of live route availability. Unsupported Native
    // authority requires no route work and never permits an interjection.
    let route: NativeResponseRoute | null = null;
    if (admission.status === 'pending') {
      try {
        route = await deps.resolveRoute(identity);
        if (nativeResponseOrigin(route.baseURL) !== identity.originSha256)
          return finish('unavailable');
      } catch {
        return finish('unavailable');
      }
    }
    // Preparation may yield to a newly accepted Core input before Native sees its request.
    if (
      !(await deps.isEligible()) ||
      !(await authorMatches()) ||
      (!deps.readCurrentAuthor && !(await deps.isCurrentLogicalTurn(identity.streamId)))
    )
      return finish('not_running');
    if (identity.sourceOrderScope && identity.sourceSequence != null) {
      const source = await deps.observeSourceOrder({
        source_order_scope: identity.sourceOrderScope,
        source_sequence: identity.sourceSequence,
      });
      if (source.stale || source.latest_source_sequence !== identity.sourceSequence)
        return finish('not_running');
    }
    // Read the final incarnation after all asynchronous eligibility and owner lookups.
    const current = deps.readCurrentAuthor ? null : await deps.getJob(input.streamId);
    if (
      !deps.readCurrentAuthor &&
      (!current ||
        current.status !== 'running' ||
        current.generationCompleted ||
        current.nativeResponseCancelled ||
        !nativeJobMatches(current, identity) ||
        (current.nativeResponse &&
          nativeIdentityJson(current.nativeResponse) !== nativeIdentityJson(identity)))
    )
      return finish('not_running');
    if (admission.status === 'unsupported') return finish('unsupported');
    // Source preparation grants no Native control authority. Its pending binding must still exist.
    if (
      !route ||
      (!deps.readCurrentAuthor && (current?.nativeResponseSettled || !current?.nativeResponse))
    )
      return finish('not_running');
    let response: Response;
    try {
      response = await (deps.fetch || fetch)(
        `${route.baseURL.replace(/\/$/, '')}/requests/by-invocation/${encodeURIComponent(identity.invocationId)}/interject`,
        {
          method: 'POST',
          headers: {
            ...Object.fromEntries(new Headers(route.headers)),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            stream_id: identity.streamId,
            message_id: identity.responseMessageId,
            body_sha256: identity.bodySha256,
            delivery_id: deliveryId,
            text: input.context,
            text_sha256: textSha256,
          }),
          signal: AbortSignal.timeout(4000),
          redirect: 'error',
        },
      );
    } catch {
      return finish('unavailable');
    }
    if (!response.ok) return finish('unavailable');
    let receipt;
    try {
      receipt = await response.json();
    } catch {
      return finish('unavailable');
    }
    if (
      receipt?.version !== 1 ||
      receipt.invocation_id !== identity.invocationId ||
      receipt.delivery_id !== deliveryId ||
      receipt.text_sha256 !== textSha256 ||
      !['queued', 'pending', 'unsupported', 'not_running'].includes(receipt.status)
    )
      return finish('unavailable');
    if (
      ['queued', 'pending'].includes(receipt.status) &&
      (!receipt.run_id || !receipt.attempt_id || !receipt.message_id)
    )
      return finish('unavailable');
    return finish(receipt.status, receipt);
  } catch {
    // No retry with a guessed native owner. Unknown/unsupported controls retain durable delivery.
    return { status: 'unavailable' };
  }
}
