'use strict';

const {
  feelingsRequestId,
  logFeelingsEvent,
  splitEventPayload,
} = require('~/server/services/viventium/feelingsTelemetry');

describe('Feelings telemetry', () => {
  test('persists the public-safe structured envelope in the formatted message', () => {
    const logger = { info: jest.fn() };
    const req = { id: 'request-1' };

    logFeelingsEvent(logger, req, 'feelings.api.read', {
      version: 4,
      durationMs: 2,
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
      }),
    );
    expect(reconstructed).not.toHaveProperty('requestId');
  });

  test('uses stable request-id fallbacks without reading user content', () => {
    expect(feelingsRequestId({ body: { traceId: 'trace-2', text: 'private' } })).toBe('trace-2');
    expect(feelingsRequestId({ body: { text: 'private' } })).toBe('unknown');
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

  test('splits long events into complete parseable log envelopes before formatter truncation', () => {
    const payload = {
      event: 'feelings.reaction.start',
      stimulusId: 'stimulus-00000000-0000-0000-0000-000000000001',
      snapshotHash: '0123456789abcdef',
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
    expect(chunks.every((chunk) => JSON.stringify(chunk).length < 120)).toBe(true);
    expect(chunks.every((chunk) => chunk.i === 'event001' && chunk.r === 'req00001')).toBe(true);
    expect(chunks.map((chunk) => chunk.p)).toEqual(chunks.map((_chunk, index) => index + 1));
    expect(chunks.every((chunk) => chunk.n === chunks.length)).toBe(true);
    const reconstructed = Object.assign({}, ...chunks);
    for (const key of ['i', 'r', 'p', 'n']) delete reconstructed[key];
    const { requestId: _requestId, ...expectedPayload } = payload;
    expect(reconstructed).toEqual(expectedPayload);
  });
});
