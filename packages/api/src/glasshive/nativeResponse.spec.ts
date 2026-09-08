/* === VIVENTIUM START === Saved-result lookup is read-only and exact invocation scoped. === */
import type { MainContinuityFetch } from '../continuity/mainContinuity';
import { nativeResponseDigest } from '@librechat/data-schemas';
import {
  nativeIdentityJson,
  nativeIdentityValid,
  nativeJobMatches,
} from '../stream/implementations/nativeResponse';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { SerializableJobData } from '../stream/interfaces/IJobStore';
import {
  createNativeResponseFetch,
  createNativeResponseRecoveryService,
  nativeResponseOrigin,
  nativeResponseSha256,
} from './nativeResponse';

describe('native response binding and recovery', () => {
  const context = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: 1,
    logicalTurnId: 'scope.turn',
    revision: 1,
    providerId: 'native',
    agentId: 'main',
    source: { id: 'source-id', messageId: 'question', digest: 'source-digest' },
  };
  const identity = {
    ...context,
    invocationId: 'invocation',
    bodySha256: 'b'.repeat(64),
    originSha256: nativeResponseOrigin('http://native.test/v1'),
    admittedAt: 1,
    recoverUntil: Date.now() + 86_400_000,
  };
  const result = {
    version: 1,
    object: 'glasshive.request.result',
    state: 'completed',
    invocation_id: identity.invocationId,
    body_sha256: identity.bodySha256,
    stream_id: identity.streamId,
    message_id: identity.responseMessageId,
    agent_id: identity.agentId,
    conversation_id: identity.conversationId,
    authority_sha256: 'effective-authority',
    request_id: 'native-request',
    run_id: 'native-run',
    response: {
      object: 'chat.completion',
      id: 'native-request',
      choices: [
        { finish_reason: 'stop', message: { role: 'assistant', content: 'Canonical answer.' } },
      ],
    },
  };
  const deps = () => ({
    db: {
      listNativeResponses: jest.fn(),
      nativeResponseSourceMatches: jest.fn().mockResolvedValue(true),
      getNativeResponse: jest
        .fn()
        .mockResolvedValue({ nativeResponse: { ...identity, status: 'pending' } }),
      admitNativeResponse: jest.fn(),
      prepareNativeResponse: jest.fn().mockResolvedValue('candidate'),
      materializeNativeResponse: jest.fn().mockResolvedValue({
        text: 'Canonical answer.',
        nativeResponse: { candidateJson: 'private' },
        savedMemoryWrite: { source: 'private' },
      }),
      materializeNativeResponseTerminal: jest.fn().mockResolvedValue(null),
      settleNativeResponse: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    },
    transaction: jest.fn(),
    bind: jest.fn().mockResolvedValue(true),
    commit: jest.fn(),
    revoke: jest.fn().mockResolvedValue({ status: 'revoked' }),
    isCurrent: jest.fn().mockResolvedValue(true),
    authorizeTerminal: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
    resolveRoute: jest.fn().mockResolvedValue({
      baseURL: 'http://native.test/v1',
      headers: { Authorization: 'Bearer synthetic', 'X-Viventium-User-Id': 'owner' },
    }),
    fetch: jest.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 })),
  });
  it.each(['completed', 'unsupported'])(
    'reads source evidence with %s answer ownership',
    async (status) => {
      const d = deps();
      d.db.getNativeResponse.mockResolvedValue({
        user: 'owner',
        conversationId: 'conversation',
        messageId: 'answer',
        text: 'Host graph answer',
        content: [],
        unfinished: false,
        error: false,
        nativeResponse: { ...identity, status },
      } as never);
      const graph = {
        version: 1,
        owner_id: 'owner',
        conversation_id: 'conversation',
        message_id: 'answer',
        stream_id: 'stream',
        anchor_invocation_id: 'invocation',
        logical_turn_id: 'scope.turn',
        logical_turn_revision: 1,
        main_context_snapshot_sha256: 'a'.repeat(64),
        context_epoch: 'b'.repeat(64),
        requests: [],
        omitted_requests: 0,
      };
      d.fetch.mockImplementation(
        async () => new Response(JSON.stringify({ ...result, graph_tool_evidence: graph })),
      );
      const content = await createNativeResponseRecoveryService(d).readToolEvidence(
        'owner',
        'conversation',
        'answer',
      );
      expect(JSON.parse(content[0].text).native_tool_evidence).toEqual(graph);
      expect(String(d.fetch.mock.calls[0][0])).toContain('include_tool_evidence=true');
      expect(d.db.prepareNativeResponse).not.toHaveBeenCalled();
      expect(d.revoke).not.toHaveBeenCalled();
      expect(d.db.nativeResponseSourceMatches).toHaveBeenCalledTimes(2);
    },
  );
  it.each([true, false])(
    'missing saved coverage is explicit without blocking valid memory input: %s',
    async (missingResult) => {
      const d = deps();
      d.db.getNativeResponse.mockResolvedValue({
        user: 'owner',
        conversationId: 'conversation',
        messageId: 'answer',
        text: 'Host answer',
        unfinished: false,
        error: false,
        nativeResponse: { ...identity, status: 'unsupported' },
      } as never);
      d.fetch.mockResolvedValue(
        missingResult ? new Response('', { status: 404 }) : new Response(JSON.stringify(result)),
      );
      const content = await createNativeResponseRecoveryService(d).readToolEvidence(
        'owner',
        'conversation',
        'answer',
      );
      expect(JSON.parse(content[0].text).native_tool_evidence).toMatchObject({
        evidence_available: false,
        reason: missingResult ? 'saved_result_missing' : 'graph_evidence_missing',
        anchor_invocation_id: 'invocation',
      });
      expect(d.db.nativeResponseSourceMatches).toHaveBeenCalledTimes(2);
      expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
    },
  );
  it('reports a typed unavailable-parent error without reading or accepting its evidence', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue({
      user: 'owner', conversationId: 'conversation', messageId: 'answer',
      unfinished: false, error: true,
      nativeResponse: { ...identity, status: 'unsupported' },
    } as never);
    await expect(createNativeResponseRecoveryService(d).readToolEvidence(
      'owner', 'conversation', 'answer',
    )).rejects.toMatchObject({ code: 'native_graph_tool_evidence_parent_unfinished' });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
  });
  it.each(['owner', 'conversation', 'source', 'body', 'changed-source'])(
    'rejects graph evidence on %s mismatch',
    async (field) => {
      const d = deps();
      const row = {
        user: 'owner',
        conversationId: 'conversation',
        messageId: 'answer',
        text: 'Host answer',
        unfinished: false,
        error: false,
        nativeResponse: { ...identity, status: 'unsupported' },
      };
      d.db.getNativeResponse.mockResolvedValue(row as never);
      if (field === 'source') d.db.nativeResponseSourceMatches.mockResolvedValue(false);
      if (field === 'changed-source')
        d.db.nativeResponseSourceMatches.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      if (field === 'body')
        d.fetch.mockResolvedValue(
          new Response(JSON.stringify({ ...result, body_sha256: 'foreign' })),
        );
      const service = createNativeResponseRecoveryService(d);
      await expect(
        service.readToolEvidence(
          field === 'owner' ? 'foreign' : 'owner',
          field === 'conversation' ? 'foreign' : 'conversation',
          'answer',
        ),
      ).rejects.toThrow();
      expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
    },
  );
  it.each(['stopSnapshotStoredAt', 'terminalSnapshotStoredAt'] as const)(
    'rejects malformed numeric-string %s authority',
    async (field) => {
      const d = deps();
      d.db.getNativeResponse.mockResolvedValue({
        nativeResponse: { ...identity, status: 'cancelled', [field]: '123' },
        text: 'Untrusted',
        content: [],
      });
      const service = createNativeResponseRecoveryService(d);
      expect(await service.recover(identity)).toBeNull();
      expect(await service.projectForTransmit(identity, { text: '', content: [] })).toBeNull();
    },
  );
  it('skips upstream lookup for a retired legacy terminal job', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue({
      nativeResponse: { ...identity, status: 'cancelled' },
    });
    d.isCurrent.mockResolvedValue(false);
    expect(await createNativeResponseRecoveryService(d).recover(identity)).toBeNull();
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('recovers an explicitly stored Stop snapshot without provider lookup or re-projection', async () => {
    const d = deps();
    const row = {
      text: 'Original partial.',
      content: [{ type: 'text', text: 'Original partial.' }],
      unfinished: true,
      error: false,
      finish_reason: 'incomplete',
      metadata: { viventium: { deliveryDisposition: { audio: 'skip', valid: false } } },
      nativeResponse: { ...identity, status: 'cancelled', stopSnapshotStoredAt: Date.now() },
      savedMemoryWrite: { private: true },
    };
    d.db.getNativeResponse.mockResolvedValue(row as never);
    const service = createNativeResponseRecoveryService(d as never);
    const saved = await service.recover(identity);
    expect(saved).toEqual(expect.objectContaining({ text: row.text, metadata: row.metadata }));
    expect(saved).not.toHaveProperty('nativeResponse');
    expect(saved).not.toHaveProperty('savedMemoryWrite');
    const projected = await service.projectForTransmit(identity, {
      text: 'Mutable retry input.',
      content: [],
    });
    expect(projected).toMatchObject({
      text: row.text,
      content: row.content,
      metadata: row.metadata,
    });
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.resolveRoute).not.toHaveBeenCalled();
    expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, false, 'claimed', -1])(
    'unmarked or invalid Stop proof %s cannot recover a cancelled response',
    async (marker) => {
      const d = deps();
      d.db.getNativeResponse.mockResolvedValue({
        text: 'Partial.',
        nativeResponse: {
          ...identity,
          status: 'cancelled',
          stopSnapshotStoredAt: marker,
        },
      } as never);
      const service = createNativeResponseRecoveryService(d as never);
      expect(await service.recover(identity)).toBeNull();
      expect(
        await service.projectForTransmit(identity, { text: 'Retry.', content: [] }),
      ).toBeNull();
      expect(d.fetch).toHaveBeenCalledTimes(marker === undefined ? 1 : 0);
    },
  );
  it.each(['invocationId', 'bodySha256', 'logicalTurnId', 'originSha256', 'providerId'])(
    'Stop replay rejects changed %s even with a saved marker',
    async (key) => {
      const d = deps();
      d.db.getNativeResponse.mockResolvedValue({
        text: 'Partial.',
        nativeResponse: {
          ...identity,
          status: 'cancelled',
          stopSnapshotStoredAt: Date.now(),
        },
      } as never);
      const service = createNativeResponseRecoveryService(d as never);
      const changed = { ...identity, [key]: 'changed' };
      expect(await service.recover(changed)).toBeNull();
      expect(await service.projectForTransmit(changed, { text: 'Retry.', content: [] })).toBeNull();
      expect(d.fetch).not.toHaveBeenCalled();
    },
  );
  it('a failed unsupported transition cannot release a concurrently stopped job', async () => {
    const d = deps();
    d.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...result, state: 'unsupported' }), { status: 200 }),
    );
    d.db.settleNativeResponse.mockResolvedValue({ matchedCount: 0 });
    await expect(createNativeResponseRecoveryService(d).recover(identity)).rejects.toThrow(
      'handoff_unavailable',
    );
    expect(d.release).not.toHaveBeenCalled();
  });
  it('an exact unsupported retry releases its host binding without another result lookup', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue({
      nativeResponse: { ...identity, status: 'unsupported' },
    } as never);
    expect(await createNativeResponseRecoveryService(d).recover(identity)).toBeNull();
    expect(d.release).toHaveBeenCalledWith(identity);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.db.settleNativeResponse).not.toHaveBeenCalled();
  });
  it('snapshots original delivery facts before dispatch and hashes a changed request separately', async () => {
    const deliveryContext = {
      surface: 'telegram' as const,
      authenticated: true,
      audioRequested: false,
    };
    const admit = jest.fn(async () => true);
    const bound = jest.fn();
    const wrapped = createNativeResponseFetch(
      async () => new Response('{}'),
      async () => ({ ...context, deliveryContext }),
      admit,
      bound,
    );
    const request = { body: '{"messages":[]}' };
    await wrapped('http://native.test/v1/chat/completions', request);
    const original = bound.mock.calls[0][0];
    deliveryContext.audioRequested = true;
    expect(original.deliveryContext.audioRequested).toBe(false);
    expect(Object.isFrozen(original.deliveryContext)).toBe(true);
    await wrapped('http://native.test/v1/chat/completions', request);
    expect(bound.mock.calls[1][0].invocationId).not.toBe(original.invocationId);
  });
  it('transmission rejects changed identity, edited admission, and a corrupted saved candidate', async () => {
    const d = deps();
    const candidate = {
      text: 'Canonical answer.',
      responseJson: JSON.stringify(result.response),
      authoritySha256: 'a'.repeat(64),
      requestId: 'native-request',
      runId: 'native-run',
    };
    const row = {
      text: 'Canonical answer.',
      nativeResponse: {
        ...identity,
        status: 'completed',
        candidateSha256: nativeResponseDigest(candidate),
        candidateJson: JSON.stringify(candidate),
      },
    };
    d.db.getNativeResponse.mockResolvedValue(row);
    const projectMessage = jest.fn((_identity, _response, message) => message);
    const recovery = createNativeResponseRecoveryService({ ...d, projectMessage });
    const publicRead = { text: 'Public answer.', metadata: { sibling: true } };
    expect(
      await recovery.projectForTransmit(
        { ...identity, deliveryContext: { surface: 'voice' } },
        publicRead,
      ),
    ).toBeNull();
    row.nativeResponse.status = 'cancelled';
    expect(await recovery.projectForTransmit(identity, publicRead)).toBeNull();
    row.nativeResponse.status = 'completed';
    row.nativeResponse.candidateJson = JSON.stringify({
      ...candidate,
      text: 'Changed private bytes.',
    });
    await expect(recovery.projectForTransmit(identity, publicRead)).rejects.toThrow(
      'candidate_mismatch',
    );
    expect(projectMessage).not.toHaveBeenCalled();
    row.nativeResponse.candidateJson = JSON.stringify(candidate);
    await recovery.projectForTransmit(identity, publicRead);
    expect(projectMessage).toHaveBeenCalledWith(
      expect.objectContaining(identity),
      result.response,
      expect.any(Object),
      'transmit',
      candidate,
    );
  });
  it('binds exact final body before sending and preserves it through the native fetch', async () => {
    const body = JSON.stringify({
      messages: [{ role: 'user', content: 'Source.' }],
      metadata: { visible_message_chain: [{ id: 'question', sha256: 'source' }] },
    });
    const order: string[] = [];
    const send = jest.fn<ReturnType<MainContinuityFetch>, Parameters<MainContinuityFetch>>(
      async () => {
        order.push('send');
        return new Response('{}');
      },
    );
    const admit = jest.fn(async () => {
      order.push('admit');
      return true;
    });
    const bound = jest.fn();
    const wrapped = createNativeResponseFetch(send, async () => context, admit, bound);
    await wrapped('http://native.test/v1/chat/completions', { method: 'POST', body });
    expect(order).toEqual(['admit', 'send']);
    expect(admit).toHaveBeenCalledWith(
      expect.objectContaining({ bodySha256: nativeResponseSha256(body) }),
    );
    expect(send.mock.calls[0][1]?.body).toBe(body);
    expect(new Headers(send.mock.calls[0][1]?.headers).get('X-Viventium-Native-Body-SHA256')).toBe(
      nativeResponseSha256(body),
    );
  });
  it('freezes the authored parent proof before an awaited admission can change request context', async () => {
    const parent = { id: 'parent-id', messageId: 'prior', digest: 'd'.repeat(64) };
    const supplied = { ...context, source: { ...context.source, parent } };
    const bound = jest.fn();
    const wrapped = createNativeResponseFetch(
      async () => new Response('{}'),
      async () => supplied,
      async () => {
        parent.digest = 'e'.repeat(64);
        supplied.source.digest = 'f'.repeat(64);
        return true;
      },
      bound,
    );
    await wrapped('http://native.test/v1/chat/completions', { body: '{}' });
    expect(bound.mock.calls[0][0].source).toEqual({
      ...context.source,
      parent: { ...parent, digest: 'd'.repeat(64) },
    });
  });
  it('never dispatches when Stop wins admission', async () => {
    const send = jest.fn();
    const wrapped = createNativeResponseFetch(
      send,
      async () => context,
      async () => {
        throw new Error('revoked');
      },
      jest.fn(),
    );
    await expect(wrapped('http://native.test/v1/chat/completions', { body: '{}' })).rejects.toThrow(
      'revoked',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('persists Mongo admission between both original-job bind fences', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue(null);
    expect(await createNativeResponseRecoveryService(d).admit(identity)).toBe(true);
    expect(d.db.admitNativeResponse).toHaveBeenCalledWith(identity, d.transaction);
    expect(d.bind).toHaveBeenCalledTimes(2);
    expect(d.bind.mock.invocationCallOrder[0]).toBeLessThan(
      d.db.admitNativeResponse.mock.invocationCallOrder[0],
    );
    expect(d.db.admitNativeResponse.mock.invocationCallOrder[0]).toBeLessThan(
      d.bind.mock.invocationCallOrder[1],
    );
  });
  it('settles the late Mongo admission when Stop wins between its two job fences', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue(null);
    d.bind.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(createNativeResponseRecoveryService(d).admit(identity)).rejects.toThrow(
      'job_revoked',
    );
    expect(d.db.settleNativeResponse).toHaveBeenCalledWith(identity, 'cancelled');
  });
  it('releases undispatched job authority when Mongo admission fails', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue(null);
    d.db.admitNativeResponse.mockRejectedValue(new Error('source_changed'));
    await expect(createNativeResponseRecoveryService(d).admit(identity)).rejects.toMatchObject({
      message: 'source_changed',
      code: 'source_context_unavailable',
      cause: expect.objectContaining({ message: 'source_changed' }),
    });
    expect(d.revoke).toHaveBeenCalledWith(identity);
    expect(d.release).toHaveBeenCalledWith(identity);
    expect(d.bind).toHaveBeenCalledTimes(1);
  });
  it('keeps an uncertain persisted admission fenced after a transaction error', async () => {
    const d = deps();
    d.db.admitNativeResponse.mockRejectedValue(new Error('transaction_uncertain'));
    await expect(createNativeResponseRecoveryService(d).admit(identity)).rejects.toThrow(
      'transaction_uncertain',
    );
    expect(d.revoke).toHaveBeenCalledWith(identity);
    expect(d.release).not.toHaveBeenCalled();
  });
  it('revalidates current route authority before publishing a prepared result', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue({
      nativeResponse: { ...identity, status: 'prepared', candidateSha256: 'saved-candidate' },
    });
    d.resolveRoute.mockRejectedValue(new Error('native_response_agent_unavailable'));
    await expect(createNativeResponseRecoveryService(d).recover(identity)).rejects.toThrow(
      'agent_unavailable',
    );
    expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
  });
  it('reads exact authenticated result and materializes its canonical answer without private fields', async () => {
    const d = deps();
    const service = createNativeResponseRecoveryService(d);
    expect(await service.recover(identity)).toEqual({ text: 'Canonical answer.' });
    const [url, options] = d.fetch.mock.calls[0];
    expect(url.pathname).toBe('/v1/requests/by-invocation/invocation/result');
    expect(url.searchParams.get('stream_id')).toBe('stream');
    expect(options.method).toBe('GET');
    expect(d.db.prepareNativeResponse).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        text: 'Canonical answer.',
        authoritySha256: 'effective-authority',
      }),
      d.transaction,
    );
  });
  it.each(['queued', 'running', 'failed', 'cancelled', 'unsupported'])(
    'does not project an answer for %s',
    async (state) => {
      const d = deps();
      d.fetch.mockResolvedValue(
        new Response(JSON.stringify({ ...result, state }), { status: 200 }),
      );
      expect(await createNativeResponseRecoveryService(d).recover(identity)).toBeNull();
      expect(d.db.prepareNativeResponse).not.toHaveBeenCalled();
      expect(d.db.materializeNativeResponse).not.toHaveBeenCalled();
    },
  );
  it('rejects a result from another invocation and a changed route origin', async () => {
    const d = deps();
    d.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ...result, invocation_id: 'other' }), { status: 200 }),
    );
    await expect(createNativeResponseRecoveryService(d).recover(identity)).rejects.toThrow(
      'identity_mismatch',
    );
    d.resolveRoute.mockResolvedValue({ baseURL: 'http://changed.test/v1', headers: {} });
    d.fetch.mockClear();
    await expect(createNativeResponseRecoveryService(d).recover(identity)).rejects.toThrow(
      'route_changed',
    );
    expect(d.fetch).not.toHaveBeenCalled();
  });
  it('never turns a host graph tool call into a Main answer', async () => {
    const d = deps();
    d.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...result,
          response: {
            ...result.response,
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  role: 'assistant',
                  content: 'Helper output.',
                  tool_calls: [{ id: 'tool' }],
                },
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    expect(await createNativeResponseRecoveryService(d).recover(identity)).toBeNull();
    expect(d.db.settleNativeResponse).toHaveBeenCalledWith(identity, 'unsupported');
    expect(d.db.prepareNativeResponse).not.toHaveBeenCalled();
  });
  it('a crash after preparation reuses the candidate without another provider lookup', async () => {
    const d = deps();
    d.db.getNativeResponse.mockResolvedValue({
      nativeResponse: { ...identity, status: 'prepared', candidateSha256: 'saved-candidate' },
    });
    await createNativeResponseRecoveryService(d).recover(identity);
    expect(d.fetch).not.toHaveBeenCalled();
    expect(d.db.materializeNativeResponse).toHaveBeenCalledWith(
      identity,
      'saved-candidate',
      d.commit,
      d.transaction,
      expect.any(Function),
    );
  });
});

