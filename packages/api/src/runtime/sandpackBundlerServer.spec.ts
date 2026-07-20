import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  resolveSandpackBundlerServerConfig,
  startSandpackBundlerServer,
} from './sandpackBundlerServer';

const ON_PREM_FLAG = '<script>window._env_={IS_ONPREM:"true"}</script>';

const createFixture = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandpack-runtime-'));
  fs.mkdirSync(path.join(root, 'static', 'js'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'index.html'),
    `${ON_PREM_FLAG}<script src="/static/js/app.js"></script>`,
  );
  fs.writeFileSync(path.join(root, 'static', 'js', 'app.js'), 'self.fixture=true;');
  fs.writeFileSync(path.join(root, 'static', 'js', 'app.abcdef12.js'), 'self.hashed=true;');
  return root;
};

const closeServer = async (server: Server | null): Promise<void> => {
  if (!server) {
    return;
  }
  server.close();
  await once(server, 'close');
};

describe('Sandpack bundler server configuration', () => {
  it('stays disabled unless an isolated listener port is explicitly configured', () => {
    expect(resolveSandpackBundlerServerConfig({ distPath: '/tmp/dist', env: {} })).toBeNull();
  });

  it('resolves a loopback listener and requires both public root URLs', () => {
    expect(
      resolveSandpackBundlerServerConfig({
        distPath: '/tmp/dist',
        env: {
          SANDPACK_BUNDLER_LISTEN_PORT: '3191',
          SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/',
          SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
          DOMAIN_CLIENT: 'http://127.0.0.1:3190',
        },
      }),
    ).toEqual({
      applicationOrigin: 'http://127.0.0.1:3190',
      host: '127.0.0.1',
      port: 3191,
      publicOrigin: 'http://127.0.0.1:3191',
      root: path.join('/tmp/dist', 'sandpack-bundler'),
    });
  });

  it.each([
    [{ SANDPACK_BUNDLER_LISTEN_PORT: '0' }, 'integer from 1 through 65535'],
    [{ SANDPACK_BUNDLER_LISTEN_PORT: '3191', SANDPACK_BUNDLER_URL: '' }, 'both public URLs'],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/nested',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
        DOMAIN_CLIENT: 'http://127.0.0.1:3190',
      },
      'origin-root URLs',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
        DOMAIN_CLIENT: 'http://127.0.0.1:3190',
      },
      'ending in /',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/',
        SANDPACK_STATIC_BUNDLER_URL: 'http://localhost:3191/',
        DOMAIN_CLIENT: 'http://127.0.0.1:3190',
      },
      'same isolated origin',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:4191/',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:4191/',
        DOMAIN_CLIENT: 'http://127.0.0.1:3190',
      },
      'port must match',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
      },
      'requires DOMAIN_CLIENT',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
        DOMAIN_CLIENT: 'http://127.0.0.1:3191',
      },
      'different from DOMAIN_CLIENT',
    ],
    [
      {
        SANDPACK_BUNDLER_LISTEN_PORT: '3191',
        SANDPACK_BUNDLER_URL: 'http://127.0.0.1:3191/',
        SANDPACK_STATIC_BUNDLER_URL: 'http://127.0.0.1:3191/',
        VIVENTIUM_RUNTIME_PROFILE: 'native',
        DOMAIN_CLIENT: 'http://127.0.0.1:3190',
      },
      'frontend proxy own',
    ],
  ])('rejects unsafe or incomplete configuration %#', (env, message) => {
    expect(() => resolveSandpackBundlerServerConfig({ distPath: '/tmp/dist', env })).toThrow(
      message,
    );
  });
});

