import { bindCurrentCallContext, getCurrentCallContext } from './callContext';

describe('current Call data context', () => {
  const request = () => ({
    user: { id: 'owner' }, body: { voiceMode: true },
    viventiumCallSession: {
      callSessionId: 'call-owned', userId: 'owner', agentId: 'agent-main', mode: 'call',
      requestedVoiceRoute: {
        stt: { provider: 'pywhispercpp', variant: 'large-v3-turbo' },
        tts: { provider: 'local_chatterbox_turbo_mlx_8bit', variant: 'mlx-community/chatterbox-turbo-8bit' },
      },
    },
  });
  const gateway = () => ({
    version: 1 as const, callSessionId: 'call-owned', readyRoute: request().viventiumCallSession.requestedVoiceRoute,
    configuredTtsFallback: 'cartesia',
    turnHandling: { turnDetection: 'vad', minEndpointingDelayS: 0.3, maxEndpointingDelayS: 0.8,
      minInterruptionDurationS: 0.5, minInterruptionWords: 0 },
  });
  const facts = (req: ReturnType<typeof request>) => JSON.parse(getCurrentCallContext(req)
    .replace('<viventium_current_call_v1>', '').replace('</viventium_current_call_v1>', ''));

  test('pins requested and initialized route facts without claiming actual playback or profile defaults', () => {
    const req = request();
    expect(bindCurrentCallContext(req, gateway())).toBe(true);
    expect(facts(req)).toEqual({
      version: 1, callSessionId: 'call-owned', agentId: 'agent-main', mode: 'call',
      requestedRoute: req.viventiumCallSession.requestedVoiceRoute,
      gatewayReadyRoute: req.viventiumCallSession.requestedVoiceRoute,
      configuredTtsFallback: 'cartesia', turnHandling: gateway().turnHandling,
      actualPlaybackRoute: null,
    });
    req.viventiumCallSession.requestedVoiceRoute.tts.provider = 'xai';
    expect(bindCurrentCallContext(req, { ...gateway(), configuredTtsFallback: 'openai' })).toBe(true);
    expect(facts(req).requestedRoute.tts.provider).toBe('local_chatterbox_turbo_mlx_8bit');
  });

  test.each([undefined, { ...gateway(), callSessionId: 'foreign-call' }, { ...gateway(), version: 2 }])(
    'missing, stale or foreign ready evidence leaves readiness unknown', (value) => {
      const req = request();
      // Exercise the JS ingress boundary with an invalid version as well as valid typed facts.
      expect(bindCurrentCallContext(req, value as ReturnType<typeof gateway>)).toBe(true);
      expect(facts(req).requestedRoute.tts.provider).toBe('local_chatterbox_turbo_mlx_8bit');
      expect(facts(req).gatewayReadyRoute).toBeNull();
      expect(facts(req).configuredTtsFallback).toBeNull();
    },
  );

  test('whitelists facts and refuses source text, credentials, permissions and invalid identifiers', () => {
    const req = request();
    const value = { ...gateway(), apiKey: 'synthetic-secret', authorizeTools: true,
      prompt: 'Invented instructions', actualPlaybackRoute: { provider: 'xai' },
      configuredTtsFallback: '<secret>', turnHandling: { ...gateway().turnHandling,
        minEndpointingDelayS: Infinity, maxEndpointingDelayS: -1, minInterruptionWords: 2.5 } };
    bindCurrentCallContext(req, value);
    const text = getCurrentCallContext(req);
    expect(text).not.toMatch(/synthetic-secret|authorizeTools|Invented instructions|<secret>/);
    expect(facts(req).actualPlaybackRoute).toBeNull();
    expect(facts(req).configuredTtsFallback).toBeNull();
    expect(facts(req).turnHandling).toMatchObject({ minEndpointingDelayS: null,
      maxEndpointingDelayS: null, minInterruptionWords: null });
  });

  test.each(['foreign-owner', 'text', 'no-session'])('does not admit %s', (boundary) => {
    const req = request();
    if (boundary === 'foreign-owner') req.user.id = 'foreign';
    if (boundary === 'text') req.body.voiceMode = false;
    if (boundary === 'no-session') delete (req as { viventiumCallSession?: object }).viventiumCallSession;
    expect(bindCurrentCallContext(req, gateway())).toBe(false);
    expect(getCurrentCallContext(req)).toBe('');
  });

  test('body-carried copies cannot forge the admitted request context', () => {
    const req = request();
    bindCurrentCallContext(req, gateway());
    const forged = { ...req, body: { ...req.body,
      currentCallContext: getCurrentCallContext(req), _viventiumCurrentCallContextV1: 'forged' } };
    expect(getCurrentCallContext(forged)).toBe('');
  });
});
