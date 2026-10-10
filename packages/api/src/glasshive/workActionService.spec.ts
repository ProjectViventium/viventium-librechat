import { createGlassHiveWorkActionService } from './workActionService';

function dependencies() {
  return {
    assertVoiceWorkAuthority: jest.fn(async () => {}),
    GenerationJobManager: {
      getJob: jest.fn(async () => ({
        metadata: {
          userId: 'owner-1',
          viventiumCallSessionId: 'call-1',
          viventiumVoiceTaskId: 'task-1',
          interactionContext: { surface: 'voice', logical_turn_id: 'turn-1' },
        },
      })),
    },
    logger: { warn: jest.fn() },
    buildTrustedActionIdempotencyKey: jest.fn(() => 'trusted-action-key'),
    getActiveWorkSnapshot: jest.fn(async () => ({ snapshot: 'fresh', work: [] })),
    invalidateActiveWorkSnapshot: jest.fn(),
    requestAccountApi: jest.fn(async (input: Record<string, unknown>) =>
      input.method === 'POST'
        ? { workRef: 'work-1', state: 'queued' }
        : {
            workRef: 'work-1',
            attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
          },
    ),
    reauthorizeCapabilityAuthorization: jest.fn(async () => ({
      authorizationRef: 'authorization-1',
      maxExpiresAt: '2027-01-17T07:59:02.000Z',
      scopeFingerprint: 'scope-1',
    })),
    dismissCoreOnlyPreDispatchAttention: jest.fn(async () => null),
    getCoreWorkDelivery: jest.fn(async () => ({ state: 'delivered' })),
    getCoreWorkOriginRef: jest.fn(async () => 'origin-1'),
    recordVoiceOrchestrationTraceBestEffort: jest.fn(async () => ({ sequence: 1 })),
  };
}

describe('GlassHive work-action service', () => {
  it('reauthorizes only the exact expired-horizon Resume', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);

    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'resume',
      operationId: 'operation-1',
    });

    expect(deps.reauthorizeCapabilityAuthorization).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work-1',
    });
    expect(deps.requestAccountApi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          action: 'resume',
          idempotencyKey: 'trusted-action-key',
          capabilityReauthorization: expect.objectContaining({
            authorizationRef: 'authorization-1',
          }),
        }),
      }),
    );
  });

  it('keeps non-Resume actions on one authenticated request', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: 'operation-2',
    });

    expect(deps.requestAccountApi).toHaveBeenCalledTimes(1);
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(deps.invalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
  });

  it('does not trace a completed control when the owner action request fails', async () => {
    const deps = dependencies();
    deps.requestAccountApi.mockRejectedValueOnce(new Error('action_request_failed'));
    const service = createGlassHiveWorkActionService(deps);
    await expect(service.executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'stop', operationId: 'failed-operation',
      durableEffectContext: { streamId: 'stream-1' },
    })).rejects.toThrow('action_request_failed');
    expect(deps.recordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  it('retains event-time provenance and traces accepted actions without a presentation override', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'message',
      instruction: 'Continue with exact evidence.',
      operationId: 'operation-3',
      durableEffectContext: {
        streamId: 'stream-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-1',
      },
    });

    expect(deps.requestAccountApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          sourceContext: expect.objectContaining({
            originRef: 'origin-1',
            sourceRevision: 7,
            surface: 'voice',
          }),
        }),
      }),
    );
    expect(deps.recordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(2);
  });

  it('fails closed before dispatch without exact durable provenance or launch origin', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await expect(
      service.executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work-1',
        action: 'steer',
        operationId: 'operation-4',
        durableEffectContext: {
          streamId: 'stream-1',
          sourceEventId: 'voice:session-1:request-1',
          sourceSurface: 'voice',
        },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_source_context_unavailable', status: 409 });
    expect(deps.requestAccountApi).not.toHaveBeenCalled();

    deps.getCoreWorkOriginRef.mockResolvedValueOnce(null as never);
    await expect(
      service.executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work-1',
        action: 'queue',
        operationId: 'operation-5',
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_origin_unavailable', status: 409 });
  });

  it('dismisses only settled Core delivery and refreshes the owner roster', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'dismiss',
      operationId: 'operation-6',
    });
    expect(deps.getCoreWorkDelivery).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work-1',
    });
    expect(deps.getActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      forceRefresh: true,
    });
  });
});

