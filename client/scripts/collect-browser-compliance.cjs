const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clientRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(clientRoot, '..');
const complianceRoot = path.join(clientRoot, 'dist-compliance');
const closurePath = path.join(complianceRoot, 'module-closure.json');
const packageLockPath = path.join(repositoryRoot, 'package-lock.json');
const curatedSourceRoot = path.join(clientRoot, 'third_party/browser-compliance');
const curatedOverridesPath = path.join(curatedSourceRoot, 'overrides.json');
const legalFilePattern = /^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const {
  PINNED_OUTPUT_INDEX_SHA256,
  PINNED_SOURCE_INDEX_SHA256,
  PINNED_SOURCE_RUNTIME_SHA256,
  RUNTIME_RELATIVE_PATH,
} = require('./prepare-local-sandpack-bundler.cjs');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error(`${label} is missing, unreadable, or invalid JSON`);
  }
}

function assertSafeLockPath(lockPath) {
  const segments = typeof lockPath === 'string' ? lockPath.split('/') : [];
  if (
    typeof lockPath !== 'string' ||
    !segments.includes('node_modules') ||
    segments.at(-1) === 'node_modules' ||
    path.isAbsolute(lockPath) ||
    lockPath.includes('\\') ||
    segments.includes('..') ||
    segments.includes('')
  ) {
    throw new Error('Browser closure contains an unsafe package-lock path');
  }
}

function assertSafeCompliancePath(relativePath) {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.split('/').some((segment) => segment === '' || segment === '..')
  ) {
    throw new Error('Compliance manifest contains an unsafe relative path');
  }
}

function compliancePath(relativePath, root = complianceRoot) {
  assertSafeCompliancePath(relativePath);
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('Compliance manifest path escaped its root');
  }
  return resolvedPath;
}

function copyAndHash(sourcePath, relativeDestinationPath) {
  const sourceStat = fs.lstatSync(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Compliance source is not an owned regular file');
  }
  const bytes = fs.readFileSync(sourcePath);
  const destinationPath = compliancePath(relativeDestinationPath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.writeFileSync(destinationPath, bytes, { mode: 0o644 });
  return { path: relativeDestinationPath, sha256: sha256(bytes) };
}

function verifyFileRecord(fileRecord, label, root = complianceRoot) {
  if (
    !fileRecord ||
    typeof fileRecord.path !== 'string' ||
    typeof fileRecord.sha256 !== 'string' ||
    !sha256Pattern.test(fileRecord.sha256)
  ) {
    throw new Error(`Shipped compliance has an invalid ${label} record`);
  }
  const shippedPath = compliancePath(fileRecord.path, root);
  let shippedStat;
  let bytes;
  try {
    shippedStat = fs.lstatSync(shippedPath);
    bytes = fs.readFileSync(shippedPath);
  } catch {
    throw new Error(`Shipped compliance ${label} is missing or unreadable`);
  }
  if (!shippedStat.isFile() || shippedStat.isSymbolicLink()) {
    throw new Error(`Shipped compliance ${label} is not a regular owned file`);
  }
  if (sha256(bytes) !== fileRecord.sha256) {
    throw new Error(`Shipped compliance hash mismatch for ${fileRecord.path}`);
  }
  return bytes;
}

function installedLicense(packageJson) {
  if (typeof packageJson.license === 'string' && packageJson.license.length > 0) {
    return packageJson.license;
  }
  if (Array.isArray(packageJson.licenses)) {
    const licenseTypes = [
      ...new Set(
        packageJson.licenses
          .map((license) => license?.type)
          .filter((licenseType) => typeof licenseType === 'string' && licenseType.length > 0),
      ),
    ];
    if (licenseTypes.length === 1) {
      return licenseTypes[0];
    }
  }
  return null;
}

function packageRepositorySource(lockPath) {
  try {
    assertSafeLockPath(lockPath);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, lockPath, 'package.json'), 'utf8'),
    );
    const repository =
      typeof packageJson.repository === 'string'
        ? packageJson.repository
        : packageJson.repository?.url;
    const declaredSource = repository || packageJson.homepage;
    if (typeof declaredSource !== 'string' || declaredSource.length === 0) {
      return '<not declared by package>';
    }
    return declaredSource.replace(/^git\+/, '').replace(/\.git(?:#.*)?$/, '');
  } catch {
    return '<unreadable package metadata>';
  }
}

function clearGeneratedComplianceState(root = complianceRoot) {
  fs.rmSync(path.join(root, 'licenses'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'vendored'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'manifest.json'), { force: true });
  fs.rmSync(path.join(root, 'blockers.json'), { force: true });
}

