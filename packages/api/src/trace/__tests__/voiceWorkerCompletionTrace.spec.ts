import mongoose from 'mongoose';
import type { VoiceWorkerCompletionPresentationV1 } from '../voiceWorkerCompletionTrace';

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

describe('accepted nonterminal Worker attention presentation', () => {
  const authority = {
    ownerId: 'owner-1',
    conversationId: 'conversation-1',
    callSessionId: 'call-1',
    responseMessageId: 'main-question',
    responseText: 'May I renew the access needed to continue?',
  };
  const binding = {
    kind: 'nonterminal_attention' as const,
    originRef: 'origin-1',
    workRef: 'work-1',
    workerId: 'worker-1',
    runId: 'run-1',
    callbackRef: 'callback_sha256:' + 'a'.repeat(64),
    event: 'run.needs_input' as const,
    workTerminal: false as const,
    evidenceId: 'ghe_' + 'b'.repeat(32),
  };
  test('binds Main response without inventing an attempt, terminal result or operation', () => {
    const presentation = buildVoiceWorkerCompletionPresentation({
      ...authority,
      bindings: [binding],
    });
    expect(presentation.bindings).toEqual([binding]);
    expect(verifyVoiceWorkerCompletionPresentation(presentation, authority)).toBe(true);
    expect(
      verifyVoiceWorkerCompletionPresentation(presentation, { ...authority, ownerId: 'foreign' }),
    ).toBe(false);
  });
  test.each([
    { event: 'run.completed' },
    { workTerminal: true },
    { evidenceId: 'invalid' },
    { attemptNumber: 1 },
    { resultKey: 'ghtr_' + 'a'.repeat(64) },
  ])('rejects unsupported attention structure %p', (change) => {
    expect(() =>
      buildVoiceWorkerCompletionPresentation({
        ...authority,
        bindings: [{ ...binding, ...change } as typeof binding],
      }),
    ).toThrow('voice_worker_completion_binding_invalid');
  });
  test('rejects duplicate attention for one accepted work', () => {
    expect(() =>
      buildVoiceWorkerCompletionPresentation({ ...authority, bindings: [binding, binding] }),
    ).toThrow('voice_worker_completion_binding_duplicate');
  });
});

describe('persisted Worker presentation verification', () => {
  const authority = {
    ownerId: 'owner-1',
    conversationId: 'conversation-1',
    callSessionId: 'call-1',
    responseMessageId: 'main-follow-up',
    responseText: 'The requested work needs your input.',
  };
  const attention = {
    kind: 'nonterminal_attention' as const,
    originRef: 'origin-c',
    workRef: 'work-c',
    workerId: 'worker-c',
    runId: 'run-c',
    callbackRef: 'callback_sha256:' + 'c'.repeat(64),
    event: 'run.needs_input' as const,
    workTerminal: false as const,
    evidenceId: 'ghe_' + 'c'.repeat(32),
  };
  const connection = mongoose.createConnection();
  const Model = require('../../../../../api/db/viventiumGlassHiveCallbackDelivery')(connection);
  const presentation = () =>
    buildVoiceWorkerCompletionPresentation({
      ...authority,
      bindings: [terminalBinding('a'), attention],
    });
  const persisted = () =>
    new Model({
      workerCompletionPresentation: presentation(),
    }).workerCompletionPresentation.toObject() as VoiceWorkerCompletionPresentationV1;

  test('accepts the actual Mongoose attention binding order after persistence', () => {
    const stored = persisted();
    expect(Object.keys(stored.bindings[1])).not.toEqual(Object.keys(presentation().bindings[1]));
    expect(stored).toEqual(presentation());
    expect(verifyVoiceWorkerCompletionPresentation(stored, authority)).toBe(true);
  });

  test('accepts reordered terminal binding and presentation object fields', () => {
    const built = presentation();
    const reorder = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    const reordered = { ...reorder(built), bindings: built.bindings.map(reorder) };
    expect(verifyVoiceWorkerCompletionPresentation(reordered, authority)).toBe(true);
  });

  test.each(['presentationRef', 'turnId', 'responseMessageId', 'responseDigest'] as const)(
    'rejects changed presentation identity %s',
    (key) => {
      const stored = persisted();
      expect(
        verifyVoiceWorkerCompletionPresentation(
          { ...stored, [key]: stored[key] + '-changed' },
          authority,
        ),
      ).toBe(false);
    },
  );

  test.each(['originRef', 'workRef', 'workerId', 'runId', 'callbackRef', 'evidenceId'] as const)(
    'rejects changed persisted attention identity %s',
    (key) => {
      const stored = persisted();
      const changed = { ...stored.bindings[1], [key]: 'changed' };
      expect(
        verifyVoiceWorkerCompletionPresentation(
          { ...stored, bindings: [stored.bindings[0], changed] },
          authority,
        ),
      ).toBe(false);
    },
  );

  test('rejects changed persisted terminal result identity', () => {
    const stored = persisted();
    expect(
      verifyVoiceWorkerCompletionPresentation(
        {
          ...stored,
          bindings: [
            { ...stored.bindings[0], resultDigest: 'sha256:' + 'd'.repeat(64) },
            stored.bindings[1],
          ],
        },
        authority,
      ),
    ).toBe(false);
  });

  test('rejects unknown presentation and binding fields after persistence', () => {
    const stored = persisted();
    expect(
      verifyVoiceWorkerCompletionPresentation(
        { ...stored, extra: true } as VoiceWorkerCompletionPresentationV1,
        authority,
      ),
    ).toBe(false);
    expect(
      verifyVoiceWorkerCompletionPresentation(
        {
          ...stored,
          bindings: [stored.bindings[0], { ...stored.bindings[1], extra: true }],
        } as VoiceWorkerCompletionPresentationV1,
        authority,
      ),
    ).toBe(false);
  });

  test('rejects changed binding array order and duplicate bindings', () => {
    const stored = persisted();
    expect(
      verifyVoiceWorkerCompletionPresentation(
        { ...stored, bindings: [...stored.bindings].reverse() },
        authority,
      ),
    ).toBe(false);
    expect(
      verifyVoiceWorkerCompletionPresentation(
        { ...stored, bindings: [stored.bindings[0], stored.bindings[0]] },
        authority,
      ),
    ).toBe(false);
  });
});
