import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { MainContinuityFetch } from '../continuity/mainContinuity';
/* === VIVENTIUM START === Durable supersession authority. === */
import {
  nativePredecessorSupersession,
  stripNativePredecessorSupersession,
} from './nativeSupersession';
import type { SerializableJobData } from '../stream/interfaces/IJobStore';
const sources = [{ id: 'user', sha256: 'a'.repeat(64) }];
const previous = {
  streamId: 'previous',
  userId: 'owner',
  conversationId: 'chat',
  createdAt: 1,
  status: 'superseded',
  syncSent: false,
  responseMessageId: 'removed',
  interactionContext: { logical_turn_id: 'turn', revision: 1 },
  nativeResponse: {
    invocationId: 'invocation',
    responseMessageId: 'removed',
    logicalTurnId: 'turn',
    revision: 1,
  },
  nativeAcceptedSources: { invocationId: 'invocation', sources },
  deliveryAcknowledgement: { logical_turn_id: 'turn', revision: 1, state: 'partial_removed' },
} as SerializableJobData;
const current = {
  streamId: 'current',
  userId: 'owner',
  conversationId: 'chat',
  createdAt: 2,
  status: 'running',
  syncSent: false,
  interactionContext: { logical_turn_id: 'turn', revision: 2 },
  nativePredecessor: {
    streamId: 'previous',
    createdAt: 1,
    responseMessageId: 'removed',
    invocationId: 'invocation',
  },
} as SerializableJobData;
test('carries exact predecessor and protected sources', () => {
  expect(nativePredecessorSupersession(current, previous, sources)).toEqual({
    version: 1,
    previous_response_message_id: 'removed',
    logical_turn_id: 'turn',
    previous_revision: 1,
    revision: 2,
    disposition: 'partial_removed',
    accepted_sources: sources,
  });
});
test.each([
  { deliveryAcknowledgement: undefined },
  { deliveryAcknowledgement: { logical_turn_id: 'turn', revision: 1, state: 'committed' } },
  { deliveryAcknowledgement: { logical_turn_id: 'turn', revision: 2, state: 'partial_removed' } },
  { status: 'complete' },
  { createdAt: 9 },
  { userId: 'other' },
  { nativeAcceptedSources: undefined },
  { nativeAcceptedSources: { invocationId: 'another', sources } },
])('omits absent or mismatched proof: %j', (patch) => {
  expect(
    nativePredecessorSupersession(
      current,
      { ...previous, ...patch } as SerializableJobData,
      sources,
    ),
  ).toBeUndefined();
});
test('same turn alone and edited protected source fail closed', () => {
  expect(
    nativePredecessorSupersession({ ...current, nativePredecessor: undefined }, previous, sources),
  ).toBeUndefined();
  expect(
    nativePredecessorSupersession(current, previous, [{ ...sources[0], sha256: 'c'.repeat(64) }]),
  ).toBeUndefined();
});
test('strips supplied carrier only', () => {
  const init = {
    body: JSON.stringify({
      metadata: { native_predecessor_supersession: { forged: true }, keep: 1 },
    }),
  };
  expect(JSON.parse(stripNativePredecessorSupersession(init)!.body as string)).toEqual({
    metadata: { keep: 1 },
  });
  const plain = { body: '{}' };
  expect(stripNativePredecessorSupersession(plain)).toBe(plain);
});
/* === VIVENTIUM END === */

import { GenerationJobManager } from '../stream/GenerationJobManager';
import { createNativeResponseFetch } from './nativeResponse';
import { retainVerifiedNativeSources } from './nativeSupersession';

