/* === VIVENTIUM START === Typed orchestration trace hook projection tests. === VIVENTIUM END === */

import {
  buildCallbackTraceEvents,
  buildDeliveryTraceEvent,
  buildLaunchTraceEvents,
  canonicalizeGlassHiveCallbackRef,
} from '../orchestrationTraceHooks';

describe('orchestration trace hook projection', () => {
  test('projects launch identity and valid prompt telemetry without raw payload fields', () => {
    const events = buildLaunchTraceEvents({
      originRef: 'private-origin',
      sourceEventRef: 'private-source',
      logicalTurnRef: 'private-turn',
      promptLayers: { contractVersion: 1, unknownLayerNames: [] },
    });

    expect(events.map((event) => event.stage)).toEqual([
      'source.bound',
      'prompt.layers.verified',
      'launch.prepared',
    ]);
    expect(JSON.stringify(events)).not.toContain('promptText');
  });

  test('marks malformed prompt-layer telemetry invalid without retaining names', () => {
    const events = buildLaunchTraceEvents({
      originRef: 'private-origin',
      sourceEventRef: 'private-source',
      promptLayers: { contractVersion: 1, unknownLayerNames: ['bad layer text'] },
    });
    const prompt = events.find((event) => event.stage === 'prompt.layers.invalid');

    expect(prompt).toMatchObject({ facts: { unknownPromptLayerCount: 1 } });
    expect(JSON.stringify(prompt)).not.toContain('bad layer text');
  });

  test('projects terminal callback identity but does not invent absent attempt or capacity history', () => {
    const callbackRef = canonicalizeGlassHiveCallbackRef('private-callback');
    const events = buildCallbackTraceEvents({
      workRef: 'private-work',
      runRef: 'private-run',
      callbackRef,
      event: 'run.completed',
      workState: 'completed',
      workTerminal: true,
      callbackAt: '2026-08-22T12:00:00.000Z',
      callbackAcceptedAt: '2026-08-22T12:00:00.100Z',
      attemptNumber: 1,
    });

    expect(events.map((event) => event.stage)).toEqual(['work.completed', 'callback.accepted']);
    expect(events.map((event) => event.at)).toEqual([
      '2026-08-22T12:00:00.000Z',
      '2026-08-22T12:00:00.100Z',
    ]);
    expect(events.some((event) => event.stage === 'attempt.history.complete')).toBe(false);
    expect(events.some((event) => event.stage === 'capacity.history.complete')).toBe(false);
  });

  test('does not accept callback-body booleans as history evidence', () => {
    const callbackRef = canonicalizeGlassHiveCallbackRef('private-callback');
    const events = buildCallbackTraceEvents({
      workRef: 'private-work',
      runRef: 'private-run',
      callbackRef,
      event: 'run.started',
      workState: 'running',
      workTerminal: false,
      attemptNumber: 2,
      traceability: {
        attemptHistoryComplete: true,
        capacityAttemptHistoryComplete: true,
      },
    } as Parameters<typeof buildCallbackTraceEvents>[0]);

    expect(events.map((event) => event.stage)).toEqual(['work.running', 'callback.accepted']);
  });

  test('projects a settled delivery with the same callback identity', () => {
    const callbackRef = canonicalizeGlassHiveCallbackRef('private-callback');
    expect(
      buildDeliveryTraceEvent({
        deliveryRef: 'private-delivery',
        workRef: 'private-work',
        runRef: 'private-run',
        callbackRef,
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
        surface: 'telegram',
        status: 'sent',
        attemptNumber: 1,
      }),
    ).toMatchObject({
      stage: 'callback.delivery.sent',
      facts: {
        workRef: 'private-work',
        runRef: 'private-run',
        callbackRef,
        deliveryState: 'sent',
        attemptNumber: 1,
      },
    });
  });

  test('projects an exact pre-runtime cancellation without inventing an attempt', () => {
    const callbackRef = canonicalizeGlassHiveCallbackRef('pre-runtime-callback');
    const events = buildCallbackTraceEvents({
      workRef: 'private-work',
      runRef: 'private-run',
      callbackRef,
      event: 'run.cancelled',
      workState: 'cancelled',
      workTerminal: true,
      callbackAt: '2026-08-22T12:00:00.000Z',
      callbackAcceptedAt: '2026-08-22T12:00:00.100Z',
      attemptNumber: null,
    });
    const delivery = buildDeliveryTraceEvent({
      deliveryRef: 'private-delivery',
      workRef: 'private-work',
      runRef: 'private-run',
      callbackRef,
      callbackEvent: 'run.cancelled',
      state: 'cancelled',
      terminal: true,
      surface: 'telegram',
      status: 'sent',
      attemptNumber: null,
    });

    expect(events.map((event) => event.stage)).toEqual(['work.cancelled', 'callback.accepted']);
    expect(events.map((event) => event.eventKey)).toEqual([
      'work.cancelled:private-run:pre-runtime',
      `callback.accepted:${callbackRef}:pre-runtime`,
    ]);
    expect(events.every((event) => !('attemptNumber' in event.facts))).toBe(true);
    expect(delivery.eventKey).toBe('callback.delivery.sent:private-delivery:pre-runtime');
    expect(delivery.facts).not.toHaveProperty('attemptNumber');
  });

  test.each([
    ['run.started', 'running', false],
    ['run.completed', 'completed', true],
    ['run.cancelled', 'running', true],
  ])(
    'rejects missing-attempt evidence for non-pre-runtime identity %s/%s',
    (event, workState, workTerminal) => {
      const callbackRef = canonicalizeGlassHiveCallbackRef('invalid-pre-runtime-callback');
      expect(() =>
        buildCallbackTraceEvents({
          workRef: 'private-work',
          runRef: 'private-run',
          callbackRef,
          event,
          workState,
          workTerminal,
          attemptNumber: null,
        }),
      ).toThrow('orchestration_trace_attempt_number_invalid');
    },
  );

  test('canonicalizes one raw callback id once and preserves the canonical value', () => {
    const canonical = canonicalizeGlassHiveCallbackRef('raw-callback-id');

    expect(canonical).toMatch(/^callback_sha256:[a-f0-9]{64}$/);
    expect(canonicalizeGlassHiveCallbackRef(canonical)).toBe(canonical);
  });

  test.each([undefined, 0, -1, 1.5])(
    'rejects callback and delivery evidence with invalid attempt %s',
    (attemptNumber) => {
      const callbackRef = canonicalizeGlassHiveCallbackRef('raw-callback-id');
      expect(() =>
        buildCallbackTraceEvents({
          workRef: 'private-work',
          runRef: 'private-run',
          callbackRef,
          event: 'run.completed',
          workState: 'completed',
          workTerminal: true,
          attemptNumber,
        }),
      ).toThrow('orchestration_trace_attempt_number_invalid');
      expect(() =>
        buildDeliveryTraceEvent({
          deliveryRef: 'private-delivery',
          workRef: 'private-work',
          runRef: 'private-run',
          callbackRef,
          callbackEvent: 'run.completed',
          state: 'completed',
          terminal: true,
          surface: 'telegram',
          status: 'sent',
          attemptNumber,
        }),
      ).toThrow('orchestration_trace_attempt_number_invalid');
    },
  );

  test('rejects a raw callback id after trusted ingress', () => {
    expect(() =>
      buildCallbackTraceEvents({
        workRef: 'private-work',
        runRef: 'private-run',
        callbackRef: 'raw-callback-id',
        event: 'run.completed',
        workState: 'completed',
        workTerminal: true,
        attemptNumber: 1,
      }),
    ).toThrow('orchestration_trace_callback_ref_invalid');
  });
});
