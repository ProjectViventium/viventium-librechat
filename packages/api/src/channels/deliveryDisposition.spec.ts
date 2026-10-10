import { ChatModelStreamHandler } from '@librechat/agents';
import {
  inspectProviderDeliveryDisposition,
  resolveEffectiveDeliveryDisposition,
  supportsMessagingDeliveryDisposition,
  isAudioDeliveryRequested,
  createDeliveryDispositionStreamHandler,
  getStreamDeliveryDisposition,
  inspectProviderPublicPartCompletion,
  createReleasedMainPublicPartOwner,
} from './deliveryDisposition';
import {
  createVoiceInteractionContext,
  setTrustedInteractionContext,
} from '../agents/interactionContext';

const modelDisposition = (audio: 'skip' | 'eligible' = 'eligible') => ({
  version: 1 as const,
  audio,
  required: true,
  valid: true,
  source: 'model' as const,
});

describe('messaging delivery disposition', () => {
  it.each([
    [{ _viventiumTelegram: true, body: { telegramAudioRequested: true } }, true],
    [{ body: { telegramAudioRequested: true } }, false],
    [{ body: { voiceMode: true } }, false],
    [
      { viventiumCallSession: { callSessionId: 'synthetic-call' }, body: { voiceMode: true } },
      true,
    ],
    [
      { viventiumCallSession: { callSessionId: 'synthetic-call' }, body: { voiceMode: false } },
      false,
    ],
  ])('uses adapter authority and strict audio flags: %j', (request, expected) => {
    expect(isAudioDeliveryRequested(request)).toBe(expected);
  });

  it('accepts the trusted voice context and excludes its background text requests', () => {
    const request = { body: { voiceMode: true } };
    setTrustedInteractionContext(
      request,
      createVoiceInteractionContext({
        conversation_id: 'synthetic-conversation',
        source_event_id: 'synthetic-event',
      }),
    );
    expect(isAudioDeliveryRequested(request)).toBe(true);
    request.body.voiceMode = false;
    expect(isAudioDeliveryRequested(request)).toBe(false);
  });

  it('validates direct, non-streaming, and streaming provider metadata', () => {
    const skip = modelDisposition('skip');
    const eligible = modelDisposition();
    expect(
      inspectProviderDeliveryDisposition({
        additional_kwargs: {
          provider_specific_fields: { viventium: { delivery_disposition: skip } },
        },
      }),
    ).toEqual({ status: 'valid', disposition: skip });
    expect(
      inspectProviderDeliveryDisposition({
        choices: [
          {
            message: {
              provider_specific_fields: { viventium: { delivery_disposition: eligible } },
            },
            delta: { provider_specific_fields: { viventium: { delivery_disposition: skip } } },
          },
        ],
      }),
    ).toEqual({ status: 'valid', disposition: skip });
  });

  it('distinguishes missing and malformed metadata', () => {
    expect(inspectProviderDeliveryDisposition({ choices: [{ delta: {} }] })).toEqual({
      status: 'missing',
    });
    expect(
      inspectProviderDeliveryDisposition({
        choices: [
          {
            delta: {
              provider_specific_fields: {
                viventium: { delivery_disposition: { ...modelDisposition(), version: 2 } },
              },
            },
          },
        ],
      }),
    ).toEqual({ status: 'malformed' });
  });

  it('resolves legacy precedence and required fail-closed behavior', () => {
    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: true,
        captured: { status: 'valid', disposition: modelDisposition() },
      }),
    ).toMatchObject({ audio: 'skip', source: 'legacy_marker' });
    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: false,
        captured: { status: 'missing' },
      }),
    ).toMatchObject({ audio: 'skip', valid: false, source: 'required_missing' });
  });

  it('recognizes only the exact versioned capability', () => {
    expect(
      supportsMessagingDeliveryDisposition({
        messaging_delivery_disposition: true,
        messaging_delivery_disposition_version: 1,
      }),
    ).toBe(true);
    expect(
      supportsMessagingDeliveryDisposition({
        messaging_delivery_disposition: true,
        messaging_delivery_disposition_version: 2,
      }),
    ).toBe(false);
  });
});


