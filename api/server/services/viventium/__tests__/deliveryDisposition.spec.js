'use strict';

const {
  captureFinalModelDeliveryDisposition,
  getDeliveryDispositionCapture,
  inspectProviderDeliveryDisposition,
  resetDeliveryDispositionCapture,
  resolveEffectiveDeliveryDisposition,
} = require('../deliveryDisposition');

const modelDisposition = (audio = 'eligible') => ({
  version: 1,
  audio,
  required: true,
  valid: true,
  source: 'model',
});

const capableTelegramRequest = () => ({
  _viventiumTelegram: true,
  body: { telegramAudioRequested: true },
  config: {
    endpoints: {
      agents: {
        providerCapabilities: {
          harness: {
            messaging_delivery_disposition: true,
            messaging_delivery_disposition_version: 1,
          },
        },
      },
    },
  },
});

const streamOutput = (disposition) => ({
  content: 'Visible answer.',
  additional_kwargs: {
    __raw_response: {
      choices: [
        {
          index: 0,
          delta: {
            provider_specific_fields: {
              viventium: { delivery_disposition: disposition },
            },
          },
        },
      ],
    },
  },
});

describe('structured messaging delivery disposition', () => {
  it('accepts the exact versioned non-streaming and streaming provider contracts', () => {
    const nonStreaming = inspectProviderDeliveryDisposition({
      choices: [
        {
          message: {
            provider_specific_fields: {
              viventium: { delivery_disposition: modelDisposition('skip') },
            },
          },
        },
      ],
    });
    const streaming = inspectProviderDeliveryDisposition(streamOutput(modelDisposition()));

    expect(nonStreaming).toEqual({ status: 'valid', disposition: modelDisposition('skip') });
    expect(streaming).toEqual({ status: 'valid', disposition: modelDisposition('eligible') });
  });

  it('accepts the direct additional_kwargs shape emitted by the LibreChat OpenAI converter', () => {
    expect(
      inspectProviderDeliveryDisposition({
        content: 'Visible answer.',
        additional_kwargs: {
          provider_specific_fields: {
            viventium: { delivery_disposition: modelDisposition('skip') },
          },
        },
      }),
    ).toEqual({ status: 'valid', disposition: modelDisposition('skip') });
  });

  it.each([
    ['wrong version', { ...modelDisposition(), version: 2 }],
    ['unknown audio value', { ...modelDisposition(), audio: 'speak' }],
    ['non-required output', { ...modelDisposition(), required: false }],
    ['provider-declared invalid output', { ...modelDisposition(), valid: false }],
    ['unknown source', { ...modelDisposition(), source: 'runtime_guess' }],
    ['extra fields', { ...modelDisposition(), rationale: 'private reasoning' }],
  ])('rejects malformed required output: %s', (_label, disposition) => {
    expect(inspectProviderDeliveryDisposition(streamOutput(disposition))).toEqual({
      status: 'malformed',
    });
  });

  it('distinguishes missing output from a malformed present field', () => {
    expect(
      inspectProviderDeliveryDisposition({
        additional_kwargs: { __raw_response: { choices: [{ delta: {} }] } },
      }),
    ).toEqual({ status: 'missing' });
    expect(inspectProviderDeliveryDisposition(streamOutput(null))).toEqual({
      status: 'malformed',
    });
  });

  it('gives a valid structured skip precedence over a conflicting eligible candidate', () => {
    expect(
      inspectProviderDeliveryDisposition({
        choices: [
          {
            message: {
              provider_specific_fields: {
                viventium: { delivery_disposition: modelDisposition('eligible') },
              },
            },
            delta: {
              provider_specific_fields: {
                viventium: { delivery_disposition: modelDisposition('skip') },
              },
            },
          },
        ],
      }),
    ).toEqual({ status: 'valid', disposition: modelDisposition('skip') });
  });

  it('captures only the final non-tool model result and lets the final handoff win', () => {
    const req = capableTelegramRequest();
    resetDeliveryDispositionCapture(req);

    captureFinalModelDeliveryDisposition({
      req,
      output: streamOutput(modelDisposition('eligible')),
      capabilityOwner: 'harness',
    });
    expect(getDeliveryDispositionCapture(req)).toEqual({
      status: 'valid',
      disposition: modelDisposition('eligible'),
    });

    captureFinalModelDeliveryDisposition({
      req,
      output: {
        ...streamOutput(modelDisposition('eligible')),
        tool_calls: [{ id: 'handoff-1' }],
      },
      capabilityOwner: 'harness',
    });
    expect(getDeliveryDispositionCapture(req)).toEqual({
      status: 'valid',
      disposition: modelDisposition('eligible'),
    });

    captureFinalModelDeliveryDisposition({
      req,
      output: streamOutput(modelDisposition('skip')),
      capabilityOwner: 'harness',
    });
    expect(getDeliveryDispositionCapture(req)).toEqual({
      status: 'valid',
      disposition: modelDisposition('skip'),
    });
    expect(req._viventiumDeliveryDispositionRequired).toBe(true);
  });

  it('activates capture when the winning fallback is capable even if the initial route was not', () => {
    const req = capableTelegramRequest();
    req._viventiumDeliveryDispositionRequired = false;

    captureFinalModelDeliveryDisposition({
      req,
      output: streamOutput(modelDisposition('skip')),
      capabilityOwner: 'harness',
    });

    expect(req._viventiumDeliveryDispositionRequired).toBe(true);
    expect(getDeliveryDispositionCapture(req)).toEqual({
      status: 'valid',
      disposition: modelDisposition('skip'),
    });
  });

  it('does not trust delivery metadata from a provider without the compiled capability', () => {
    const req = capableTelegramRequest();

    captureFinalModelDeliveryDisposition({
      req,
      output: streamOutput(modelDisposition('skip')),
      capabilityOwner: 'legacy',
    });

    expect(req._viventiumDeliveryDispositionRequired).toBeUndefined();
    expect(getDeliveryDispositionCapture(req)).toEqual({ status: 'missing' });
  });

  it('invalidates an earlier required capture when the final non-tool provider is not capable', () => {
    const req = capableTelegramRequest();

    captureFinalModelDeliveryDisposition({
      req,
      output: streamOutput(modelDisposition('eligible')),
      capabilityOwner: 'harness',
    });
    expect(getDeliveryDispositionCapture(req)).toEqual({
      status: 'valid',
      disposition: modelDisposition('eligible'),
    });

    captureFinalModelDeliveryDisposition({
      req,
      output: { content: 'Final answer from a legacy provider.' },
      capabilityOwner: 'legacy',
    });

    expect(req._viventiumDeliveryDispositionRequired).toBe(true);
    expect(getDeliveryDispositionCapture(req)).toEqual({ status: 'missing' });
  });

  it('applies legacy, structured, and fail-closed precedence without intent inference', () => {
    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: true,
        captured: { status: 'valid', disposition: modelDisposition('eligible') },
      }),
    ).toEqual({
      version: 1,
      audio: 'skip',
      required: true,
      valid: true,
      source: 'legacy_marker',
    });

    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: false,
        captured: { status: 'valid', disposition: modelDisposition('eligible') },
      }),
    ).toEqual(modelDisposition('eligible'));

    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: false,
        captured: { status: 'missing' },
      }),
    ).toEqual({
      version: 1,
      audio: 'skip',
      required: true,
      valid: false,
      source: 'required_missing',
    });

    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: true,
        legacySkipVoice: false,
        captured: { status: 'malformed' },
      }),
    ).toEqual({
      version: 1,
      audio: 'skip',
      required: true,
      valid: false,
      source: 'required_malformed',
    });

    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: false,
        legacySkipVoice: false,
        captured: { status: 'valid', disposition: modelDisposition('eligible') },
      }),
    ).toBeNull();
  });

  it('keeps legacy skip behavior for non-required requests', () => {
    expect(
      resolveEffectiveDeliveryDisposition({
        audioEligible: false,
        legacySkipVoice: true,
        captured: { status: 'missing' },
      }),
    ).toEqual({
      version: 1,
      audio: 'skip',
      required: false,
      valid: true,
      source: 'legacy_marker',
    });
  });
});