function assertExactLockedIdentity(identity, lockEntry, packageName, label) {
  if (
    !identity ||
    typeof identity.lockPath !== 'string' ||
    typeof identity.name !== 'string' ||
    typeof identity.version !== 'string' ||
    typeof identity.resolved !== 'string' ||
    typeof identity.integrity !== 'string' ||
    identity.version !== lockEntry?.version ||
    identity.resolved !== lockEntry?.resolved ||
    identity.integrity !== lockEntry?.integrity ||
    (packageName != null && identity.name !== packageName)
  ) {
    throw new Error(`${label} does not exactly match the locked package identity`);
  }
}

function validateCuratedSource(source) {
  if (
    !source ||
    typeof source.id !== 'string' ||
    !/^[a-z0-9][a-z0-9.-]*$/.test(source.id) ||
    typeof source.repository !== 'string' ||
    !source.repository.startsWith('https://github.com/') ||
    typeof source.revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(source.revision) ||
    typeof source.sourcePath !== 'string' ||
    source.sourcePath.length === 0 ||
    typeof source.localFile !== 'string' ||
    source.localFile.length === 0 ||
    !sha256Pattern.test(source.sha256) ||
    !['license', 'license-declaration', 'license-text-in-readme', 'notice'].includes(
      source.contentRole,
    ) ||
    !['exact-package-revision', 'exact-upstream-revision'].includes(source.provenance)
  ) {
    throw new Error('Curated browser legal source metadata is incomplete or ambiguous');
  }
  assertSafeCompliancePath(source.localFile);
  const sourcePath = path.resolve(curatedSourceRoot, source.localFile);
  if (!sourcePath.startsWith(`${path.resolve(curatedSourceRoot)}${path.sep}`)) {
    throw new Error('Curated browser legal source escaped its root');
  }
  let sourceStat;
  let sourceBytes;
  try {
    sourceStat = fs.lstatSync(sourcePath);
    sourceBytes = fs.readFileSync(sourcePath);
  } catch {
    throw new Error(`Curated browser legal source ${source.id} is missing or unreadable`);
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error(`Curated browser legal source ${source.id} is not a regular owned file`);
  }
  if (sha256(sourceBytes) !== source.sha256) {
    throw new Error(`Curated browser legal source ${source.id} hash does not match its pin`);
  }
}

