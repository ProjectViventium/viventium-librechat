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
const PINNED_SOURCE_TREE_SHA256 =
  'f9bf648f2b3e5f78eb728ba691b599b0e41b1595b716df78e6c96fe3c40cbf1e';
const PINNED_OUTPUT_TREE_SHA256 =
  '6dbf5576d6cc8c76d5f3f8f289094d45d7e8f85a4750e984d2b1161a6bca331d';
const RUNTIME_RELATIVE_PATH = 'static/js/sandbox.8a7d01a44.js';
const ON_PREM_BOOTSTRAP =
  '<script>window._env_=Object.assign({},window._env_,{IS_ONPREM:"true"})</script>';
const UPSTREAM_PATH_SANITIZATIONS = [
  {
    id: 'mac-typescript-build-root',
    expectedOccurrences: 2,
    replacement: '/virtual/typescript/lib',
    pattern:
      /\/Users\/[A-Za-z0-9._-]+\/Documents\/GitHub\/prettier\/prettier\/node_modules\/typescript\/lib/g,
  },
  {
    id: 'unix-browserfs-build-root',
    expectedOccurrences: 30,
    replacement: '/virtual/browserfs',
    pattern: /\/home\/([A-Za-z0-9._-]+)(?=\/|\b)/g,
    shouldReplace: (match) => !ALLOWED_VIRTUAL_HOME_NAMES.has(match[1]),
  },
];
const ALLOWED_VIRTUAL_HOME_NAMES = new Set(['ai', 'myself', 'sandbox']);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function treeSha256(root, relativePaths) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of relativePaths) {
    const bytes = fs.readFileSync(path.join(root, relativePath));
    hash.update(relativePath);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function assertPublicSafeRuntime(root, relativePaths) {
  const violations = [];
  for (const relativePath of relativePaths) {
    const contents = fs.readFileSync(path.join(root, relativePath), 'utf8');
    if (/\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/.test(contents)) {
      violations.push(`${relativePath}: macOS home path`);
    }
    for (const match of contents.matchAll(/\/home\/([A-Za-z0-9._-]+)(?:\/|\b)/g)) {
      if (!ALLOWED_VIRTUAL_HOME_NAMES.has(match[1])) {
        violations.push(`${relativePath}: non-virtual Unix home path`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(`Sandpack runtime contains private build paths:\n${violations.join('\n')}`);
  }
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
  files.sort((left, right) => {
    if (left.relativePath === right.relativePath) {
      return 0;
    }
    return left.relativePath < right.relativePath ? -1 : 1;
  });
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
  const relativePaths = files.map(({ relativePath }) => relativePath);
  const sourceTreeSha256 = treeSha256(resolvedSourceRoot, relativePaths);
  if (sourceTreeSha256 !== PINNED_SOURCE_TREE_SHA256) {
    throw new Error('Sandpack source tree bytes do not match the pinned package manifest');
  }

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
  const sanitizationCounts = new Map(UPSTREAM_PATH_SANITIZATIONS.map((rule) => [rule.id, 0]));
  for (const file of files) {
    const destinationPath = path.join(resolvedDestinationRoot, file.relativePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o755 });
    let sourceBytes = fs.readFileSync(file.absolutePath);
    let changed = false;
    for (const rule of UPSTREAM_PATH_SANITIZATIONS) {
      const sourceContents = sourceBytes.toString('utf8');
      let occurrences = 0;
      const sanitizedContents = sourceContents.replace(rule.pattern, (...args) => {
        const match = args.slice(0, -2);
        if (rule.shouldReplace && !rule.shouldReplace(match)) {
          return match[0];
        }
        occurrences += 1;
        return rule.replacement;
      });
      if (occurrences > 0) {
        sanitizationCounts.set(rule.id, sanitizationCounts.get(rule.id) + occurrences);
        sourceBytes = Buffer.from(sanitizedContents);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(destinationPath, sourceBytes, { mode: 0o644 });
    } else {
      copyFile(file.absolutePath, destinationPath, file.relativePath);
    }
    fs.chmodSync(destinationPath, 0o644);
  }

  for (const rule of UPSTREAM_PATH_SANITIZATIONS) {
    if (sanitizationCounts.get(rule.id) !== rule.expectedOccurrences) {
      throw new Error('Sandpack upstream path sanitization count drifted');
    }
  }

  const outputIndex = Buffer.from(injectOnPremEnvironment(sourceIndex.toString('utf8')));
  const outputIndexSha256 = sha256(outputIndex);
  if (outputIndexSha256 !== PINNED_OUTPUT_INDEX_SHA256) {
    throw new Error('Telemetry-disabled Sandpack index does not match the pinned output');
  }
  fs.writeFileSync(path.join(resolvedDestinationRoot, 'index.html'), outputIndex, {
    mode: 0o644,
  });

  assertPublicSafeRuntime(resolvedDestinationRoot, relativePaths);
  const outputTreeSha256 = treeSha256(resolvedDestinationRoot, relativePaths);
  if (outputTreeSha256 !== PINNED_OUTPUT_TREE_SHA256) {
    throw new Error('Sanitized Sandpack output tree does not match the pinned manifest');
  }

  return {
    destinationRoot: resolvedDestinationRoot,
    fileCount: files.length,
    sourceIndexSha256,
    outputIndexSha256,
    runtimeSha256,
    sourceTreeSha256,
    outputTreeSha256,
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
  PINNED_SOURCE_TREE_SHA256,
  PINNED_OUTPUT_TREE_SHA256,
  RUNTIME_RELATIVE_PATH,
  assertPublicSafeRuntime,
  collectSourceFiles,
  injectOnPremEnvironment,
  prepareSandpackBundler,
  sha256,
  treeSha256,
};
