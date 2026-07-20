const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { resolveNativeApiListenTarget, secureNativeApiSocket } = require('../nativeApiListen');

describe('resolveNativeApiListenTarget', () => {
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
});
