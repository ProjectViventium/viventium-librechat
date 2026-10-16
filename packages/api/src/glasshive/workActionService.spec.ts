import { createGlassHiveWorkActionService } from './workActionService';

const nativeQuestion = () => ({
  version: 1, kind: 'question', state: 'pending', runtimeName: 'Grok', mode: 'form',
  requestId: 'request-question', requestFingerprint: 'a'.repeat(64), runId: 'run-question',
  attemptId: 'attempt-question', sessionId: 'session-question', expiresAt: '2099-01-01T00:00:00Z',
  message: 'Which colour?', requestedSchema: {
    type: 'object', required: ['answers'], additionalProperties: false,
    properties: {
      answers: { type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 16,
        properties: { 'Which colour?': { type: 'array', uniqueItems: true, minItems: 1, maxItems: 1,
          items: { type: 'string', enum: ['Blue', 'Other'] } } } },
      annotations: { type: 'object', additionalProperties: false, properties: {
        'Which colour?': { type: 'object', additionalProperties: false, required: ['notes'],
          properties: { notes: { type: 'string', minLength: 1, maxLength: 8000 } } } } },
    },
  },
});
const questionReply = () => ({ version: 1 as const, requestId: 'request-question',
  requestFingerprint: 'a'.repeat(64), action: 'accept' as const,
  content: { answers: { 'Which colour?': ['Blue'] } } });

test('Main returns a current native clarification through existing signed owner action, with one reused detail read', async () => {
  const deps = dependencies();
  deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => request.method === 'POST'
    ? { status: 'accepted' } : { workRef: 'work-1', pendingNativeInput: nativeQuestion() });
  const nativeInput = questionReply();
  const result = await createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
    ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'question-answer', nativeInput });
  expect(result).toEqual({ status: 'accepted' });
  expect(deps.requestAccountApi.mock.calls.filter(([request]) => request.method !== 'POST')).toHaveLength(1);
  expect(deps.requestAccountApi).toHaveBeenLastCalledWith(expect.objectContaining({
    ownerId: 'owner-1', ownerNativeInput: nativeInput, method: 'POST',
    body: expect.objectContaining({ action: 'resume', nativeInput }) }));
  expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
});

test.each(['permission', 'replaced', 'expired', 'wrong_work', 'wrong_choice', 'wrong_question'])(
  'Main cannot use clarification reply to bypass %s', async (mutation) => {
    const deps = dependencies(); const pending = nativeQuestion(); const reply = questionReply();
    let workRef = 'work-1';
    if (mutation === 'permission') pending.kind = 'permission';
    if (mutation === 'replaced') pending.requestFingerprint = 'b'.repeat(64);
    if (mutation === 'expired') pending.expiresAt = '2000-01-01T00:00:00Z';
    if (mutation === 'wrong_work') workRef = 'work-other';
    if (mutation === 'wrong_choice') reply.content.answers['Which colour?'] = ['blue'];
    if (mutation === 'wrong_question') reply.content.answers = { 'Which color?': ['Blue'] } as typeof reply.content.answers;
    deps.requestAccountApi.mockImplementation(async () => ({ workRef, pendingNativeInput: pending }));
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', nativeInput: reply,
    })).rejects.toMatchObject({ status: 403 });
    expect(deps.requestAccountApi.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
  });

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
      ownerInputControl: true,
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

  it.each(['chat', 'voice', 'scheduler', 'workbench'])(
    'keeps an unattested %s Resume in needs-input without renewing scope', async (sourceSurface) => {
      const deps = dependencies();
      await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
        ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'operation-1', sourceSurface,
      })).rejects.toMatchObject({ code: 'capability_authorization_horizon_expired', status: 409, needsInput: true });
      expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
      expect(deps.requestAccountApi.mock.calls.some(([request]) => request.method === 'POST')).toBe(false);
    },
  );

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
    expect(f.deps.invalidateActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      fetchImpl: f.deps.fetchImpl,
    });
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

