/* === VIVENTIUM START === Existing history loading keeps its real payload and failure. === */
jest.mock('~/models', () => ({ getMessages: jest.fn() }));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/models/balanceMethods', () => ({ checkBalance: jest.fn() }));
const { logger } = require('@librechat/data-schemas');
const { markVoiceLatencyStart } = require('~/server/services/viventium/voiceLatencyTiming');
const BaseClient = require('../BaseClient');

describe('BaseClient history owner voice timing', () => {
  afterEach(() => jest.restoreAllMocks());
  test.each([false, true])('preserves loaded history with timing enabled=%s', async (enabled) => {
    const req = {};
    markVoiceLatencyStart(req, 'synthetic-request');
    req.viventiumVoiceLogLatency = enabled;
    const client = new BaseClient('synthetic');
    client.options = { req };
    client.getSaveOptions = () => ({});
    const rows = [{ messageId: 'synthetic-parent', text: 'Private source text.' }];
    client.loadHistory = jest.fn(async () => rows);
    const logs = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    const result = await client.setMessageOptions({ user: 'synthetic-user',
      conversationId: 'synthetic-conversation', parentMessageId: 'synthetic-parent' });
    expect(client.loadHistory).toHaveBeenCalledWith('synthetic-conversation',
      'synthetic-parent', 'synthetic-parent');
    expect(client.currentMessages).toBe(rows);
    expect(result.conversationId).toBe('synthetic-conversation');
    const timings = logs.mock.calls.filter((call) => call[0] === '[VoiceLatency][LC][Timing]');
    expect(timings).toHaveLength(enabled ? 1 : 0);
    if (enabled) expect(timings[0][1]).toMatchObject({ source: 'base_client', stage: 'history_load_completed' });
    expect(JSON.stringify(timings)).not.toContain('Private source text.');
  });

  test('a failed history read still prevents message setup with the original error', async () => {
    const req = {};
    markVoiceLatencyStart(req, 'synthetic-request');
    const client = new BaseClient('synthetic');
    client.options = { req };
    client.getSaveOptions = () => ({});
    const error = new Error('Private failed source.');
    client.loadHistory = jest.fn(async () => { throw error; });
    const logs = jest.spyOn(logger, 'debug').mockImplementation(() => {});
    await expect(client.setMessageOptions({ conversationId: 'synthetic-conversation' })).rejects.toBe(error);
    const timings = logs.mock.calls.filter((call) => call[0] === '[VoiceLatency][LC][Timing]');
    expect(timings[0][1].stage).toBe('history_load_failed');
    expect(JSON.stringify(timings)).not.toContain(error.message);
  });
});
/* === VIVENTIUM END === */
