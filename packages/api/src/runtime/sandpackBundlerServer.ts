import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type SandpackBundlerServerOptions = {
  applicationOrigin: string;
  host: string;
  port: number;
  publicOrigin: string;
  root: string;
};

type ResolveSandpackBundlerServerConfigOptions = {
  distPath: string;
  env: RuntimeEnvironment;
};

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.sh': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ts': 'text/plain; charset=utf-8',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml; charset=utf-8',
};

const parseCanonicalOriginRootURL = (value: string): URL | null => {
  try {
    const url = new URL(value);
    const isOriginRoot =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      url.username === '' &&
      url.password === '' &&
      url.href === value;
    return isOriginRoot ? url : null;
  } catch {
    return null;
  }
};

const parseApplicationOrigin = (value: string | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

const effectivePort = (url: URL): number => {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === 'https:' ? 443 : 80;
};

const validatePublicURLs = (
  env: RuntimeEnvironment,
  listenPort: number,
): { applicationOrigin: string; publicOrigin: string } => {
  const bundlerURL = env.SANDPACK_BUNDLER_URL;
  const staticBundlerURL = env.SANDPACK_STATIC_BUNDLER_URL;
  if (!bundlerURL || !staticBundlerURL) {
    throw new Error(
      'The isolated Sandpack listener requires both public URLs: SANDPACK_BUNDLER_URL and SANDPACK_STATIC_BUNDLER_URL',
    );
  }
  const parsedBundlerURL = parseCanonicalOriginRootURL(bundlerURL);
  const parsedStaticBundlerURL = parseCanonicalOriginRootURL(staticBundlerURL);
  if (!parsedBundlerURL || !parsedStaticBundlerURL) {
    throw new Error(
      'Sandpack public URLs must be canonical absolute HTTP(S) origin-root URLs ending in /',
    );
  }
  if (parsedBundlerURL.origin !== parsedStaticBundlerURL.origin) {
    throw new Error('Sandpack public URLs must use the same isolated origin');
  }
  if (effectivePort(parsedBundlerURL) !== listenPort) {
    throw new Error('Sandpack public URL port must match SANDPACK_BUNDLER_LISTEN_PORT');
  }

  const applicationOrigin = parseApplicationOrigin(env.DOMAIN_CLIENT);
  if (!applicationOrigin) {
    throw new Error(
      'The isolated Sandpack listener requires DOMAIN_CLIENT to be an absolute HTTP(S) URL',
    );
  }
  if (parsedBundlerURL.origin === applicationOrigin) {
    throw new Error('The Sandpack origin must be different from DOMAIN_CLIENT');
  }
  return { applicationOrigin, publicOrigin: parsedBundlerURL.origin };
};

export const resolveSandpackBundlerServerConfig = ({
  distPath,
  env,
}: ResolveSandpackBundlerServerConfigOptions): SandpackBundlerServerOptions | null => {
  const configuredPort = env.SANDPACK_BUNDLER_LISTEN_PORT;
  if (!configuredPort) {
    return null;
  }
  if (env.VIVENTIUM_RUNTIME_PROFILE?.toLowerCase() === 'native') {
    throw new Error(
      'Native runtime must let the Viventium frontend proxy own the isolated Sandpack listener',
    );
  }

  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SANDPACK_BUNDLER_LISTEN_PORT must be an integer from 1 through 65535');
  }
  const { applicationOrigin, publicOrigin } = validatePublicURLs(env, port);

  return {
    applicationOrigin,
    host: env.SANDPACK_BUNDLER_LISTEN_HOST || '127.0.0.1',
    port,
    publicOrigin,
    root: path.join(distPath, 'sandpack-bundler'),
  };
};

const validateRuntimeRoot = (root: string): string => {
  const resolvedRoot = path.resolve(root);
  if (fs.lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error('Sandpack bundler root cannot be a symbolic link');
  }
  const realRoot = fs.realpathSync(resolvedRoot);

  const indexPath = path.join(realRoot, 'index.html');
  const indexHTML = fs.readFileSync(indexPath, 'utf8');
  if (!/IS_ONPREM\s*[:=]\s*["']true["']/.test(indexHTML)) {
    throw new Error('Sandpack index.html is missing the required IS_ONPREM=true privacy flag');
  }
  return realRoot;
};

const sendStatus = (response: ServerResponse, status: number): void => {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(`${status}\n`);
};

const setDefensiveHeaders = (response: ServerResponse, applicationOrigin: string): void => {
  response.setHeader('Access-Control-Allow-Origin', applicationOrigin);
  response.setHeader('Content-Security-Policy', `frame-ancestors ${applicationOrigin}`);
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Vary', 'Origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
};

const loopbackHostnames = new Set(['127.0.0.1', '[::1]', 'localhost']);

const allowedRequestHosts = (publicOrigin: string): ReadonlySet<string> => {
  const url = new URL(publicOrigin);
  const portSuffix = url.port ? `:${url.port}` : '';
  if (!loopbackHostnames.has(url.hostname)) {
    return new Set([url.host.toLowerCase()]);
  }
  return new Set([...loopbackHostnames].map((hostname) => `${hostname}${portSuffix}`));
};

const isContentAddressedFile = (filePath: string): boolean =>
  /(?:^|[.-])[a-f0-9]{8,64}(?=[.-]|$)/i.test(path.basename(filePath));

const resolveRequestFile = (requestURL: string, root: string): string | null => {
  const rawPath = requestURL.split('?', 1)[0];
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return null;
  }

  const segments = decodedPath.replace(/\\/g, '/').split('/');
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) {
    return null;
  }

  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
  const candidate = path.resolve(root, relativePath);
  if (!candidate.startsWith(`${root}${path.sep}`)) {
    return null;
  }

  try {
    const realCandidate = fs.realpathSync(candidate);
    if (!realCandidate.startsWith(`${root}${path.sep}`) || !fs.statSync(realCandidate).isFile()) {
      return null;
    }
    return realCandidate;
  } catch {
    return null;
  }
};

export const startSandpackBundlerServer = async ({
  applicationOrigin,
  host,
  port,
  publicOrigin,
  root,
}: SandpackBundlerServerOptions): Promise<Server> => {
  const realRoot = validateRuntimeRoot(root);
  const acceptedHosts = allowedRequestHosts(publicOrigin);
  const server = createServer((request, response) => {
    setDefensiveHeaders(response, applicationOrigin);
    const requestHost = request.headers.host?.toLowerCase();
    if (!requestHost || !acceptedHosts.has(requestHost)) {
      sendStatus(response, 421);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendStatus(response, 405);
      return;
    }

    const filePath = resolveRequestFile(request.url || '/', realRoot);
    if (!filePath) {
      sendStatus(response, 404);
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      sendStatus(response, 404);
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    response.statusCode = 200;
    response.setHeader('Content-Type', MIME_TYPES[extension] || 'application/octet-stream');
    response.setHeader('Content-Length', stat.size);
    response.setHeader(
      'Cache-Control',
      isContentAddressedFile(filePath) ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    if (extension === '.js') {
      response.setHeader('Service-Worker-Allowed', '/');
    }
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.once('error', (error: NodeJS.ErrnoException) => {
      if (!response.headersSent) {
        response.removeHeader('Content-Length');
        sendStatus(response, error.code === 'ENOENT' ? 404 : 500);
        return;
      }
      response.destroy(error);
    });
    stream.pipe(response);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => reject(error);
    server.once('error', handleError);
    server.listen(port, host, () => {
      server.off('error', handleError);
      resolve();
    });
  });
  return server;
};
