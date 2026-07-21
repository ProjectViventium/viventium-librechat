/**
 * === VIVENTIUM START ===
 * Release gate: inspect the real offline API image runtime, legal bundle, and privacy boundary.
 * === VIVENTIUM END ===
 */

const { spawnSync } = require('node:child_process');

const image = process.argv[2];
if (!image || !/^[A-Za-z0-9._/:@-]+$/.test(image)) {
  console.error('Usage: node scripts/verify-viventium-docker-image.cjs <local-image-reference>');
  process.exit(2);
}

const verifier = String.raw`
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
if (process.version !== 'v24.16.0') throw new Error('unexpected Node runtime: ' + process.version);
const npmPackage = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/npm/package.json', 'utf8'));
if (npmPackage.version !== '11.13.0') throw new Error('unexpected npm runtime: ' + npmPackage.version);
for (const required of [
  '/app/api/server/index.js',
  '/app/client/dist/index.html',
  '/app/packages/api/dist/index.js',
  '/app/packages/data-provider/dist/index.js',
  '/app/packages/data-schemas/dist/index.cjs',
]) {
  if (!fs.statSync(required).isFile()) throw new Error('missing shipped runtime file');
}
for (const forbidden of ['/app/data-node', '/app/images', '/app/uploads', '/app/.rag-pgdata']) {
  if (fs.existsSync(forbidden)) throw new Error('private runtime state entered image');
}
const root = '/app/client/dist-compliance';
const manifestPath = path.join(root, 'manifest.json');
const closurePath = path.join(root, 'module-closure.json');
for (const required of [manifestPath, closurePath]) {
  if (!fs.statSync(required).isFile()) throw new Error('missing compliance manifest');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (!Array.isArray(manifest.packages) || manifest.packages.length < 400) {
  throw new Error('compliance package inventory is incomplete');
}
const requiredAdapters = new Map([
  ['react-remove-scroll-bar-adapter', ['react-remove-scroll-bar', '2.3.8']],
  ['use-composed-ref-adapter', ['use-composed-ref', '1.4.0']],
  ['html-parse-stringify-adapter', ['html-parse-stringify', '3.0.1']],
]);
for (const [id, [upstreamPackage, upstreamVersion]] of requiredAdapters) {
  const adapter = manifest.vendoredComponents?.find((component) => component.id === id);
  if (
    !adapter ||
    adapter.upstreamPackage !== upstreamPackage ||
    adapter.upstreamVersion !== upstreamVersion ||
    adapter.license !== 'MIT' ||
    adapter.modified !== true ||
    !adapter.notice ||
    !Array.isArray(adapter.legalFiles) ||
    adapter.legalFiles.length === 0
  ) {
    throw new Error('missing shipped browser adapter attribution: ' + id);
  }
  for (const record of [adapter.notice, ...adapter.legalFiles]) {
    const absolutePath = path.resolve(root, record.path);
    if (!absolutePath.startsWith(root + path.sep) || !fs.statSync(absolutePath).isFile()) {
      throw new Error('unsafe or missing browser adapter legal file: ' + id);
    }
    const digest = crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
    if (digest !== record.sha256) throw new Error('browser adapter legal hash drift: ' + id);
  }
}
let files = 0;
let legalFiles = 0;
function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(entryPath);
    else if (entry.isFile()) {
      files += 1;
      if (/license|notice|copying/i.test(entry.name)) legalFiles += 1;
    }
  }
}
visit(root);
if (files < 900 || legalFiles < 400) throw new Error('shipped compliance payload is incomplete');
console.log(JSON.stringify({
  node: process.version,
  npm: npmPackage.version,
  root,
  files,
  legalFiles,
  packages: manifest.packages.length,
}));
`;

const result = spawnSync(
  'docker',
  ['run', '--rm', '--network', 'none', '--entrypoint', 'node', image, '-e', verifier],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout);
