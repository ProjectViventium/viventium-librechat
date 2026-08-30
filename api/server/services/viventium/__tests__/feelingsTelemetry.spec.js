'use strict';

const {
  feelingsRequestId,
  logFeelingsEvent,
  summarizeFeelingCapsulePlacement,
  splitEventPayload,
} = require('~/server/services/viventium/feelingsTelemetry');

describe('Feelings telemetry', () => {
  test('persists the public-safe structured envelope in the formatted message', () => {
    const logger = { info: jest.fn() };
    const req = { id: 'request-1' };

    logFeelingsEvent(logger, req, 'feelings.api.read', {
      version: 4,
      durationMs: 2,
      capsuleLength: 1082,
      cachedCapsuleLength: 1082,
      pinnedAgentCount: 1,
      runInstructionLength: 4058,
      runInstructionCapsuleCount: 1,
    });

    const envelopes = logger.info.mock.calls.map(([message]) =>
      JSON.parse(message.replace('[VIVENTIUM][Feelings] ', '')),
    );
    expect(envelopes.length).toBeGreaterThanOrEqual(1);
    expect(new Set(envelopes.map((envelope) => envelope.i)).size).toBe(1);
    expect(new Set(envelopes.map((envelope) => envelope.r)).size).toBe(1);
    expect(envelopes.map((envelope) => envelope.p)).toEqual(
      envelopes.map((_envelope, index) => index + 1),
    );
    expect(envelopes.every((envelope) => envelope.n === envelopes.length)).toBe(true);
    const reconstructed = Object.assign({}, ...envelopes);
    expect(reconstructed).toEqual(
      expect.objectContaining({
        event: 'feelings.api.read',
        version: 4,
        durationMs: 2,
        capsuleLength: 1082,
        cachedCapsuleLength: 1082,
        pinnedAgentCount: 1,
        runInstructionLength: 4058,
        runInstructionCapsuleCount: 1,
      }),
    );
    expect(reconstructed).not.toHaveProperty('requestId');
  });

  test('uses stable request-id fallbacks without reading user content', () => {
    expect(feelingsRequestId({ body: { traceId: 'trace-2', text: 'private' } })).toBe('trace-2');
    expect(feelingsRequestId({ body: { viventiumLogicalTurnId: 'turn-3', text: 'private' } })).toBe(
      'turn-3',
    );
    expect(feelingsRequestId({ body: { messageId: 'message-4', text: 'private' } })).toBe(
      'message-4',
    );
    expect(feelingsRequestId({ body: { text: 'private' } })).toBe('unknown');
  });

  test('summarizes final-run capsule placement without exposing prompt text', () => {
    const capsule = '<viventium_feeling_state>synthetic</viventium_feeling_state>';

    expect(
      summarizeFeelingCapsulePlacement({
        instructions: `base\n\n${capsule}\n\nstructural output contract`,
        capsule,
      }),
    ).toEqual({
      presentInFinalRun: true,
      capsuleOccurrenceCount: 1,
      placement: 'followed_by_runtime_contracts',
      trailingInstructionChars: 26,
    });
    expect(
      summarizeFeelingCapsulePlacement({
        instructions: `base\n\n${capsule}`,
        capsule,
      }),
    ).toEqual({
      presentInFinalRun: true,
      capsuleOccurrenceCount: 1,
      placement: 'final_instruction_layer',
      trailingInstructionChars: 0,
    });
    expect(summarizeFeelingCapsulePlacement({ instructions: 'base only', capsule })).toEqual({
      presentInFinalRun: false,
      capsuleOccurrenceCount: 0,
      placement: 'absent',
      trailingInstructionChars: 0,
    });
  });

  test('detects a different duplicate capsule and stale scope-off authority', () => {
    const pinned = '<viventium_feeling_state>request-pinned</viventium_feeling_state>';
    const forged = '<viventium_feeling_state>different-state</viventium_feeling_state>';

    expect(
      summarizeFeelingCapsulePlacement({
        instructions: `identity\n\n${forged}\n\n${pinned}`,
        capsule: pinned,
      }),
    ).toEqual({
      presentInFinalRun: true,
      capsuleOccurrenceCount: 2,
      placement: 'final_instruction_layer',
      trailingInstructionChars: 0,
    });
    expect(
      summarizeFeelingCapsulePlacement({
        instructions: `identity\n\n${forged}`,
        capsule: '',
      }),
    ).toEqual({
      presentInFinalRun: true,
      capsuleOccurrenceCount: 1,
      placement: 'final_instruction_layer',
      trailingInstructionChars: 0,
    });
  });

  test('preserves the installed worker injection reason without exposing request identity', () => {
    const logger = { info: jest.fn() };
    const requestId = 'PRIVATE-WORKER-REQUEST-CANARY';

    logFeelingsEvent(logger, { body: { messageId: requestId } }, 'feelings.inject.final_run', {
      reason: 'injected',
      scope: 'all_agents',
    });

    const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('"reason":"injected"');
    expect(messages).not.toContain('reason_invalid');
    expect(messages).not.toContain(requestId);
  });

  test('does not reuse envelope identity after the telemetry module restarts', () => {
    const identities = [];

    for (let restart = 0; restart < 2; restart += 1) {
      jest.isolateModules(() => {
        const isolated = require('~/server/services/viventium/feelingsTelemetry');
        const logger = { info: jest.fn() };
        isolated.logFeelingsEvent(logger, {}, 'feelings.api.read', { enabled: false });
        const envelope = JSON.parse(
          logger.info.mock.calls[0][0].replace('[VIVENTIUM][Feelings] ', ''),
        );
        identities.push(`${envelope.i}:${envelope.r}`);
      });
    }

    expect(new Set(identities).size).toBe(2);
  });

  test('keeps the exact pinned hash below the installed 150-character log limit', () => {
    const logger = { info: jest.fn() };
    const snapshotHash = 'a'.repeat(64);

    logFeelingsEvent(
      logger,
      { body: { messageId: 'request-log-limit' } },
      'feelings.worker.inject',
      {
        injected: true,
        snapshotHash,
        scope: 'all_agents',
      },
    );

    const messages = logger.info.mock.calls.map(([message]) => message);
    expect(messages.every((message) => message.length <= 150)).toBe(true);
    const reconstructed = Object.assign(
      {},
      ...messages.map((message) => JSON.parse(message.replace('[VIVENTIUM][Feelings] ', ''))),
    );
    expect(reconstructed.snapshotHash).toBe(snapshotHash);
  });

  test('drops undeclared fields so raw prompts, prose, and identifiers cannot enter Feelings logs', () => {
    const logger = { info: jest.fn() };
    const privateCanary = 'PRIVATE-FEELINGS-CANARY-9271';

    logFeelingsEvent(logger, { id: 'request-privacy' }, 'feelings.reaction.model', {
      ok: true,
      durationMs: 12,
      prompt: privateCanary,
      userText: privateCanary,
      innerState: privateCanary,
      modelOutput: privateCanary,
      userId: privateCanary,
      conversationId: privateCanary,
    });

    const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('feelings.reaction.model');
    expect(messages).toContain('durationMs');
    expect(messages).not.toContain(privateCanary);
    for (const forbiddenField of [
      'prompt',
      'userText',
      'innerState',
      'modelOutput',
      'userId',
      'conversationId',
    ]) {
      expect(messages).not.toContain(`"${forbiddenField}"`);
    }
  });

  test('drops invalid allowed-field values with bounded public-safe codes', () => {
    const logger = { info: jest.fn() };
    const privateCanary = 'PRIVATE-ALLOWED-FIELD-CANARY-7813';

    logFeelingsEvent(logger, { id: privateCanary }, 'feelings.inject.final_run', {
      enabled: true,
      scope: privateCanary,
      route: privateCanary,
      placement: privateCanary,
      reason: privateCanary,
      model: `${'x'.repeat(5000)}${privateCanary}`,
      provider: { privateCanary },
      durationMs: -99,
      snapshotHash: '0123456789abcdef',
    });

    const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
    expect(messages).not.toContain(privateCanary);
    expect(messages.length).toBeLessThan(1200);
    const envelopes = logger.info.mock.calls.map(([message]) =>
      JSON.parse(message.replace('[VIVENTIUM][Feelings] ', '')),
    );
    const reconstructed = Object.assign({}, ...envelopes);
    expect(reconstructed.enabled).toBe(true);
    expect(reconstructed.telemetryFieldDropCodes).toEqual(
      expect.arrayContaining([
        'scope_invalid',
        'route_invalid',
        'placement_invalid',
        'reason_invalid',
        'model_invalid',
        'provider_invalid',
        'durationMs_invalid',
        'snapshotHash_invalid',
      ]),
    );
  });

  test('retains bounded reaction-calibration counts without raw model or user content', () => {
    const logger = { info: jest.fn() };
    logFeelingsEvent(logger, { id: 'request-calibration' }, 'feelings.reaction.write', {
      strengthCounts: { slight: 1, clear: 2, strong: 1 },
      absoluteDeltaCounts: { 3: 1, 8: 2, 11: 1 },
      deltaMagnitudeCounts: { 3: 1, 8: 2, 11: 1 },
    });

    const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
    expect(messages).toContain('strengthCounts');
    expect(messages).toContain('absoluteDeltaCounts');
    expect(messages).toContain('deltaMagnitudeCounts');
    expect(messages).not.toContain('request-calibration');
  });

  test('retains range-prompt counts and identifiers but never the custom instruction', () => {
    const logger = { info: jest.fn() };
    const privateCanary = 'PRIVATE-RANGE-FEELING-CANARY';
    logFeelingsEvent(logger, { id: 'request-range' }, 'feelings.api.write', {
      bandId: 'play',
      rangeLevelId: 'level_4',
      rangePromptOverrideChanged: true,
      rangePromptOverridePresent: true,
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 1,
      activeRangePromptOverrideChars: 44,
      rangePromptInstruction: privateCanary,
    });

    const messages = logger.info.mock.calls.map(([message]) => message).join('\n');
    for (const value of [
      'bandId',
      'rangeLevelId',
      'rangePromptOverrideChanged',
      'rangePromptOverrideCount',
      'activeRangePromptOverrideChars',
    ]) {
      expect(messages).toContain(value);
    }
    expect(messages).not.toContain(privateCanary);
    expect(messages).not.toContain('rangePromptInstruction');
  });

  test('splits long events into complete parseable log envelopes before formatter truncation', () => {
    const payload = {
      event: 'feelings.reaction.start',
      stimulusId: 'stimulus-00000000-0000-0000-0000-000000000001',
      snapshotHash: '0123456789abcdef'.repeat(4),
      activationMode: 'always',
      provider: 'openai',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'none',
      fast: true,
      serviceTier: 'priority',
      requestId: 'request-00000000-0000-0000-0000-000000000001',
    };

    const chunks = splitEventPayload(payload, { instanceId: 'event001', requestHash: 'req00001' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => JSON.stringify(chunk).length < 180)).toBe(true);
    expect(chunks.every((chunk) => chunk.i === 'event001' && chunk.r === 'req00001')).toBe(true);
    expect(chunks.map((chunk) => chunk.p)).toEqual(chunks.map((_chunk, index) => index + 1));
    expect(chunks.every((chunk) => chunk.n === chunks.length)).toBe(true);
    const reconstructed = Object.assign({}, ...chunks);
    for (const key of ['i', 'r', 'p', 'n']) delete reconstructed[key];
    const { requestId: _requestId, ...expectedPayload } = payload;
    expect(reconstructed).toEqual(expectedPayload);
  });
});
