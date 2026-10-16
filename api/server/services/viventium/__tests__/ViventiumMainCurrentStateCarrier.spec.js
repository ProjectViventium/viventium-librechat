const crypto = require('node:crypto');
const { buildActiveWorkCapsule } = require('../ViventiumDynamicTurnContext');
const { captureMainContextSnapshot, applyMainContextAttempt, bindMainContextSnapshot } = require('../ViventiumMainContextService');
const { createMainContinuityFetch, MAIN_CONTEXT_STATE_BLOCKS_HEADER, setTrustedInteractionContext } = require('@librechat/api');

function ownerProjection(maxBytes = 16384) {
  const projection = { mode: 'parallel', available: true, snapshot: { snapshot: 'fresh',
    work: [{ workId: 'synthetic-work', status: 'needs_input', title: 'é 漢字 "quoted"', summary: 'Synthetic current work.' }] } };
  let rosterText = '';
  const capsule = buildActiveWorkCapsule({ ...projection, maxBytes, onRenderedRoster: value => { rosterText = value; } });
  expect(capsule).toBe(buildActiveWorkCapsule({ ...projection, maxBytes }));
  expect(rosterText.startsWith('<viventium_untrusted_active_work_data')).toBe(true);
  expect(rosterText).not.toContain('# Parallel work');
  return { projection: { ...projection, rosterText }, capsule, rosterText };
}

async function authoredCarrier({ budget = false, suppliedRoster = true } = {}) {
  const owned = ownerProjection();
  const req = { user: { id: 'synthetic-owner' }, body: { conversationId: 'synthetic-conversation' } };
  setTrustedInteractionContext(req, { actor_kind: 'external_user', origin: 'interactive', surface: 'voice',
    conversation_id: 'synthetic-conversation', logical_turn_id: 'synthetic-turn', revision: 1 });
  const agent = { id: 'synthetic-main', instructions: 'Exact instructions.',
    model_parameters: { configuration: { defaultHeaders: { 'X-GlassHive-Agent-Id': 'synthetic-main',
      'X-Viventium-Visible-Message-Chain-B64': Buffer.from('[]').toString('base64') } } } };
  const context = [budget ? 'Additional current context. '.repeat(6000) : 'Current time: synthetic. é', owned.capsule].join('\n\n');
  const snapshot = captureMainContextSnapshot(req, { agent, messages: [], sections: {},
    attemptState: { instructionsByAgentId: { 'synthetic-main': agent.instructions }, turnContextText: context,
      activeWorkProjection: suppliedRoster ? owned.projection : null,
      turnContextComponents: [{ kind: 'time', text: context.split('\n\n')[0] }, { kind: 'activeWork', text: owned.capsule }] } });
  const requestBody = {};
  expect(applyMainContextAttempt({ agents: [agent], snapshot, requestBody,
    turnContextDeliveryByAgentId: { 'synthetic-main': 'per_turn_header' }, attemptAuthorityBlock: 'Exact attempt authority.' })).toBe(true);
  const headers = agent.model_parameters.configuration.defaultHeaders;
  const finalContext = Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString('utf8');
  let captured;
  await createMainContinuityFetch(async (_url, init) => {
    captured = { metadata: JSON.parse(init.body).metadata, headers: Object.fromEntries(new Headers(init.headers)) };
    return new Response('{}');
  }, headers['X-Viventium-Visible-Message-Chain-B64'])('https://provider.invalid/v1/chat/completions', {
    method: 'POST', headers: { ...headers, 'X-GlassHive-Turn-Context-B64': requestBody.viventiumGlassHiveTurnContextB64 },
    body: JSON.stringify({ messages: [], metadata: { main_context_state_blocks: [{ kind: 'forged' }] } }),
  });
  return { ...captured, owned, finalContext, snapshot, agent };
}

test.each([false, true])('real owner capsule and compiled courier preserve exact UTF8 DATA (%s)', async budget => {
  const result = await authoredCarrier({ budget });
  const [range] = result.metadata.main_context_state_blocks;
  const bytes = Buffer.from(result.metadata.turn_context).subarray(range.start_utf8, range.start_utf8 + range.length_utf8);
  expect(crypto.createHash('sha256').update(bytes).digest('hex')).toBe(range.sha256);
  expect(bytes.toString('utf8')).toBe(result.owned.rosterText);
  expect(result.metadata.turn_context).toBe(result.finalContext);
  expect(result.headers[MAIN_CONTEXT_STATE_BLOCKS_HEADER.toLowerCase()]).toBeUndefined();
  expect(result.finalContext).toContain('Exact attempt authority.');
});

test('unmarked capsule is passed intact with no inferred state descriptor', async () => {
  const result = await authoredCarrier({ suppliedRoster: false });
  expect(result.metadata.main_context_state_blocks).toBeUndefined();
  expect(result.finalContext).toContain(result.owned.rosterText);
});

test('rebinding clears inherited case-variant descriptor without changing other headers', async () => {
  const result = await authoredCarrier();
  const headers = result.agent.model_parameters.configuration.defaultHeaders;
  headers['x-viventium-main-context-state-blocks-b64'] = 'stale';
  headers['X-Synthetic-Capability'] = 'retained';
  expect(bindMainContextSnapshot(result.agent, result.snapshot)).toBe(true);
  const fresh = new Headers(result.agent.model_parameters.configuration.defaultHeaders);
  expect(fresh.get(MAIN_CONTEXT_STATE_BLOCKS_HEADER)).toBe('');
  expect(fresh.get('X-Synthetic-Capability')).toBe('retained');
});

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const nativeRoot = path.resolve(__dirname, '../../../../../../xPerfect/runtime_phase1');
const python = path.join(nativeRoot, '.venv', 'bin', 'python');
(fs.existsSync(python) ? test : test.skip)('compiled Core owner to typed Native carrier to actual JSON-bound Direct origin', async () => {
  const result = await authoredCarrier();
  const script = `import json,sys
from starlette.requests import Request
from workers_projects_runtime import conversation_provider as owner
from workers_projects_runtime.direct_runner import _core_state_input
value=json.load(sys.stdin)
owner.require_native_installed_owner=lambda _:None
payload=owner.ChatCompletionRequest(model='synthetic',messages=[{'role':'user','content':'Synthetic current goal'}],metadata=value['metadata'])
request=Request({'type':'http','headers':[(k.encode(),v.encode()) for k,v in value['headers'].items()]})
accepted=owner._hydrate_metadata(payload,request,owner.ProviderAuthContext(tenant_id='synthetic',principal_id='synthetic-owner',trust_identity_headers=True))
for profile in ('direct-xai','direct-openai','direct-anthropic'):
 projection=owner._direct_core_state_projection(accepted,type('Model',(),{'harness_profile':profile})())
 carrier=json.dumps({'instruction':accepted.metadata.turn_context,'context':[],'context_manifest':{}},ensure_ascii=False)
 bound=_core_state_input({'instruction':carrier,'core_state':projection})
 assert bound['blocks']==value['metadata']['main_context_state_blocks']
print(json.dumps({'profiles':3,'bound':True}))
`;
  const child = spawnSync(python, ['-c', script], { cwd: nativeRoot, encoding: 'utf8',
    env: { ...process.env, PYTHONPATH: path.join(nativeRoot, 'src') },
    input: JSON.stringify({ metadata: result.metadata, headers: result.headers }) });
  expect(child.status === 0 ? '' : child.stderr).toBe('');
  expect(child.status).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual({ profiles: 3, bound: true });
});