it('requires the authenticated owner control for native input, not a model action', async () => {
  const deps = dependencies();
  const service = createGlassHiveWorkActionService(deps);
  const nativeInput = {
    version: 1 as const,
    requestId: 'request-1',
    requestFingerprint: 'a'.repeat(64),
    action: 'decline' as const,
  };
  await expect(
    service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'resume',
      nativeInput,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(deps.requestAccountApi).not.toHaveBeenCalled();
  await service.executeGlassHiveWorkAction({
    ownerId: 'owner-1',
    workRef: 'work-1',
    action: 'resume',
    operationId: 'op-native',
    nativeInput,
    ownerInputControl: true,
  });
  expect(deps.requestAccountApi).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerNativeInput: nativeInput,
      body: expect.objectContaining({ nativeInput }),
    }),
  );
});

it('rechecks voice authority after async preparation and before dispatch', async () => {
  const deps = dependencies();
  deps.assertVoiceWorkAuthority
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      Object.assign(new Error('voice_work_authority_stale'), {
        code: 'voice_work_authority_stale',
      }),
    );
  const binding = {
    version: 1 as const,
    callSessionId: 'call-1',
    userId: 'owner-1',
    kind: 'audio' as const,
    fingerprint: 'synthetic-fingerprint',
    turnIds: ['turn-1'],
  };
  await expect(
    createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: 'action-1',
      voiceAuthorityContext: { callSessionId: 'call-1', binding },
    }),
  ).rejects.toMatchObject({ code: 'voice_work_authority_stale' });
  expect(deps.requestAccountApi).not.toHaveBeenCalled();
});