function loadCuratedOverrides(packageLock, closureLockPaths) {
  const overrides = readJson(curatedOverridesPath, 'Curated browser compliance overrides');
  if (
    overrides.schemaVersion !== 1 ||
    !Array.isArray(overrides.sources) ||
    !Array.isArray(overrides.packageOverrides) ||
    !Array.isArray(overrides.supplementalNotices) ||
    !Array.isArray(overrides.vendoredAdapters)
  ) {
    throw new Error('Curated browser compliance overrides have an unsupported schema');
  }

  const sources = new Map();
  for (const source of overrides.sources) {
    validateCuratedSource(source);
    if (sources.has(source.id)) {
      throw new Error(`Curated browser legal source ${source.id} is duplicated`);
    }
    sources.set(source.id, source);
  }

  const closureSet = new Set(closureLockPaths);
  const packageOverrides = new Map();
  for (const packageOverride of overrides.packageOverrides) {
    assertSafeLockPath(packageOverride.lockPath);
    if (!closureSet.has(packageOverride.lockPath)) {
      throw new Error(`Curated package override is stale: ${packageOverride.lockPath}`);
    }
    if (packageOverrides.has(packageOverride.lockPath)) {
      throw new Error(`Curated package override is duplicated: ${packageOverride.lockPath}`);
    }
    assertExactLockedIdentity(
      packageOverride,
      packageLock.packages?.[packageOverride.lockPath],
      null,
      `Curated package override ${packageOverride.lockPath}`,
    );
    if (
      typeof packageOverride.license !== 'string' ||
      packageOverride.license.length === 0 ||
      !sources.has(packageOverride.legalSourceId) ||
      sources.get(packageOverride.legalSourceId).contentRole === 'notice' ||
      sources.get(packageOverride.legalSourceId).provenance !== 'exact-package-revision'
    ) {
      throw new Error(`Curated package override is incomplete: ${packageOverride.lockPath}`);
    }
    packageOverrides.set(packageOverride.lockPath, packageOverride);
  }

  const supplementalNotices = new Map();
  for (const notice of overrides.supplementalNotices) {
    const source = sources.get(notice?.sourceId);
    if (!source || source.contentRole !== 'notice' || !Array.isArray(notice.packageBindings)) {
      throw new Error('Curated supplemental notice is incomplete');
    }
    for (const binding of notice.packageBindings) {
      assertSafeLockPath(binding.lockPath);
      if (!closureSet.has(binding.lockPath)) {
        throw new Error(`Curated supplemental notice binding is stale: ${binding.lockPath}`);
      }
      assertExactLockedIdentity(
        binding,
        packageLock.packages?.[binding.lockPath],
        null,
        `Curated supplemental notice binding ${binding.lockPath}`,
      );
      if (supplementalNotices.has(binding.lockPath)) {
        throw new Error(`Curated supplemental notice binding is duplicated: ${binding.lockPath}`);
      }
      supplementalNotices.set(binding.lockPath, { binding, source });
    }
  }

  const vendoredAdapters = new Map();
  for (const adapter of overrides.vendoredAdapters) {
    assertSafeLockPath(adapter?.lockPath);
    const lockEntry = packageLock.packages?.[adapter.lockPath];
    const packageMetadata = readJson(
      path.join(repositoryRoot, adapter.lockPath, 'package.json'),
      `Vendored browser adapter package metadata for ${adapter?.lockPath}`,
    );
    if (
      typeof adapter.id !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]*$/.test(adapter.id) ||
      vendoredAdapters.has(adapter.id) ||
      typeof adapter.name !== 'string' ||
      typeof adapter.upstreamPackage !== 'string' ||
      adapter.upstreamPackage !== packageMetadata.name ||
      adapter.upstreamVersion !== lockEntry?.version ||
      adapter.upstreamVersion !== packageMetadata.version ||
      adapter.resolved !== lockEntry?.resolved ||
      adapter.integrity !== lockEntry?.integrity ||
      adapter.license !== 'MIT' ||
      adapter.modified !== true ||
      typeof adapter.sourceFile !== 'string' ||
      !sha256Pattern.test(adapter.sourceSha256) ||
      typeof adapter.noticeFile !== 'string' ||
      !adapter.noticeFile.endsWith('.NOTICE.md') ||
      !sha256Pattern.test(adapter.noticeSha256) ||
      !Array.isArray(adapter.legalSourceIds) ||
      adapter.legalSourceIds.length === 0 ||
      new Set(adapter.legalSourceIds).size !== adapter.legalSourceIds.length ||
      adapter.legalSourceIds.some((sourceId) => !sources.has(sourceId))
    ) {
      throw new Error('Curated vendored browser adapter metadata is incomplete or ambiguous');
    }
    assertSafeCompliancePath(adapter.sourceFile);
    assertSafeCompliancePath(adapter.noticeFile);
    for (const [filePath, expectedSha256, label] of [
      [path.join(clientRoot, adapter.sourceFile), adapter.sourceSha256, 'source'],
      [path.join(clientRoot, adapter.noticeFile), adapter.noticeSha256, 'notice'],
    ]) {
      const stat = fs.lstatSync(filePath);
      const bytes = fs.readFileSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(bytes) !== expectedSha256) {
        throw new Error(`Curated vendored browser adapter ${adapter.id} ${label} drifted`);
      }
    }
    vendoredAdapters.set(adapter.id, adapter);
  }

  const referencedSourceIds = new Set([
    ...[...packageOverrides.values()].map((entry) => entry.legalSourceId),
    ...[...supplementalNotices.values()].map((entry) => entry.source.id),
    ...[...vendoredAdapters.values()].flatMap((entry) => entry.legalSourceIds),
  ]);
  for (const sourceId of sources.keys()) {
    if (!referencedSourceIds.has(sourceId)) {
      throw new Error(`Curated browser legal source is unreferenced: ${sourceId}`);
    }
  }
  return { packageOverrides, supplementalNotices, sources, vendoredAdapters };
}

function curatedFileName(source) {
  const extension = source.sourcePath.toLowerCase().endsWith('.md') ? '.md' : '.txt';
  const prefix =
    source.contentRole === 'notice'
      ? 'NOTICE'
      : source.contentRole === 'license-declaration'
        ? 'LICENSE-DECLARATION'
        : 'LICENSE';
  return `${prefix}.curated.${source.id}${extension}`;
}

function copyVendoredBrowserAdapter(adapter, curatedOverrides) {
  const destinationDirectory = `vendored/${adapter.id}`;
  const notice = copyAndHash(
    path.join(clientRoot, adapter.noticeFile),
    `${destinationDirectory}/NOTICE.md`,
  );
  if (notice.sha256 !== adapter.noticeSha256) {
    throw new Error(`Vendored browser adapter ${adapter.id} notice changed while copying`);
  }
  const legalFiles = adapter.legalSourceIds.map((sourceId) =>
    copyCuratedSource(curatedOverrides.sources.get(sourceId), destinationDirectory),
  );
  return {
    id: adapter.id,
    name: adapter.name,
    upstreamPackage: adapter.upstreamPackage,
    upstreamVersion: adapter.upstreamVersion,
    upstreamResolved: adapter.resolved,
    upstreamIntegrity: adapter.integrity,
    license: adapter.license,
    modified: adapter.modified,
    notice,
    legalFiles,
    sourceIdentity: {
      path: adapter.sourceFile,
      sha256: adapter.sourceSha256,
    },
  };
}