describe('stream disposition ordering', () => {
  const graph = {} as NonNullable<Parameters<ChatModelStreamHandler['handle']>[3]>;
  afterEach(() => jest.restoreAllMocks());

  it.each(['skip', 'eligible'] as const)('carries %s before SDK delta dispatch', async (audio) => {
    const order: string[] = [];
    const metadata = { agentId: 'main' };
    const disposition = modelDisposition(audio);
    jest.spyOn(ChatModelStreamHandler.prototype, 'handle').mockImplementation(
      async (_event, _data, carrier) => {
        order.push('dispatch');
        expect(carrier).not.toBe(metadata);
        expect(getStreamDeliveryDisposition(carrier)).toEqual(disposition);
        expect(carrier?.agentId).toBe('main');
      },
    );
    const handler = createDeliveryDispositionStreamHandler({
      required: () => true,
      beforeHandle: async () => { order.push('chunk'); },
    });
    expect(handler).toBeInstanceOf(ChatModelStreamHandler);
    await handler.handle('on_chat_model_stream', { chunk: {
      content: 'Report ready.',
      additional_kwargs: {
        provider_specific_fields: { viventium: { delivery_disposition: disposition } },
      },
    } }, metadata, graph);
    expect(order).toEqual(['chunk', 'dispatch']);
    expect(getStreamDeliveryDisposition(metadata)).toBeNull();
  });

  it('fails unknown required control closed without copying earlier or adjacent controls', async () => {
    const observed: ReturnType<typeof getStreamDeliveryDisposition>[] = [];
    jest.spyOn(ChatModelStreamHandler.prototype, 'handle').mockImplementation(
      async (_event, _data, metadata) => { observed.push(getStreamDeliveryDisposition(metadata)); },
    );
    const handler = createDeliveryDispositionStreamHandler({
      required: () => true, beforeHandle: async () => undefined,
    });
    const metadata = { agentId: 'main' };
    await handler.handle('', { chunk: { content: 'First.', additional_kwargs: {
      provider_specific_fields: { viventium: { delivery_disposition: modelDisposition() } },
    } } }, metadata, graph);
    await handler.handle('', { chunk: { content: 'Unknown.' } }, metadata, graph);
    await handler.handle('', { chunk: { content: 'Malformed.', additional_kwargs: {
      provider_specific_fields: { viventium: { delivery_disposition: { audio: 'eligible' } } },
    } } }, { agentId: 'adjacent' }, graph);
    expect(observed.map((entry) => [entry?.audio, entry?.source])).toEqual([
      ['eligible', 'model'], ['skip', 'required_missing'], ['skip', 'required_malformed'],
    ]);
  });

  it('preserves legacy and ordinary text metadata unchanged', async () => {
    const metadata = { agentId: 'legacy' };
    jest.spyOn(ChatModelStreamHandler.prototype, 'handle').mockImplementation(
      async (_event, _data, carrier) => {
        expect(carrier).toBe(metadata);
        expect(getStreamDeliveryDisposition(carrier)).toBeNull();
      },
    );
    await createDeliveryDispositionStreamHandler({
      required: () => false, beforeHandle: async () => undefined,
    }).handle('', { chunk: { content: 'Legacy.' } }, metadata, graph);
  });
});


