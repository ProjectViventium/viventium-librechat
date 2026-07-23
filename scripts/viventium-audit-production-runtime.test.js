const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadBuiltApi,
  readResolvedPackageVersion,
  versionAtLeast,
} = require('./viventium-audit-production-runtime');

function writeModule(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('post-prune runtime load fails closed on an externalized missing import', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-runtime-load-missing-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeModule(root, 'package.json', '{}\n');
  writeModule(
    root,
    'node_modules/@librechat/api/package.json',
    '{"name":"@librechat/api","main":"dist/index.js"}\n',
  );
  writeModule(
    root,
    'node_modules/@librechat/api/dist/index.js',
    "module.exports = require('mongodb');\n",
  );

  assert.throws(() => loadBuiltApi(root), { code: 'MODULE_NOT_FOUND' });
});

test('post-prune runtime load executes the built API entrypoint', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-runtime-load-pass-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeModule(root, 'package.json', '{}\n');
  writeModule(
    root,
    'node_modules/@librechat/api/package.json',
    '{"name":"@librechat/api","main":"dist/index.js"}\n',
  );
  writeModule(
    root,
    'node_modules/@librechat/api/dist/index.js',
    "module.exports = require('mongodb');\n",
  );
  writeModule(root, 'node_modules/mongodb/index.js', "module.exports = { marker: 'loaded' };\n");

  assert.deepEqual(loadBuiltApi(root), { marker: 'loaded' });
});

test('production dependency version checks compare numeric components', () => {
  assert.equal(versionAtLeast('0.35.3', '0.35.3'), true);
  assert.equal(versionAtLeast('0.35.10', '0.35.3'), true);
  assert.equal(versionAtLeast('0.35.2', '0.35.3'), false);
  assert.equal(versionAtLeast('2.0.11', '2.0.11'), true);
  assert.equal(versionAtLeast('2.0.10', '2.0.11'), false);
});

test('production dependency version checks resolve the owning package manifest', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-runtime-version-pass-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeModule(root, 'package.json', '{}\n');
  writeModule(
    root,
    'node_modules/example-package/package.json',
    '{"name":"example-package","version":"2.0.11","main":"dist/index.js"}\n',
  );
  writeModule(root, 'node_modules/example-package/dist/index.js', 'module.exports = {};\n');
  const requireFromRoot = require('node:module').createRequire(path.join(root, 'package.json'));

  assert.equal(readResolvedPackageVersion(requireFromRoot, 'example-package'), '2.0.11');
});