describe('isolated Sandpack bundler HTTP server', () => {
  let root: string;
  let server: Server | null = null;

  beforeEach(() => {
    root = createFixture();
  });

  afterEach(async () => {
    await closeServer(server);
    fs.rmSync(root, { recursive: true, force: true });
    server = null;
  });

  const start = async (): Promise<string> => {
    const probe = createNetServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const probeAddress = probe.address();
    if (!probeAddress || typeof probeAddress === 'string') {
      throw new Error('Expected a TCP listener');
    }
    const port = probeAddress.port;
    probe.close();
    await once(probe, 'close');

    const publicOrigin = `http://127.0.0.1:${port}`;
    server = await startSandpackBundlerServer({
      applicationOrigin: 'http://127.0.0.1:3190',
      host: '127.0.0.1',
      port,
      publicOrigin,
      root,
    });
    return publicOrigin;
  };

  const requestStatusWithHost = async (origin: string, requestHost: string): Promise<number> => {
    const url = new URL(origin);
    return await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          headers: { Host: requestHost },
          hostname: url.hostname,
          path: '/',
          port: url.port,
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode || 0));
        },
      );
      request.once('error', reject);
      request.end();
    });
  };

  it('serves only GET/HEAD files from the verified bundler root with defensive headers', async () => {
    const origin = await start();
    const indexResponse = await fetch(`${origin}/`);
    const scriptResponse = await fetch(`${origin}/static/js/app.js`);
    const hashedScriptResponse = await fetch(`${origin}/static/js/app.abcdef12.js`);
    const headResponse = await fetch(`${origin}/static/js/app.js`, { method: 'HEAD' });
    const postResponse = await fetch(`${origin}/`, { method: 'POST' });

    expect(indexResponse.status).toBe(200);
    expect(await indexResponse.text()).toContain('IS_ONPREM');
    expect(indexResponse.headers.get('cache-control')).toBe('no-store');
    expect(indexResponse.headers.get('referrer-policy')).toBe('no-referrer');
    expect(indexResponse.headers.get('x-content-type-options')).toBe('nosniff');
    expect(indexResponse.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:3190');
    expect(indexResponse.headers.get('content-security-policy')).toBe(
      'frame-ancestors http://127.0.0.1:3190',
    );
    expect(scriptResponse.status).toBe(200);
    expect(scriptResponse.headers.get('content-type')).toContain('javascript');
    expect(scriptResponse.headers.get('cache-control')).toBe('no-store');
    expect(hashedScriptResponse.status).toBe(200);
    expect(hashedScriptResponse.headers.get('cache-control')).toContain('immutable');
    expect(headResponse.status).toBe(200);
    expect(await headResponse.text()).toBe('');
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get('allow')).toBe('GET, HEAD');
  });

  it('accepts loopback aliases at the configured port and rejects foreign or wrong-port hosts', async () => {
    const origin = await start();
    const port = new URL(origin).port;
    const aliasStatus = await requestStatusWithHost(origin, `localhost:${port}`);
    const foreignStatus = await requestStatusWithHost(origin, 'example.com');
    const wrongPortStatus = await requestStatusWithHost(origin, `127.0.0.1:${Number(port) + 1}`);

    expect(aliasStatus).toBe(200);
    expect(foreignStatus).toBe(421);
    expect(wrongPortStatus).toBe(421);
  });

  it.each(['/../package.json', '/%2e%2e/package.json', '/.env', '/missing.js'])(
    'does not expose paths outside the dedicated root: %s',
    async (requestPath) => {
      const origin = await start();
      const response = await fetch(`${origin}${requestPath}`);

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('workspaces');
    },
  );

  it('does not follow a symbolic link that escapes the dedicated root', async () => {
    const outsideFile = path.join(path.dirname(root), 'private-fixture.txt');
    fs.writeFileSync(outsideFile, 'must-not-be-served');
    fs.symlinkSync(outsideFile, path.join(root, 'escape.txt'));

    try {
      const origin = await start();
      const response = await fetch(`${origin}/escape.txt`);

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('must-not-be-served');
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it('returns a controlled status if a file disappears between validation and streaming', async () => {
    const originalCreateReadStream = fs.createReadStream.bind(fs);
    const createReadStreamSpy = jest
      .spyOn(fs, 'createReadStream')
      .mockImplementationOnce((filePath) => {
        fs.rmSync(filePath);
        return originalCreateReadStream(filePath);
      });

    try {
      const origin = await start();
      const response = await fetch(`${origin}/static/js/app.js`);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('404\n');
    } finally {
      createReadStreamSpy.mockRestore();
    }
  });

  it('fails closed before listening when the generated runtime is missing or not on-prem', async () => {
    fs.rmSync(path.join(root, 'index.html'));
    await expect(startSandpackBundlerServer({ host: '127.0.0.1', port: 0, root })).rejects.toThrow(
      'index.html',
    );

    fs.writeFileSync(path.join(root, 'index.html'), '<script src="/static/js/app.js"></script>');
    await expect(startSandpackBundlerServer({ host: '127.0.0.1', port: 0, root })).rejects.toThrow(
      'IS_ONPREM',
    );
  });
});
