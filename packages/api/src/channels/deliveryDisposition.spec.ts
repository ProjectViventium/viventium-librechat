import {
  inspectProviderDeliveryDisposition,
  resolveEffectiveDeliveryDisposition,
  supportsMessagingDeliveryDisposition,
} from './deliveryDisposition';

const modelDisposition = (audio: 'skip' | 'eligible' = 'eligible') => ({
  version: 1 as const,
  audio,
  required: true,
  valid: true,
  source: 'model' as const,
});

describe('messaging delivery disposition', () => {
  it('validates direct, non-streaming, and streaming provider metadata', () => {
    const skip = modelDisposition('skip');
    const eligible = modelDisposition();
    expect(
      inspectProviderDeliveryDisposition({
        additional_kwargs: { provider_specific_fields: { viventium: { delivery_disposition: skip } } },
      }),
    ).toEqual({ status: 'valid', disposition: skip });
    expect(
      inspectProviderDeliveryDisposition({
        choices: [
          {
            message: { provider_specific_fields: { viventium: { delivery_disposition: eligible } } },
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