describe('natural owner controls through the current original human source',()=>{
  const requestBody={conversationId:'conversation',messageId:'assistant',viventiumStreamId:'stream',
    viventiumLogicalTurnId:'turn',viventiumLogicalTurnRevision:2,
    viventiumAuthoringSourceEventId:'source',viventiumAuthoringSourceRevision:2};
  function permissionDependencies(kind='allow_once') {
    const deps=dependencies();
    const job={streamId:'stream',userId:'owner-1',conversationId:'conversation',responseMessageId:'assistant',
      status:'running' as const,interactionContext:{actor_kind:'external_user' as const,origin:'interactive' as const,
        surface:'voice' as const,conversation_id:'conversation',logical_turn_id:'turn',revision:2,source_event_id:'source',
        source_segments:[{ordinal:0,source_event_id:'source',source_index:0,source_message_id:'human',
          source_persisted:true as const,authoring_revision:2,source_received_at:2000,text:'Approve the current write once.'}]}};
    const pending={kind:'permission',requestId:'native-current',requestFingerprint:'c'.repeat(64),
      requestedSchema:{properties:{optionId:{enum:['provider-current-choice'],enumKinds:[kind]}}}};
    deps.requestAccountApi.mockImplementation(async request=>request.method==='POST'?{status:'accepted'}:
      {workRef:'work-1',pendingNativeInput:pending});
    return {...deps,getSourceAuthorJob:jest.fn(async()=>job),
      getOriginalInputReceipt:jest.fn(async()=>({sourceEventId:'source',receivedAt:2000})),job,pending};
  }
  const reply={version:1 as const,requestId:'native-current',requestFingerprint:'c'.repeat(64),
    action:'accept' as const,content:{optionId:'provider-current-choice'}};
  test.each(['web','telegram','voice'])('reauthorizes an explicit current %s owner continuation from its original receipt',async surface=>{
    const deps=permissionDependencies();
    Object.assign(deps.job.interactionContext,{surface});
    deps.job.interactionContext.source_segments[0].text='Resume this work with the same connected capabilities.';
    deps.requestAccountApi.mockImplementation(async request=>request.method==='POST'?{status:'accepted'}:
      {workRef:'work-1',attention:{code:'capability_authorization_horizon_expired'}});
    await createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
      action:'resume',requestBody,operationId:'owner-resume'});
    expect(deps.getOriginalInputReceipt).toHaveBeenCalledTimes(1);
    expect(deps.reauthorizeCapabilityAuthorization).toHaveBeenCalledTimes(1);
    expect(deps.requestAccountApi).toHaveBeenLastCalledWith(expect.objectContaining({method:'POST',
      body:expect.objectContaining({capabilityReauthorization:expect.objectContaining({authorizationRef:'authorization-1'})})}));
  });
  test.each(['callback','scheduler','agent','truncated','overflow','changed_receipt','missing_receipt','superseded','legacy'])(
    'does not renew a %s source or dispatch native Resume',async variant=>{
      const deps=permissionDependencies();
      deps.requestAccountApi.mockImplementation(async request=>request.method==='POST'?{status:'accepted'}:
        {workRef:'work-1',attention:{code:'capability_authorization_horizon_expired'}});
      if(['callback','scheduler'].includes(variant)) Object.assign(deps.job.interactionContext,{origin:variant});
      if(variant==='agent') Object.assign(deps.job.interactionContext,{actor_kind:'agent'});
      if(variant==='truncated') Object.assign(deps.job.interactionContext.source_segments[0],{truncated:true});
      if(variant==='overflow') Object.assign(deps.job.interactionContext,{source_segments_overflow_count:1});
      if(variant==='changed_receipt') deps.getOriginalInputReceipt.mockResolvedValue({sourceEventId:'source',receivedAt:9999});
      if(variant==='missing_receipt') deps.getOriginalInputReceipt.mockResolvedValue(undefined as any);
      if(variant==='superseded') Object.assign(deps.job,{status:'completed'});
      await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
        action:'resume',requestBody:variant==='legacy'?{}:requestBody,operationId:'unattested-resume'}))
        .rejects.toMatchObject({code:'capability_authorization_horizon_expired',status:409,needsInput:true});
      expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
      expect(deps.requestAccountApi.mock.calls.some(([request])=>request.method==='POST')).toBe(false);
    });
  test.each(['allow_once','reject_once'])('couriers actual offered %s with exact server source attestation',async kind=>{
    const deps=permissionDependencies(kind);
    await createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
      action:'resume',nativeInput:reply,requestBody,operationId:'native-response'});
    expect(deps.requestAccountApi).toHaveBeenLastCalledWith(expect.objectContaining({ownerNativeInput:reply,
      body:expect.objectContaining({nativeInput:reply,nativeHumanInput:{version:1,actorKind:'external_user',origin:'interactive',
        sourceEventId:'source',sourceIndex:0,sourceMessageId:'human',authoringRevision:2,logicalTurnId:'turn',conversationId:'conversation',receivedAt:2000}})}));
    expect(deps.getSourceAuthorJob).toHaveBeenCalledTimes(1);
  });
  test.each(['allow_always','reject_always','unknown','missing','callback','changed_receipt','legacy'])('rejects %s without native mutation',async variant=>{
    const deps=permissionDependencies(['callback','changed_receipt','legacy'].includes(variant)?'allow_once':variant);
    if(variant==='missing') delete (deps.pending.requestedSchema.properties.optionId as any).enumKinds;
    if(variant==='callback') (deps.job.interactionContext as any).origin='callback';
    if(variant==='changed_receipt') deps.getOriginalInputReceipt.mockResolvedValue({sourceEventId:'source',receivedAt:9999});
    if(variant==='legacy') deps.getOriginalInputReceipt.mockResolvedValue(undefined as any);
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
      action:'resume',nativeInput:reply,requestBody})).rejects.toBeInstanceOf(Error);
    expect(deps.requestAccountApi.mock.calls.some(([request])=>request.method==='POST')).toBe(false);
  });
  test('direct authenticated owner form stays unchanged and does not acquire natural source authority',async()=>{
    const deps=permissionDependencies('allow_always');
    await createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
      action:'resume',nativeInput:reply,ownerInputControl:true});
    expect(deps.getSourceAuthorJob).not.toHaveBeenCalled();
    const post=deps.requestAccountApi.mock.calls.find(([request])=>request.method==='POST')![0];
    expect(post.body).not.toHaveProperty('nativeHumanInput');
  });
});

