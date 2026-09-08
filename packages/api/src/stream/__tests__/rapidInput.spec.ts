import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import Redis from 'ioredis';
import {createServer} from 'net';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { RedisJobStore } from '../implementations/RedisJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { IJobStore, InteractionContext } from '../interfaces/IJobStore';

const scope = 'a'.repeat(64);
const context = (id: string, sequence?: number): InteractionContext => ({
 actor_kind: 'external_user', origin: 'interactive', surface: 'telegram',
 conversation_id: 'conversation', source_event_id: id, revision: 1,
 ...(sequence ? { source_sequence: sequence, source_order_scope: scope } : {}),
 source_segments: [{ ordinal: 0, source_event_id: id, source_index: 0, text: `${id} original goal`,
 ...(sequence ? {source_sequence: sequence} : {}) }],
});

let server: ChildProcess; let redis: Redis; let scratch: string;
beforeAll(async () => {
 scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-rapid-input-'));
 const probe=createServer(); await new Promise<void>(resolve=>probe.listen(0,'127.0.0.1',resolve));
 const address=probe.address(); if(!address || typeof address==='string') throw new Error('No test port');
 const port=address.port; await new Promise<void>(resolve=>probe.close(()=>resolve()));
 server = spawn(process.env.VIVENTIUM_TEST_REDIS_SERVER ?? 'redis-server', ['--bind','127.0.0.1','--port',String(port),
   '--save', '', '--appendonly', 'no', '--dir', scratch], {stdio: 'ignore'});
 redis = new Redis({host:'127.0.0.1',port,maxRetriesPerRequest:0,retryStrategy:()=>25});
 redis.on('error',()=>{});
 await new Promise<void>((resolve,reject)=> {redis.once('connect',resolve);server.once('error',reject);server.once('exit',code=>reject(new Error(`Owned Redis exited: ${code}`)));});
 if(!(await redis.info('server')).includes(`process_id:${server.pid}\r\n`)) throw new Error('Test Redis ownership not proven');
});
afterAll(async () => { if (redis) await redis.quit(); server?.kill('SIGTERM'); fs.rmSync(scratch, {recursive: true, force: true}); });

