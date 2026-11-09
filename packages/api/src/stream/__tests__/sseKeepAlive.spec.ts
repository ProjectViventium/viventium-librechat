import { EventEmitter } from 'events';
import { createServer, get } from 'http';
import type { Response } from 'express';
import type { AddressInfo } from 'net';
import { startSseKeepAlive } from '../sseKeepAlive';

describe('quiet SSE transport', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const fixture = () =>
    Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writableNeedDrain: false,
      write: jest.fn(),
      flush: jest.fn(),
    });
  test.each(['close', 'finish'])(
    'sends comments, then clears its timer and listeners on %s',
    (event) => {
      const response = fixture();
      startSseKeepAlive(response as Response, () => true);
      jest.advanceTimersByTime(14999);
      expect(response.write).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(response.write).toHaveBeenCalledWith(': keep-alive\n\n');
      expect(response.flush).toHaveBeenCalledTimes(1);
      response.emit(event);
      jest.advanceTimersByTime(30000);
      expect(response.write).toHaveBeenCalledTimes(1);
      expect(response.listenerCount('close')).toBe(0);
      expect(response.listenerCount('finish')).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  test('does not queue comments behind backpressure or write to a closed response', () => {
    const response = fixture();
    response.writableNeedDrain = true;
    startSseKeepAlive(response as Response, () => true);
    jest.advanceTimersByTime(15000);
    expect(response.write).not.toHaveBeenCalled();
    response.writableNeedDrain = false;
    jest.advanceTimersByTime(15000);
    expect(response.write).toHaveBeenCalledTimes(1);
    response.writableEnded = true;
    jest.advanceTimersByTime(15000);
    expect(jest.getTimerCount()).toBe(0);
  });
  test('write failure and explicit cancellation release the timer', () => {
    const response = fixture();
    response.write.mockImplementation(() => {
      throw new Error('disconnected');
    });
    const stop = startSseKeepAlive(response as Response, () => true);
    jest.advanceTimersByTime(15000);
    expect(jest.getTimerCount()).toBe(0);
    stop();
    stop();
    expect(response.listenerCount('close')).toBe(0);
  });

  test.each([true, false, 'stale'] as const)(
    'real quiet HTTP stream preserves the idle bound for an inactive producer (%s)',
    async (enabled) => {
      jest.useRealTimers();
      const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/event-stream');
        response.flushHeaders();
        const aliveUntil = Date.now() + 100;
        if (enabled)
          startSseKeepAlive(
            response as Response,
            () => enabled === true || Date.now() < aliveUntil,
            30,
          );
        const final = setTimeout(() => response.end('data: {"final":true}\n\n'), 600);
        response.once('close', () => clearTimeout(final));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const received = new Promise<string>((resolve, reject) => {
          const request = get(
            `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            (response) => {
              let body = '';
              response.on('data', (chunk) => {
                body += String(chunk);
              });
              response.once('end', () => resolve(body));
              response.once('error', reject);
            },
          );
          request.setTimeout(200, () => request.destroy(new Error('read_idle_timeout')));
          request.once('error', reject);
        });
        if (enabled === true) {
          const body = await received;
          expect(body).toContain(': keep-alive\n\n');
          expect(body).toContain('data: {"final":true}\n\n');
        } else await expect(received).rejects.toThrow('read_idle_timeout');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
