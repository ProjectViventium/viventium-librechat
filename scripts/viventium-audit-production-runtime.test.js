const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadBuiltApi } = require('./viventium-audit-production-runtime');

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
