const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { ChannelGatewayClient } = require('@librechat/api');
const { createChannelWorkerReconciler } = require('../channelPersistence');
const {
  assertNativeApiSocketAvailable,
  createNativeApiSocketFetch,
  resolveNativeChannelGatewayTransport,
  resolveNativeApiListenTarget,
  secureNativeApiSocket,
} = require('../nativeApiListen');

async function listenOnSocket(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      try {
        secureNativeApiSocket(socketPath);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve) => server.close(resolve));
}

describe('resolveNativeApiListenTarget', () => {
  it('selects the Unix adapter only for an explicitly configured absolute Native socket', () => {
    expect(
      resolveNativeChannelGatewayTransport({
        socketPath: undefined,
        loopbackUrl: 'http://127.0.0.1:3180',
      }),
    ).toEqual({ baseUrl: 'http://127.0.0.1:3180' });
    expect(() =>
      resolveNativeChannelGatewayTransport({
        socketPath: 'runtime/api.sock',
        loopbackUrl: 'http://127.0.0.1:3180',
      }),
    ).toThrow(/must be an absolute path/);
    expect(
      resolveNativeChannelGatewayTransport({
        socketPath: '/synthetic/viventium-runtime/api.sock',
        loopbackUrl: 'http://127.0.0.1:3180',
      }),
    ).toMatchObject({ baseUrl: 'http://localhost', fetchImpl: expect.any(Function) });
  });

  it('preserves the upstream TCP host and port when no native socket is configured', () => {
    expect(
      resolveNativeApiListenTarget({ socketPath: undefined, port: 3180, host: '127.0.0.1' }),
    ).toEqual({
      args: [3180, '127.0.0.1'],
      socketPath: null,
    });
  });

  it('uses only the absolute native socket path when configured', () => {
    expect(
      resolveNativeApiListenTarget({
        socketPath: '/private/tmp/viventium-runtime/api.sock',
        port: 3180,
        host: '127.0.0.1',
      }),
    ).toEqual({
      args: ['/private/tmp/viventium-runtime/api.sock'],
      socketPath: '/private/tmp/viventium-runtime/api.sock',
    });
  });

  it('produces arguments that bind and serve over a Unix socket', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-native-api-'));
    const socketPath = path.join(tempDirectory, 'api.sock');
    const target = resolveNativeApiListenTarget({ socketPath, port: 3180, host: '127.0.0.1' });
    const server = http.createServer((_request, response) => response.end('VIVENTIUM_SOCKET_OK'));

    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(...target.args, () => {
          try {
            secureNativeApiSocket(socketPath);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);
      const responseBody = await new Promise((resolve, reject) => {
        http
          .get({ socketPath, path: '/' }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => resolve(body));
          })
          .once('error', reject);
      });

      expect(responseBody).toBe('VIVENTIUM_SOCKET_OK');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails closed when the configured path is not a Unix socket', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-native-api-'));
    const regularFile = path.join(tempDirectory, 'not-a-socket');
    fs.writeFileSync(regularFile, 'synthetic fixture');

    try {
      expect(() => secureNativeApiSocket(regularFile)).toThrow(/not an owned Unix socket/);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ['relative socket', 'runtime/api.sock'],
    ['outer whitespace', ' /private/tmp/viventium-runtime/api.sock '],
    ['NUL byte', '/private/tmp/viventium\0runtime.sock'],
  ])('rejects an invalid %s path', (_label, socketPath) => {
    expect(() =>
      resolveNativeApiListenTarget({ socketPath, port: 3180, host: '127.0.0.1' }),
    ).toThrow(/VIVENTIUM_NATIVE_API_SOCKET must be an absolute path/);
  });

  it('runs signed channel POST and SSE GET requests through the Native Unix socket', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-channel-socket-'));
    const socketPath = path.join(tempDirectory, 'api.sock');
    const requests = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push({
        method: request.method,
        path: request.url,
        secret: request.headers['x-viventium-gateway-secret'],
        signature: request.headers['x-viventium-gateway-signature'],
        body,
      });
      if (request.method === 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ streamId: 'socket-stream', conversationId: 'new' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        'event: final\ndata: {"type":"final","final":true,"text":"socket answer","conversationId":"socket-conversation"}\n\n',
      );
    });

    try {
      await listenOnSocket(server, socketPath);
      const client = new ChannelGatewayClient({
        baseUrl: 'http://127.0.0.1:65535',
        secret: 'synthetic-gateway-secret',
        fetchImpl: createNativeApiSocketFetch(socketPath),
        nowSeconds: () => 1_750_000_000,
        randomNonce: () => 'synthetic-nonce',
      });

      await expect(
        client.handle({
          channel: 'telegram',
          accountId: 'synthetic-account',
          externalUserId: 'synthetic-user',
          externalConversationId: 'synthetic-chat',
          externalMessageId: 'synthetic-message',
          text: 'Hello over the Unix socket',
          pairingContext: 'private',
          inputMode: 'text',
          authorizationSnapshot: {
            kind: 'paired',
            libreChatUserId: 'synthetic-local-user',
            bindingVersion: 'synthetic-binding',
          },
        }),
      ).resolves.toEqual({ text: 'socket answer' });

      expect(server.address()).toBe(socketPath);
      expect(requests.map(({ method, path: requestPath }) => [method, requestPath])).toEqual([
        ['POST', '/api/viventium/gateway/chat'],
        [
          'GET',
          '/api/viventium/gateway/stream/socket-stream?channel=telegram&accountId=synthetic-account&externalUserId=synthetic-user&externalChatId=synthetic-chat',
        ],
      ]);
      expect(requests.every((request) => request.secret === 'synthetic-gateway-secret')).toBe(true);
      expect(requests.every((request) => /^[a-f0-9]{64}$/.test(request.signature))).toBe(true);
    } finally {
      await closeServer(server);
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('classifies a missing or stale socket and recovers with the same fetch adapter', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-channel-socket-'));
    const socketPath = path.join(tempDirectory, 'api.sock');
    const fetchOverSocket = createNativeApiSocketFetch(socketPath);
    const server = http.createServer((_request, response) => response.end('RECOVERED'));

    try {
      await expect(fetchOverSocket('http://localhost/health')).rejects.toMatchObject({
        name: 'NativeApiSocketUnavailableError',
        issueCode: 'connection_unavailable',
      });
      fs.writeFileSync(socketPath, 'stale non-socket fixture');
      await expect(fetchOverSocket('http://localhost/health')).rejects.toMatchObject({
        name: 'NativeApiSocketUnavailableError',
        issueCode: 'connection_unavailable',
      });
      fs.rmSync(socketPath);

      await listenOnSocket(server, socketPath);
      const response = await fetchOverSocket('http://localhost/health');
      await expect(response.text()).resolves.toBe('RECOVERED');
    } finally {
      await closeServer(server);
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('lets the 30-second worker reconciler recover when the Native socket appears', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-channel-socket-'));
    const socketPath = path.join(tempDirectory, 'api.sock');
    const server = http.createServer((_request, response) => response.end('OK'));
    const logger = { error: jest.fn(), warn: jest.fn() };
    let periodicRetry;
    const restored = jest.fn();
    const restoreWorkers = createChannelWorkerReconciler({
      logger,
      reconcile: async () => {
        assertNativeApiSocketAvailable(socketPath);
        restored();
      },
      setIntervalImpl: (callback, intervalMs) => {
        expect(intervalMs).toBe(30_000);
        periodicRetry = callback;
        return { unref() {} };
      },
    });

    try {
      await restoreWorkers();
      expect(restored).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        '[VIVENTIUM][channels] Failed to restore channel workers after restart',
        { error: 'NativeApiSocketUnavailableError' },
      );

      await listenOnSocket(server, socketPath);
      periodicRetry();
      await new Promise((resolve) => setImmediate(resolve));
      expect(restored).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
