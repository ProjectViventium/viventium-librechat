const fs = require('fs');
const path = require('path');

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

  if (typeof socketPath !== 'string' || socketPath !== socketPath.trim()) {
    throw new Error(
      'VIVENTIUM_NATIVE_API_SOCKET must be an absolute path without outer whitespace',
    );
  }

  if (socketPath.includes('\0') || !path.isAbsolute(socketPath)) {
    throw new Error('VIVENTIUM_NATIVE_API_SOCKET must be an absolute path');
  }

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

module.exports = { resolveNativeApiListenTarget, secureNativeApiSocket };