describe('selected files on the actual shared action executor', () => {
  const crypto = require('node:crypto');
  const saved = { ...process.env };
  beforeAll(() => {
    process.env.WPR_API_TOKEN = 'synthetic-test-token';
    process.env.VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET = 'synthetic-test-secret';
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'http://127.0.0.1:9766/v1';
  });
  afterAll(() => { process.env = saved; });
  function fixture() {
    const deps = dependencies();
    const blobs = new Map();
    const keys = new Map();
    const puts = [];
    const actions = [];
    const source = (id, content, kind = 'original') => ({
      fileId: id, filename: `${id}.csv`, sizeBytes: Buffer.byteLength(content), inputKind: kind, mediaGroupIndex: id === 'a' ? 0 : 1,
      openStream: async () => (async function* () { yield Buffer.from(content); })(),
    });
    const sources = [source('a', 'x,y\na,1\n'), source('b', 'x,y\nb,2\n')];
    deps.getActionFileSources = jest.fn(async (input) => input.fileIds.map(id => sources.find(file => file.fileId === id)));
    deps.requestAccountApi.mockImplementation(async (input) => {
      if (input.method !== 'POST') return {workRef:'work-1', actions:['steer','message','queue','stop']};
      if (input.path === '/v1/file-uploads') {
        const body = input.body;
        if (keys.has(body.idempotency_key)) return blobs.get(keys.get(body.idempotency_key));
        const upload_id = `fil_${crypto.createHash('sha256').update(body.idempotency_key).digest('hex').slice(0,16)}`;
        const receipt = {upload_id, name:body.name,size_bytes:body.size_bytes,state:'pending'};
        keys.set(body.idempotency_key, upload_id);blobs.set(upload_id, receipt);
        return receipt;
      }
      actions.push(input);return {workRef:'work-1', state:'queued'};
    });
    deps.fetchImpl = jest.fn(async (url, init) => {
      const reader = init.body.getReader();const chunks=[];
      for (;;) { const next=await reader.read();if(next.done)break;chunks.push(Buffer.from(next.value)); }
      const bytes = Buffer.concat(chunks);
      const id = String(url).split('/').at(-2);
      const old=blobs.get(id);
      const receipt={...old,state:'ready',revision:'ready-r1',received_bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
      blobs.set(id,receipt);puts.push({url,init,bytes});
      return new Response(JSON.stringify(receipt), {status:200,headers:{'Content-Type':'application/json'}});
    });
    const input = {ownerId:'owner-1',workRef:'work-1',action:'steer',instruction:'Use these selected inputs.',operationId:'files-op',fileIds:['a','b']};
    return {deps,blobs,puts,actions,sources,input};
  }
  it('uses only the lean current action projection before selected file transfer', async () => {
    const f=fixture();
    await createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input);
    const reads=f.deps.requestAccountApi.mock.calls.map(([input])=>input).filter(input=>input.method !== 'POST');
    expect(reads).toEqual([{ownerId:'owner-1',path:'/v1/work/work-1?projection=actions'}]);
    expect(f.deps.requestAccountApi.mock.invocationCallOrder[0]).toBeLessThan(f.deps.getActionFileSources.mock.invocationCallOrder[0]);
    expect(f.deps.getActionFileSources.mock.invocationCallOrder[0]).toBeLessThan(f.deps.fetchImpl.mock.invocationCallOrder[0]);
  });
  it('carries exact original byte receipts in selected order to the existing action', async () => {
    const f=fixture();await createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input);
    expect(f.puts.map(x=>x.bytes.toString())).toEqual(['x,y\na,1\n','x,y\nb,2\n']);
    expect(f.actions[0].body.fileInputs.map(x=>[x.sourceFileId,x.inputKind,x.mediaGroupIndex])).toEqual([['a','original',0],['b','original',1]]);
    expect(f.actions[0].body.fileInputs.every(x=>x.uploadId.startsWith('fil_') && x.revision==='ready-r1')).toBe(true);
    expect(f.puts.every(x=>x.init.redirect==='error' && x.init.headers['Content-Type']==='application/octet-stream')).toBe(true);
  });
  it.each(['queue', 'message'])('keeps completed-draft %s explicit and carries exact selected inputs', async (action) => {
    const f=fixture();f.input.action=action;
    await createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input);
    expect(f.actions[0].body.action).toBe(action);expect(f.actions[0].body.fileInputs.map(x=>x.sourceFileId)).toEqual(['a','b']);
  });
  it('reuses durable begin keys and exact ready IDs without another PUT', async () => {
    const f=fixture();const svc=createGlassHiveWorkActionService(f.deps);
    await svc.executeGlassHiveWorkAction(f.input);await svc.executeGlassHiveWorkAction(f.input);
    expect(f.puts).toHaveLength(2);expect(f.actions[0].body.fileInputs).toEqual(f.actions[1].body.fileInputs);
  });
  it('records Upload-as-Text bytes as extracted rather than original', async () => {
    const f=fixture();f.sources[0].inputKind='extracted_text';f.input.fileIds=['a'];
    await createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input);
    expect(f.actions[0].body.fileInputs[0].inputKind).toBe('extracted_text');
  });
  it('does not prepare or bind files on an unavailable/completed Steer', async () => {
    const f=fixture();f.deps.requestAccountApi.mockResolvedValue({state:'completed',actions:['message','queue','dismiss']});
    await expect(createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input)).rejects.toThrow('active_work_action_not_available');
    expect(f.deps.getActionFileSources).not.toHaveBeenCalled();expect(f.puts).toHaveLength(0);
  });
  it('rejects unselected/foreign owner data before any byte transfer', async () => {
    const f=fixture();f.deps.getActionFileSources.mockRejectedValue(new Error('active_work_file_selection_unauthorized'));
    await expect(createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input)).rejects.toThrow('active_work_file_selection_unauthorized');
    expect(f.puts).toHaveLength(0);expect(f.actions).toHaveLength(0);
  });
  it('rejects a source whose actual bytes do not match its durable size', async () => {
    const f=fixture();f.sources[0].sizeBytes++;
    await expect(createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input)).rejects.toThrow('active_work_file_source_changed');
    expect(f.puts).toHaveLength(0);expect(f.actions).toHaveLength(0);
  });
  it('rejects ready receipt hash drift and admits no action', async () => {
    const f=fixture();await createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input);
    f.actions.length=0;for(const row of f.blobs.values()) row.sha256='0'.repeat(64);
    await expect(createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input)).rejects.toThrow('active_work_upload_content_unconfirmed');
    expect(f.actions).toHaveLength(0);
  });
  it('rejects files on unsupported action without re-routing it', async () => {
    const f=fixture();f.input.action='pause';
    await expect(createGlassHiveWorkActionService(f.deps).executeGlassHiveWorkAction(f.input)).rejects.toThrow('active_work_file_selection_invalid');
    expect(f.puts).toHaveLength(0);expect(f.actions).toHaveLength(0);
  });
});
