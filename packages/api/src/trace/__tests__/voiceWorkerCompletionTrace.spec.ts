import {
  buildVoiceWorkerCompletionPresentation,
  verifyVoiceWorkerCompletionPresentation,
} from '../voiceWorkerCompletionTrace';

const terminalBinding = (suffix: string) => ({
  originRef: `origin-${suffix}`,
  workRef: `work-${suffix}`,
  workerId: `worker-${suffix}`,
  runId: `run-${suffix}`,
  callbackRef: `callback_sha256:${suffix.repeat(64)}`,
  attemptNumber: 1,
  resultKey: `ghtr_${suffix.repeat(64)}`,
  acceptedOperationId: suffix.repeat(32),
  terminalCallbackId: `cb_terminal_${suffix.repeat(64)}`,
  resultDigest: `sha256:${suffix.repeat(64)}`,
  resultRevision: 1,
  effectGeneration: 1,
});

describe('Voice worker-completion presentation', () => {
  test('binds one coalesced Main response to every exact terminal Worker result', () => {
    const presentation = buildVoiceWorkerCompletionPresentation({
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      callSessionId: 'call-2',
      responseMessageId: 'main-follow-up-1',
      responseText: 'Both requested Workers completed.',
      bindings: [terminalBinding('b'), terminalBinding('a')],
    });

    expect(presentation.bindings.map((binding) => binding.workRef)).toEqual(['work-a', 'work-b']);
    expect(presentation.presentationRef).toMatch(/^voice_worker_completion_[a-f0-9]{64}$/);
    expect(presentation.turnId).toMatch(/^voice_worker_completion_turn_[a-f0-9]{64}$/);
    expect(presentation.responseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      verifyVoiceWorkerCompletionPresentation(presentation, {
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        callSessionId: 'call-2',
        responseMessageId: 'main-follow-up-1',
        responseText: 'Both requested Workers completed.',
      }),
    ).toBe(true);
  });

  test.each([
    ['substituted response', { responseText: 'A substituted response.' }],
    ['wrong call', { callSessionId: 'call-other' }],
  ])('rejects %s', (_label, authorityOverride) => {
    const authority = {
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      callSessionId: 'call-2',
      responseMessageId: 'main-follow-up-1',
      responseText: 'Both requested Workers completed.',
    };
    const presentation = buildVoiceWorkerCompletionPresentation({
      ...authority,
      bindings: [terminalBinding('a'), terminalBinding('b')],
    });

    expect(
      verifyVoiceWorkerCompletionPresentation(presentation, {
        ...authority,
        ...authorityOverride,
      }),
    ).toBe(false);
  });

  test('rejects duplicate or mixed terminal bindings', () => {
    expect(() =>
      buildVoiceWorkerCompletionPresentation({
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        callSessionId: 'call-2',
        responseMessageId: 'main-follow-up-1',
        responseText: 'One response.',
        bindings: [terminalBinding('a'), terminalBinding('a')],
      }),
    ).toThrow('voice_worker_completion_binding_duplicate');
  });
});
