import { createHash } from 'node:crypto';
import type { NativeResponseAdmission, IMainContinuityBackgroundInput } from '@librechat/data-schemas';
import type { SerializableJobData } from '../stream/interfaces/IJobStore';
import { nativeResponseOrigin } from '../glasshive/nativeResponse';
import { deliverCortexBatchToRunningMain } from './liveMainContext';
import { createMainContinuityFetch, renderMainBackgroundInputs } from '../continuity/mainContinuity';

const identity = {
  userId: 'owner',
  conversationId: 'conversation',
  responseMessageId: 'answer',
  streamId: 'stream',
  jobCreatedAt: 1,
  logicalTurnId: 'turn',
  revision: 1,
  providerId: 'native',
  agentId: 'main',
  source: { id: 'source', messageId: 'question', digest: 'd'.repeat(64) },
  invocationId: 'invocation',
  bodySha256: 'b'.repeat(64),
  originSha256: nativeResponseOrigin('http://native.test/v1'),
  admittedAt: 1,
  recoverUntil: Date.now() + 86400000,
};
function setup() {
  const job = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    createdAt: 1,
    status: 'running',
    userMessage: { messageId: 'question' },
    interactionContext: { logical_turn_id: 'turn', revision: 1 },
    nativeResponse: identity,
  } as unknown as SerializableJobData;
  const input = {
    ownerId: 'owner',
    conversationId: 'conversation',
    parentMessageId: 'answer',
    streamId: 'stream',
    insights: [{ cortexId: 'cortex-a', insight: 'Useful context.' }],
    context: 'Useful context.',
  };
  const send = jest.fn(async (_url: string | URL | Request, options?: RequestInit) => {
    const body = JSON.parse(String(options?.body));
    return new Response(
      JSON.stringify({
        version: 1,
        status: 'queued',
        invocation_id: 'invocation',
        delivery_id: body.delivery_id,
        text_sha256: body.text_sha256,
        run_id: 'run',
        attempt_id: 'attempt',
        message_id: 'mailbox',
      }),
    );
  });
  const deps = {
    liveContextEnabled: true,
    getJob: jest.fn(async () => job),
    readAdmission: jest.fn(
      async () => ({ ...identity, status: 'pending' }) as NativeResponseAdmission,
    ),
    resolveRoute: jest.fn(async () => ({
      baseURL: 'http://native.test/v1',
      headers: { Authorization: 'Bearer synthetic' },
    })),
    isEligible: jest.fn(async () => true),
    isCurrentLogicalTurn: jest.fn(async () => true),
    observeSourceOrder: jest.fn(async () => ({
      stale: false,
      latest_source_sequence: 1,
      observed_at: 1,
    })),
    prepareInput: jest.fn(async (_identity: typeof identity, _input: IMainContinuityBackgroundInput, _mode?: 'current_main') => true),
    recordInputReceipt: jest.fn(async () => true),
    fetch: send,
  };
  return { job, input, deps, send };
}

describe('completed cohort native Main context courier', () => {
  it('does no route, persistence, source or transport work when the reviewed feature is not enabled', async () => {
    const { input, deps, send } = setup();
    deps.liveContextEnabled = false;
    expect(await deliverCortexBatchToRunningMain(input, deps)).toEqual({ status: 'unsupported' });
    expect(deps.isEligible).not.toHaveBeenCalled();
    expect(deps.getJob).not.toHaveBeenCalled();
    expect(deps.resolveRoute).not.toHaveBeenCalled();
    expect(deps.readAdmission).not.toHaveBeenCalled();
    expect(deps.prepareInput).not.toHaveBeenCalled();
    expect(deps.recordInputReceipt).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves the lost sealed source after Native release and carries it into later Main dispatch', async () => {
    const { input, deps, job, send } = setup();
    delete job.nativeResponse;
    deps.readAdmission.mockResolvedValue({ ...identity, status: 'unsupported' } as NativeResponseAdmission);
    let saved: IMainContinuityBackgroundInput[] = [];
    deps.prepareInput.mockImplementation(async (_identity, value) => { saved = [value]; return true; });
    const result = await deliverCortexBatchToRunningMain(input, deps);
    expect(result.status).toBe('unsupported');
    expect(deps.prepareInput).toHaveBeenCalledWith(expect.objectContaining(identity), expect.objectContaining({
      invocationId: identity.invocationId, text: input.context,
    }), 'current_main');
    expect(deps.resolveRoute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(deps.recordInputReceipt).toHaveBeenCalledWith(expect.objectContaining(identity), expect.objectContaining({ status: 'unavailable' }));
    const chain = Buffer.from('[]').toString('base64');
    const native = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.metadata.turn_context).toBe(renderMainBackgroundInputs(saved));
      expect(payload.metadata.main_background_inputs).toEqual(saved);
      return new Response('{}');
    });
    await createMainContinuityFetch(native, chain, {}, async () => saved)(
      'https://provider.invalid/v1/chat/completions', { method: 'POST',
        headers: { 'X-Viventium-Visible-Message-Chain-B64': chain }, body: '{"messages":[]}' },
    );
    expect(native).toHaveBeenCalledTimes(1);
  });
  it('retains accepted data if Native release happens while preparation awaits, without interjecting', async () => {
    const { input, deps, job, send } = setup();
    deps.prepareInput.mockImplementation(async () => {
      delete job.nativeResponse; delete job.nativeResponseCancelled;
      return true;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(deps.prepareInput).toHaveBeenCalledWith(identity, expect.objectContaining({ text: input.context }), 'current_main');
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'prepared', 'completed', 'failed'])('does not preserve new source under terminal %s authority', async (status) => {
    const { input, deps, job, send } = setup();
    delete job.nativeResponse;
    deps.readAdmission.mockResolvedValue({ ...identity, status } as NativeResponseAdmission);
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(deps.prepareInput).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['stop', 'replacement', 'logical_owner', 'sequence', 'generation_done'])('refuses released source under changed current owner: %s', async (mode) => {
    const { input, deps, job, send } = setup();
    delete job.nativeResponse;
    const scoped = { ...identity, sourceOrderScope: 'a'.repeat(64), sourceSequence: 1 };
    job.interactionContext = { ...job.interactionContext, source_order_scope: scoped.sourceOrderScope, source_sequence: 1 } as typeof job.interactionContext;
    deps.readAdmission.mockImplementation(async () => {
      if (mode === 'stop') job.nativeResponseCancelled = true;
      if (mode === 'replacement') job.createdAt = 2;
      if (mode === 'logical_owner') deps.isCurrentLogicalTurn.mockResolvedValue(false);
      if (mode === 'sequence') deps.observeSourceOrder.mockResolvedValue({ stale: false, latest_source_sequence: 2, observed_at: 2 });
      if (mode === 'generation_done') job.generationCompleted = true;
      return { ...scoped, status: 'unsupported' } as NativeResponseAdmission;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(deps.prepareInput).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['unavailable', 'changed_origin'])('retains exact data when live route is %s', async (cause) => {
    const { input, deps, send } = setup();
    if (cause === 'unavailable') deps.resolveRoute.mockRejectedValue(new Error('Route unavailable'));
    else deps.resolveRoute.mockResolvedValue({ baseURL: 'http://other.test/v1', headers: {} });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('unavailable');
    expect(deps.prepareInput).toHaveBeenCalledWith(identity, expect.objectContaining({ text: input.context }), 'current_main');
    expect(deps.recordInputReceipt).toHaveBeenCalledWith(identity, expect.objectContaining({ status: 'unavailable' }));
    expect(send).not.toHaveBeenCalled();
  });
  it('persists exact source-labelled evidence before transport, with a separate transport receipt', async () => {
    const { input, deps, send } = setup();
    input.insights = [{ cortexId: 'cortex-a', insight: 'Useful context.' }];
    const result = await deliverCortexBatchToRunningMain(input, deps);
    expect(deps.prepareInput).toHaveBeenCalledWith(identity, {
      version: 1, invocationId: identity.invocationId, deliveryId: result.deliveryId,
      text: input.context, textSha256: createHash('sha256').update(input.context).digest('hex'),
      sources: [{ cortexId: 'cortex-a', insightSha256: createHash('sha256').update('Useful context.').digest('hex') }],
    }, 'current_main');
    expect(deps.prepareInput.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(deps.recordInputReceipt).toHaveBeenCalledWith(identity, {
      deliveryId: result.deliveryId,
      textSha256: createHash('sha256').update(input.context).digest('hex'),
      status: 'queued', runId: 'run', attemptId: 'attempt', messageId: 'mailbox',
    });
    expect(deps.recordInputReceipt.mock.invocationCallOrder[0]).toBeGreaterThan(send.mock.invocationCallOrder[0]);
  });
  it('does not dispatch when durable preparation fails or source is invalid', async () => {
    for (const reason of ['false', 'throw', 'invalid']) {
      const { input, deps, send } = setup();
      if (reason === 'false') deps.prepareInput.mockResolvedValue(false);
      if (reason === 'throw') deps.prepareInput.mockRejectedValue(new Error('conflict'));
      if (reason === 'invalid') input.insights[0].cortexId = '';
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('unavailable');
      expect(send).not.toHaveBeenCalled();
      expect(deps.recordInputReceipt).not.toHaveBeenCalled();
    }
  });
  it('rechecks Stop after the asynchronous durable preparation', async () => {
    const { input, deps, send, job } = setup();
    deps.prepareInput.mockImplementation(async () => {
      job.nativeResponseCancelled = true;
      return true;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(send).not.toHaveBeenCalled();
    expect(deps.recordInputReceipt).toHaveBeenCalledWith(identity, expect.objectContaining({ status: 'unavailable' }));
  });
  it('keeps the exact source and reports unavailable if the transport receipt cannot be saved', async () => {
    for (const failure of [false, true]) {
      const { input, deps, send } = setup();
      if (failure) deps.recordInputReceipt.mockRejectedValue(new Error('store unavailable'));
      else deps.recordInputReceipt.mockResolvedValue(false);
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('unavailable');
      expect(deps.prepareInput).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
  it('accepts the exact current source-order result from the canonical ledger', async () => {
    const { input, deps, job, send } = setup();
    job.nativeResponse = { ...identity, sourceOrderScope: 'a'.repeat(64), sourceSequence: 1 };
    job.interactionContext = {
      ...job.interactionContext,
      source_order_scope: 'a'.repeat(64),
      source_sequence: 1,
    } as typeof job.interactionContext;
    deps.readAdmission.mockResolvedValue({
      ...job.nativeResponse,
      status: 'pending',
    } as NativeResponseAdmission);
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
    expect(deps.observeSourceOrder).toHaveBeenCalledTimes(2);
  });
  it('refuses a newer logical owner before its old job status changes', async () => {
    const { input, deps, send } = setup();
    deps.isCurrentLogicalTurn.mockResolvedValue(false);
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses a new logical owner accepted while preparation awaits', async () => {
    const { input, deps, send } = setup();
    deps.prepareInput.mockImplementation(async () => {
      deps.isCurrentLogicalTurn.mockResolvedValue(false);
      return true;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses source advancement during preparation while the old job still runs', async () => {
    const { input, deps, send, job } = setup();
    job.nativeResponse = { ...identity, sourceOrderScope: 'a'.repeat(64), sourceSequence: 1 };
    job.interactionContext = { ...job.interactionContext, source_order_scope: 'a'.repeat(64), source_sequence: 1 } as typeof job.interactionContext;
    deps.readAdmission.mockResolvedValue({ ...job.nativeResponse, status: 'pending' } as NativeResponseAdmission);
    deps.prepareInput.mockImplementation(async () => {
      deps.observeSourceOrder.mockResolvedValue({ stale: false, latest_source_sequence: 2, observed_at: 2 });
      return true;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(send).not.toHaveBeenCalled();
  });
  it('uses the existing source-order ledger to refuse a stale admitted source', async () => {
    for (const stale of [true, false]) {
      const { input, deps, send, job } = setup();
      job.nativeResponse = { ...identity, sourceOrderScope: 'a'.repeat(64), sourceSequence: 1 };
      job.interactionContext = {
        ...job.interactionContext,
        source_order_scope: 'a'.repeat(64),
        source_sequence: 1,
      } as typeof job.interactionContext;
      deps.readAdmission.mockResolvedValue({
        ...job.nativeResponse,
        status: 'pending',
      } as NativeResponseAdmission);
      deps.observeSourceOrder.mockResolvedValue({
        stale,
        latest_source_sequence: 2,
        observed_at: 1,
      });
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
      expect(send).not.toHaveBeenCalled();
      expect(deps.observeSourceOrder).toHaveBeenCalledWith({
        source_order_scope: 'a'.repeat(64),
        source_sequence: 1,
      });
    }
  });
  it('refuses accepted native Stop while the job and admission still say running/pending', async () => {
    for (const duringLookup of [false, true]) {
      const { input, deps, send, job } = setup();
      if (duringLookup)
        deps.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce({
          ...job,
          nativeResponseCancelled: true,
        });
      else job.nativeResponseCancelled = true;
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
      expect(send).not.toHaveBeenCalled();
    }
  });
  it('refuses Stop accepted during the final canonical owner lookup', async () => {
    const { input, deps, send, job } = setup();
    deps.isCurrentLogicalTurn.mockImplementation(async () => {
      job.nativeResponseCancelled = true;
      return true;
    });
    expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
    expect(send).not.toHaveBeenCalled();
  });
  it('offers one exact batch without an after-Main wait and keeps a queued ACK distinct from consumption', async () => {
    const { input, deps, send } = setup();
    const result = await deliverCortexBatchToRunningMain(input, deps);
    expect(result.status).toBe('queued');
    expect(send).toHaveBeenCalledTimes(1);
    const [url, options] = send.mock.calls[0];
    expect(url).toBe('http://native.test/v1/requests/by-invocation/invocation/interject');
    expect(JSON.parse(String(options?.body))).toMatchObject({
      stream_id: 'stream',
      message_id: 'answer',
      body_sha256: identity.bodySha256,
      text: input.context,
      text_sha256: createHash('sha256').update(input.context).digest('hex'),
    });
    expect(result).not.toHaveProperty('consumed');
    expect(result).not.toHaveProperty('presented');
    expect((await deliverCortexBatchToRunningMain(input, deps)).deliveryId).toBe(result.deliveryId);
  });
  it('does no owner or network work for an all-NTA/empty accepted batch', async () => {
    const { input, deps, send } = setup();
    expect(
      await deliverCortexBatchToRunningMain({ ...input, insights: [], context: '' }, deps),
    ).toEqual({ status: 'no_insights' });
    expect(deps.getJob).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it.each(['complete', 'aborted', 'superseded', 'error'])(
    'does not steer %s Main',
    async (status) => {
      const { job, input, deps, send } = setup();
      job.status = status as SerializableJobData['status'];
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
      expect(send).not.toHaveBeenCalled();
    },
  );
  it.each(['userId', 'conversationId', 'responseMessageId'])(
    'refuses a foreign %s',
    async (field) => {
      const { input, deps, send, job } = setup();
      job.nativeResponse = { ...identity, [field]: 'foreign' };
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('refuses changed admission, origin, or incarnation after authorization', async () => {
    for (const cause of ['admission', 'origin', 'job']) {
      const { input, deps, send, job } = setup();
      if (cause === 'admission')
        deps.readAdmission.mockResolvedValue({
          ...identity,
          status: 'pending',
          invocationId: 'replacement',
        } as NativeResponseAdmission);
      if (cause === 'origin')
        deps.resolveRoute.mockResolvedValue({
          baseURL: 'http://other.test/v1',
          headers: { Authorization: 'Bearer synthetic' },
        });
      if (cause === 'job')
        deps.getJob.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, createdAt: 2 });
      expect(['unavailable', 'not_running']).toContain(
        (await deliverCortexBatchToRunningMain(input, deps)).status,
      );
      expect(send).not.toHaveBeenCalled();
    }
  });
  it('refuses cancelled/newer input both before and after asynchronous owner lookup', async () => {
    for (const initiallyEligible of [false, true]) {
      const { input, deps, send } = setup();
      deps.isEligible.mockResolvedValueOnce(initiallyEligible).mockResolvedValue(false);
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('not_running');
      expect(send).not.toHaveBeenCalled();
    }
  });
  it.each(['unsupported', 'not_running', 'pending'])(
    'retains truthful %s for existing durable follow-up',
    async (status) => {
      const { input, deps, send } = setup();
      send.mockImplementation(async (_url, options) => {
        const body = JSON.parse(String(options?.body));
        return new Response(
          JSON.stringify({
            version: 1,
            status,
            invocation_id: 'invocation',
            delivery_id: body.delivery_id,
            text_sha256: body.text_sha256,
            run_id: 'run',
            attempt_id: 'attempt',
            message_id: 'mailbox',
          }),
        );
      });
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe(status);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('does not retry an unknown outcome or accept a mismatched ACK', async () => {
    for (const failure of ['timeout', 'receipt', 'http']) {
      const { input, deps, send } = setup();
      if (failure === 'timeout') send.mockRejectedValue(new Error('timeout'));
      if (failure === 'receipt')
        send.mockResolvedValue(
          new Response(
            JSON.stringify({
              version: 1,
              status: 'queued',
              invocation_id: 'foreign',
            }),
          ),
        );
      if (failure === 'http') send.mockResolvedValue(new Response('{}', { status: 409 }));
      expect((await deliverCortexBatchToRunningMain(input, deps)).status).toBe('unavailable');
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