describe('native identity across BSON optional-field representation', () => {
  const admittedAt = Date.now();
  const identity: NativeResponseIdentity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: admittedAt - 1,
    logicalTurnId: 'scope.turn',
    revision: 1,
    invocationId: 'invocation',
    providerId: 'provider',
    agentId: 'agent',
    bodySha256: 'a'.repeat(64),
    originSha256: 'b'.repeat(64),
    source: { id: 'source', messageId: 'question', digest: 'c'.repeat(64) },
    admittedAt,
    recoverUntil: admittedAt + 86_400_000,
  };
  const job = {
    userId: identity.userId,
    conversationId: identity.conversationId,
    responseMessageId: identity.responseMessageId,
    streamId: identity.streamId,
    createdAt: identity.jobCreatedAt,
    userMessage: { messageId: identity.source.messageId },
    interactionContext: { logical_turn_id: identity.logicalTurnId, revision: identity.revision },
  } as SerializableJobData;
  it.each([
    { sourceOrderScope: null, sourceSequence: null },
    { deliveryDispositionRequired: null, deliveryContext: null },
    {
      sourceOrderScope: null,
      sourceSequence: null,
      deliveryDispositionRequired: null,
      deliveryContext: null,
    },
  ])('retains the same canonical identity, validation and job owner for %j', (optionals) => {
    const stored = { ...identity, ...optionals } as unknown as NativeResponseIdentity;
    expect(nativeIdentityJson(stored)).toBe(nativeIdentityJson(identity));
    expect(nativeIdentityValid(stored)).toBe(true);
    expect(nativeJobMatches(job, stored)).toBe(true);
  });
  it.each([
    { userId: null },
    { bodySha256: null },
    { originSha256: '' },
    { source: { ...identity.source, digest: null } },
    { sourceOrderScope: null, sourceSequence: 1 },
    { sourceOrderScope: 'd'.repeat(64), sourceSequence: null },
    { sourceOrderScope: 'd'.repeat(64), sourceSequence: 0 },
    { sourceOrderScope: '', sourceSequence: 1 },
    { deliveryContext: { surface: 'telegram', audioRequested: null, authenticated: true } },
    { deliveryContext: { surface: 'telegram', audioRequested: true, authenticated: null } },
  ])('continues to reject malformed non-optional facts or incomplete pairs: %j', (invalid) => {
    expect(
      nativeIdentityValid({ ...identity, ...invalid } as unknown as NativeResponseIdentity),
    ).toBe(false);
  });
  it('preserves false, zero and changed mandatory facts as distinct identities', () => {
    for (const changed of [
      { sourceSequence: 0 },
      { deliveryDispositionRequired: false },
      { bodySha256: 'd'.repeat(64) },
      { originSha256: 'd'.repeat(64) },
      { agentId: 'another' },
      { source: { ...identity.source, digest: 'd'.repeat(64) } },
    ]) {
      expect(nativeIdentityJson({ ...identity, ...changed })).not.toBe(
        nativeIdentityJson(identity),
      );
    }
    expect(nativeJobMatches(job, { ...identity, sourceSequence: 0 })).toBe(false);
    expect(nativeJobMatches(job, { ...identity, userId: 'another' })).toBe(false);
  });
});
/* === VIVENTIUM END === */
