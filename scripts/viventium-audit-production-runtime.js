const path = require('node:path');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const projectRoot = path.resolve(__dirname, '..');

function loadBuiltApi(root = projectRoot) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const apiEntry = requireFromRoot.resolve('@librechat/api');
  return requireFromRoot(apiEntry);
}

function versionAtLeast(actual, minimum) {
  const actualParts = String(actual).split('.').map(Number);
  const minimumParts = String(minimum).split('.').map(Number);
  for (let index = 0; index < Math.max(actualParts.length, minimumParts.length); index += 1) {
    const actualPart = actualParts[index] || 0;
    const minimumPart = minimumParts[index] || 0;
    if (actualPart !== minimumPart) {
      return actualPart > minimumPart;
    }
  }
  return true;
}

function readResolvedPackageVersion(requireFromRoot, packageName) {
  let directory = path.dirname(requireFromRoot.resolve(packageName));
  while (directory !== path.dirname(directory)) {
    const candidate = path.join(directory, 'package.json');
    if (fs.existsSync(candidate)) {
      const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return manifest.version;
      }
    }
    directory = path.dirname(directory);
  }
  throw new Error(`Could not resolve package metadata for ${packageName}`);
}

async function verifyProductionDependencies(root = projectRoot) {
  const requireFromBackend = createRequire(path.join(root, 'api', 'package.json'));
  const sharp = requireFromBackend('sharp');
  assert.equal(versionAtLeast(sharp.versions.sharp, '0.35.3'), true);
  assert.equal(versionAtLeast(sharp.versions.vips, '8.18.3'), true);

  const input = Buffer.from(
    '<svg width="8" height="6" xmlns="http://www.w3.org/2000/svg"><rect width="8" height="6" fill="#6655dd"/></svg>',
  );
  const png = await sharp(input).resize(4, 3).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 4);
  assert.equal(metadata.height, 3);

  const streamableHttpPath = requireFromBackend.resolve(
    '@modelcontextprotocol/sdk/server/streamableHttp.js',
  );
  const requireFromSdk = createRequire(streamableHttpPath);
  const hono = requireFromSdk('@hono/node-server');
  assert.equal(typeof hono.getRequestListener, 'function');
  assert.equal(
    versionAtLeast(readResolvedPackageVersion(requireFromSdk, '@hono/node-server'), '2.0.11'),
    true,
  );

  const streamableHttp = requireFromBackend('@modelcontextprotocol/sdk/server/streamableHttp.js');
  assert.equal(typeof streamableHttp.StreamableHTTPServerTransport, 'function');
}

// VIVENTIUM START: exercise patched parsers through their production dependency owners.
function verifyStructuredInputDependencies(root = projectRoot) {
  const requireFromBackend = createRequire(path.join(root, 'api', 'package.json'));
  const requireFromExpress = createRequire(requireFromBackend.resolve('express'));
  const qs = requireFromExpress('qs');
  assert.equal(versionAtLeast(readResolvedPackageVersion(requireFromExpress, 'qs'), '6.16.0'), true);
  const parsedQuery = qs.parse('record[constructor][isBuffer]=invalid', { plainObjects: true });
  assert.doesNotThrow(() => qs.stringify(parsedQuery));
  assert.equal(qs.parse(qs.stringify({ record: { title: 'Useful report' } })).record.title, 'Useful report');

  const requireFromSdk = createRequire(requireFromBackend.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  const requireFromAjv = createRequire(requireFromSdk.resolve('ajv'));
  const uri = requireFromAjv('fast-uri');
  assert.equal(versionAtLeast(readResolvedPackageVersion(requireFromAjv, 'fast-uri'), '3.1.6'), true);
  assert.equal(uri.resolve('https://base.invalid/', '//exämple.invalid/report'), 'https://xn--exmple-cua.invalid/report');
  assert.equal(uri.resolve('https://base.invalid/work/', '../report'), 'https://base.invalid/report');

  const { DOMImplementation, DOMParser, XMLSerializer } = requireFromBackend('@xmldom/xmldom');
  assert.equal(versionAtLeast(readResolvedPackageVersion(requireFromBackend, '@xmldom/xmldom'), '0.8.15'), true);
  const document = new DOMImplementation().createDocument(null, 'root', null);
  assert.throws(() => {
    const reference = document.createEntityReference('safe; <injected/> &x');
    new XMLSerializer().serializeToString(reference, { requireWellFormed: true });
  }, /not a valid xml name/);
  assert.equal(new DOMParser().parseFromString('<report>Useful work</report>', 'text/xml').documentElement.textContent, 'Useful work');
}
// VIVENTIUM END

async function main() {
  loadBuiltApi();
  await verifyProductionDependencies();
  verifyStructuredInputDependencies();
  console.log(
    'PASS: pruned production runtime loads @librechat/api, patched image processing, MCP HTTP transport, and structured input parsers.',
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  loadBuiltApi,
  readResolvedPackageVersion,
  verifyProductionDependencies,
  verifyStructuredInputDependencies,
  versionAtLeast,
};
