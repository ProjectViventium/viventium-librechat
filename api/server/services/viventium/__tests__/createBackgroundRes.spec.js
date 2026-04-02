/* === VIVENTIUM START ===
 * Tests: createBackgroundRes EventEmitter stub for Phase B cortex execution.
 * Added: 2026-02-12
 *
 * Why:
 * - Phase B background cortex execution receives `res: null` when a tool-cortex hold is active.
 * - The `createBackgroundRes()` stub must satisfy the Express `res` interface used by
 *   MCP tool loading (`res.on`, `res.once`, `res.emit`), SSE helpers (`res.write`),
 *   and stream lifecycle checks (`res.writableEnded`, `res.destroyed`).
 * === VIVENTIUM END === */

const EventEmitter = require('events');
const {
  createBackgroundRes,
} = require('../../BackgroundCortexService');

describe('createBackgroundRes', () => {
  let res;

  beforeEach(() => {
    res = createBackgroundRes();
  });

  // --- EventEmitter interface ---

  test('returns an object that is an EventEmitter instance', () => {
    expect(res).toBeInstanceOf(EventEmitter);
  });

  test('res.on() is callable and does not throw', () => {
    expect(() => res.on('close', () => {})).not.toThrow();
    expect(() => res.on('drain', () => {})).not.toThrow();
    expect(() => res.on('error', () => {})).not.toThrow();
  });

  test('res.once() is callable and does not throw', () => {
    expect(() => res.once('close', () => {})).not.toThrow();
    expect(() => res.once('drain', () => {})).not.toThrow();
  });

  test('res.emit() is callable', () => {
    expect(() => res.emit('close')).not.toThrow();
  });

  test('res.removeListener() is callable', () => {
    const handler = () => {};
    res.on('close', handler);
    expect(() => res.removeListener('close', handler)).not.toThrow();
  });

  // --- Express `res` properties ---

  test('has writableEnded = false', () => {
    expect(res.writableEnded).toBe(false);
  });

  test('has destroyed = false', () => {
    expect(res.destroyed).toBe(false);
  });

  test('has headersSent = false', () => {
    expect(res.headersSent).toBe(false);
  });

  test('has statusCode = 200', () => {
    expect(res.statusCode).toBe(200);
  });

  // --- Express `res` methods ---

  test('write() returns true (no backpressure)', () => {
    const result = res.write('data');
    expect(result).toBe(true);
  });

  test('write() with SSE-formatted data returns true', () => {
    const ssePayload = 'event: message\ndata: {"text":"hello"}\n\n';
    expect(res.write(ssePayload)).toBe(true);
  });

  test('end() is callable and does not throw', () => {
    expect(() => res.end()).not.toThrow();
  });

  test('setHeader() is callable and does not throw', () => {
    expect(() => res.setHeader('Content-Type', 'text/event-stream')).not.toThrow();
  });

  test('getHeader() returns undefined', () => {
    expect(res.getHeader('Content-Type')).toBeUndefined();
  });

  test('writeHead() is callable and does not throw', () => {
    expect(() => res.writeHead(200, { 'Content-Type': 'text/html' })).not.toThrow();
  });

  test('flushHeaders() is callable and does not throw', () => {
    expect(() => res.flushHeaders()).not.toThrow();
  });

  // --- Real-world usage simulation ---

  test('survives the sendEvent pattern: guard + write', () => {
    // Simulates the check in ToolService.js:
    // `if (res && !res.writableEnded) { sendEvent(res, payload); }`
    if (res && !res.writableEnded) {
      const wrote = res.write(JSON.stringify({ event: 'test', data: {} }));
      expect(wrote).toBe(true);
    }
  });

  test('survives close-handler registration pattern', () => {
    // Simulates the pattern in request.js:
    // `res.on('close', closeHandler);`
    // `res.removeListener('close', closeHandler);`
    const handler = jest.fn();
    res.on('close', handler);
    res.removeListener('close', handler);
    res.emit('close');
    // Handler was removed before emit, so it should not be called
    expect(handler).not.toHaveBeenCalled();
  });

  test('returns a fresh instance on every call (no shared state)', () => {
    const res1 = createBackgroundRes();
    const res2 = createBackgroundRes();
    expect(res1).not.toBe(res2);
    // Mutating one does not affect the other
    res1.writableEnded = true;
    expect(res2.writableEnded).toBe(false);
  });
});
