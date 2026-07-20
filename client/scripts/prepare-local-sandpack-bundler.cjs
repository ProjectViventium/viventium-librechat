const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const clientRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(clientRoot, '..');
const packageLockPath = path.join(repositoryRoot, 'package-lock.json');
const defaultDestinationRoot = path.join(clientRoot, 'dist/sandpack-bundler');

const PINNED_PACKAGE_VERSION = '2.19.8';
const PINNED_PACKAGE_INTEGRITY =
  'sha512-CMV4nr1zgKzVpx4I3FYvGRM5YT0VaQhALMW9vy4wZRhEyWAtJITQIqZzrTGWqB1JvV7V72dVEUCUPLfYz5hgJQ==';
const PINNED_SOURCE_FILE_COUNT = 441;
const PINNED_SOURCE_BYTE_COUNT = 67010847;
const PINNED_SOURCE_INDEX_SHA256 =
  '2722386bc39a8450c805488deb0eba8f9665c5acfe4b9cb8dcce847ac95e5cc0';
const PINNED_OUTPUT_INDEX_SHA256 =
  'ace51687532a2e9cbfcc11d790bc96b250c477cfa3545ab285915b9eca8e7aa6';
const PINNED_SOURCE_RUNTIME_SHA256 =
  '17a6448ab2dc5c3f426454c3147529c359d52b8a09cc060cb557457e13ae680b';
const RUNTIME_RELATIVE_PATH = 'static/js/sandbox.8a7d01a44.js';
const ON_PREM_BOOTSTRAP =
  '<script>window._env_=Object.assign({},window._env_,{IS_ONPREM:"true"})</script>';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function findPackageRoot(entryPath) {
  let candidate = path.dirname(entryPath);
  while (candidate !== path.dirname(candidate)) {
    const packageJsonPath = path.join(candidate, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name === '@codesandbox/sandpack-client') {
        return candidate;
      }
    }
    candidate = path.dirname(candidate);
  }
  throw new Error('Unable to resolve the installed Sandpack package root');
}

function resolveSourceRoot() {
  const runtimeEntry = require.resolve('@codesandbox/sandpack-client/clients/runtime', {
    paths: [clientRoot],
  });
  return path.join(findPackageRoot(runtimeEntry), 'sandpack');
}

function collectSourceFiles(sourceRoot) {
  const sourceRootWithSeparator = `${sourceRoot}${path.sep}`;
  const files = [];
  let totalBytes = 0;

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isSymbolicLink()) {
        throw new Error(`Sandpack source contains a forbidden symbolic link: ${entry.name}`);
      }
      if (stats.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Sandpack source contains a non-file entry: ${entry.name}`);
      }
      if (!absolutePath.startsWith(sourceRootWithSeparator)) {
        throw new Error('Sandpack source file escaped its package root');
      }
      const relativePath = path.relative(sourceRoot, absolutePath);
      if (
        relativePath.length === 0 ||
        path.isAbsolute(relativePath) ||
        relativePath.split(path.sep).includes('..')
      ) {
        throw new Error('Sandpack source produced an unsafe relative path');
      }
      totalBytes += stats.size;
      files.push({ absolutePath, relativePath, size: stats.size });
    }
  }

  visit(sourceRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (files.length !== PINNED_SOURCE_FILE_COUNT || totalBytes !== PINNED_SOURCE_BYTE_COUNT) {
    throw new Error(
      `Sandpack source tree drifted from the pinned package (${files.length} files, ${totalBytes} bytes)`,
    );
  }
  return files;
}

function injectOnPremEnvironment(indexHtml) {
  if (indexHtml.includes('IS_ONPREM')) {
    throw new Error('Sandpack source index already declares the on-prem flag');
  }
  const headMarker = '<head>';
  if (indexHtml.split(headMarker).length !== 2) {
    throw new Error('Sandpack source index does not contain exactly one head marker');
  }
  return indexHtml.replace(headMarker, `${headMarker}${ON_PREM_BOOTSTRAP}`);
}

function assertDestination(destinationRoot) {
  const resolved = path.resolve(destinationRoot);
  if (path.basename(resolved) !== 'sandpack-bundler' || resolved === path.parse(resolved).root) {
    throw new Error('Sandpack destination must be a dedicated sandpack-bundler directory');
  }
  return resolved;
}

function assertPinnedPackage(sourceRoot) {
  const packageRoot = path.dirname(sourceRoot);
  const installedPackage = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  const packageLock = JSON.parse(fs.readFileSync(packageLockPath, 'utf8'));
  const lockEntry = packageLock.packages?.['node_modules/@codesandbox/sandpack-client'];
  if (
    installedPackage.name !== '@codesandbox/sandpack-client' ||
    installedPackage.version !== PINNED_PACKAGE_VERSION ||
    lockEntry?.version !== PINNED_PACKAGE_VERSION ||
    lockEntry?.integrity !== PINNED_PACKAGE_INTEGRITY
  ) {
    throw new Error('Installed Sandpack package does not match the pinned lock identity');
  }
}

function prepareSandpackBundler({
  sourceRoot = resolveSourceRoot(),
  destinationRoot = defaultDestinationRoot,
  copyFile = (source, destination) => fs.copyFileSync(source, destination),
} = {}) {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const resolvedDestinationRoot = assertDestination(destinationRoot);
  assertPinnedPackage(resolvedSourceRoot);
  const files = collectSourceFiles(resolvedSourceRoot);

  const sourceIndex = fs.readFileSync(path.join(resolvedSourceRoot, 'index.html'));
  const sourceRuntime = fs.readFileSync(path.join(resolvedSourceRoot, RUNTIME_RELATIVE_PATH));
  const sourceIndexSha256 = sha256(sourceIndex);
  const runtimeSha256 = sha256(sourceRuntime);
  if (
    sourceIndexSha256 !== PINNED_SOURCE_INDEX_SHA256 ||
    runtimeSha256 !== PINNED_SOURCE_RUNTIME_SHA256
  ) {
    throw new Error('Sandpack source runtime bytes do not match the pinned package');
  }

  fs.rmSync(resolvedDestinationRoot, { recursive: true, force: true });
  fs.mkdirSync(resolvedDestinationRoot, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const destinationPath = path.join(resolvedDestinationRoot, file.relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o755 });
    copyFile(file.absolutePath, destinationPath, file.relativePath);
    fs.chmodSync(destinationPath, 0o644);
  }

  const outputIndex = Buffer.from(injectOnPremEnvironment(sourceIndex.toString('utf8')));
  const outputIndexSha256 = sha256(outputIndex);
  if (outputIndexSha256 !== PINNED_OUTPUT_INDEX_SHA256) {
    throw new Error('Telemetry-disabled Sandpack index does not match the pinned output');
  }
  fs.writeFileSync(path.join(resolvedDestinationRoot, 'index.html'), outputIndex, {
    mode: 0o644,
  });

  return {
    destinationRoot: resolvedDestinationRoot,
    fileCount: files.length,
    sourceIndexSha256,
    outputIndexSha256,
    runtimeSha256,
  };
}

if (require.main === module) {
  try {
    const result = prepareSandpackBundler();
    console.log(
      `✅ Local Sandpack bundler prepared (${result.fileCount} pinned files; telemetry disabled).`,
    );
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ON_PREM_BOOTSTRAP,
  PINNED_OUTPUT_INDEX_SHA256,
  PINNED_SOURCE_INDEX_SHA256,
  PINNED_SOURCE_RUNTIME_SHA256,
  RUNTIME_RELATIVE_PATH,
  collectSourceFiles,
  injectOnPremEnvironment,
  prepareSandpackBundler,
  sha256,
};