test('only verified final transport sources authorize a carrier and binding hashes it', async () => {
  const proof = nativePredecessorSupersession(current, previous, sources)!;
  const read = jest
    .spyOn(GenerationJobManager, 'getNativePredecessorSupersession')
    .mockResolvedValue(proof);
  const save = jest.spyOn(GenerationJobManager, 'retainNativeAcceptedSources').mockResolvedValue();
  const send = jest.fn<ReturnType<MainContinuityFetch>, Parameters<MainContinuityFetch>>(
    async () => new Response('{}'),
  );
  const admit = jest.fn(async (_identity: NativeResponseIdentity) => true);
  const context = {
    userId: 'owner',
    conversationId: 'chat',
    responseMessageId: 'new',
    streamId: 'current',
    jobCreatedAt: 2,
    logicalTurnId: 'turn',
    revision: 2,
    providerId: 'native',
    agentId: 'main',
    source: { id: 'input', messageId: 'user', digest: 'digest' },
  };
  const fetch = createNativeResponseFetch(send, async () => context, admit, jest.fn());
  const request = {
    body: JSON.stringify({
      metadata: { native_predecessor_supersession: { forged: true } },
      messages: [],
    }),
  };
  await fetch('https://native.invalid/v1/chat/completions', request);
  expect(read).not.toHaveBeenCalled();
  expect(
    JSON.parse(send.mock.calls[0][1]!.body as string).metadata.native_predecessor_supersession,
  ).toBeUndefined();
  retainVerifiedNativeSources(
    request,
    sources.map((item) => ({ ...item, role: 'user', accepted_source: true })),
  );
  const verifiedFetch = createNativeResponseFetch(send, async () => context, admit, jest.fn());
  await verifiedFetch('https://native.invalid/v1/chat/completions', request);
  expect(read).toHaveBeenCalledWith(context, sources);
  expect(save).toHaveBeenCalled();
  expect(
    JSON.parse(send.mock.calls[1][1]!.body as string).metadata.native_predecessor_supersession,
  ).toEqual(proof);
  expect(admit.mock.calls[0][0].bodySha256).not.toBe(admit.mock.calls[1][0].bodySha256);
});
test('strips Request body carrier even without native authority', async () => {
  const send = jest.fn<ReturnType<MainContinuityFetch>, Parameters<MainContinuityFetch>>(
    async () => new Response('{}'),
  );
  const fetch = createNativeResponseFetch(send, async () => null, jest.fn(), jest.fn());
  await fetch(
    new Request('https://native.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ metadata: { native_predecessor_supersession: { forged: true } } }),
    }),
  );
  expect(JSON.parse(send.mock.calls[0][1]!.body as string).metadata).toEqual({});
});

import { InMemoryJobStore } from '../stream/implementations/InMemoryJobStore';
import { InMemoryEventTransport } from '../stream/implementations/InMemoryEventTransport';
import { GenerationJobManagerClass } from '../stream/GenerationJobManager';
import { admitted } from '../stream/__tests__/nativeResponse.helper';

test('durable claim captures predecessor and requires actual removal acknowledgement', async () => {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({
    jobStore: store,
    eventTransport: new InMemoryEventTransport(),
  });
  manager.initialize();
  try {
    const { identity, job } = await admitted(store, 'old-stream', false);
    expect(await manager.bindNativeResponse(identity)).toBe(true);
    await manager.retainNativeAcceptedSources(identity, sources);
    expect((await store.getJob('old-stream'))?.nativeAcceptedSources).toEqual({
      invocationId: identity.invocationId,
      sources,
    });
    await manager.createJob('new-stream', 'owner', 'conversation', {
      interactionContext: { ...job.interactionContext!, source_event_id: 'new-event' },
    });
    const next = await store.getJob('new-stream');
    expect(next?.nativePredecessor).toEqual({
      streamId: 'old-stream',
      createdAt: job.createdAt,
      responseMessageId: identity.responseMessageId,
      invocationId: identity.invocationId,
    });
    await store.updateJob('new-stream', { responseMessageId: 'new-response' });
    const context = {
      ...identity,
      streamId: 'new-stream',
      jobCreatedAt: next!.createdAt,
      responseMessageId: 'new-response',
      logicalTurnId: next!.interactionContext!.logical_turn_id!,
      revision: next!.interactionContext!.revision,
    };
    expect(await manager.getNativePredecessorSupersession(context, sources)).toBeUndefined();
    await store.updateJob('old-stream', {
      deliveryAcknowledgement: {
        logical_turn_id: identity.logicalTurnId,
        revision: identity.revision,
        state: 'partial_removed',
      },
    });
    expect(await manager.getNativePredecessorSupersession(context, sources)).toMatchObject({
      previous_response_message_id: identity.responseMessageId,
      disposition: 'partial_removed',
    });
    expect(
      await manager.getNativePredecessorSupersession({ ...context, jobCreatedAt: -1 }, sources),
    ).toBeUndefined();
  } finally {
    await manager.destroy();
  }
});