function copyCuratedSource(source, destinationDirectory) {
  const relativePath = `${destinationDirectory}/${curatedFileName(source)}`;
  const copiedFile = copyAndHash(path.join(curatedSourceRoot, source.localFile), relativePath);
  if (copiedFile.sha256 !== source.sha256) {
    throw new Error(`Curated browser legal source ${source.id} changed while copying`);
  }
  return {
    ...copiedFile,
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
}

function assertCuratedFileRecord(fileRecord, source, expectedDirectory, label) {
  const provenance = fileRecord?.provenance;
  if (
    fileRecord?.path !== `${expectedDirectory}/${curatedFileName(source)}` ||
    fileRecord.sha256 !== source.sha256 ||
    !provenance ||
    provenance.sourceId !== source.id ||
    provenance.repository !== source.repository ||
    provenance.revision !== source.revision ||
    provenance.sourcePath !== source.sourcePath ||
    provenance.sourceSha256 !== source.sha256 ||
    provenance.contentRole !== source.contentRole ||
    provenance.provenance !== source.provenance
  ) {
    throw new Error(`Shipped curated provenance mismatch for ${label}`);
  }
}

function collect() {
  const closure = readJson(closurePath, 'Browser module closure');
  const packageLock = readJson(packageLockPath, 'Package lock');
  if (closure.schemaVersion !== 1 || !Array.isArray(closure.packageLockPaths)) {
    throw new Error('Browser module closure has an unsupported schema');
  }

  const uniqueLockPaths = new Set(closure.packageLockPaths);
  if (uniqueLockPaths.size !== closure.packageLockPaths.length) {
    throw new Error('Browser module closure contains duplicate package-lock paths');
  }
  const curatedOverrides = loadCuratedOverrides(packageLock, closure.packageLockPaths);

  clearGeneratedComplianceState();
  const manifest = { schemaVersion: 1, packages: [], vendoredComponents: [] };
  const failures = [];
  for (const lockPath of closure.packageLockPaths) {
    try {
      assertSafeLockPath(lockPath);
      const lockEntry = packageLock.packages?.[lockPath];
      if (!lockEntry?.version || !lockEntry?.resolved || !lockEntry?.integrity) {
        throw new Error('incomplete package-lock version/resolved/integrity metadata');
      }

      const packageRoot = path.resolve(repositoryRoot, lockPath);
      const repositoryPrefix = `${repositoryRoot}${path.sep}`;
      if (
        !packageRoot.startsWith(repositoryPrefix) ||
        !packageRoot.split(path.sep).includes('node_modules')
      ) {
        throw new Error('package root escaped a repository node_modules directory');
      }
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      if (packageJson.version !== lockEntry.version) {
        throw new Error('installed/locked version mismatch');
      }
      const packageOverride = curatedOverrides.packageOverrides.get(lockPath);
      if (packageOverride) {
        assertExactLockedIdentity(
          packageOverride,
          lockEntry,
          packageJson.name,
          `Curated package override ${lockPath}`,
        );
      }
      const installedLicenseIdentity = installedLicense(packageJson);
      const license = lockEntry.license ?? installedLicenseIdentity ?? packageOverride?.license;
      if (!license) {
        throw new Error('license identity is absent from lock and installed package metadata');
      }
      const legalFiles = fs
        .readdirSync(packageRoot, { withFileTypes: true })
        .filter((entry) => entry.isFile() && legalFilePattern.test(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
      if (legalFiles.length === 0 && !packageOverride) {
        throw new Error('no package-owned license or notice file');
      }

      const packageName = packageJson.name;
      if (typeof packageName !== 'string' || packageName.length === 0) {
        throw new Error('installed package name is missing');
      }
      const destinationDirectoryName = `${lockPath.replaceAll('/', '__')}--${sha256(lockPath).slice(0, 12)}`;
      const destinationDirectory = `licenses/${destinationDirectoryName}`;
      const packageMetadata = copyAndHash(
        path.join(packageRoot, 'package.json'),
        `${destinationDirectory}/package.json`,
      );
      const copiedLegalFiles = legalFiles.map((fileName) =>
        copyAndHash(path.join(packageRoot, fileName), `${destinationDirectory}/${fileName}`),
      );
      if (packageOverride) {
        copiedLegalFiles.push(
          copyCuratedSource(
            curatedOverrides.sources.get(packageOverride.legalSourceId),
            destinationDirectory,
          ),
        );
      }
      const supplementalNotice = curatedOverrides.supplementalNotices.get(lockPath);
      if (supplementalNotice) {
        assertExactLockedIdentity(
          supplementalNotice.binding,
          lockEntry,
          packageJson.name,
          `Curated supplemental notice binding ${lockPath}`,
        );
        copiedLegalFiles.push(copyCuratedSource(supplementalNotice.source, destinationDirectory));
      }
      let licenseSource = 'package-lock.json#license';
      if (!lockEntry.license) {
        licenseSource = installedLicenseIdentity
          ? 'installed-package.json#license(s)'
          : `curated-source:${packageOverride.legalSourceId}`;
      }

      manifest.packages.push({
        lockPath,
        name: packageName,
        version: lockEntry.version,
        resolved: lockEntry.resolved,
        license,
        licenseSource,
        integrity: lockEntry.integrity,
        packageMetadata,
        legalFiles: copiedLegalFiles,
      });
    } catch (error) {
      failures.push({
        lockPath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sandpackLockEntry = packageLock.packages?.['node_modules/@codesandbox/sandpack-client'];
  try {
    if (!sandpackLockEntry?.version || !sandpackLockEntry?.integrity) {
      throw new Error('Sandpack lock identity is incomplete');
    }
    const notice = copyAndHash(
      path.join(clientRoot, 'src/utils/sandpackClientAdapter.NOTICE.md'),
      'vendored/sandpack-client-adapter/NOTICE.md',
    );
    const license = copyAndHash(
      path.join(clientRoot, 'third_party/sandpack-client/LICENSE.txt'),
      'vendored/sandpack-client-adapter/LICENSE.txt',
    );
    const runtimePrivacyNotice = copyAndHash(
      path.join(clientRoot, 'third_party/sandpack-client/RUNTIME_PRIVACY_NOTICE.md'),
      'vendored/sandpack-client-adapter/RUNTIME_PRIVACY_NOTICE.md',
    );
    const runtimeIndex = {
      path: 'sandpack-bundler/index.html',
      sha256: sha256(fs.readFileSync(path.join(clientRoot, 'dist/sandpack-bundler/index.html'))),
    };
    const runtimeJavaScript = {
      path: `sandpack-bundler/${RUNTIME_RELATIVE_PATH}`,
      sha256: sha256(
        fs.readFileSync(path.join(clientRoot, 'dist/sandpack-bundler', RUNTIME_RELATIVE_PATH)),
      ),
    };
    if (
      runtimeIndex.sha256 !== PINNED_OUTPUT_INDEX_SHA256 ||
      runtimeJavaScript.sha256 !== PINNED_SOURCE_RUNTIME_SHA256
    ) {
      throw new Error('Prepared Sandpack runtime does not match its pinned shipped identity');
    }
    manifest.vendoredComponents.push({
      id: 'sandpack-client-adapter',
      name: 'Viventium Sandpack browser adapter',
      upstreamPackage: '@codesandbox/sandpack-client',
      upstreamVersion: sandpackLockEntry.version,
      upstreamIntegrity: sandpackLockEntry.integrity,
      license: 'Apache-2.0',
      modified: true,
      notice,
      runtimePrivacyNotice,
      legalFiles: [license],
      sourceIdentity: {
        indexSha256: PINNED_SOURCE_INDEX_SHA256,
        runtimeSha256: PINNED_SOURCE_RUNTIME_SHA256,
      },
      shippedRuntime: {
        index: runtimeIndex,
        javascript: runtimeJavaScript,
        telemetryPolicy: 'upstream-on-prem-environment-flag',
      },
    });
  } catch (error) {
    failures.push({
      lockPath: 'vendored/sandpack-client-adapter',
      reason: error instanceof Error ? error.message : String(error),
    });
  }


  for (const adapter of curatedOverrides.vendoredAdapters.values()) {
    try {
      manifest.vendoredComponents.push(copyVendoredBrowserAdapter(adapter, curatedOverrides));
    } catch (error) {
      failures.push({
        lockPath: `vendored/${adapter.id}`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    const missingLegalFileGroups = new Map();
    for (const failure of failures.filter(
      (failure) => failure.reason === 'no package-owned license or notice file',
    )) {
      const source = packageRepositorySource(failure.lockPath);
      const lockPaths = missingLegalFileGroups.get(source) ?? [];
      lockPaths.push(failure.lockPath);
      missingLegalFileGroups.set(source, lockPaths);
    }
    const sourceGroups = [...missingLegalFileGroups]
      .map(([source, lockPaths]) => ({ source, lockPaths: lockPaths.sort() }))
      .sort((left, right) => left.source.localeCompare(right.source));
    fs.writeFileSync(
      path.join(complianceRoot, 'blockers.json'),
      `${JSON.stringify({ schemaVersion: 1, failures, missingLegalFileSourceGroups: sourceGroups }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o644 },
    );
    throw new Error(
      `Browser compliance closure failed:\n- ${failures
        .map((failure) => `${failure.lockPath}: ${failure.reason}`)
        .join('\n- ')}`,
    );
  }

  manifest.packages.sort((left, right) => left.lockPath.localeCompare(right.lockPath));
  const manifestLockPaths = manifest.packages.map((entry) => entry.lockPath);
  if (
    manifestLockPaths.length !== closure.packageLockPaths.length ||
    manifestLockPaths.some((lockPath, index) => lockPath !== closure.packageLockPaths[index])
  ) {
    throw new Error('Compliance manifest package set does not exactly match the browser closure');
  }
  fs.writeFileSync(
    path.join(complianceRoot, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  );
  console.log(
    `✅ Browser compliance collected (${manifest.packages.length} locked packages; ${manifest.vendoredComponents.length} vendored component).`,
  );
}

function verifyShipped() {
  const closure = readJson(closurePath, 'Shipped browser module closure');
  const manifest = readJson(
    path.join(complianceRoot, 'manifest.json'),
    'Shipped browser compliance manifest',
  );
  const packageLock = readJson(packageLockPath, 'Package lock');
  if (closure.schemaVersion !== 1 || manifest.schemaVersion !== 1) {
    throw new Error('Shipped compliance has an unsupported schema version');
  }
  const closureLockPaths = closure.packageLockPaths;
  const manifestLockPaths = manifest.packages?.map((entry) => entry.lockPath);
  if (
    !Array.isArray(closureLockPaths) ||
    !Array.isArray(manifestLockPaths) ||
    new Set(closureLockPaths).size !== closureLockPaths.length ||
    closureLockPaths.length !== manifestLockPaths.length ||
    closureLockPaths.some((lockPath, index) => lockPath !== manifestLockPaths[index])
  ) {
    throw new Error('Shipped compliance package set does not exactly match the browser closure');
  }
  for (const lockPath of closureLockPaths) {
    assertSafeLockPath(lockPath);
  }
  const curatedOverrides = loadCuratedOverrides(packageLock, closureLockPaths);

  const fileRecords = [];
  for (const packageRecord of manifest.packages) {
    const lockEntry = packageLock.packages?.[packageRecord.lockPath];
    const expectedDirectory = `licenses/${packageRecord.lockPath.replaceAll('/', '__')}--${sha256(packageRecord.lockPath).slice(0, 12)}`;
    if (
      !lockEntry ||
      packageRecord.version !== lockEntry.version ||
      packageRecord.resolved !== lockEntry.resolved ||
      packageRecord.integrity !== lockEntry.integrity ||
      typeof packageRecord.name !== 'string' ||
      typeof packageRecord.license !== 'string' ||
      typeof packageRecord.licenseSource !== 'string' ||
      !Array.isArray(packageRecord.legalFiles) ||
      packageRecord.legalFiles.length === 0
    ) {
      throw new Error(`Shipped compliance identity is incomplete for ${packageRecord.lockPath}`);
    }
    if (packageRecord.packageMetadata?.path !== `${expectedDirectory}/package.json`) {
      throw new Error(`Shipped package metadata path mismatch for ${packageRecord.lockPath}`);
    }
    const metadataBytes = verifyFileRecord(
      packageRecord.packageMetadata,
      `package metadata for ${packageRecord.lockPath}`,
    );
    const packageMetadata = JSON.parse(metadataBytes.toString('utf8'));
    if (
      packageMetadata.name !== packageRecord.name ||
      packageMetadata.version !== packageRecord.version
    ) {
      throw new Error(`Shipped package metadata identity mismatch for ${packageRecord.lockPath}`);
    }
    const packageOverride = curatedOverrides.packageOverrides.get(packageRecord.lockPath);
    if (packageOverride) {
      assertExactLockedIdentity(
        packageOverride,
        lockEntry,
        packageMetadata.name,
        `Curated package override ${packageRecord.lockPath}`,
      );
      if (packageRecord.license !== packageOverride.license) {
        throw new Error(`Shipped curated license mismatch for ${packageRecord.lockPath}`);
      }
    }
    if (packageRecord.licenseSource === 'package-lock.json#license') {
      if (packageRecord.license !== lockEntry.license) {
        throw new Error(`Shipped lock license mismatch for ${packageRecord.lockPath}`);
      }
    } else if (packageRecord.licenseSource === 'installed-package.json#license(s)') {
      if (packageRecord.license !== installedLicense(packageMetadata)) {
        throw new Error(`Shipped package-metadata license mismatch for ${packageRecord.lockPath}`);
      }
    } else if (packageRecord.licenseSource.startsWith('curated-source:')) {
      if (
        !packageOverride ||
        packageRecord.licenseSource !== `curated-source:${packageOverride.legalSourceId}`
      ) {
        throw new Error(`Shipped curated license source mismatch for ${packageRecord.lockPath}`);
      }
    } else {
      throw new Error(`Shipped license source is invalid for ${packageRecord.lockPath}`);
    }
    const expectedCuratedSources = [];
    if (packageOverride) {
      expectedCuratedSources.push(curatedOverrides.sources.get(packageOverride.legalSourceId));
    }
    const supplementalNotice = curatedOverrides.supplementalNotices.get(packageRecord.lockPath);
    if (supplementalNotice) {
      assertExactLockedIdentity(
        supplementalNotice.binding,
        lockEntry,
        packageMetadata.name,
        `Curated supplemental notice binding ${packageRecord.lockPath}`,
      );
      expectedCuratedSources.push(supplementalNotice.source);
    }
    const curatedLegalFiles = packageRecord.legalFiles.filter((file) => file.provenance);
    if (curatedLegalFiles.length !== expectedCuratedSources.length) {
      throw new Error(`Shipped curated legal-file set mismatch for ${packageRecord.lockPath}`);
    }
    for (const source of expectedCuratedSources) {
      const curatedFile = curatedLegalFiles.find((file) => file.provenance?.sourceId === source.id);
      assertCuratedFileRecord(curatedFile, source, expectedDirectory, packageRecord.lockPath);
    }
    fileRecords.push(packageRecord.packageMetadata, ...packageRecord.legalFiles);
    for (const legalFile of packageRecord.legalFiles) {
      if (
        path.posix.dirname(legalFile.path) !== expectedDirectory ||
        !legalFilePattern.test(path.posix.basename(legalFile.path))
      ) {
        throw new Error(`Shipped legal-file path mismatch for ${packageRecord.lockPath}`);
      }
      verifyFileRecord(legalFile, `legal file for ${packageRecord.lockPath}`);
    }
  }

  if (
    !Array.isArray(manifest.vendoredComponents) ||
    manifest.vendoredComponents.length !== curatedOverrides.vendoredAdapters.size + 1
  ) {
    throw new Error('Shipped compliance has an incomplete vendored component set');
  }
  const vendored = manifest.vendoredComponents.find(
    (component) => component.id === 'sandpack-client-adapter',
  );
  const sandpackLock = packageLock.packages?.['node_modules/@codesandbox/sandpack-client'];
  if (
    !vendored ||
    vendored.name !== 'Viventium Sandpack browser adapter' ||
    vendored.upstreamPackage !== '@codesandbox/sandpack-client' ||
    vendored.upstreamVersion !== sandpackLock?.version ||
    vendored.upstreamIntegrity !== sandpackLock?.integrity ||
    vendored.license !== 'Apache-2.0' ||
    vendored.modified !== true ||
    vendored.notice?.path !== 'vendored/sandpack-client-adapter/NOTICE.md' ||
    vendored.runtimePrivacyNotice?.path !==
      'vendored/sandpack-client-adapter/RUNTIME_PRIVACY_NOTICE.md' ||
    !Array.isArray(vendored.legalFiles) ||
    vendored.legalFiles.length !== 1 ||
    vendored.legalFiles[0]?.path !== 'vendored/sandpack-client-adapter/LICENSE.txt' ||
    vendored.sourceIdentity?.indexSha256 !== PINNED_SOURCE_INDEX_SHA256 ||
    vendored.sourceIdentity?.runtimeSha256 !== PINNED_SOURCE_RUNTIME_SHA256 ||
    vendored.shippedRuntime?.telemetryPolicy !== 'upstream-on-prem-environment-flag' ||
    vendored.shippedRuntime?.index?.path !== 'sandpack-bundler/index.html' ||
    vendored.shippedRuntime?.index?.sha256 !== PINNED_OUTPUT_INDEX_SHA256 ||
    vendored.shippedRuntime?.javascript?.path !== `sandpack-bundler/${RUNTIME_RELATIVE_PATH}` ||
    vendored.shippedRuntime?.javascript?.sha256 !== PINNED_SOURCE_RUNTIME_SHA256
  ) {
    throw new Error('Shipped vendored Sandpack identity is incomplete or mismatched');
  }
  const noticeBytes = verifyFileRecord(vendored.notice, 'vendored Sandpack notice');
  const runtimePrivacyNoticeBytes = verifyFileRecord(
    vendored.runtimePrivacyNotice,
    'vendored Sandpack runtime privacy notice',
  );
  const sandpackLicenseBytes = verifyFileRecord(
    vendored.legalFiles[0],
    'vendored Sandpack license',
  );
  if (
    !noticeBytes.toString('utf8').includes('@codesandbox/sandpack-client') ||
    !noticeBytes.toString('utf8').includes('Viventium changed') ||
    vendored.notice.sha256 !== 'c6780cf00c1a0d36452e24213995dacef06f3631d1c8cc1cdafb7693362f68e8' ||
    !runtimePrivacyNoticeBytes.toString('utf8').includes('window._env_.IS_ONPREM') ||
    vendored.runtimePrivacyNotice.sha256 !==
      'bce814f591509b996e21a1d70342014bf04a4d0a25b90140ef3bcf657b33978a' ||
    sha256(sandpackLicenseBytes) !==
      'b75c33064bdc1c7f392dc4e42df8329f64332e841f87ccaa1f3954c5eeba5bc1'
  ) {
    throw new Error('Shipped vendored Sandpack notice/license bytes are not the pinned record');
  }
  verifyFileRecord(
    vendored.shippedRuntime.index,
    'vendored Sandpack runtime index',
    clientRoot + '/dist',
  );
  verifyFileRecord(
    vendored.shippedRuntime.javascript,
    'vendored Sandpack runtime JavaScript',
    clientRoot + '/dist',
  );
  fileRecords.push(vendored.notice, vendored.runtimePrivacyNotice, ...vendored.legalFiles);

  for (const adapter of curatedOverrides.vendoredAdapters.values()) {
    const shippedAdapter = manifest.vendoredComponents.find(
      (component) => component.id === adapter.id,
    );
    const expectedDirectory = `vendored/${adapter.id}`;
    if (
      !shippedAdapter ||
      shippedAdapter.name !== adapter.name ||
      shippedAdapter.upstreamPackage !== adapter.upstreamPackage ||
      shippedAdapter.upstreamVersion !== adapter.upstreamVersion ||
      shippedAdapter.upstreamResolved !== adapter.resolved ||
      shippedAdapter.upstreamIntegrity !== adapter.integrity ||
      shippedAdapter.license !== adapter.license ||
      shippedAdapter.modified !== true ||
      shippedAdapter.notice?.path !== `${expectedDirectory}/NOTICE.md` ||
      shippedAdapter.notice?.sha256 !== adapter.noticeSha256 ||
      shippedAdapter.sourceIdentity?.path !== adapter.sourceFile ||
      shippedAdapter.sourceIdentity?.sha256 !== adapter.sourceSha256 ||
      !Array.isArray(shippedAdapter.legalFiles) ||
      shippedAdapter.legalFiles.length !== adapter.legalSourceIds.length
    ) {
      throw new Error(`Shipped vendored browser adapter mismatch for ${adapter.id}`);
    }
    const sourceBytes = fs.readFileSync(path.join(clientRoot, adapter.sourceFile));
    if (sha256(sourceBytes) !== shippedAdapter.sourceIdentity.sha256) {
      throw new Error(`Shipped vendored browser adapter source drift for ${adapter.id}`);
    }
    verifyFileRecord(shippedAdapter.notice, `vendored browser adapter notice for ${adapter.id}`);
    for (const sourceId of adapter.legalSourceIds) {
      const source = curatedOverrides.sources.get(sourceId);
      const legalFile = shippedAdapter.legalFiles.find(
        (file) => file.provenance?.sourceId === sourceId,
      );
      assertCuratedFileRecord(legalFile, source, expectedDirectory, adapter.id);
      verifyFileRecord(legalFile, `vendored browser adapter legal file for ${adapter.id}`);
    }
    fileRecords.push(shippedAdapter.notice, ...shippedAdapter.legalFiles);
  }

  if (new Set(fileRecords.map((fileRecord) => fileRecord.path)).size !== fileRecords.length) {
    throw new Error('Shipped compliance contains duplicate legal-file destinations');
  }
  console.log(
    `✅ Shipped browser compliance verified (${manifest.packages.length} locked packages; ${fileRecords.length} notice/license files).`,
  );
}

if (require.main === module) {
  try {
    if (process.argv.includes('--verify')) {
      verifyShipped();
    } else {
      collect();
    }
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  assertCuratedFileRecord,
  assertExactLockedIdentity,
  assertSafeLockPath,
  clearGeneratedComplianceState,
  collect,
  curatedFileName,
  sha256,
  validateCuratedSource,
  verifyFileRecord,
  verifyShipped,
};
