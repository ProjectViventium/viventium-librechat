const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertCuratedFileRecord,
  assertExactLockedIdentity,
  assertSafeLockPath,
  clearGeneratedComplianceState,
  curatedFileName,
  sha256,
  validateCuratedSource,
  verifyFileRecord,
} = require('../../../scripts/collect-browser-compliance.cjs');
const curatedOverrides = require('../../../third_party/browser-compliance/overrides.json');

describe('browser compliance collector', () => {
  it.each([
    'node_modules/react',
    'node_modules/react/node_modules/loose-envify',
    'packages/client/node_modules/lucide-react',
  ])('accepts normalized physical package-lock path %s', (lockPath) => {
    expect(() => assertSafeLockPath(lockPath)).not.toThrow();
  });

  it.each([
    '../secret',
    '/absolute/node_modules/package',
    'node_modules/../secret',
    'client\\node_modules\\package',
    'node_modules',
  ])('rejects unsafe package-lock path %s', (lockPath) => {
    expect(() => assertSafeLockPath(lockPath)).toThrow(/unsafe package-lock path/);
  });

  it('produces the expected SHA-256 digest for copied legal bytes', () => {
    expect(sha256(Buffer.from('fixture'))).toBe(
      'f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d',
    );
  });

  it('pins every curated source to exact immutable bytes and explicit package identities', () => {
    expect(new Set(curatedOverrides.sources.map((source) => source.id)).size).toBe(
      curatedOverrides.sources.length,
    );
    curatedOverrides.sources.forEach((source) => {
      expect(() => validateCuratedSource(source)).not.toThrow();
      expect(curatedFileName(source)).toMatch(/^(?:LICENSE|NOTICE)\.curated\./);
    });
    curatedOverrides.packageOverrides.forEach((packageOverride) => {
      expect(packageOverride.lockPath).not.toContain('*');
      expect(packageOverride.version).not.toContain('*');
      expect(packageOverride.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(packageOverride.integrity).toMatch(/^sha512-/);
    });
  });

  it('rejects curated identity and shipped provenance drift', () => {
    const packageOverride = curatedOverrides.packageOverrides[0];
    const source = curatedOverrides.sources.find(
      (entry) => entry.id === packageOverride.legalSourceId,
    );
    const expectedDirectory = 'licenses/synthetic';
    const fileRecord = {
      path: `${expectedDirectory}/${curatedFileName(source)}`,
      sha256: source.sha256,
      provenance: {
        sourceId: source.id,
        repository: source.repository,
        revision: source.revision,
        sourcePath: source.sourcePath,
        sourceSha256: source.sha256,
        contentRole: source.contentRole,
        provenance: source.provenance,
      },
    };

    expect(() =>
      assertExactLockedIdentity(
        packageOverride,
        {
          version: packageOverride.version,
          resolved: packageOverride.resolved,
          integrity: packageOverride.integrity,
        },
        packageOverride.name,
        'synthetic override',
      ),
    ).not.toThrow();
    expect(() =>
      assertExactLockedIdentity(
        packageOverride,
        {
          version: `${packageOverride.version}-drift`,
          resolved: packageOverride.resolved,
          integrity: packageOverride.integrity,
        },
        packageOverride.name,
        'synthetic override',
      ),
    ).toThrow(/does not exactly match/);
    expect(() =>
      assertCuratedFileRecord(fileRecord, source, expectedDirectory, 'synthetic record'),
    ).not.toThrow();
    expect(() =>
      assertCuratedFileRecord(
        { ...fileRecord, sha256: '0'.repeat(64) },
        source,
        expectedDirectory,
        'synthetic record',
      ),
    ).toThrow(/provenance mismatch/);
  });

  it('clears stale blockers and manifests before a new compliance collection', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-compliance-state-'));
    fs.mkdirSync(path.join(tempDirectory, 'licenses'));
    fs.mkdirSync(path.join(tempDirectory, 'vendored'));
    fs.writeFileSync(path.join(tempDirectory, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(tempDirectory, 'blockers.json'), '{}');

    try {
      clearGeneratedComplianceState(tempDirectory);
      expect(fs.readdirSync(tempDirectory)).toEqual([]);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('verifies a regular legal file and rejects digest drift and symlinks', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-compliance-'));
    const licensePath = path.join(tempDirectory, 'LICENSE');
    const symlinkPath = path.join(tempDirectory, 'LICENSE.link');
    fs.writeFileSync(licensePath, 'synthetic license fixture');
    fs.symlinkSync(licensePath, symlinkPath);
    const digest = sha256(Buffer.from('synthetic license fixture'));

    try {
      expect(
        verifyFileRecord({ path: 'LICENSE', sha256: digest }, 'test legal file', tempDirectory),
      ).toEqual(Buffer.from('synthetic license fixture'));
      expect(() =>
        verifyFileRecord(
          { path: 'LICENSE', sha256: '0'.repeat(64) },
          'test legal file',
          tempDirectory,
        ),
      ).toThrow(/hash mismatch/);
      expect(() =>
        verifyFileRecord(
          { path: 'LICENSE.link', sha256: digest },
          'test legal file',
          tempDirectory,
        ),
      ).toThrow(/not a regular owned file/);
      expect(() =>
        verifyFileRecord({ path: 'LICENSE', sha256: 'invalid' }, 'test legal file', tempDirectory),
      ).toThrow(/invalid test legal file record/);
    } finally {
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
