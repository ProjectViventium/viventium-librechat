/**
 * === VIVENTIUM START ===
 * Release contracts for the exact Node, Docker, RAG, Sandpack, and Native HEIC delivery surfaces.
 * === VIVENTIUM END ===
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const NODE_VERSION = '24.16.0';
const NPM_VERSION = '11.13.0';
const RAG_LITE_IMAGE =
  'registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest@sha256:c0ad82657b556c1e16dcfca85d045788f67caa223e25e70eb687f4d16b41dedc';
const RAG_FULL_IMAGE =
  'registry.librechat.ai/danny-avila/librechat-rag-api-dev:latest@sha256:c3e1a05bdd576b5000fa0e8a84a476e9858fa9219b2b5d78432ddce12c9fcf23';

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = (file) => JSON.parse(read(file));

test('pins source, package, container, devcontainer, and CI to Node 24.16.0', () => {
  assert.equal(read('.nvmrc').trim(), NODE_VERSION);
  assert.equal(read('.node-version').trim(), NODE_VERSION);

  const packageJson = json('package.json');
  const lockfile = json('package-lock.json');
  assert.equal(packageJson.engines.node, NODE_VERSION);
  assert.equal(packageJson.packageManager, `npm@${NPM_VERSION}`);
  assert.equal(lockfile.packages[''].engines.node, NODE_VERSION);

  for (const file of ['Dockerfile', 'Dockerfile.multi']) {
    assert.match(read(file), new RegExp(`FROM node:${NODE_VERSION.replaceAll('.', '\\.')}-alpine`));
  }
  assert.deepEqual(
    [...read('Dockerfile.multi').matchAll(/ARG NODE_MAX_OLD_SPACE_SIZE=(\d+)/g)].map(
      (match) => match[1],
    ),
    ['2560', '2560'],
    'Docker client builds must fit beside supported services in an 8 GiB builder',
  );
  assert.match(
    read('Dockerfile'),
    /ARG NODE_MAX_OLD_SPACE_SIZE=2560/,
    'The legacy Docker entrypoint must use the same loaded-machine-safe heap budget',
  );
  assert.match(
    read('.devcontainer/Dockerfile'),
    new RegExp(`FROM node:${NODE_VERSION.replaceAll('.', '\\.')}-bookworm`),
  );

  const workflowDirectory = path.join(ROOT, '.github', 'workflows');
  const workflowVersions = fs
    .readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) =>
      [
        ...fs
          .readFileSync(path.join(workflowDirectory, file), 'utf8')
          .matchAll(/node-version:\s*['"]?([^'"\s]+)/g),
      ].map((match) => ({ file, version: match[1] })),
    );
  assert.ok(workflowVersions.length > 0, 'expected setup-node contracts in CI');
  assert.deepEqual(
    workflowVersions.filter(({ version }) => version !== NODE_VERSION),
    [],
    `all setup-node jobs must use ${NODE_VERSION}`,
  );
});

test('exactly pins direct production dependencies whose own engine requires Node 22 or 24', () => {
  const lockfile = json('package-lock.json');
  const workspaceManifests = [
    'api/package.json',
    'client/package.json',
    ...fs
      .readdirSync(path.join(ROOT, 'packages'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          fs.existsSync(path.join(ROOT, 'packages', entry.name, 'package.json')),
      )
      .map((entry) => `packages/${entry.name}/package.json`),
  ];
  const engineBoundDependencies = [];

  for (const manifestPath of workspaceManifests) {
    const manifest = json(manifestPath);
    for (const [name, requested] of Object.entries(manifest.dependencies || {})) {
      const locked = lockfile.packages[`node_modules/${name}`];
      if (!locked?.engines?.node || !/(?:>=\s*22|>=\s*24)/.test(locked.engines.node)) {
        continue;
      }
      engineBoundDependencies.push({ manifestPath, name, requested, locked });
    }
  }

  assert.ok(engineBoundDependencies.length > 0, 'expected dependencies with Node 22/24 engines');
  for (const { manifestPath, name, requested, locked } of engineBoundDependencies) {
    assert.equal(requested, locked.version, `${manifestPath} must exactly pin ${name}`);
    assert.match(locked.resolved || '', /^https:\/\//, `${name} must have a locked source`);
    assert.match(locked.integrity || '', /^sha512-/, `${name} must have locked integrity`);
  }
});

test('pins every supported RAG image to the registry-verified multi-platform digest', () => {
  for (const file of [
    'docker-compose.yml',
    'deploy-compose.yml',
    'utils/docker/test-compose.yml',
  ]) {
    assert.match(read(file), new RegExp(RAG_LITE_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const file of ['rag.yml', 'docker-compose.override.yml.example']) {
    assert.match(read(file), new RegExp(RAG_FULL_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  for (const file of [
    'docker-compose.yml',
    'deploy-compose.yml',
    'rag.yml',
    'utils/docker/test-compose.yml',
  ]) {
    assert.doesNotMatch(
      read(file),
      /^\s*image:\s+registry\.librechat\.ai\/danny-avila\/librechat-rag-api[^@\n]*:latest\s*$/m,
    );
  }
});

test('supported Compose entrypoints build the checked-out fork and expose isolated Sandpack', () => {
  for (const file of ['docker-compose.yml', 'deploy-compose.yml']) {
    const compose = read(file);
    assert.match(
      compose,
      /build:\s*\n\s+context:\s+\.\s*\n\s+dockerfile:\s+Dockerfile\.multi\s*\n\s+target:\s+api-build/,
    );
    assert.match(compose, /SANDPACK_BUNDLER_LISTEN_PORT=/);
    assert.match(compose, /127\.0\.0\.1:\$\{SANDPACK_BUNDLER_PORT:-3081\}/);
    assert.doesNotMatch(compose, /^\s*image:\s+.*librechat-dev(?:-api)?:latest\s*$/m);
  }
  assert.match(
    read('config/deployed-update.js'),
    /docker compose -f \.\/deploy-compose\.yml build api/,
  );
  assert.doesNotMatch(read('config/deployed-update.js'), /pull api/);
});

test('Docker API image ships the generated legal compliance bundle at a stable path', () => {
  const dockerfile = read('Dockerfile.multi');
  assert.match(
    dockerfile,
    /COPY --from=client-build \/app\/client\/dist-compliance \/app\/client\/dist-compliance/,
  );
  const buildScript = json('client/package.json').scripts.build;
  assert.match(buildScript, /collect-browser-compliance\.cjs --verify/);
  assert.ok(fs.statSync(path.join(ROOT, 'scripts/verify-viventium-docker-image.cjs')).isFile());

  const overrides = json('client/third_party/browser-compliance/overrides.json');
  assert.deepEqual(
    overrides.vendoredAdapters.map(({ id, upstreamPackage, upstreamVersion }) => ({
      id,
      upstreamPackage,
      upstreamVersion,
    })),
    [
      {
        id: 'react-remove-scroll-bar-adapter',
        upstreamPackage: 'react-remove-scroll-bar',
        upstreamVersion: '2.3.8',
      },
      {
        id: 'use-composed-ref-adapter',
        upstreamPackage: 'use-composed-ref',
        upstreamVersion: '1.4.0',
      },
      {
        id: 'html-parse-stringify-adapter',
        upstreamPackage: 'html-parse-stringify',
        upstreamVersion: '3.0.1',
      },
    ],
  );
  const imageVerifier = read('scripts/verify-viventium-docker-image.cjs');
  for (const adapter of overrides.vendoredAdapters) {
    assert.match(imageVerifier, new RegExp(adapter.id));
  }
});

test('Docker build contexts exclude personal runtime state without excluding source assets', () => {
  const patterns = new Set(
    read('.dockerignore')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  for (const pattern of [
    'data-node',
    'data-node-*',
    'meili_data*',
    'images',
    'uploads',
    '.rag-pgdata*',
  ]) {
    assert.ok(patterns.has(pattern), `missing Docker context exclusion: ${pattern}`);
  }
  for (const unsafePattern of ['**/images', '**/uploads', 'client/public/images']) {
    assert.ok(
      !patterns.has(unsafePattern),
      `source-breaking Docker ignore pattern: ${unsafePattern}`,
    );
  }
  assert.ok(fs.statSync(path.join(ROOT, 'scripts/verify-docker-build-context.cjs')).isFile());
});

test('Native API startup runs a zero-age bounded HEIC temp scavenger before serving', () => {
  const server = read('api/server/index.js');
  assert.match(server, /await scavengeNativeHeicTemporaryFiles\([\s\S]*minimumAgeMs:\s*0/);
});