describe('immutable native action receipt recovery', () => {
  const conflict = () => Object.assign(new Error('Synthetic digest conflict'),
    { code: 'active_work_idempotency_conflict', status: 409 });
  const candidate = { version: 1, authorizationRef: 'authorization-1',
    maxExpiresAt: '2027-01-17T07:59:02.000Z', scopeFingerprint: 'scope-1' };
  test('same operation after a different terminal failure recovers the exact receipt without renewal', async () => {
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => candidate) };
    const receipt = { workRef: 'work-1', state: 'queued', actionRef: 'original-action' };
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', state: 'failed', failureCode: 'context_unavailable' };
      if (String(request.path).endsWith('/actions/receipt')) return receipt;
      throw conflict();
    });
    const result = await createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-owner-operation', ownerInputControl: true });
    expect(result).toEqual(receipt);
    const posts = deps.requestAccountApi.mock.calls.map(([request]) => request).filter(request => request.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({ ownerId: 'owner-1', path: '/v1/work/work-1/actions/receipt',
      body: { ...posts[0].body as object, capabilityReauthorization: candidate } });
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(deps.buildTrustedActionIdempotencyKey).toHaveBeenCalledTimes(1);
    expect(deps.readCapabilityReauthorizationReceiptCandidate).toHaveBeenCalledWith({ ownerId: 'owner-1', workRef: 'work-1' });
  });
  test.each(['happy', 'other_error', 'foreign_or_changed_body', 'missing_candidate'])('preserves %s action authority', async (kind) => {
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => kind === 'missing_candidate' ? null : candidate) };
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', state: 'failed' };
      if (kind === 'happy') return { state: 'queued' };
      if (kind === 'other_error') throw Object.assign(new Error('Synthetic'), { status: 503, code: 'native_unavailable' });
      throw conflict();
    });
    const operation = createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-operation', ownerInputControl: true });
    if (kind === 'happy') await expect(operation).resolves.toEqual({ state: 'queued' });
    else await expect(operation).rejects.toMatchObject({ code: kind === 'other_error' ? 'native_unavailable' : 'active_work_idempotency_conflict' });
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => String(request.path).endsWith('/actions/receipt')))
      .toHaveLength(kind === 'foreign_or_changed_body' ? 1 : 0);
  });

  test('receipt candidate lookup cannot outlive the current Voice authority', async () => {
    let callEnded = false;
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => {
      callEnded = true;
      return candidate;
    }) };
    deps.assertVoiceWorkAuthority.mockImplementation(async () => {
      if (callEnded) throw Object.assign(new Error('Synthetic ended call'), { code: 'voice_work_authority_stale', status: 409 });
    });
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', state: 'failed' };
      throw conflict();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-operation', ownerInputControl: true,
      voiceAuthorityContext: { callSessionId: 'call-1', binding: { callSessionId: 'call-1' } as never },
    })).rejects.toMatchObject({ code: 'voice_work_authority_stale' });
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => String(request.path).endsWith('/actions/receipt'))).toHaveLength(0);
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
  });
  test('receipt lookup preserves the complete original instruction and native owner input body', async () => {
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => candidate) };
    const reply = questionReply();
    const receipt = { actionRef: 'original-action', state: 'queued' };
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', state: 'failed' };
      if (String(request.path).endsWith('/actions/receipt')) return receipt;
      throw conflict();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-operation', ownerInputControl: true,
      instruction: 'Original exact continuation', nativeInput: reply,
    })).resolves.toEqual(receipt);
    const posts = deps.requestAccountApi.mock.calls.map(([request]) => request).filter(request => request.method === 'POST');
    expect(posts[0].body).toEqual({ action: 'resume', instruction: 'Original exact continuation', idempotencyKey: 'trusted-action-key', nativeInput: reply });
    expect(posts[1]).toEqual({ ...posts[0], path: '/v1/work/work-1/actions/receipt',
      body: { ...posts[0].body as object, capabilityReauthorization: candidate } });
    expect(posts[1].ownerNativeInput).toEqual(reply);
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
  });
  test('a typed receipt-only rejection cannot renew or dispatch another effect', async () => {
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => candidate) };
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', state: 'failed' };
      throw conflict();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-operation', ownerInputControl: true,
    })).rejects.toMatchObject({ code: 'active_work_idempotency_conflict' });
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => request.method === 'POST')).toHaveLength(2);
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => String(request.path).endsWith('/actions'))).toHaveLength(1);
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(deps.invalidateActiveWorkSnapshot).not.toHaveBeenCalled();
  });
  test('a conflicting fresh renewal never substitutes a different receipt descriptor', async () => {
    const deps = { ...dependencies(), readCapabilityReauthorizationReceiptCandidate: jest.fn(async () => candidate) };
    deps.requestAccountApi.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.method !== 'POST') return { workRef: 'work-1', attention: { code: 'capability_authorization_horizon_expired' } };
      throw conflict();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'resume', operationId: 'same-operation', ownerInputControl: true,
    })).rejects.toMatchObject({ code: 'active_work_idempotency_conflict' });
    expect(deps.readCapabilityReauthorizationReceiptCandidate).not.toHaveBeenCalled();
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => String(request.path).endsWith('/actions/receipt'))).toHaveLength(0);
  });
});

