const { isVoiceActorSideEffectRestricted } = require('../VoiceActorAuthorityService');

describe('VoiceActorAuthorityService', () => {
  test('fails closed when an authenticated call request omits client authority markers', () => {
    expect(
      isVoiceActorSideEffectRestricted({
        viventiumCallSession: { callSessionId: 'call-synthetic' },
        body: {},
      }),
    ).toBe(true);
  });

  test('allows only an exact owner-authoritative call turn', () => {
    expect(
      isVoiceActorSideEffectRestricted({
        viventiumCallSession: { callSessionId: 'call-synthetic' },
        body: {
          viventiumActorTrust: 'owner_participant',
          viventiumCanAuthorizeSideEffects: true,
        },
      }),
    ).toBe(false);
  });

  test('does not reinterpret an ordinary non-voice request', () => {
    expect(isVoiceActorSideEffectRestricted({ body: {} })).toBe(false);
  });
});