for (const backend of ['memory', 'redis']) describe(backend, () => {
 let store: IJobStore;
 beforeEach(async () => { if (backend === 'redis') await redis.flushdb();
 store = backend === 'memory' ? new InMemoryJobStore({ttlAfterComplete: 60_000}) : new RedisJobStore(redis);
 });
 afterEach(async () => { await store.destroy(); });
 test('ready input keeps its original provenance, yields to active Main, and resumes only at the current presentation watermark', async () => {
   const old=context('slow',1), quick=context('quick',2);
   await store.observeSourceOrder!({source_order_scope:scope,source_sequence:2});
   const active=await store.claimLogicalTurn('quick-stream','owner',quick);
   await store.createJob('quick-stream','owner','conversation',{interactionContext:active.interactionContext});
   const ready={...old,ready_input_continuation:{source_message_id:'input-slow',presentation_source_sequence:2}};
   expect((await store.claimLogicalTurn('slow-stream','owner',ready)).status).toBe('busy');
   expect((await store.getJob('quick-stream'))?.status).toBe('running');
   await store.completeLogicalTurn('quick-stream');
   const resumed=await store.claimLogicalTurn('slow-stream','owner',ready);
   expect(resumed).toMatchObject({status:'claimed',supersededStreamIds:[],interactionContext:{
     source_event_id:'slow',source_sequence:1,ready_input_continuation:{presentation_source_sequence:2}}});
   expect(resumed.interactionContext.source_segments?.map(s=>s.source_sequence)).toEqual([1]);
   expect((await store.claimLogicalTurn('duplicate','owner',ready)).status).toBe('duplicate');
 });
 test('a new observation fences a ready input continuation without losing the original goal', async () => {
   const old=context('slow',1);
   const ready={...old,ready_input_continuation:{source_message_id:'input-slow',presentation_source_sequence:2}};
   await store.observeSourceOrder!({source_order_scope:scope,source_sequence:3});
   expect((await store.claimLogicalTurn('stale','owner',ready)).status).toBe('superseded');
   expect((await store.claimLogicalTurn('retry','owner',{...ready,ready_input_continuation:{...ready.ready_input_continuation,presentation_source_sequence:3}})).status).toBe('claimed');
 });
 test('ready input native result uses the separate fence and a newer source still rejects its publication and delivery', async () => {
   await store.observeSourceOrder!({source_order_scope:scope,source_sequence:2});
   const ready={...context('slow',1),ready_input_continuation:{source_message_id:'input-slow',presentation_source_sequence:2}};
   const claim=await store.claimLogicalTurn('slow-stream','owner',ready);
   const job=await store.createJob('slow-stream','owner','conversation',{interactionContext:claim.interactionContext,
     responseMessageId:'answer',userMessage:{messageId:'input-slow'}});
   const now=Date.now(),digest='a'.repeat(64);
   const identity: NativeResponseIdentity={userId:'owner',conversationId:'conversation',responseMessageId:'answer',streamId:'slow-stream',
     jobCreatedAt:job.createdAt,logicalTurnId:claim.interactionContext.logical_turn_id!,revision:claim.interactionContext.revision,
     sourceOrderScope:scope,sourceSequence:2,invocationId:'invocation',bodySha256:digest,providerId:'provider',agentId:'agent',originSha256:digest,
     source:{id:'source-row',messageId:'input-slow',digest},admittedAt:now,recoverUntil:now+86400000};
   expect(await store.bindNativeResponse(identity)).toBe(true);
   expect(await store.bindNativeResponse({...identity,sourceSequence:1})).toBe(false);
   await store.observeSourceOrder!({source_order_scope:scope,source_sequence:3});
   expect(await store.commitNativeResponse(identity,digest)).toMatchObject({status:'revoked'});
   expect(await store.acknowledgeDelivery({logical_turn_id:identity.logicalTurnId,revision:identity.revision,state:'committed'})).toMatchObject({status:'stale_source_order'});
 });
 test('older setup finishing last cannot take newest authority or erase either accepted input', async () => {
   const a=context('a', 1), b=context('b', 2);
   await store.observeSourceOrder!({source_order_scope: scope, source_sequence: 1});
   await store.retainLogicalTurnInput('owner', a);
   await store.observeSourceOrder!({source_order_scope: scope, source_sequence: 2});
   await store.retainLogicalTurnInput('owner', b);
   const newest=await store.claimLogicalTurn('b-stream', 'owner', b);
   expect(newest.status).toBe('claimed');
   expect(newest.interactionContext.source_segments?.map(s=>s.text)).toEqual(['a original goal', 'b original goal']);
   const old=await store.claimLogicalTurn('a-stream', 'owner', a);
   expect(old.status).toBe('superseded');
   expect(old.supersededStreamIds).toEqual([]);
   const duplicate=await store.claimLogicalTurn('b-replay', 'owner', b);
   expect(duplicate).toMatchObject({status:'duplicate',streamId:'b-stream',interactionContext:{revision:1}});
 });
 test('claim waits for retained input persistence and then exposes both sources', async () => {
   const a=context('a',1), b=context('b',2);
   a.source_segments=[{...a.source_segments![0],source_message_id:'input-a'}];
   await store.retainLogicalTurnInput('owner',a); await store.retainLogicalTurnInput('owner',b);
   expect((await store.claimLogicalTurn('b-stream','owner',b)).status).toBe('initializing');
   a.source_segments=[{...a.source_segments![0],source_persisted:true}];
   await store.retainLogicalTurnInput('owner',a);
   const ready=await store.claimLogicalTurn('b-stream','owner',b);
   expect(ready.status).toBe('claimed');
   expect(ready.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(['a','b']);
 });
 test('ordinary supersession inherits exact prior source and owned uploaded files once', async () => {
   const a=context('a'), b=context('b');
   a.source_segments=[{...a.source_segments![0],source_files:[{file_id:'owner-file'}]}];
   const first=await store.claimLogicalTurn('a-stream','owner',a);
   const next=await store.claimLogicalTurn('b-stream','owner',b);
   expect(next.supersededStreamIds).toEqual(['a-stream']);
   expect(next.interactionContext.logical_turn_id).toBe(first.interactionContext.logical_turn_id);
   expect(next.interactionContext.source_segments).toHaveLength(2);
   expect(next.interactionContext.source_segments![0].source_files).toEqual([{file_id:'owner-file'}]);
 });
 test('failed first claim retains pending sources for the existing retry owner', async () => {
   await store.retainLogicalTurnInput('owner',context('a'));
   const b=context('b');
   const failed=await store.claimLogicalTurn('failed','owner',b);
   await store.rollbackLogicalTurnClaim('failed',failed.interactionContext);
   const retry=await store.claimLogicalTurn('retry','owner',b);
   expect(retry.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(['a','b']);
 });
 test('completed turn does not replay its old goals into the next turn', async () => {
   const a=await store.claimLogicalTurn('a-stream','owner',context('a'));
   await store.createJob('a-stream','owner','conversation',{interactionContext:a.interactionContext});
   await store.completeLogicalTurn('a-stream');
   await store.retainLogicalTurnInput('owner',context('b'));
   const next=await store.claimLogicalTurn('b-stream','owner',context('b'));
   expect(next.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(['b']);
 });
 test('a repeated adopted source cannot leak into the next completed turn', async () => {
   await store.retainLogicalTurnInput('owner',context('a'));
   const claim=await store.claimLogicalTurn('b-stream','owner',context('b'));
   await store.createJob('b-stream','owner','conversation',{interactionContext:claim.interactionContext});
   await store.completeLogicalTurn('b-stream');
   await store.retainLogicalTurnInput('owner',context('a'));
   await store.retainLogicalTurnInput('owner',context('c'));
   const next=await store.claimLogicalTurn('c-stream','owner',context('c'));
   expect(next.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(['c']);
 });
 test.each([[32,10],[2,24*1024]])('input capacity (%i sources of %i bytes) fails before evicting an accepted reference', async (count,bytes) => {
   const a=context('a'); a.source_segments=Array.from({length:count},(_,index)=>({ordinal:index,source_event_id:`source-${index}`,source_index:0,text:'x'.repeat(bytes)}));
   await store.retainLogicalTurnInput('owner',a);
   const b=context('b');b.source_segments=[{...b.source_segments![0],text:'y'.repeat(bytes)}];
   await expect(store.retainLogicalTurnInput('owner',b)).rejects.toMatchObject({code:'source_input_capacity'});
   const original=await store.claimLogicalTurn('a-stream','owner',a);
   expect(original.interactionContext.source_segments).toHaveLength(count);
   expect(original.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(a.source_segments.map(s=>s.source_event_id));
 });
 test('different owner or conversation cannot import retained input', async () => {
   await store.retainLogicalTurnInput('other',context('private'));
   const next=await store.claimLogicalTurn('own','owner',context('current'));
   expect(next.interactionContext.source_segments?.map(s=>s.source_event_id)).toEqual(['current']);
 });
 test('manager refuses stale authoring without replacing or aborting the current job', async () => {
   const manager=new GenerationJobManagerClass({jobStore:store,eventTransport:new InMemoryEventTransport(),cleanupOnComplete:false});
   manager.initialize();
   await manager.retainLogicalTurnInput('owner',context('a',1));
   await manager.retainLogicalTurnInput('owner',context('b',2));
   const current=await manager.createJob('b-stream','owner','conversation',{interactionContext:context('b',2)});
   await expect(manager.createJob('a-stream','owner','conversation',{interactionContext:context('a',1)})).rejects.toMatchObject({code:'source_order_superseded'});
   expect(current.abortController.signal.aborted).toBe(false);
   await manager.destroy();
 });
});
