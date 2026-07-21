const fs = require('fs');
const path = require('path');

const dist = path.resolve(__dirname, '../dist');
const clientRoot = path.resolve(__dirname, '..');
const adapterNotice = path.join(clientRoot, 'src/utils/sandpackClientAdapter.NOTICE.md');
const adapterLicense = path.join(clientRoot, 'third_party/sandpack-client/LICENSE.txt');
const runtimePrivacyNotice = path.join(
  clientRoot,
  'third_party/sandpack-client/RUNTIME_PRIVACY_NOTICE.md',
);
const localBundlerRoot = path.join(dist, 'sandpack-bundler');
const localBundlerIndex = path.join(localBundlerRoot, 'index.html');
const localBundlerRuntime = path.join(localBundlerRoot, 'static/js/sandbox.8a7d01a44.js');
const allowedVirtualHomeNames = new Set(['ai', 'myself', 'sandbox']);
const PINNED_OUTPUT_INDEX_SHA256 =
  'ace51687532a2e9cbfcc11d790bc96b250c477cfa3545ab285915b9eca8e7aa6';
const PINNED_RUNTIME_SHA256 = '17a6448ab2dc5c3f426454c3147529c359d52b8a09cc060cb557457e13ae680b';
const forbiddenSignatures = [
  '@codesandbox/nodebox',
  'DEFAULT_RUNTIME_URL',
  'SandpackNode',
  'emulatorShellProcess',
  'createShellProcessFromTask',
  'nodebox-runtime',
  'restartShellProcess',
  'static-browser-server',
  'SandpackStatic',
];

function collectJavaScript(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entryPath === localBundlerRoot) {
        return [];
      }
      return collectJavaScript(entryPath);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
  });
}

const javascriptFiles = collectJavaScript(dist);

const noticeContents = fs.readFileSync(adapterNotice, 'utf8');
const licenseContents = fs.readFileSync(adapterLicense, 'utf8');
const runtimePrivacyContents = fs.readFileSync(runtimePrivacyNotice, 'utf8');
if (
  !noticeContents.includes('client/third_party/sandpack-client/LICENSE.txt') ||
  !licenseContents.includes('Version 2.0, January 2004') ||
  !licenseContents.includes('Copyright 2022 CodeSandbox BV') ||
  !runtimePrivacyContents.includes('window._env_.IS_ONPREM')
) {
  throw new Error('Sandpack adapter Apache-2.0 attribution is incomplete.');
}

const hash = (bytes) => require('crypto').createHash('sha256').update(bytes).digest('hex');
const localIndexBytes = fs.readFileSync(localBundlerIndex);
const localRuntimeBytes = fs.readFileSync(localBundlerRuntime);
const localIndexContents = localIndexBytes.toString('utf8');
const localRuntimeContents = localRuntimeBytes.toString('utf8');
const onPremBootstrap =
  '<script>window._env_=Object.assign({},window._env_,{IS_ONPREM:"true"})</script>';
if (
  hash(localIndexBytes) !== PINNED_OUTPUT_INDEX_SHA256 ||
  hash(localRuntimeBytes) !== PINNED_RUNTIME_SHA256 ||
  localIndexContents.split(onPremBootstrap).length !== 2 ||
  localIndexContents.indexOf(onPremBootstrap) > localIndexContents.indexOf('<script src=') ||
  localRuntimeContents.split('col.csbops.io').length !== 2 ||
  localRuntimeContents.indexOf('IS_ONPREM') > localRuntimeContents.indexOf('col.csbops.io')
) {
  throw new Error('Self-hosted Sandpack telemetry safeguard drifted from its pinned runtime.');
}

if (!javascriptFiles.some((file) => path.basename(file).startsWith('sandpack.'))) {
  throw new Error('Sandpack production chunk is missing.');
}

const violations = javascriptFiles.flatMap((file) => {
  const contents = fs.readFileSync(file, 'utf8');
  return forbiddenSignatures
    .filter((signature) => contents.includes(signature))
    .map((signature) => `${path.relative(dist, file)}: ${signature}`);
});

if (violations.length > 0) {
  throw new Error(`Nodebox code reached the browser production bundle:\n${violations.join('\n')}`);
}

const privatePathViolations = [];
function scanPrivatePaths(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      scanPrivatePaths(entryPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const contents = fs.readFileSync(entryPath, 'utf8');
    if (/\/Users\/[A-Za-z0-9._-]+(?:\/|\b)/.test(contents)) {
      privatePathViolations.push(`${path.relative(localBundlerRoot, entryPath)}: macOS home`);
    }
    for (const match of contents.matchAll(/\/home\/([A-Za-z0-9._-]+)(?:\/|\b)/g)) {
      if (!allowedVirtualHomeNames.has(match[1])) {
        privatePathViolations.push(
          `${path.relative(localBundlerRoot, entryPath)}: non-virtual Unix home`,
        );
      }
    }
  }
}
scanPrivatePaths(localBundlerRoot);
if (privatePathViolations.length > 0) {
  throw new Error(
    `Private build paths reached the shipped Sandpack runtime:\n${privatePathViolations.join('\n')}`,
  );
}

console.log(
  `✅ Browser-only Sandpack verification passed (${javascriptFiles.length} JavaScript assets scanned).`,
);
