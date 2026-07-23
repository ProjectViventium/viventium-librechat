const fs = require('fs');
const http = require('http');
const path = require('path');

class NativeApiSocketUnavailableError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = 'NativeApiSocketUnavailableError';
    this.code = 'native_api_socket_unavailable';
    this.issueCode = 'connection_unavailable';
  }
}

function validateNativeApiSocketPath(socketPath) {
  if (typeof socketPath !== 'string' || socketPath !== socketPath.trim()) {
    throw new Error(
      'VIVENTIUM_NATIVE_API_SOCKET must be an absolute path without outer whitespace',
    );
  }

  if (socketPath.includes('\0') || !path.isAbsolute(socketPath)) {
    throw new Error('VIVENTIUM_NATIVE_API_SOCKET must be an absolute path');
  }
  return socketPath;
}

/**
 * Resolve LibreChat's listen arguments without changing the upstream TCP default.
 *
 * The native Viventium runtime uses a socket inside its private runtime directory so
 * its proxy cannot accidentally attach to an unrelated process that later acquires
 * the configured TCP port.
 */
function resolveNativeApiListenTarget({ socketPath, port, host }) {
  if (socketPath == null || socketPath === '') {
    return {
      args: [port, host],
      socketPath: null,
    };
  }

  validateNativeApiSocketPath(socketPath);

  return {
    args: [socketPath],
    socketPath,
  };
}

function secureNativeApiSocket(socketPath) {
  const before = fs.lstatSync(socketPath);
  if (before.isSymbolicLink() || !before.isSocket()) {
    throw new Error('Native API socket path is not an owned Unix socket');
  }

  fs.chmodSync(socketPath, 0o600);
  const after = fs.lstatSync(socketPath);
  if (after.isSymbolicLink() || !after.isSocket() || (after.mode & 0o777) !== 0o600) {
    throw new Error('Native API socket permissions could not be secured to mode 0600');
  }
}

function assertNativeApiSocketAvailable(socketPath) {
  validateNativeApiSocketPath(socketPath);
  let stat;
  try {
    stat = fs.lstatSync(socketPath);
  } catch (error) {
    throw new NativeApiSocketUnavailableError('Native API socket is unavailable', error);
  }
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    (currentUid != null && stat.uid !== currentUid) ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new NativeApiSocketUnavailableError('Native API socket is not an owned mode-0600 socket');
  }
}

function nativeRequestBody(body) {
  if (body == null) {
    return null;
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body);
  }
  throw new TypeError('Native API socket fetch supports only string or byte request bodies');
}

function createNativeApiSocketFetch(socketPath) {
  const validatedSocketPath = validateNativeApiSocketPath(socketPath);

  return async function fetchOverNativeApiSocket(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const loopbackHost = ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname);
    if (url.protocol !== 'http:' || !loopbackHost || url.username || url.password) {
      throw new TypeError(
        'Native API socket fetch accepts only credential-free loopback HTTP URLs',
      );
    }
    assertNativeApiSocketAvailable(validatedSocketPath);
    const body = nativeRequestBody(init.body);
    const headers = Object.fromEntries(new Headers(init.headers).entries());

    return await new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: validatedSocketPath,
          path: `${url.pathname}${url.search}`,
          method: init.method || 'GET',
          headers,
          signal: init.signal,
        },
        (response) => {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (Array.isArray(value)) {
                value.forEach((item) => responseHeaders.append(name, item));
              } else if (value != null) {
                responseHeaders.set(name, value);
              }
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode || 500,
                statusText: response.statusMessage,
                headers: responseHeaders,
              }),
            );
          });
        },
      );
      request.on('error', (error) => {
        if (init.signal?.aborted || error?.name === 'AbortError') {
          reject(error);
          return;
        }
        reject(new NativeApiSocketUnavailableError('Native API socket request failed', error));
      });
      if (body != null) {
        request.write(body);
      }
      request.end();
    });
  };
}

function resolveNativeChannelGatewayTransport({ socketPath, loopbackUrl }) {
  if (socketPath == null || socketPath === '') {
    return { baseUrl: loopbackUrl };
  }
  return {
    baseUrl: 'http://localhost',
    fetchImpl: createNativeApiSocketFetch(socketPath),
  };
}

module.exports = {
  NativeApiSocketUnavailableError,
  assertNativeApiSocketAvailable,
  createNativeApiSocketFetch,
  resolveNativeChannelGatewayTransport,
  resolveNativeApiListenTarget,
  secureNativeApiSocket,
};
