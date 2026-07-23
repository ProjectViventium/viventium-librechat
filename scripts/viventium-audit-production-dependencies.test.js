const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseFailedNpmList,
  isAuditedMCPHonoOverride,
} = require('./viventium-audit-production-dependencies');

const projectRoot = path.resolve(__dirname, '..');

test('production dependency audit is wired into the public package scripts', () => {
  const packageJSON = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const apiPackageJSON = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'packages/api/package.json'), 'utf8'),
  );
  const backendPackageJSON = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'api/package.json'), 'utf8'),
  );

  assert.equal(
    packageJSON.scripts['test:production-dependency-tree'],
    'node scripts/viventium-audit-production-dependencies.js',
  );
  assert.equal(
    packageJSON.scripts['test:production-runtime-load'],
    'node scripts/viventium-audit-production-runtime.js',
  );
  assert.equal(apiPackageJSON.devDependencies.mongodb, '^6.14.2');
  assert.equal(apiPackageJSON.peerDependencies.mongodb, '^6.14.2');
  assert.equal(backendPackageJSON.dependencies.mongodb, '^6.14.2');
  assert.equal(packageJSON.devDependencies.mongodb, '6.21.0');
  assert.equal(packageJSON.overrides['@anthropic-ai/sdk'], '^0.103.0');
  assert.equal(packageJSON.overrides['@hono/node-server'], '2.0.11');
  assert.equal(packageJSON.overrides['@modelcontextprotocol/sdk']['@hono/node-server'], '2.0.11');
  assert.equal(backendPackageJSON.dependencies.sharp, '^0.35.3');
  assert.equal(packageJSON.overrides.tslib, undefined);
  assert.equal(packageJSON.overrides['monaco-editor'].dompurify, '^3.4.12');
});

test('failed npm ls without a structured problems array fails closed', () => {
  assert.throws(
    () => parseFailedNpmList({ stdout: JSON.stringify({ error: { code: 'EUNKNOWN' } }) }),
    /without a structured problems array/,
  );
  assert.throws(() => parseFailedNpmList({ stdout: 'not-json' }), /without valid JSON/);
  assert.throws(() => parseFailedNpmList({}), /without JSON output/);
});

test('failed npm ls returns only its explicit structured problems', () => {
  assert.deepEqual(
    parseFailedNpmList({ stdout: JSON.stringify({ problems: ['invalid: example@1.0.0'] }) }),
    ['invalid: example@1.0.0'],
  );
});

test('only the installed, minimum-safe MCP Hono security override is accepted', () => {
  assert.equal(
    isAuditedMCPHonoOverride(
      'invalid: @hono/node-server@2.0.11 /synthetic/node_modules/@hono/node-server',
    ),
    true,
  );
  assert.equal(
    isAuditedMCPHonoOverride(
      'invalid: @hono/node-server@2.0.10 /synthetic/node_modules/@hono/node-server',
    ),
    false,
  );
  assert.equal(isAuditedMCPHonoOverride('invalid: unrelated@1.0.0 /synthetic'), false);
});