/* === VIVENTIUM START === Public completion is bound, ordered, and separate from text. === */
describe('public part completion carrier', () => {
  const completion = {
    version: 1,
    complete: true,
    request_id: 'request-a',
    run_id: 'run-a',
    part_id: 'run-a:0',
    message_id: 'answer-a',
    stream_id: 'stream-a',
  };
  const rawChunk = (content = '', marker = completion) => ({
    id: 'request-a',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: {
          content,
          provider_specific_fields: {
            viventium: {
              public_part_complete: marker,
              delivery_disposition: modelDisposition(),
            },
          },
        },
        finish_reason: null,
      },
    ],
  });
  const wrappedChunk = (content = '') => ({
    content,
    additional_kwargs: {
      __raw_response: rawChunk(content),
    },
  });
  it.each(['', '<emphasis>Cobalt blue.</emphasis>'])(
    'keeps completion-only and complete text: %s',
    (text) => {
      expect(inspectProviderPublicPartCompletion(rawChunk(text))).toEqual(completion);
      expect(inspectProviderPublicPartCompletion(wrappedChunk(text))).toEqual(completion);
    },
  );
  it.each([
    { complete: false },
    { version: 2 },
    { request_id: 'request-other' },
    { run_id: 'run-other' },
    { part_id: 'run-a:01' },
    { part_id: 'run-a:-1' },
    { part_id: 'run-a:NaN' },
    { part_id: 'run-a:1.5' },
    { message_id: '' },
    { stream_id: '' },
    { text: 'Not control data.' },
  ])('rejects malformed or foreign markers: %j', (changes) => {
    expect(
      inspectProviderPublicPartCompletion(rawChunk('', { ...completion, ...changes })),
    ).toBeNull();
  });
  it.each([
    'tool_calls',
    'tool_call_chunks',
    'function_call',
    'reasoning_content',
    'reasoning',
    'thinking',
    'error',
  ])('rejects non-public envelopes: %s', (key) => {
    const raw = rawChunk('');
    Object.assign(raw.choices[0].delta, { [key]: key.startsWith('tool_') ? [{}] : {} });
    expect(inspectProviderPublicPartCompletion(raw)).toBeNull();
  });
  it('rejects conflicting metadata and failed terminal output', () => {
    const chunk = wrappedChunk();
    Object.assign(chunk.additional_kwargs, {
      provider_specific_fields: {
        viventium: {
          public_part_complete: { ...completion, part_id: 'run-a:1' },
        },
      },
    });
    expect(inspectProviderPublicPartCompletion(chunk)).toBeNull();
    const raw = rawChunk();
    Object.assign(raw.choices[0], { finish_reason: 'length' });
    expect(inspectProviderPublicPartCompletion(raw)).toBeNull();
  });
  it.each(['', 'Complete.'])(
    'runs completion after awaited SDK delivery, including empty chunks: %s',
    async (text) => {
      const order: string[] = [];
      jest.spyOn(ChatModelStreamHandler.prototype, 'handle').mockImplementation(async () => {
        await Promise.resolve();
        order.push('sdk-return');
      });
      const handler = createDeliveryDispositionStreamHandler({
        required: () => true,
        beforeHandle: async () => {
          order.push('before');
        },
        afterHandle: async (_event, data, metadata) => {
          expect(inspectProviderPublicPartCompletion(data.chunk)).toEqual(completion);
          expect(getStreamDeliveryDisposition(metadata)).toEqual(modelDisposition());
          order.push('completion');
        },
      });
      const raw = rawChunk(text);
      await handler.handle(
        '',
        {
          chunk: {
            content: text,
            additional_kwargs: {
              __raw_response: raw,
            },
          },
        },
        { agentId: 'main' },
        {} as NonNullable<Parameters<ChatModelStreamHandler['handle']>[3]>,
      );
      expect(order).toEqual(['before', 'sdk-return', 'completion']);
    },
  );
  it('cannot report success after a failed SDK delivery', async () => {
    jest
      .spyOn(ChatModelStreamHandler.prototype, 'handle')
      .mockRejectedValue(new Error('delivery failed'));
    const afterHandle = jest.fn();
    const handler = createDeliveryDispositionStreamHandler({
      required: () => true,
      beforeHandle: async () => undefined,
      afterHandle,
    });
    await expect(
      handler.handle(
        '',
        { chunk: wrappedChunk('Complete.') },
        {},
        {} as NonNullable<Parameters<ChatModelStreamHandler['handle']>[3]>,
      ),
    ).rejects.toThrow('delivery failed');
    expect(afterHandle).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Canonical unsupported state is distinct from Core completion. === */
describe('released Main public-part canonical source', () => {
  const identity = {
    userId: 'owner',
    conversationId: 'conversation',
    responseMessageId: 'answer',
    streamId: 'stream',
    jobCreatedAt: 1,
    logicalTurnId: 'turn',
    revision: 1,
    invocationId: 'invocation',
    providerId: 'provider',
    agentId: 'agent',
    bodySha256: 'a'.repeat(64),
    originSha256: 'a'.repeat(64),
    source: { id: 'source-db', messageId: 'question', digest: 'a'.repeat(64) },
    admittedAt: 1,
    recoverUntil: 86_400_001,
  };
  it.each([
    'real_release',
    'cancelled',
    'pending',
    'foreign_identity',
    'foreign_owner',
    'deleted',
    'changed_source',
  ])('validates %s', async (kind) => {
    const row = {
      user: 'owner',
      conversationId: 'conversation',
      messageId: 'answer',
      parentMessageId: 'question',
      isCreatedByUser: false,
      unfinished: false,
      error: true,
      nativeResponse: { ...identity, status: 'unsupported' },
      deletedAt: undefined as Date | undefined,
    };
    if (kind === 'cancelled') row.nativeResponse.status = 'cancelled';
    if (kind === 'pending') row.nativeResponse.status = 'pending';
    if (kind === 'foreign_identity') row.nativeResponse.invocationId = 'foreign';
    if (kind === 'foreign_owner') row.user = 'foreign';
    if (kind === 'deleted') row.deletedAt = new Date();
    const db = {
      getNativeResponse: jest.fn(async () => row as never),
      nativeResponseSourceMatches: jest.fn(async () => kind !== 'changed_source'),
    };
    const owner = createReleasedMainPublicPartOwner(identity, db);
    expect(await owner.verifySource()).toBe(kind === 'real_release');
    if (kind === 'real_release')
      expect(db.nativeResponseSourceMatches).toHaveBeenCalledWith(identity);
  });
});
/* === VIVENTIUM END === */
