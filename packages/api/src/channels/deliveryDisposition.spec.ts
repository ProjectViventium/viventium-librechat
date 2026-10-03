import { ChatModelStreamHandler } from '@librechat/agents';
import {
  inspectProviderDeliveryDisposition,
  resolveEffectiveDeliveryDisposition,
  supportsMessagingDeliveryDisposition,
  isAudioDeliveryRequested,
  createDeliveryDispositionStreamHandler,
  getStreamDeliveryDisposition,
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
