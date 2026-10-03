jest.mock('../GlassHiveConversationProviderService', () => ({
  restrictedConversationProviderBootstrapHeaders: jest.fn(() => ({
    'X-GlassHive-Bootstrap-Bundle-B64': Buffer.from(
      JSON.stringify({ provider_capabilities: { native_tools: false } }),
    ).toString('base64'),
    'X-GlassHive-Bootstrap-Timestamp': '123',
    'X-GlassHive-Bootstrap-Signature': 'synthetic-signature',
  })),
}));
const {
  restrictedConversationProviderBootstrapHeaders,
} = require('../GlassHiveConversationProviderService');
const {
  isVoiceActorSideEffectRestricted,
  sanitizeAgentForRestrictedVoiceTurn,
} = require('../VoiceActorAuthorityService');

describe('VoiceActorAuthorityService', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each(['defaultHeaders', 'configuration.defaultHeaders', 'configuration.headers'])(
    'retains only Core courier fields and a signed restriction through repeated sanitation at %s',
    (placement) => {
      const headers = {
        'X-GlassHive-Agent-Id': 'synthetic-main',
        'X-GlassHive-Turn-Context-B64': '{{LIBRECHAT_BODY_VIVENTIUMGLASSHIVETURNCONTEXTB64}}',
        'X-GlassHive-Access': 'full',
        'X-GlassHive-Workspace-Mode': 'custom',
        'X-GlassHive-Workspace-Path-B64': 'c3ludGhldGlj',
        'X-GlassHive-Fallback-Model': 'synthetic-fallback',
        'X-GlassHive-Fallback-Reasoning-Effort': 'high',
        'X-GlassHive-Capability-Broker-Token': 'synthetic-old-grant',
        'X-GlassHive-Bootstrap-Bundle-B64': 'synthetic-old-bundle',
        'X-GlassHive-Bootstrap-Timestamp': 'synthetic-old-time',
        'X-GlassHive-Bootstrap-Signature': 'synthetic-old-signature',
        'X-GlassHive-Idempotency-Key': 'synthetic-old-invocation',
        'X-GlassHive-Stable-Authority-SHA256': 'synthetic-old-authority',
        'X-GlassHive-Developer-Instruction-Tail-B64': 'synthetic-old-tail',
        'X-GlassHive-Unrecognized-Grant': 'synthetic-old-capability',
        'x-glasshive-agent-id': 'synthetic-noncanonical-id',
        'x-glasshive-turn-context-b64': 'synthetic-noncanonical-context',
        'X-Viventium-Audio-Eligible': 'true',
        Authorization: 'Bearer synthetic-transport',
      };
      const [outer, inner] = placement.split('.');
      const modelParameters = inner ? { [outer]: { [inner]: headers } } : { [outer]: headers };
      const agent = { model_parameters: modelParameters, tools: ['synthetic-tool'] };
      const sanitized = sanitizeAgentForRestrictedVoiceTurn(agent);
      const repeated = sanitizeAgentForRestrictedVoiceTurn(sanitized);
      const finalHeaders = inner
        ? repeated.model_parameters[outer][inner]
        : repeated.model_parameters[outer];
      expect(finalHeaders).toEqual({
        Authorization: headers.Authorization,
        'X-Viventium-Audio-Eligible': 'true',
        'X-GlassHive-Agent-Id': headers['X-GlassHive-Agent-Id'],
        'X-GlassHive-Turn-Context-B64': headers['X-GlassHive-Turn-Context-B64'],
        ...restrictedConversationProviderBootstrapHeaders(),
      });
      // Native dispatch checks the canonical own key; header aliases cannot substitute for it.
      expect(Boolean(finalHeaders['X-GlassHive-Agent-Id'])).toBe(true);
      expect(
        JSON.parse(Buffer.from(finalHeaders['X-GlassHive-Bootstrap-Bundle-B64'], 'base64')),
      ).toEqual({
        provider_capabilities: { native_tools: false },
      });
      expect(repeated.tools).toEqual([]);
      expect(agent.model_parameters).toEqual(modelParameters);
      expect(headers['X-GlassHive-Access']).toBe('full');
    },
  );

  test('does not promote noncanonical header aliases into Core courier identity', () => {
    const agent = {
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'x-glasshive-agent-id': 'synthetic-noncanonical',
            'x-glasshive-turn-context-b64': 'synthetic-noncanonical-context',
          },
        },
      },
    };
    const sanitized = sanitizeAgentForRestrictedVoiceTurn(agent);
    expect(sanitized.model_parameters.configuration.defaultHeaders).toEqual(
      restrictedConversationProviderBootstrapHeaders(),
    );
  });

  test('leaves ordinary provider headers intact without native projection', () => {
    const agent = {
      model_parameters: { configuration: { defaultHeaders: { Authorization: 'synthetic' } } },
    };
    expect(sanitizeAgentForRestrictedVoiceTurn(agent).model_parameters).toEqual(
      agent.model_parameters,
    );
    expect(restrictedConversationProviderBootstrapHeaders).not.toHaveBeenCalled();
  });

  test('fails before provider invocation when the native restriction cannot be signed', () => {
    restrictedConversationProviderBootstrapHeaders.mockImplementationOnce(() => {
      throw new Error('Synthetic signing unavailable');
    });
    expect(() =>
      sanitizeAgentForRestrictedVoiceTurn({
        model_parameters: {
          configuration: { defaultHeaders: { 'X-GlassHive-Agent-Id': 'synthetic' } },
        },
      }),
    ).toThrow('signing unavailable');
  });

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