describe('timed-out native action receipt', () => {
  const timedOut = () => Object.assign(new Error('Synthetic timeout'), {
    code: 'glasshive_account_request_timeout', status: 504 });
  test.each([false, true])('reads exact %s pending/completed receipt without a second dispatch', async (pending) => {
    const deps = dependencies();
    const receipt = { workRef: 'work-1', action: 'steer', status: pending ? 'pending' : 'queued',
      state: pending ? 'running' : 'queued', confirmationPending: pending, idempotentReplay: true };
    deps.requestAccountApi.mockImplementation(async (request) => {
      if (String(request.path).endsWith('/actions/receipt')) return receipt;
      throw timedOut();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'steer', instruction: 'Preserve existing entries.', operationId: 'operation-one',
      durableEffectContext: {streamId:'stream-1',sourceEventId:'event-one',sourceRevision:1,sourceSurface:'voice'},
    })).resolves.toEqual(receipt);
    const calls = deps.requestAccountApi.mock.calls.map(([request]) => request);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ ...calls[0], path: '/v1/work/work-1/actions/receipt' });
    expect(deps.buildTrustedActionIdempotencyKey).toHaveBeenCalledTimes(1);
    const traces=deps.recordVoiceOrchestrationTraceBestEffort.mock.calls.map(([value]) => value);
    expect(traces.map(value=>value.stage)).toEqual(pending ? ['action.accepted'] : ['action.accepted','control.completed']);
    if(pending)expect(traces[0].facts).toMatchObject({confirmationPending:true});
    else expect(traces[0].facts).not.toHaveProperty('confirmationPending');
  });
  test('missing exact receipt remains unconfirmed and cannot dispatch compensation', async () => {
    const deps = dependencies();
    deps.requestAccountApi.mockImplementation(async (request) => {
      if (String(request.path).endsWith('/actions/receipt')) {
        throw Object.assign(new Error('Missing'), { code: 'active_work_idempotency_conflict', status: 409 });
      }
      throw timedOut();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'steer', instruction: 'Retain this worker.', operationId: 'operation-one',
    })).rejects.toMatchObject({ code: 'work_action_outcome_unconfirmed', retryable: false, outcomeUnknown: true });
    expect(deps.requestAccountApi.mock.calls.filter(([request]) => String(request.path).endsWith('/actions'))).toHaveLength(1);
    expect(deps.invalidateActiveWorkSnapshot).not.toHaveBeenCalled();
  });
  test('preserves a recorded native failure without reporting acceptance', async () => {
    const deps = dependencies();
    const failure = Object.assign(new Error('Synthetic stop could not be confirmed'), {
      code: 'active_work_stop_not_accepted', status: 409, actionReceipt: 'immutable_failure' });
    deps.requestAccountApi.mockImplementation(async (request) => {
      if (String(request.path).endsWith('/actions/receipt')) throw failure;
      throw timedOut();
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId:'owner-1',workRef:'work-1',action:'steer',instruction:'Preserve this goal.',operationId:'operation-one',
    })).rejects.toBe(failure);
    expect(deps.requestAccountApi).toHaveBeenCalledTimes(2);
    expect(deps.invalidateActiveWorkSnapshot).not.toHaveBeenCalled();
  });
  test('ended Voice owner cannot read acceptance', async () => {
    const deps = dependencies();
    let ended = false;
    deps.assertVoiceWorkAuthority.mockImplementation(async () => {
      if (ended) throw Object.assign(new Error('Ended'), {code: 'voice_work_authority_stale', status: 409});
    });
    deps.requestAccountApi.mockImplementation(async () => { ended = true; throw timedOut(); });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId:'owner-1',workRef:'work-1',action:'steer',instruction:'Preserve this goal.',operationId:'operation-one',
      voiceAuthorityContext:{callSessionId:'call-1',binding:{callSessionId:'call-1'} as never},
    })).rejects.toMatchObject({code:'voice_work_authority_stale'});
    expect(deps.requestAccountApi).toHaveBeenCalledTimes(1);
  });
});


describe('receipt read failure cannot decide an earlier mutation', () => {
  test.each([401,403,404,409,429,500,502,503,504])('HTTP%s stays unknown and nonretryable without immutable provenance', async (status) => {
    const deps=dependencies();
    deps.requestAccountApi.mockImplementation(async (request) => {
      if (String(request.path).endsWith('/actions/receipt')) throw Object.assign(new Error('Read failed'),{status,code:'synthetic_receipt_read_failed'});
      throw Object.assign(new Error('Deadline'),{code:'glasshive_account_request_timeout',status:504});
    });
    await expect(createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({ownerId:'owner-1',workRef:'work-1',
      action:'steer',instruction:'Keep the same work.',operationId:'operation-one'}))
      .rejects.toMatchObject({code:'work_action_outcome_unconfirmed',outcomeUnknown:true,retryable:false});
    expect(deps.requestAccountApi.mock.calls.filter(([request])=>String(request.path).endsWith('/actions'))).toHaveLength(1);
    expect(deps.invalidateActiveWorkSnapshot).not.toHaveBeenCalled();
    expect(deps.recordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });
});
