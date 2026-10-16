/* === VIVENTIUM START === Passive preparation spans preserve actual operation outcomes. === */
const crypto = require('crypto');
const { observeVoiceLatencyOperation, markVoiceLatencyStart } = require('../voiceLatencyTiming');

function setup(enabled = true, throwLogger = false) {
  const req = {};
  markVoiceLatencyStart(req, 'synthetic-private-request');
  req.viventiumVoiceLogLatency = enabled;
  const logger = { debug: jest.fn(() => { if (throwLogger) throw new Error('private logger error'); }) };
  return { req, logger };
}

describe('passive voice preparation operation timing', () => {
  test.each(['history_load', 'saved_memory_snapshot_load', 'feeling_snapshot_wait'])(
    '%s measures only the awaited owner and does not serialize its value', async (stage) => {
      const { req, logger } = setup();
      let release;
      const value = { privateContent: 'Private memory and conversation content.' };
      const pending = new Promise((resolve) => { release = resolve; });
      const operation = jest.fn(() => pending);
      const result = observeVoiceLatencyOperation(logger, req, 'synthetic-owner', stage, operation);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(logger.debug).not.toHaveBeenCalled();
      release(value);
      await expect(result).resolves.toBe(value);
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.debug.mock.calls[0][1]).toEqual(expect.objectContaining({
        source: 'synthetic-owner', stage: `${stage}_completed`,
        request_sha256: crypto.createHash('sha256').update('synthetic-private-request').digest('hex'),
        stage_ms_f: expect.any(Number), total_ms_f: expect.any(Number),
      }));
      expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('Private memory');
      expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('synthetic-private-request');
    },
  );

  test.each([false, true])('preserves async rejection with logger failure=%s', async (throwLogger) => {
    const { req, logger } = setup(true, throwLogger);
    const error = new Error('Private operation error.');
    await expect(observeVoiceLatencyOperation(logger, req, 'client', 'snapshot',
      () => Promise.reject(error))).rejects.toBe(error);
    expect(logger.debug.mock.calls[0][1].stage).toBe('snapshot_failed');
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(error.message);
  });

  test('preserves synchronous throws and its exact error object', () => {
    const { req, logger } = setup();
    const error = new Error('Private sync error.');
    expect(() => observeVoiceLatencyOperation(logger, req, 'client', 'snapshot',
      () => { throw error; })).toThrow(error);
    expect(logger.debug.mock.calls[0][1].stage).toBe('snapshot_failed');
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain(error.message);
  });

  test('logger failure cannot change a successful result', async () => {
    const { req, logger } = setup(true, true);
    const value = [];
    expect(await observeVoiceLatencyOperation(logger, req, 'client', 'snapshot',
      () => value)).toBe(value);
  });

  test('synchronous frame work stays synchronous and retains its return value', () => {
    const { req, logger } = setup();
    const value = { privateContent: 'Private frame.' };
    expect(observeVoiceLatencyOperation(logger, req, 'client', 'main_assembly_frame',
      () => value)).toBe(value);
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls[0][1].stage).toBe('main_assembly_frame_completed');
    expect(JSON.stringify(logger.debug.mock.calls)).not.toContain('Private frame.');
  });

  test('disabled timing returns the original promise without an extra wrapper', async () => {
    const { req, logger } = setup(false);
    const pending = Promise.resolve('same-result');
    const operation = jest.fn(() => pending);
    expect(observeVoiceLatencyOperation(logger, req, 'client', 'snapshot', operation)).toBe(pending);
    await pending;
    expect(operation).toHaveBeenCalledTimes(1);
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */
