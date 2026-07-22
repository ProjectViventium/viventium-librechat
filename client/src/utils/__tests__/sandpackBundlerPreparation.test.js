const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ON_PREM_BOOTSTRAP,
  PINNED_OUTPUT_INDEX_SHA256,
  PINNED_SOURCE_INDEX_SHA256,
  PINNED_SOURCE_RUNTIME_SHA256,
  PINNED_SOURCE_TREE_SHA256,
  PINNED_OUTPUT_TREE_SHA256,
  injectOnPremEnvironment,
  prepareSandpackBundler,
  sha256,
} = require('../../../scripts/prepare-local-sandpack-bundler.cjs');

describe('local Sandpack bundler preparation', () => {
  it('injects the supported on-prem flag before all runtime scripts exactly once', () => {
    const source = '<!doctype html><html><head><script src="/first.js"></script></head></html>';
    const output = injectOnPremEnvironment(source);

    expect(output.indexOf(ON_PREM_BOOTSTRAP)).toBeGreaterThan(output.indexOf('<head>'));
    expect(output.indexOf(ON_PREM_BOOTSTRAP)).toBeLessThan(output.indexOf('/first.js'));
    expect(output.match(/IS_ONPREM/g)).toHaveLength(1);
    expect(() => injectOnPremEnvironment(output)).toThrow(/already declares the on-prem flag/);
  });

  it('copies only pinned upstream bytes and emits a pinned telemetry-disabled index', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sandpack-bundler-'));
    const destinationRoot = path.join(tempDirectory, 'sandpack-bundler');

    try {
      const result = prepareSandpackBundler({
        destinationRoot,
        copyFile: (source, destination) => fs.copyFileSync(source, destination),
      });
      const indexBytes = fs.readFileSync(path.join(destinationRoot, 'index.html'));
      const runtimeBytes = fs.readFileSync(
        path.join(destinationRoot, 'static/js/sandbox.8a7d01a44.js'),
      );

      expect(result.sourceIndexSha256).toBe(PINNED_SOURCE_INDEX_SHA256);
      expect(result.outputIndexSha256).toBe(PINNED_OUTPUT_INDEX_SHA256);
      expect(result.runtimeSha256).toBe(PINNED_SOURCE_RUNTIME_SHA256);
      expect(result.sourceTreeSha256).toBe(PINNED_SOURCE_TREE_SHA256);
      expect(result.outputTreeSha256).toBe(PINNED_OUTPUT_TREE_SHA256);
      expect(sha256(indexBytes)).toBe(PINNED_OUTPUT_INDEX_SHA256);
      expect(sha256(runtimeBytes)).toBe(PINNED_SOURCE_RUNTIME_SHA256);
      expect(indexBytes.toString('utf8')).toContain(
        'window._env_=Object.assign({},window._env_,{IS_ONPREM:"true"})',
      );
      const typescriptParser = fs.readFileSync(
        path.join(destinationRoot, 'static/js/prettier/1.16.4/parser-typescript.js'),
        'utf8',
      );
      const browserFs = fs.readFileSync(
        path.join(destinationRoot, 'static/browserfs12/browserfs.js'),
        'utf8',
      );
      expect(typescriptParser).not.toMatch(/\/Users\/[A-Za-z0-9._-]+\//);
      expect(typescriptParser).toContain('/virtual/typescript/lib');
      expect(browserFs).not.toMatch(/\/home\/(?!ai(?:\/|\b)|myself(?:\/|\b)|sandbox(?:\/|\b))/);
      expect(browserFs).toContain('/virtual/browserfs');
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
