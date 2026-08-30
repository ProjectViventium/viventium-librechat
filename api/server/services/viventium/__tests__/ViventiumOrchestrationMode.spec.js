const ORIGINAL_ENV = { ...process.env };
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-release-gate-'));
const releaseDir = path.join(releaseRoot, 'runtime');
fs.mkdirSync(releaseDir, { recursive: true });
fs.chmodSync(releaseDir, 0o700);
const receiptAttestationKey = crypto.randomBytes(32);
const receiptAttestationKeyPath = path.join(releaseDir, 'parallel-work-qa-attestation.key');
const receiptAttestationKeyLinkPath = path.join(releaseDir, 'parallel-work-qa-attestation.link');
const receiptVerifierIds = Object.freeze({
  'EMO-UC-047': 'emo047-semantic-v1',
  'EMO-UC-048': 'emo048-semantic-v1',
  'MPV-061': 'mpv061-semantic-v1',
  'PWK-UC-014': 'pwk-installed-journey-v1',
  'REL-UC-004': 'rel004-semantic-v1',
  'TGDOC-010': 'tgd010-semantic-v1',
  'TR-026': 'tr026-semantic-v1',
});
const receiptServiceAckCases = new Set([
  'TR-026',
  'EMO-UC-047',
  'EMO-UC-048',
  'PWK-UC-016',
  'PWK-UC-017',
  'REL-UC-004',
]);
const releasePath = path.join(releaseDir, 'parallel-work-release-gate.json');
const localQaRequestPath = path.join(releaseDir, 'parallel-work-local-qa-request.json');
const promptBundlePath = path.join(releaseDir, 'prompt-bundle.json');
const ownerRepo = path.join(releaseRoot, 'Installed Viventium');
const ownerExecutable = path.join(ownerRepo, 'bin', 'viventium');
const ownerConfig = path.join(releaseRoot, 'config.yaml');
const ownerLock = path.join(ownerRepo, 'components.lock.json');
const productionRoot = path.resolve(
  process.env.VIVENTIUM_TEST_PRODUCTION_ROOT || path.resolve(__dirname, '../../../../../../../'),
);
const installedGateScript = path.join(
  ownerRepo,
  'scripts',
  'viventium',
  'parallel_work_release_gate.py',
);
const installedCommandContract = path.join(
  ownerRepo,
  'scripts',
  'viventium',
  'runtime_owner_command_contract.json',
);
const installedRuntimeArtifactManifest = path.join(
  ownerRepo,
  'scripts',
  'viventium',
  'parallel_work_runtime_artifact_manifest.json',
);
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Fixture',
      GIT_AUTHOR_EMAIL: 'release-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Release Fixture',
      GIT_COMMITTER_EMAIL: 'release-fixture@example.invalid',
    },
  }).trim();
}
const nestedRepo = path.join(ownerRepo, 'components', 'worker');
fs.mkdirSync(nestedRepo, { recursive: true });
fs.writeFileSync(path.join(nestedRepo, 'worker.txt'), 'worker source\n');
git(nestedRepo, ['init', '-q']);
git(nestedRepo, ['add', 'worker.txt']);
git(nestedRepo, ['commit', '-qm', 'fixture worker']);
const nestedRevision = git(nestedRepo, ['rev-parse', 'HEAD']);
const detachedCommandContract = JSON.parse(
  fs.readFileSync(
    path.join(productionRoot, 'scripts', 'viventium', 'runtime_owner_command_contract.json'),
    'utf8',
  ),
);
fs.mkdirSync(path.dirname(ownerExecutable), { recursive: true });
fs.writeFileSync(
  ownerExecutable,
  '#!/bin/sh\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n',
  { mode: 0o755 },
);
fs.writeFileSync(ownerConfig, 'version: 1\n');
fs.writeFileSync(
  ownerLock,
  `${JSON.stringify({
    version: 1,
    components: [
      {
        name: 'worker',
        path: 'components/worker',
        origin: 'https://example.invalid/worker.git',
        upstream: '',
        ref: nestedRevision,
      },
    ],
  })}\n`,
);
const helperRoot = path.join(ownerRepo, 'apps', 'macos', 'ViventiumHelper');
const helperSourceFiles = [
  'Package.swift',
  'Sources/ViventiumHelper/ViventiumHelperApp.swift',
  'Sources/ViventiumHelper/Resources/Info.plist',
];
for (const relative of helperSourceFiles) {
  const target = path.join(helperRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `fixture:${relative}\n`);
}
const helperPrebuilt = path.join(helperRoot, 'prebuilt');
const helperBinary = path.join(helperPrebuilt, 'ViventiumHelper-universal');
fs.mkdirSync(helperPrebuilt, { recursive: true });
fs.writeFileSync(helperBinary, 'synthetic prebuilt fixture\n', { mode: 0o755 });
const helperSourceDigest = crypto.createHash('sha256');
for (const relative of helperSourceFiles) {
  helperSourceDigest.update(relative);
  helperSourceDigest.update('\0');
  helperSourceDigest.update(fs.readFileSync(path.join(helperRoot, relative)));
  helperSourceDigest.update('\0');
}
fs.writeFileSync(
  path.join(helperPrebuilt, 'source.sha256'),
  `${helperSourceDigest.digest('hex')}\n`,
);
fs.writeFileSync(
  path.join(helperPrebuilt, 'binary.sha256'),
  `${crypto.createHash('sha256').update(fs.readFileSync(helperBinary)).digest('hex')}\n`,
);
fs.mkdirSync(path.dirname(installedGateScript), { recursive: true });
fs.copyFileSync(
  path.join(productionRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py'),
  installedGateScript,
);
fs.chmodSync(installedGateScript, 0o755);
const installedGateSource = fs.readFileSync(installedGateScript, 'utf8');
const readinessAuthorityMarker = '\ndef load_required_gates(';
if (installedGateSource.split(readinessAuthorityMarker).length !== 2) {
  throw new Error('fixture readiness authority requires the canonical gate marker');
}
fs.writeFileSync(
  installedGateScript,
  installedGateSource.replace(
    readinessAuthorityMarker,
    [
      '',
      'def _fixture_remeasure_storage_pressure(readiness_facts, installed_prompt_bundle_path):',
      '    del installed_prompt_bundle_path',
      '    return readiness_facts',
      '',
      '_remeasure_storage_pressure = _fixture_remeasure_storage_pressure',
      '',
      readinessAuthorityMarker,
    ].join('\n'),
  ),
);
fs.copyFileSync(
  path.join(productionRoot, 'scripts', 'viventium', 'runtime_owner_command_contract.json'),
  installedCommandContract,
);
fs.copyFileSync(
  path.join(productionRoot, 'scripts', 'viventium', 'parallel_work_runtime_artifact_manifest.json'),
  installedRuntimeArtifactManifest,
);
const installedArtifactManifest = JSON.parse(
  fs.readFileSync(installedRuntimeArtifactManifest, 'utf8'),
);
for (const entry of installedArtifactManifest.entries) {
  if (entry.kind !== 'file' || entry.path === 'bin/viventium') {
    continue;
  }
  const source = path.join(productionRoot, entry.path);
  const target = path.join(ownerRepo, entry.path);
  if (fs.existsSync(target)) {
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  fs.chmodSync(target, fs.statSync(source).mode);
}
fs.writeFileSync(
  path.join(ownerRepo, '.gitignore'),
  'viventium_v0_4/LibreChat/client/dist/\n' + 'viventium_v0_4/LibreChat/packages/api/dist/\n',
);
const runningServicePath = path.join(
  ownerRepo,
  'viventium_v0_4',
  'LibreChat',
  'api',
  'server',
  'index.js',
);
fs.mkdirSync(path.dirname(runningServicePath), { recursive: true });
fs.writeFileSync(runningServicePath, '// installed service fixture\n');
const runtimeLoadedFiles = {
  'viventium_v0_4/LibreChat/api/app/clients/tools/util/handleTools.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/cache/index.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/config/index.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/strategies/index.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/utils/logger.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/server/services/viventium/ReleaseGateConsumer.js':
    'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/server/routes/viventium/parallelWorkHealth.js':
    'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/server/controllers/agents/client.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/models/Conversation.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/api/db/ReleaseLedger.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/packages/data-schemas/dist/index.js': 'export const schema = true;\n',
  'viventium_v0_4/LibreChat/packages/data-provider/dist/index.js':
    'export const provider = true;\n',
  'viventium_v0_4/LibreChat/api/package.json': '{"name":"@viventium/api-fixture"}\n',
  'viventium_v0_4/LibreChat/api/typedefs.js': 'module.exports = {};\n',
  'viventium_v0_4/LibreChat/package.json': '{"name":"viventium-librechat-fixture"}\n',
  'viventium_v0_4/LibreChat/client/package.json': '{"name":"viventium-client-fixture"}\n',
  'viventium_v0_4/LibreChat/package-lock.json':
    '{"lockfileVersion":3,"name":"viventium-librechat-fixture"}\n',
  'viventium_v0_4/LibreChat/packages/api/package.json': '{"name":"@viventium/api"}\n',
  'viventium_v0_4/LibreChat/packages/client/package.json': '{"name":"@viventium/client"}\n',
  'viventium_v0_4/LibreChat/packages/data-provider/package.json':
    '{"name":"@viventium/data-provider"}\n',
  'viventium_v0_4/LibreChat/packages/data-provider/react-query/package.json':
    '{"name":"@viventium/data-provider-react-query"}\n',
  'viventium_v0_4/LibreChat/packages/data-schemas/package.json':
    '{"name":"@viventium/data-schemas"}\n',
  'viventium_v0_4/LibreChat/api/server/utils/emails/inviteUser.handlebars':
    '<p>Fixture invitation</p>\n',
  'qa/parallel-orchestrator/cases.md': `| Case | Current status |
| --- | --- |
| \`PWK-UC-014\` | NOT RUN |
`,
  'qa/release-readiness/cases.md': `| Case ID | Last Run |
| --- | --- |
| \`REL-UC-004\` | NOT RUN |
`,
  'qa/emotional-cortex/cases.md': `| ID | Last run |
| --- | --- |
| \`EMO-UC-047\` | NOT RUN |
| \`EMO-UC-048\` | NOT RUN |
`,
  'qa/telegram-document-attachments/cases.md': `| ID | Last run |
| --- | --- |
| \`TGDOC-010\` | NOT RUN |
`,
  'qa/telegram-runtime/cases.md': `## Case TR-026: Source-order race

- **Last run:** NOT RUN
`,
  'qa/modern-playground-voice/cases.md': `### MPV-061: Trusted Wing Worker control

- **Last Run:** NOT RUN
`,
};
const runtimeLoadedServicePath = path.join(
  ownerRepo,
  'viventium_v0_4/LibreChat/api/server/services/viventium/ReleaseGateConsumer.js',
);
const runtimeLoadedDependencyPath = path.join(
  ownerRepo,
  'viventium_v0_4/LibreChat/api/app/clients/tools/util/handleTools.js',
);
for (const [relative, content] of Object.entries(runtimeLoadedFiles)) {
  const target = path.join(ownerRepo, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
fs.writeFileSync(
  path.join(ownerRepo, 'config.schema.yaml'),
  'properties:\n  integrations:\n    properties:\n      glasshive:\n        properties:\n          orchestration:\n            properties:\n              available:\n                type: boolean\n                default: false\n              default_mode:\n                type: string\n                default: focused\n',
);
git(ownerRepo, ['init', '-q']);
git(ownerRepo, ['add', '.']);
git(ownerRepo, ['commit', '-qm', 'clean commit A']);
const runtimeEnvPath = path.join(releaseDir, 'runtime.env');
const libreChatConfigPath = path.join(releaseDir, 'librechat.yaml');
const frontendBuildRoot = path.join(ownerRepo, 'viventium_v0_4', 'LibreChat', 'client', 'dist');
const apiBuildRoot = path.join(ownerRepo, 'viventium_v0_4', 'LibreChat', 'packages', 'api', 'dist');
fs.mkdirSync(frontendBuildRoot, { recursive: true });
fs.mkdirSync(apiBuildRoot, { recursive: true });
fs.writeFileSync(path.join(frontendBuildRoot, 'index.html'), '<main>fixture</main>\n');
fs.writeFileSync(path.join(apiBuildRoot, 'index.js'), 'export const fixture = true;\n');
fs.writeFileSync(
  runtimeEnvPath,
  'VIVENTIUM_PARALLEL_WORK_AVAILABLE=false\nVIVENTIUM_PARALLEL_WORK_DEFAULT_MODE=focused\n',
);
fs.writeFileSync(libreChatConfigPath, 'version: 1.2.1\n');
const detachedCommandValues = {
  ownerExecutablePath: fs.realpathSync(ownerExecutable),
  appSupportDir: fs.realpathSync(releaseRoot),
  configFile: fs.realpathSync(ownerConfig),
  runtimeDir: fs.realpathSync(releaseDir),
  componentsLockFile: fs.realpathSync(ownerLock),
};
const detachedOwnerArgv = detachedCommandContract.detached.argvTemplate.map((token) =>
  token.replace(/\{([^}]+)\}/g, (_match, key) => detachedCommandValues[key]),
);
const ownerProcess = spawn(detachedOwnerArgv[0], detachedOwnerArgv.slice(1), {
  cwd: ownerRepo,
  stdio: 'ignore',
});
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const VALID_PROMPT_BUNDLE = {
  schema_version: 1,
  prompt_count: 1,
  prompts: {
    'main.answer': {
      content_hash: 'a1',
      metadata: { owner_layer: 'main', status: 'active', version: 1 },
    },
  },
};
const VALID_PROMPT_REGISTRY_HASH = crypto
  .createHash('sha256')
  .update(
    JSON.stringify([
      {
        contentHash: 'a1',
        id: 'main.answer',
        ownerLayer: 'main',
        status: 'active',
        version: 1,
      },
    ]),
  )
  .digest('hex');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Tree(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error('symlink is not an artifact');
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile()) files.push(target);
    }
  };
  visit(root);
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    digest.update(path.relative(root, file).split(path.sep).join('/'));
    digest.update('\0');
    digest.update(fs.readFileSync(file));
    digest.update('\0');
  }
  return files.length ? digest.digest('hex') : '';
}

function runtimeServiceArtifactDigests(root, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const measured = [];
  for (const entry of manifest.entries) {
    const target = path.join(root, entry.path);
    if (entry.kind === 'file') {
      measured.push({ path: entry.path, sha256: sha256(fs.readFileSync(target)) });
      continue;
    }
    const excluded = new Set(entry.excludeDirectories);
    const excludedSuffixes = entry.excludeFileSuffixes;
    const extensions = new Set(entry.extensions);
    const visit = (directory) => {
      for (const name of fs.readdirSync(directory).sort()) {
        const child = path.join(directory, name);
        const relative = path.relative(root, child).split(path.sep).join('/');
        const stat = fs.lstatSync(child);
        if (stat.isDirectory()) {
          if (!excluded.has(name)) visit(child);
        } else if (
          stat.isFile() &&
          extensions.has(path.extname(name)) &&
          !excludedSuffixes.some((suffix) => name.endsWith(suffix))
        ) {
          measured.push({ path: relative, sha256: sha256(fs.readFileSync(child)) });
        }
      }
    };
    visit(target);
  }
  return {
    runningServiceSha256: sha256(JSON.stringify(measured)),
    runtimeServiceManifestSha256: sha256(fs.readFileSync(manifestPath)),
  };
}

function canonicalJson(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
}

function canonicalJsonDeep(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonDeep).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonDeep(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const READINESS_FLOAT_FIELDS = new Set(['usedPercent', 'thresholdPercent', 'warningMarginPercent']);

function canonicalReadinessJson(value, field = '') {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalReadinessJson(item)).join(',')}]`;
  }
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalReadinessJson(value[key], key)}`)
      .join(',')}}`;
  }
  if (typeof value === 'number' && READINESS_FLOAT_FIELDS.has(field) && Number.isInteger(value)) {
    return `${value}.0`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readinessIdentity(facts) {
  const storage = facts?.storagePressure;
  if (
    facts == null ||
    typeof facts !== 'object' ||
    storage == null ||
    typeof storage !== 'object'
  ) {
    return {
      factsSha256: '',
      storagePolicySha256: '',
      storageMeasurementSha256: '',
    };
  }
  const policy = {
    version: storage.version,
    thresholdPercent: storage.thresholdPercent,
    warningMarginPercent: storage.warningMarginPercent,
  };
  const measurement = {
    version: storage.version,
    status: storage.status,
    usedPercent: storage.usedPercent,
    availableBytes: storage.availableBytes,
    ...(Object.hasOwn(storage, 'reason') ? { reason: storage.reason } : {}),
  };
  return {
    factsSha256: sha256(canonicalReadinessJson(facts)),
    storagePolicySha256: sha256(canonicalReadinessJson(policy)),
    storageMeasurementSha256: sha256(canonicalReadinessJson(measurement)),
  };
}

function nestedRevisionsHash(nested) {
  return sha256(
    JSON.stringify(
      nested.map((component) => ({
        name: component.name,
        pin: component.pin,
        revision: component.revision,
      })),
    ),
  );
}

function normalized(value) {
  return String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function writeValidOwnerState(boundProcess = ownerProcess) {
  const startedAt = normalized(
    execFileSync('ps', ['-p', String(boundProcess.pid), '-o', 'lstart='], { encoding: 'utf8' }),
  );
  const command = normalized(
    execFileSync('ps', ['-p', String(boundProcess.pid), '-o', 'command='], { encoding: 'utf8' }),
  );
  const payload = {
    contractVersion: 1,
    repoRoot: fs.realpathSync(ownerRepo),
    appSupportDir: fs.realpathSync(releaseRoot),
    runtimeDir: fs.realpathSync(releaseDir),
    configFile: fs.realpathSync(ownerConfig),
    componentsLockFile: fs.realpathSync(ownerLock),
    ownerLaunchMode: 'detached',
    runtimeProfile: 'isolated',
    command: 'start',
    ownerPid: String(boundProcess.pid),
    ownerExecutablePath: fs.realpathSync(ownerExecutable),
    ownerProcessCwd: fs.realpathSync(ownerRepo),
    ownerProcessStartedAt: startedAt,
    ownerProcessCommand: command,
  };
  payload.ownerBindingSha256 = sha256(canonicalJson(payload));
  payload.updatedAt = new Date().toISOString();
  const ownerPath = path.join(releaseRoot, 'state', 'runtime', 'isolated', 'stack-owner.json');
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  fs.writeFileSync(ownerPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.chmodSync(ownerPath, 0o600);
  return { ownerPath, payload };
}

function validOwnerBinding(boundProcess = ownerProcess) {
  const { ownerPath, payload } = writeValidOwnerState(boundProcess);
  const ownerText = fs.readFileSync(ownerPath);
  const generatedAt = new Date();
  const expiresAt = new Date(generatedAt.getTime() + 86_400_000);
  return {
    contractVersion: 1,
    runtimeProfile: payload.runtimeProfile,
    command: payload.command,
    ownerPid: payload.ownerPid,
    ownerProcessStartedAt: payload.ownerProcessStartedAt,
    ownerBindingSha256: payload.ownerBindingSha256,
    ownerStateSha256: sha256(ownerText),
    repoRootSha256: sha256(payload.repoRoot),
    runtimeDirSha256: sha256(payload.runtimeDir),
    ownerExecutablePathSha256: sha256(payload.ownerExecutablePath),
    ownerProcessCwdSha256: sha256(payload.ownerProcessCwd),
    ownerProcessCommandSha256: sha256(payload.ownerProcessCommand),
    configFileSha256: sha256(payload.configFile),
    componentsLockFileSha256: sha256(payload.componentsLockFile),
    ownerLaunchMode: payload.ownerLaunchMode,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    maxAgeSeconds: 86_400,
  };
}

function validGates() {
  return [
    ['EMO-UC-047', 'qa/emotional-cortex/cases.md'],
    ['EMO-UC-048', 'qa/emotional-cortex/cases.md'],
    ['MPV-061', 'qa/modern-playground-voice/cases.md'],
    ['PWK-UC-014', 'qa/parallel-orchestrator/cases.md'],
    ['REL-UC-004', 'qa/release-readiness/cases.md'],
    ['TGDOC-010', 'qa/telegram-document-attachments/cases.md'],
    ['TR-026', 'qa/telegram-runtime/cases.md'],
  ].map(([case_id, source]) => ({ case_id, status: 'PASS', source, detail: '[redacted]' }));
}

function validGate() {
  return validGates().find((gate) => gate.case_id === 'REL-UC-004');
}

function openGate(caseId) {
  const source = caseId.startsWith('PWK-')
    ? 'qa/parallel-orchestrator/cases.md'
    : caseId.startsWith('EMO-')
      ? 'qa/emotional-cortex/cases.md'
      : caseId.startsWith('TGDOC-')
        ? 'qa/telegram-document-attachments/cases.md'
        : caseId.startsWith('MPV-')
          ? 'qa/modern-playground-voice/cases.md'
          : caseId.startsWith('TR-')
            ? 'qa/telegram-runtime/cases.md'
            : 'qa/release-readiness/cases.md';
  return {
    case_id: caseId,
    status: 'NOT_RUN',
    source,
    detail: '[redacted]',
  };
}

function validReadinessFacts() {
  return {
    contractVersion: 1,
    promptLayers: {
      contractVersion: 1,
      producerScope: 'viventium.prompt_registry.v1',
      status: 'verified',
      unknownLayerCount: 0,
      unknownLayerNames: [],
      promptCount: 1,
      layerCount: 1,
      layerNames: ['main'],
      registryHash: VALID_PROMPT_REGISTRY_HASH,
    },
    storagePressure: {
      version: 1,
      status: 'healthy',
      usedPercent: 40,
      availableBytes: 20 * 1024 * 1024 * 1024,
      thresholdPercent: 90,
      warningMarginPercent: 10,
    },
  };
}

function validArtifactIdentity() {
  const sourceRevision = git(ownerRepo, ['rev-parse', 'HEAD']);
  const currentNestedRevision = git(nestedRepo, ['rev-parse', 'HEAD']);
  const sourceStatus = git(ownerRepo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
    '--ignore-submodules=all',
  ]);
  const nestedStatus = git(nestedRepo, ['status', '--porcelain=v1', '--untracked-files=all']);
  const lockSha256 = sha256(fs.readFileSync(ownerLock));
  const sourceDeclaredSha256 = fs
    .readFileSync(path.join(helperPrebuilt, 'source.sha256'), 'utf8')
    .trim();
  const binaryDeclaredSha256 = fs
    .readFileSync(path.join(helperPrebuilt, 'binary.sha256'), 'utf8')
    .trim();
  const nested = [
    {
      name: 'worker',
      pin: currentNestedRevision,
      revision: currentNestedRevision,
      clean: nestedStatus === '',
      worktreeHash: sha256(nestedStatus),
    },
  ];
  const runtimeService = runtimeServiceArtifactDigests(ownerRepo, installedRuntimeArtifactManifest);
  return {
    contractVersion: 1,
    readiness: readinessIdentity(validReadinessFacts()),
    source: {
      revision: sourceRevision,
      clean: sourceStatus === '',
      worktreeHash: sha256(sourceStatus),
      componentsLockSha256: lockSha256,
    },
    nestedComponents: nested,
    prebuiltHelper: {
      sourceDeclaredSha256,
      sourceMeasuredSha256: sourceDeclaredSha256,
      binaryDeclaredSha256,
      binaryMeasuredSha256: binaryDeclaredSha256,
      binaryExecutable: true,
    },
    installed: {
      rootRevision: sourceRevision,
      componentsLockSha256: lockSha256,
      nestedRevisionsHash: nestedRevisionsHash(nested),
      prebuiltSourceSha256: sourceDeclaredSha256,
      prebuiltBinarySha256: binaryDeclaredSha256,
      promptBundleSha256: sha256(fs.readFileSync(promptBundlePath)),
      runtimeEnvSha256: sha256(fs.readFileSync(runtimeEnvPath)),
      libreChatConfigSha256: sha256(fs.readFileSync(libreChatConfigPath)),
      frontendBuildSha256: sha256Tree(frontendBuildRoot),
      apiBuildSha256: sha256Tree(apiBuildRoot),
      runningServiceSha256: runtimeService.runningServiceSha256,
      runtimeServiceManifestSha256: runtimeService.runtimeServiceManifestSha256,
      runtimeOwnerExecutableSha256: sha256(fs.readFileSync(ownerExecutable)),
      ownerCommandContractSha256: sha256(fs.readFileSync(installedCommandContract)),
    },
  };
}

function measuredArtifactIdentityFromPython() {
  const ownerPath = path.join(releaseRoot, 'state', 'runtime', 'isolated', 'stack-owner.json');
  const source = [
    'import importlib.util,json,sys',
    'from pathlib import Path',
    'spec=importlib.util.spec_from_file_location("gate",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec)',
    'sys.modules[spec.name]=module',
    'spec.loader.exec_module(module)',
    'value=module._measured_artifact_identity(Path(sys.argv[2]),Path(sys.argv[3]),Path(sys.argv[2]),Path(sys.argv[4]))',
    'print(json.dumps(module._public_artifact_identity(value),sort_keys=True))',
  ].join(';');
  return JSON.parse(
    execFileSync(
      '/usr/bin/python3',
      ['-c', source, installedGateScript, ownerRepo, promptBundlePath, ownerPath],
      {
        encoding: 'utf8',
      },
    ),
  );
}

function validArtifactChecks() {
  return [
    { check_id: 'SOURCE-IDENTITY', status: 'PASS', reason: '' },
    { check_id: 'NESTED-PINS', status: 'PASS', reason: '' },
    { check_id: 'PREBUILT-IDENTITY', status: 'PASS', reason: '' },
    { check_id: 'INSTALLED-ARTIFACT', status: 'PASS', reason: '' },
  ];
}

function stableReceiptOwnerBinding(ownerBinding) {
  return sha256(
    canonicalJsonDeep({
      contractVersion: 1,
      ownerUid: fs.statSync(releaseDir).uid,
      repoRootSha256: ownerBinding?.repoRootSha256,
      runtimeDirSha256: ownerBinding?.runtimeDirSha256,
      runtimeProfile: ownerBinding?.runtimeProfile,
    }),
  );
}

function signReceipt(receipt) {
  const { attestation: _previousAttestation, ...unsigned } = receipt;
  receipt.attestation = `hmac-sha256:${crypto
    .createHmac('sha256', receiptAttestationKey)
    .update(canonicalJsonDeep(unsigned))
    .digest('hex')}`;
  return receipt;
}

function writeReleaseSnapshot(overrides = {}) {
  const ownerBinding = Object.prototype.hasOwnProperty.call(overrides, 'owner_binding')
    ? overrides.owner_binding
    : validOwnerBinding();
  const payload = {
    contract_version: 1,
    mode: 'release',
    label: 'READY',
    release_ready: true,
    exposure_allowed: true,
    local_qa_override: false,
    source_defaults_dark: true,
    gate_count: validGates().length,
    open_gate_count: 0,
    gates: validGates(),
    open_gates: [],
    readiness_checks: [
      { check_id: 'PROMPT-LAYERS', status: 'PASS', reason: '' },
      { check_id: 'STORAGE-PRESSURE', status: 'PASS', reason: '' },
    ],
    blocking_checks: [],
    readiness_facts: validReadinessFacts(),
    artifact_checks: validArtifactChecks(),
    blocking_artifact_checks: [],
    artifact_identity: validArtifactIdentity(),
    owner_binding: ownerBinding,
    ...overrides,
  };
  if (
    payload.artifact_identity != null &&
    typeof payload.artifact_identity === 'object' &&
    !Object.hasOwn(overrides, 'artifact_identity')
  ) {
    payload.artifact_identity = {
      ...payload.artifact_identity,
      readiness: readinessIdentity(payload.readiness_facts),
    };
  }
  const candidateDigest = sha256(
    canonicalJsonDeep({
      readiness: payload.artifact_identity?.readiness,
      source: payload.artifact_identity?.source,
      nestedComponents: payload.artifact_identity?.nestedComponents,
      prebuiltHelper: payload.artifact_identity?.prebuiltHelper,
    }),
  );
  const artifactDigest = sha256(canonicalJsonDeep(payload.artifact_identity?.installed));
  const receiptPayload = {
    contractVersion: 1,
    receipts: payload.gates
      .filter((gate) => gate.source.startsWith('qa/') && gate.status === 'PASS')
      .map((gate) =>
        signReceipt({
          caseId: gate.case_id,
          runAt: new Date().toISOString(),
          candidateDigest,
          artifactDigest,
          evidenceDigest: sha256(`fixture:${gate.case_id}`),
          surface: gate.case_id === 'MPV-061' ? 'voice' : 'telegram',
          status: 'PASS',
          ownerBindingSha256: stableReceiptOwnerBinding(ownerBinding),
          receiptNonce: crypto.randomBytes(16).toString('hex'),
          verifierId: receiptVerifierIds[gate.case_id],
          verifierManifestSha256: sha256(`fixture-manifest:${gate.case_id}`),
          ...(receiptServiceAckCases.has(gate.case_id)
            ? {
                serviceAckDigest: `sha256:${sha256(`fixture-service:${gate.case_id}`)}`,
                serviceAckSessionRef: `qa_${sha256(gate.case_id).slice(0, 24)}`,
              }
            : {}),
        }),
      ),
  };
  payload.qa_receipt_summary = {
    contractVersion: 1,
    status: payload.gates.every((gate) => gate.status === 'PASS') ? 'verified' : 'blocked',
    receiptCount: receiptPayload.receipts.length,
    receiptDigest: sha256(canonicalJsonDeep(receiptPayload)),
    candidateDigest,
    artifactDigest,
    maxAgeSeconds: 86_400,
  };
  fs.writeFileSync(
    path.join(releaseDir, 'parallel-work-qa-case-receipts.json'),
    `${JSON.stringify(receiptPayload)}\n`,
  );
  fs.writeFileSync(releasePath, JSON.stringify(payload));
  if (payload.readiness_facts != null) {
    fs.writeFileSync(
      path.join(releaseDir, 'parallel-work-readiness-facts.json'),
      `${JSON.stringify(payload.readiness_facts)}\n`,
    );
  }
  if (payload.artifact_identity != null) {
    fs.writeFileSync(
      path.join(releaseDir, 'parallel-work-artifact-identity.json'),
      `${JSON.stringify(payload.artifact_identity)}\n`,
    );
  }
}

function writeLocalQaSnapshot(overrides = {}) {
  writeReleaseSnapshot({
    mode: 'local-qa',
    label: 'PRE-GATE / NOT READY',
    release_ready: false,
    exposure_allowed: true,
    local_qa_override: true,
    ...overrides,
  });
}

function writeBlockedReleaseSnapshot(overrides = {}) {
  const gates = validGates().map((gate) => openGate(gate.case_id));
  writeReleaseSnapshot({
    mode: 'release',
    label: 'NOT READY',
    release_ready: false,
    exposure_allowed: false,
    local_qa_override: false,
    gate_count: gates.length,
    open_gate_count: gates.length,
    gates,
    open_gates: gates,
    ...overrides,
  });
}

function writeUntrustedExternalReleaseSnapshot() {
  writeReleaseSnapshot();
  const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
  const payload = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  payload.receipts = payload.receipts.map((receipt) => {
    const { attestation: _localAttestation, ...unsigned } = receipt;
    return {
      ...unsigned,
      attestationContractVersion: 1,
      attestationPurpose: 'viventium.qa.release.receipt.v1',
      attestationSequence: 1,
      producerAttestations: [{ producerId: 'observation-producer' }],
      publisherAttestation:
        '-----BEGIN SSH SIGNATURE-----\nZmFrZS1wdWJsaXNoZXI=\n-----END SSH SIGNATURE-----\n',
      publisherIdentity: 'publisher@fixture.example.invalid',
      serviceAcknowledgements: receiptServiceAckCases.has(receipt.caseId)
        ? [{ producerId: 'librechat-core' }]
        : [],
    };
  });
  fs.writeFileSync(receiptPath, `${JSON.stringify(payload)}\n`);
  const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
  snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(payload));
  fs.writeFileSync(releasePath, JSON.stringify(snapshot));
}

jest.mock('../GlassHiveOrchestrationReadinessService', () => ({
  orchestrationReadinessSnapshot: ({ ownerId } = {}) => ({
    available: Boolean(ownerId) && process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  }),
  orchestrationDeploymentReadinessSnapshot: () => ({
    available: process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY === 'true',
  }),
}));

describe('ViventiumOrchestrationMode', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'focused';
    process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE = releasePath;
    process.env.VIVENTIUM_RUNTIME_DIR = releaseDir;
    delete process.env.VIVENTIUM_PARALLEL_WORK_LOCAL_QA_OVERRIDE;
    fs.chmodSync(releaseDir, 0o700);
    fs.rmSync(receiptAttestationKeyLinkPath, { force: true });
    fs.rmSync(receiptAttestationKeyPath, { force: true });
    fs.writeFileSync(receiptAttestationKeyPath, receiptAttestationKey, { mode: 0o600 });
    fs.chmodSync(receiptAttestationKeyPath, 0o600);
    fs.rmSync(localQaRequestPath, { force: true });
    fs.writeFileSync(promptBundlePath, `${JSON.stringify(VALID_PROMPT_BUNDLE)}\n`);
    writeReleaseSnapshot();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
    ownerProcess.kill();
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  });

  test('uses the compiled default only when the account has no explicit override', () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'parallel';
    writeLocalQaSnapshot();
    const { effectiveOrchestrationMode } = require('../ViventiumOrchestrationMode');

    expect(effectiveOrchestrationMode({ id: 'owner-1' })).toBe('parallel');
    expect(
      effectiveOrchestrationMode({
        id: 'owner-1',
        personalization: { orchestration_mode: 'focused' },
      }),
    ).toBe('focused');
  });

  test('never borrows account readiness when no owner is present', () => {
    const {
      effectiveOrchestrationMode,
      parallelWorkAvailable,
    } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkAvailable()).toBe(false);
    expect(
      effectiveOrchestrationMode({ personalization: { orchestration_mode: 'parallel' } }),
    ).toBe('focused');
  });

  test('keeps deployment readiness separate from account readiness', () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeLocalQaSnapshot();
    const {
      parallelWorkAvailable,
      parallelWorkDeploymentAvailable,
    } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkDeploymentAvailable()).toBe(true);
    expect(parallelWorkAvailable()).toBe(false);
    expect(parallelWorkAvailable('owner-1')).toBe(true);
  });

  test('reuses only the exact process-validated release gate for one owner claim', () => {
    writeLocalQaSnapshot();
    const childProcess = require('child_process');
    const subprocess = jest.spyOn(childProcess, 'execFileSync');
    const {
      consumeTrustedParallelWorkClaimState,
      parallelWorkClaimState,
      parallelWorkReleaseGateSnapshot,
    } = require('../ViventiumOrchestrationMode');

    try {
      const releaseGate = parallelWorkReleaseGateSnapshot();
      const validationsAfterGate = subprocess.mock.calls.filter(
        ([, args]) => Array.isArray(args) && args.includes('--validate-snapshot'),
      ).length;

      const claimState = parallelWorkClaimState('owner-1', releaseGate);
      expect(claimState.available).toBe(true);
      expect(
        subprocess.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args.includes('--validate-snapshot'),
        ),
      ).toHaveLength(validationsAfterGate);
      expect(consumeTrustedParallelWorkClaimState(claimState, 'owner-2')).toBe(false);
      expect(consumeTrustedParallelWorkClaimState(claimState, 'owner-1')).toBe(true);
      expect(consumeTrustedParallelWorkClaimState(claimState, 'owner-1')).toBe(false);

      expect(parallelWorkClaimState('owner-1', releaseGate).available).toBe(true);
      expect(
        subprocess.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args.includes('--validate-snapshot'),
        ),
      ).toHaveLength(validationsAfterGate + 1);

      expect(parallelWorkClaimState('owner-1', { ...releaseGate }).available).toBe(true);
      expect(
        subprocess.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args.includes('--validate-snapshot'),
        ),
      ).toHaveLength(validationsAfterGate + 2);
    } finally {
      subprocess.mockRestore();
    }
  });

  test('returns an explicitly blocked deployment without starting a release validation worker', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeBlockedReleaseSnapshot();
    const mockWorkerConstructor = jest.fn(() => {
      throw new Error('blocked release state must not start a validation worker');
    });
    jest.doMock('worker_threads', () => ({
      ...jest.requireActual('worker_threads'),
      Worker: mockWorkerConstructor,
    }));

    try {
      const { parallelWorkDeploymentAvailableAsync } = require('../ViventiumOrchestrationMode');

      await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(false);
      expect(mockWorkerConstructor).not.toHaveBeenCalled();
    } finally {
      jest.dontMock('worker_threads');
      jest.resetModules();
    }
  });

  test('delegates a raw release candidate to the full validation worker', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeReleaseSnapshot();
    const mockWorkerConstructor = jest.fn(() => {
      throw new Error('worker delegation proof');
    });
    jest.doMock('worker_threads', () => ({
      ...jest.requireActual('worker_threads'),
      Worker: mockWorkerConstructor,
    }));

    try {
      const { parallelWorkDeploymentAvailableAsync } = require('../ViventiumOrchestrationMode');

      await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(false);
      expect(mockWorkerConstructor).toHaveBeenCalledTimes(1);
    } finally {
      jest.dontMock('worker_threads');
      jest.resetModules();
    }
  });

  test('prewarms and reuses only presentation availability while owner claims revalidate', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeLocalQaSnapshot();
    const mockWorkerConstructor = jest.fn();
    jest.doMock('worker_threads', () => {
      const actual = jest.requireActual('worker_threads');
      const { EventEmitter } = jest.requireActual('events');
      return {
        ...actual,
        Worker: class SuccessfulReleaseGateWorker extends EventEmitter {
          constructor() {
            super();
            mockWorkerConstructor();
            this.threadId = mockWorkerConstructor.mock.calls.length;
            setImmediate(() =>
              this.emit('message', {
                available: true,
                releaseReady: false,
                label: 'PRE-GATE / NOT READY',
                blockers: ['local_qa_override_active'],
              }),
            );
          }

          terminate() {
            this.threadId = -1;
            return Promise.resolve(0);
          }
        },
      };
    });

    let ownerPath = null;
    let ownerBytes = null;
    try {
      const {
        parallelWorkClaimStateAsync,
        parallelWorkDeploymentAvailableAsync,
      } = require('../ViventiumOrchestrationMode');

      await expect(
        Promise.all([
          parallelWorkDeploymentAvailableAsync(),
          parallelWorkDeploymentAvailableAsync(),
        ]),
      ).resolves.toEqual([true, true]);
      await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(true);
      expect(mockWorkerConstructor).toHaveBeenCalledTimes(1);

      await expect(parallelWorkClaimStateAsync('owner-1')).resolves.toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(mockWorkerConstructor).toHaveBeenCalledTimes(2);

      writeLocalQaSnapshot();
      await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(true);
      expect(mockWorkerConstructor).toHaveBeenCalledTimes(3);

      ownerPath = path.join(releaseRoot, 'state', 'runtime', 'isolated', 'stack-owner.json');
      ownerBytes = fs.readFileSync(ownerPath);
      fs.appendFileSync(ownerPath, '\n');
      await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(false);
      expect(mockWorkerConstructor).toHaveBeenCalledTimes(3);
      fs.writeFileSync(ownerPath, ownerBytes);
    } finally {
      if (ownerPath && ownerBytes) fs.writeFileSync(ownerPath, ownerBytes);
      jest.dontMock('worker_threads');
      jest.resetModules();
    }
  });

  test('never trusts a forged raw release candidate without full validation', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeReleaseSnapshot({ artifact_identity: null });
    const { parallelWorkDeploymentAvailableAsync } = require('../ViventiumOrchestrationMode');

    await expect(parallelWorkDeploymentAvailableAsync()).resolves.toBe(false);
  });

  test('validates async owner and deployment authority without blocking the Node event loop', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_DEPLOYMENT_READY = 'true';
    writeLocalQaSnapshot();
    const {
      parallelWorkClaimStateAsync,
      parallelWorkDeploymentAvailableAsync,
    } = require('../ViventiumOrchestrationMode');
    const eventLoopTick = jest.fn();

    const claimPending = parallelWorkClaimStateAsync('owner-1');
    const deploymentPending = parallelWorkDeploymentAvailableAsync();
    setImmediate(eventLoopTick);
    await new Promise((resolve) => setImmediate(resolve));

    expect(eventLoopTick).toHaveBeenCalledTimes(1);
    await expect(claimPending).resolves.toEqual(expect.objectContaining({ available: true }));
    await expect(deploymentPending).resolves.toBe(true);
  });

  test('fails closed and terminates a release validation worker that never settles', async () => {
    jest.useFakeTimers();
    const mockTerminate = jest.fn().mockResolvedValue(0);
    jest.doMock('worker_threads', () => {
      const actual = jest.requireActual('worker_threads');
      const { EventEmitter } = jest.requireActual('events');
      return {
        ...actual,
        Worker: class InertReleaseGateWorker extends EventEmitter {
          constructor() {
            super();
            this.threadId = 1;
          }

          terminate() {
            this.threadId = -1;
            return mockTerminate();
          }
        },
      };
    });

    try {
      const { parallelWorkReleaseGateSnapshotAsync } = require('../ViventiumOrchestrationMode');
      const pending = parallelWorkReleaseGateSnapshotAsync();
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await Promise.resolve();
      expect(settled).toBe(false);
      jest.advanceTimersByTime(135_000);

      await expect(pending).resolves.toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
      expect(mockTerminate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      jest.dontMock('worker_threads');
      jest.resetModules();
    }
  });

  test('fails closed to focused whenever the capability is unavailable', () => {
    const { effectiveOrchestrationMode } = require('../ViventiumOrchestrationMode');

    expect(
      effectiveOrchestrationMode(
        { personalization: { orchestration_mode: 'parallel' } },
        { available: false },
      ),
    ).toBe('focused');
  });

  test('fails the actual claim path closed when the compiled snapshot is missing', () => {
    fs.unlinkSync(releasePath);
    const {
      parallelWorkAvailable,
      parallelWorkClaimState,
    } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkAvailable('owner-1')).toBe(false);
    expect(parallelWorkClaimState('owner-1')).toEqual(
      expect.objectContaining({
        available: false,
        label: 'NOT READY',
        blockers: expect.arrayContaining(['release_snapshot_unavailable']),
      }),
    );
  });

  test('rejects a release snapshot without a bound owner projection', () => {
    writeReleaseSnapshot({ owner_binding: undefined });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('owner-readable HMAC receipts never establish release readiness even if a downstream check is bypassed', () => {
    const childProcess = require('child_process');
    const originalExecFileSync = childProcess.execFileSync;
    const subprocess = jest
      .spyOn(childProcess, 'execFileSync')
      .mockImplementation((file, args, options) => {
        if (Array.isArray(args) && args.includes('--validate-snapshot')) return '';
        return originalExecFileSync(file, args, options);
      });

    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({
          available: false,
          releaseReady: false,
          label: 'NOT READY',
        }),
      );
    } finally {
      subprocess.mockRestore();
    }
  });

  test('rejects a complete external envelope without a pinned publisher and protected witness', () => {
    writeUntrustedExternalReleaseSnapshot();
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
      }),
    );
  });

  test('accepts stable-owner, case-bound HMAC receipts only for labelled local QA', () => {
    writeLocalQaSnapshot();
    const receipts = JSON.parse(
      fs.readFileSync(path.join(releaseDir, 'parallel-work-qa-case-receipts.json'), 'utf8'),
    );
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(
      receipts.receipts.every(
        (receipt) =>
          receipt.ownerBindingSha256 === stableReceiptOwnerBinding(snapshot.owner_binding),
      ),
    ).toBe(true);
    expect(receipts.receipts[0].ownerBindingSha256).not.toBe(
      snapshot.owner_binding.ownerBindingSha256,
    );
    expect(
      receipts.receipts.some((receipt) => ['PWK-001', 'REL-001'].includes(receipt.caseId)),
    ).toBe(false);
    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: true,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
  });

  test('keeps local QA HMAC receipts valid across an owner-process restart without claiming release', () => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const originalReceipts = fs.readFileSync(receiptPath, 'utf8');
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const previousOwnerBinding = snapshot.owner_binding.ownerBindingSha256;
    const restartedOwner = spawn(detachedOwnerArgv[0], detachedOwnerArgv.slice(1), {
      cwd: ownerRepo,
      stdio: 'ignore',
    });
    try {
      snapshot.owner_binding = validOwnerBinding(restartedOwner);
      fs.writeFileSync(releasePath, JSON.stringify(snapshot));
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(snapshot.owner_binding.ownerBindingSha256).not.toBe(previousOwnerBinding);
      expect(fs.readFileSync(receiptPath, 'utf8')).toBe(originalReceipts);
      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({
          available: true,
          releaseReady: false,
          label: 'PRE-GATE / NOT READY',
        }),
      );
    } finally {
      restartedOwner.kill('SIGTERM');
      writeValidOwnerState(ownerProcess);
    }
  });

  test.each([
    ['missing attestation', (receipt) => delete receipt.attestation, false],
    [
      'forged attestation',
      (receipt) => (receipt.attestation = `hmac-sha256:${'0'.repeat(64)}`),
      false,
    ],
    ['changed signed evidence', (receipt) => (receipt.evidenceDigest = '1'.repeat(64)), false],
    [
      'changed signed verifier manifest',
      (receipt) => (receipt.verifierManifestSha256 = '1'.repeat(64)),
      false,
    ],
    ['wrong signed candidate', (receipt) => (receipt.candidateDigest = '3'.repeat(64)), true],
    ['wrong signed artifact', (receipt) => (receipt.artifactDigest = '4'.repeat(64)), true],
    ['wrong stable owner', (receipt) => (receipt.ownerBindingSha256 = '2'.repeat(64)), true],
    [
      'process-instance owner',
      (receipt, snapshot) =>
        (receipt.ownerBindingSha256 = snapshot.owner_binding.ownerBindingSha256),
      true,
    ],
    ['unregistered verifier', (receipt) => (receipt.verifierId = 'fixture-semantic-v1'), true],
    ['another case verifier', (receipt) => (receipt.verifierId = 'emo047-semantic-v1'), true],
    ['unsafe verifier', (receipt) => (receipt.verifierId = '../../invalid'), true],
    ['invalid verifier manifest', (receipt) => (receipt.verifierManifestSha256 = 'broken'), true],
    ['invalid nonce', (receipt) => (receipt.receiptNonce = 'invalid'), true],
  ])('rejects an authenticated QA receipt with %s', (_label, mutate, resign) => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    const receipt = receipts.receipts.find((item) => item.caseId === 'PWK-UC-014');
    mutate(receipt, snapshot);
    if (resign) signReceipt(receipt);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts)}\n`);
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(receipts));
    fs.writeFileSync(releasePath, JSON.stringify(snapshot));

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects the same signed nonce replayed across different QA cases', () => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipts.receipts[1].receiptNonce = receipts.receipts[0].receiptNonce;
    signReceipt(receipts.receipts[1]);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts)}\n`);
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(receipts));
    fs.writeFileSync(releasePath, JSON.stringify(snapshot));

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
  });

  test.each([
    ['group-readable key', () => fs.chmodSync(receiptAttestationKeyPath, 0o640)],
    [
      'hard-linked key',
      () => fs.linkSync(receiptAttestationKeyPath, receiptAttestationKeyLinkPath),
    ],
    [
      'symbolic-link key',
      () => {
        fs.renameSync(receiptAttestationKeyPath, receiptAttestationKeyLinkPath);
        fs.symlinkSync(receiptAttestationKeyLinkPath, receiptAttestationKeyPath);
      },
    ],
    [
      'short key',
      () => fs.writeFileSync(receiptAttestationKeyPath, receiptAttestationKey.subarray(0, 31)),
    ],
    ['missing key', () => fs.rmSync(receiptAttestationKeyPath, { force: true })],
    [
      'extended key',
      () =>
        fs.writeFileSync(
          receiptAttestationKeyPath,
          Buffer.concat([receiptAttestationKey, Buffer.from([0])]),
        ),
    ],
    ['group-readable runtime', () => fs.chmodSync(releaseDir, 0o750)],
  ])('rejects authenticated receipts when the signing authority has a %s', (_label, mutate) => {
    writeLocalQaSnapshot();
    mutate();

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
  });

  test('rejects a Voice QA receipt recorded on the wrong surface', () => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const voiceReceipt = receipts.receipts.find((receipt) => receipt.caseId === 'MPV-061');
    voiceReceipt.surface = 'telegram';
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts)}\n`);

    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(receipts));
    fs.writeFileSync(releasePath, JSON.stringify(snapshot));

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects a service-bound PASS receipt without live restart proof', () => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const telegramReceipt = receipts.receipts.find((receipt) => receipt.caseId === 'TR-026');
    delete telegramReceipt.serviceAckDigest;
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts)}\n`);

    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(receipts));
    fs.writeFileSync(releasePath, JSON.stringify(snapshot));

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test.each([
    ['missing signed session', (receipt) => delete receipt.serviceAckSessionRef, true],
    ['invalid signed session', (receipt) => (receipt.serviceAckSessionRef = 'invalid'), true],
    ['invalid signed digest', (receipt) => (receipt.serviceAckDigest = 'sha256:invalid'), true],
    [
      'tampered service digest',
      (receipt) => (receipt.serviceAckDigest = `sha256:${'a'.repeat(64)}`),
      false,
    ],
    [
      'tampered service session',
      (receipt) => (receipt.serviceAckSessionRef = `qa_${'b'.repeat(24)}`),
      false,
    ],
  ])('rejects service-bound receipts with %s', (_label, mutate, resign) => {
    writeLocalQaSnapshot();
    const receiptPath = path.join(releaseDir, 'parallel-work-qa-case-receipts.json');
    const receipts = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const receipt = receipts.receipts.find((item) => item.caseId === 'TR-026');
    mutate(receipt);
    if (resign) signReceipt(receipt);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipts)}\n`);
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(receipts));
    fs.writeFileSync(releasePath, JSON.stringify(snapshot));

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects a snapshot after its bound owner state changes', () => {
    writeBlockedReleaseSnapshot();
    const ownerPath = path.join(releaseRoot, 'state', 'runtime', 'isolated', 'stack-owner.json');
    const changed = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    changed.ownerPid = '99998';
    fs.writeFileSync(ownerPath, `${JSON.stringify(changed)}\n`);
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_owner_unavailable'],
    });
  });

  test('rejects a live unrelated process carrying the exact owner path as bait', () => {
    const baitProcess = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 120000)', fs.realpathSync(ownerExecutable)],
      { cwd: fs.realpathSync(ownerRepo), stdio: 'ignore' },
    );
    try {
      writeBlockedReleaseSnapshot({ owner_binding: validOwnerBinding(baitProcess) });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_owner_unavailable'],
      });
    } finally {
      baitProcess.kill();
    }
  });

  test('rejects /bin/sleep with the exact canonical owner process title and cwd', () => {
    const spoofProcess = spawn(
      '/bin/bash',
      ['-c', 'exec -a "$1" /bin/sleep 120', 'owner-spoof', detachedOwnerArgv.join(' ')],
      { cwd: fs.realpathSync(ownerRepo), stdio: 'ignore' },
    );
    try {
      writeBlockedReleaseSnapshot({ owner_binding: validOwnerBinding(spoofProcess) });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_owner_unavailable'],
      });
    } finally {
      spoofProcess.kill();
    }
  });

  test('typed_argv_variant_accepted=false and ps_command_variant_accepted=false', () => {
    const variantOwner = spawn(
      detachedOwnerArgv[0],
      [...detachedOwnerArgv.slice(1), '--forged-flag'],
      {
        cwd: fs.realpathSync(ownerRepo),
        stdio: 'ignore',
      },
    );
    try {
      writeBlockedReleaseSnapshot({ owner_binding: validOwnerBinding(variantOwner) });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_owner_unavailable'],
      });
    } finally {
      variantOwner.kill();
    }
  });

  test('accepts the actual shared detached argv with spaces and rejects lookalike wrappers', () => {
    const wrappedOwner = spawn('/bin/bash', detachedOwnerArgv, {
      cwd: fs.realpathSync(ownerRepo),
      stdio: 'ignore',
    });
    try {
      writeLocalQaSnapshot({ owner_binding: validOwnerBinding(wrappedOwner) });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({
          available: true,
          releaseReady: false,
          label: 'PRE-GATE / NOT READY',
        }),
      );
    } finally {
      wrappedOwner.kill();
    }
  });

  test('binds pre-gate Voice traces to the measured installed runtime without claiming READY', () => {
    const gates = validGates().map((gate) => openGate(gate.case_id));
    writeLocalQaSnapshot({
      gate_count: gates.length,
      open_gate_count: gates.length,
      gates,
      open_gates: gates,
    });
    const receipts = JSON.parse(
      fs.readFileSync(path.join(releaseDir, 'parallel-work-qa-case-receipts.json'), 'utf8'),
    );
    expect(receipts.receipts).toEqual([]);

    const {
      orchestrationRuntimeTraceBinding,
      parallelWorkReleaseGateSnapshot,
    } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: true,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
    const binding = orchestrationRuntimeTraceBinding();
    const snapshot = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    expect(binding).toEqual({
      contractVersion: 1,
      candidateDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      installedArtifactDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      runtimeOwnerBindingHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(binding.candidateDigest).toBe(`sha256:${snapshot.qa_receipt_summary.candidateDigest}`);
  });

  test('rejects a Voice trace binding when installed identity or live owner proof is invalid', () => {
    writeLocalQaSnapshot({ artifact_identity: { contractVersion: 1 } });
    let mode = require('../ViventiumOrchestrationMode');
    expect(mode.orchestrationRuntimeTraceBinding()).toBeNull();

    jest.resetModules();
    const ownerBinding = validOwnerBinding();
    writeLocalQaSnapshot({
      owner_binding: { ...ownerBinding, ownerPid: String(Number(ownerBinding.ownerPid) + 1) },
    });
    mode = require('../ViventiumOrchestrationMode');
    expect(mode.orchestrationRuntimeTraceBinding()).toBeNull();
  });

  test('rejects clean commit B after a clean commit A snapshot', () => {
    writeReleaseSnapshot();
    fs.writeFileSync(path.join(ownerRepo, 'commit-b.txt'), 'clean commit B\n');
    git(ownerRepo, ['add', 'commit-b.txt']);
    git(ownerRepo, ['commit', '-qm', 'clean commit B']);
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test.each([
    ['runtime.env', runtimeEnvPath],
    ['generated LibreChat config', libreChatConfigPath],
    ['frontend build', path.join(frontendBuildRoot, 'index.html')],
    ['API build', path.join(apiBuildRoot, 'index.js')],
    ['running service', runningServicePath],
    ['runtime-loaded release service', runtimeLoadedServicePath],
    ['runtime-loaded API dependency', runtimeLoadedDependencyPath],
  ])('rejects %s drift after snapshot creation', (_name, target) => {
    const original = fs.readFileSync(target);
    writeReleaseSnapshot();
    try {
      fs.writeFileSync(target, 'forged live artifact\n');
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({ available: false, releaseReady: false, label: 'NOT READY' }),
      );
    } finally {
      fs.writeFileSync(target, original);
    }
  });

  test('rejects and never renews a changed owner command contract', () => {
    const original = fs.readFileSync(installedCommandContract);
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    try {
      fs.writeFileSync(
        installedCommandContract,
        `${JSON.stringify({
          contractVersion: 1,
          detached: {
            command: 'start',
            allowTrailingArguments: true,
            argvTemplate: ['/bin/sleep'],
          },
          attached: detachedCommandContract.attached,
          processWrappers: detachedCommandContract.processWrappers,
        })}\n`,
      );
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({
          available: false,
          releaseReady: false,
          label: 'PRE-GATE / NOT READY',
        }),
      );
    } finally {
      fs.writeFileSync(installedCommandContract, original);
    }
  });

  test.each(['missing_expiry', 'year_2000', 'expired', 'future'])(
    'rejects READY when snapshot freshness is %s',
    (freshness) => {
      const ownerBinding = validOwnerBinding();
      if (freshness === 'missing_expiry') {
        delete ownerBinding.expiresAt;
      } else if (freshness === 'year_2000') {
        ownerBinding.generatedAt = '2000-01-01T00:00:00.000Z';
        ownerBinding.expiresAt = '2000-01-02T00:00:00.000Z';
      } else if (freshness === 'expired') {
        ownerBinding.generatedAt = new Date(Date.now() - 86_401_000).toISOString();
        ownerBinding.expiresAt = new Date(Date.now() - 1_000).toISOString();
      } else {
        ownerBinding.generatedAt = new Date(Date.now() + 120_000).toISOString();
        ownerBinding.expiresAt = new Date(Date.now() + 86_520_000).toISOString();
      }
      writeReleaseSnapshot({ owner_binding: ownerBinding });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
    },
  );

  test('keeps PRE-GATE wording stable after a local QA snapshot expires', () => {
    const ownerBinding = validOwnerBinding();
    ownerBinding.generatedAt = new Date(Date.now() - 86_401_000).toISOString();
    ownerBinding.expiresAt = new Date(Date.now() - 1_000).toISOString();
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      owner_binding: ownerBinding,
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('renews healthy local QA before 24h expiry and survives module restart', () => {
    const ownerBinding = validOwnerBinding();
    const generatedAt = new Date(Date.now() - 23.5 * 60 * 60 * 1000);
    ownerBinding.generatedAt = generatedAt.toISOString();
    ownerBinding.expiresAt = new Date(generatedAt.getTime() + 86_400_000).toISOString();
    const oldExpiry = ownerBinding.expiresAt;
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      owner_binding: ownerBinding,
    });
    let mode = require('../ViventiumOrchestrationMode');

    expect(mode.parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: true,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
    const renewed = JSON.parse(fs.readFileSync(releasePath, 'utf8'));
    expect(renewed.owner_binding.expiresAt > oldExpiry).toBe(true);
    jest.resetModules();
    mode = require('../ViventiumOrchestrationMode');
    expect(mode.parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({
        available: true,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
  });

  test('fails closed without renewing a forged or stale local QA snapshot', () => {
    const ownerBinding = validOwnerBinding();
    const generatedAt = new Date(Date.now() - 23.5 * 60 * 60 * 1000);
    ownerBinding.generatedAt = generatedAt.toISOString();
    ownerBinding.expiresAt = new Date(generatedAt.getTime() + 86_400_000).toISOString();
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      owner_binding: ownerBinding,
    });
    const before = fs.readFileSync(releasePath, 'utf8');
    const schemaPath = path.join(ownerRepo, 'config.schema.yaml');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    fs.writeFileSync(schemaPath, schema.replace('default: false', 'default: true'));
    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
      expect(fs.readFileSync(releasePath, 'utf8')).toBe(before);
    } finally {
      fs.writeFileSync(schemaPath, schema);
    }
  });

  test('fails the actual claim path closed for open QA and exposes typed blockers', () => {
    writeBlockedReleaseSnapshot();
    const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkClaimState('owner-1')).toEqual(
      expect.objectContaining({
        available: false,
        label: 'NOT READY',
        blockers: expect.arrayContaining(['PWK-UC-014']),
      }),
    );
  });

  test('rejects a self-reported nonexistent REL-UC-READY inventory', () => {
    const forgedGate = {
      case_id: 'REL-UC-READY',
      status: 'PASS',
      source: 'qa/release-readiness/cases.md',
      detail: '[redacted]',
    };
    writeReleaseSnapshot({
      gate_count: 1,
      open_gate_count: 0,
      gates: [forgedGate],
      open_gates: [],
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects a forged READY snapshot when every artifact check is FAIL', () => {
    writeReleaseSnapshot({
      artifact_checks: [
        { check_id: 'SOURCE-IDENTITY', status: 'FAIL', reason: 'source_identity_mismatch' },
        { check_id: 'NESTED-PINS', status: 'FAIL', reason: 'nested_pin_mismatch' },
        { check_id: 'PREBUILT-IDENTITY', status: 'FAIL', reason: 'prebuilt_identity_mismatch' },
        {
          check_id: 'INSTALLED-ARTIFACT',
          status: 'FAIL',
          reason: 'installed_artifact_mismatch',
        },
      ],
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects the critic forged mixed snapshot despite PASS labels', () => {
    const artifactIdentity = validArtifactIdentity();
    artifactIdentity.installed.nestedRevisionsHash = '9'.repeat(64);
    writeReleaseSnapshot({
      mode: 'release',
      gate_count: 1,
      open_gate_count: 0,
      gates: [
        {
          case_id: 'REL-UC-FORGED',
          status: 'FAIL',
          source: 'qa/release-readiness/cases.md',
          detail: '[redacted]',
        },
      ],
      open_gates: [],
      readiness_facts: {
        contractVersion: 1,
        promptLayers: {
          contractVersion: 1,
          producerScope: 'viventium.prompt_registry.v1',
          status: 'verified',
          unknownLayerCount: 0,
          unknownLayerNames: [],
          promptCount: 1,
          layerCount: 1,
          layerNames: ['main'],
          registryHash: '4'.repeat(64),
        },
        storagePressure: {
          version: 1,
          status: 'critical',
          usedPercent: 96,
          availableBytes: 1024,
          thresholdPercent: 90,
          warningMarginPercent: 10,
        },
      },
      blocking_checks: [],
      blocking_artifact_checks: [],
      artifact_identity: artifactIdentity,
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects forged exposure when an open release gate remains without local QA', () => {
    writeReleaseSnapshot({
      open_gates: [openGate('REL-UC-FORGED')],
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects forged READY when exposure is disabled', () => {
    writeReleaseSnapshot({ exposure_allowed: false });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test.each([undefined, { contractVersion: 1 }])(
    'rejects a READY snapshot with missing or invalid artifact identity: %p',
    (artifactIdentity) => {
      writeReleaseSnapshot({ artifact_identity: artifactIdentity });
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
    },
  );

  test('rejects a candidate identity without canonical readiness hashes', () => {
    const artifactIdentity = validArtifactIdentity();
    delete artifactIdentity.readiness;
    writeReleaseSnapshot({ artifact_identity: artifactIdentity });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('rejects duplicate nested component identity entries', () => {
    const artifactIdentity = validArtifactIdentity();
    artifactIdentity.nestedComponents.push({ ...artifactIdentity.nestedComponents[0] });
    writeReleaseSnapshot({ artifact_identity: artifactIdentity });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test.each([
    validArtifactChecks().slice(0, 3),
    [
      validArtifactChecks()[0],
      validArtifactChecks()[0],
      validArtifactChecks()[1],
      validArtifactChecks()[2],
    ],
  ])('rejects incomplete or duplicate artifact checks: %p', (artifactChecks) => {
    writeReleaseSnapshot({ artifact_checks: artifactChecks });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('allows an explicit fully-gated local QA exposure but never labels it ready', () => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkClaimState('owner-1')).toEqual(
      expect.objectContaining({
        available: true,
        label: 'PRE-GATE / NOT READY',
        blockers: expect.arrayContaining(['local_qa_override_active']),
      }),
    );
  });

  test('preserves PRE-GATE wording when local QA is valid but operational readiness fails', () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkClaimState('owner-1')).toEqual(
      expect.objectContaining({
        available: false,
        label: 'PRE-GATE / NOT READY',
      }),
    );
  });

  test('rejects a local QA override carrying a forged READY label', () => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test('allows explicit local QA through open PWK/REL/TR/EMO gates without claiming ready', () => {
    const openGates = [
      openGate('PWK-UC-014'),
      openGate('REL-UC-004'),
      openGate('TR-026'),
      openGate('EMO-UC-047'),
      openGate('EMO-UC-048'),
    ];
    const openById = new Map(openGates.map((gate) => [gate.case_id, gate]));
    const gates = validGates().map((gate) => openById.get(gate.case_id) || gate);
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      gate_count: gates.length,
      open_gate_count: 5,
      gates,
      open_gates: gates.filter((gate) => gate.status !== 'PASS'),
    });
    const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkClaimState('owner-1')).toEqual(
      expect.objectContaining({
        available: true,
        label: 'PRE-GATE / NOT READY',
        blockers: expect.arrayContaining([
          'PWK-UC-014',
          'REL-UC-004',
          'TR-026',
          'EMO-UC-047',
          'EMO-UC-048',
          'local_qa_override_active',
        ]),
      }),
    );
  });

  test('allows explicit local QA with shaped dirty artifacts but blocks every non-local mode', () => {
    const dirtyPath = path.join(ownerRepo, 'dirty-local-qa.txt');
    fs.writeFileSync(dirtyPath, 'intentional local QA drift\n');
    const artifactIdentity = measuredArtifactIdentityFromPython();
    const artifactChecks = [
      { check_id: 'SOURCE-IDENTITY', status: 'FAIL', reason: 'source_dirty' },
      { check_id: 'NESTED-PINS', status: 'PASS', reason: '' },
      { check_id: 'PREBUILT-IDENTITY', status: 'PASS', reason: '' },
      {
        check_id: 'INSTALLED-ARTIFACT',
        status: 'FAIL',
        reason: 'installed_candidate_dirty',
      },
    ];
    try {
      writeReleaseSnapshot({
        mode: 'local-qa',
        label: 'PRE-GATE / NOT READY',
        release_ready: false,
        exposure_allowed: true,
        local_qa_override: true,
        artifact_checks: artifactChecks,
        blocking_artifact_checks: [artifactChecks[0], artifactChecks[3]],
        artifact_identity: artifactIdentity,
      });
      const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkClaimState('owner-1')).toEqual(
        expect.objectContaining({
          available: true,
          label: 'PRE-GATE / NOT READY',
          blockers: expect.arrayContaining(['SOURCE-IDENTITY', 'INSTALLED-ARTIFACT']),
        }),
      );
      for (const mode of ['default', 'release']) {
        writeBlockedReleaseSnapshot({
          mode,
          artifact_checks: artifactChecks,
          blocking_artifact_checks: [artifactChecks[0], artifactChecks[3]],
          artifact_identity: artifactIdentity,
        });
        expect(parallelWorkClaimState('owner-1')).toEqual(
          expect.objectContaining({
            available: false,
            label: 'NOT READY',
            blockers: expect.arrayContaining(['SOURCE-IDENTITY', 'INSTALLED-ARTIFACT']),
          }),
        );
      }
    } finally {
      fs.unlinkSync(dirtyPath);
    }
  });

  test.each([
    [
      'prompt mismatch',
      'PROMPT-LAYERS',
      {
        readiness_checks: [
          {
            check_id: 'PROMPT-LAYERS',
            status: 'FAIL',
            reason: 'prompt_layer_hash_mismatch',
          },
          { check_id: 'STORAGE-PRESSURE', status: 'PASS', reason: '' },
        ],
        blocking_checks: [
          {
            check_id: 'PROMPT-LAYERS',
            status: 'FAIL',
            reason: 'prompt_layer_hash_mismatch',
          },
        ],
        readiness_facts: {
          ...validReadinessFacts(),
          promptLayers: {
            ...validReadinessFacts().promptLayers,
            registryHash: '9'.repeat(64),
          },
        },
      },
    ],
    [
      'storage warning',
      'STORAGE-PRESSURE',
      {
        readiness_checks: [
          { check_id: 'PROMPT-LAYERS', status: 'PASS', reason: '' },
          { check_id: 'STORAGE-PRESSURE', status: 'FAIL', reason: 'storage_pressure' },
        ],
        blocking_checks: [
          { check_id: 'STORAGE-PRESSURE', status: 'FAIL', reason: 'storage_pressure' },
        ],
        readiness_facts: {
          ...validReadinessFacts(),
          storagePressure: {
            version: 1,
            status: 'warning',
            usedPercent: 85,
            availableBytes: 100 * 1024 ** 3,
            thresholdPercent: 90,
            warningMarginPercent: 10,
          },
        },
      },
    ],
    [
      'storage pressure',
      'STORAGE-PRESSURE',
      {
        readiness_checks: [
          { check_id: 'PROMPT-LAYERS', status: 'PASS', reason: '' },
          { check_id: 'STORAGE-PRESSURE', status: 'FAIL', reason: 'storage_pressure' },
        ],
        blocking_checks: [
          { check_id: 'STORAGE-PRESSURE', status: 'FAIL', reason: 'storage_pressure' },
        ],
        readiness_facts: {
          ...validReadinessFacts(),
          storagePressure: {
            version: 1,
            status: 'critical',
            usedPercent: 95,
            availableBytes: 1024,
            thresholdPercent: 90,
            warningMarginPercent: 10,
          },
        },
      },
    ],
  ])(
    'allows explicit shaped local QA with %s while every non-local mode remains blocked',
    (_caseName, blocker, degraded) => {
      writeReleaseSnapshot({
        mode: 'local-qa',
        label: 'PRE-GATE / NOT READY',
        release_ready: false,
        exposure_allowed: true,
        local_qa_override: true,
        ...degraded,
      });
      const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkClaimState('owner-1')).toEqual(
        expect.objectContaining({
          available: true,
          label: 'PRE-GATE / NOT READY',
          blockers: expect.arrayContaining([blocker, 'local_qa_override_active']),
        }),
      );

      for (const mode of ['default', 'release']) {
        writeBlockedReleaseSnapshot({
          mode,
          ...degraded,
        });
        expect(parallelWorkClaimState('owner-1')).toEqual(
          expect.objectContaining({
            available: false,
            label: 'NOT READY',
            blockers: expect.arrayContaining([blocker]),
          }),
        );
      }
    },
  );

  test('rejects malformed local QA facts instead of fabricating availability', () => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      readiness_facts: { contractVersion: 1 },
    });
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual({
      available: false,
      releaseReady: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['release_snapshot_unavailable'],
    });
  });

  test.each(['missing', 'malformed', 'expired'])(
    'preserves explicit PRE-GATE mode when the local QA snapshot is %s',
    (state) => {
      fs.writeFileSync(
        localQaRequestPath,
        `${JSON.stringify({ contractVersion: 1, mode: 'local-qa', requested: true })}\n`,
      );
      if (state === 'missing') {
        fs.rmSync(releasePath, { force: true });
      } else if (state === 'malformed') {
        fs.writeFileSync(releasePath, '{');
      } else {
        const ownerBinding = validOwnerBinding();
        ownerBinding.generatedAt = new Date(Date.now() - 86_401_000).toISOString();
        ownerBinding.expiresAt = new Date(Date.now() - 1_000).toISOString();
        writeReleaseSnapshot({
          mode: 'local-qa',
          label: 'PRE-GATE / NOT READY',
          release_ready: false,
          exposure_allowed: true,
          local_qa_override: true,
          owner_binding: ownerBinding,
        });
      }
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

      expect(parallelWorkReleaseGateSnapshot()).toEqual({
        available: false,
        releaseReady: false,
        label: 'PRE-GATE / NOT READY',
        blockers: ['release_snapshot_unavailable'],
      });
    },
  );

  test('preserves the PRE-GATE label when local QA has no owner', () => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    const { parallelWorkClaimState } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkClaimState()).toEqual({
      available: false,
      label: 'PRE-GATE / NOT READY',
      blockers: ['local_qa_override_active', 'owner_required'],
    });
  });
});

describe('independently attested release evidence', () => {
  let externalFixture;

  beforeAll(() => {
    const {
      createParallelWorkReleaseFixture,
    } = require('../../../routes/viventium/testFixtures/parallelWorkReleaseFixture');
    externalFixture = createParallelWorkReleaseFixture('viventium-external-release-consumer-');
  });

  beforeEach(() => {
    jest.resetModules();
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
    process.env.VIVENTIUM_PARALLEL_WORK_DEFAULT_MODE = 'focused';
    process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE = externalFixture.releasePath;
    process.env.VIVENTIUM_RUNTIME_DIR = externalFixture.releaseDir;
    delete process.env.VIVENTIUM_PARALLEL_WORK_LOCAL_QA_OVERRIDE;
    externalFixture.reset();
  });

  afterAll(() => {
    externalFixture?.cleanup();
    process.env = ORIGINAL_ENV;
  });

  function tamperReleaseEvidence(mutator) {
    const receiptPath = path.join(
      externalFixture.releaseDir,
      'parallel-work-qa-case-receipts.json',
    );
    const payload = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    mutator(payload.receipts);
    fs.writeFileSync(receiptPath, `${JSON.stringify(payload)}\n`);
    const snapshot = JSON.parse(fs.readFileSync(externalFixture.releasePath, 'utf8'));
    snapshot.qa_receipt_summary.receiptDigest = sha256(canonicalJsonDeep(payload));
    fs.writeFileSync(externalFixture.releasePath, JSON.stringify(snapshot));
  }

  function changedSignature(signature) {
    const lines = signature.split('\n');
    lines[1] = `${lines[1][0] === 'A' ? 'B' : 'A'}${lines[1].slice(1)}`;
    return lines.join('\n');
  }

  test('accepts only independently signed publisher, producer, service, and witness evidence', () => {
    const receipts = JSON.parse(
      fs.readFileSync(
        path.join(externalFixture.releaseDir, 'parallel-work-qa-case-receipts.json'),
        'utf8',
      ),
    );
    expect(receipts.receipts.every((receipt) => !Object.hasOwn(receipt, 'attestation'))).toBe(true);
    expect(
      receipts.receipts.every(
        (receipt) =>
          receipt.publisherIdentity === 'publisher@fixture.example.invalid' &&
          receipt.producerAttestations.length > 0,
      ),
    ).toBe(true);

    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({ available: true, releaseReady: true, label: 'READY' }),
    );
  });

  test.each([
    [
      'forged publisher signature',
      (receipts) => {
        receipts[0].publisherAttestation = changedSignature(receipts[0].publisherAttestation);
      },
    ],
    [
      'forged producer signature',
      (receipts) => {
        const producer = receipts[0].producerAttestations[0];
        producer.signature = changedSignature(producer.signature);
      },
    ],
    [
      'forged service signature',
      (receipts) => {
        const service = receipts.find((receipt) => receipt.caseId === 'TR-026')
          .serviceAcknowledgements[0];
        service.signature = changedSignature(service.signature);
      },
    ],
    [
      'wrong publisher identity',
      (receipts) => (receipts[0].publisherIdentity = 'other@fixture.invalid'),
    ],
    ['wrong candidate', (receipts) => (receipts[0].candidateDigest = 'a'.repeat(64))],
    ['wrong artifact', (receipts) => (receipts[0].artifactDigest = 'b'.repeat(64))],
    ['wrong stable owner', (receipts) => (receipts[0].ownerBindingSha256 = 'c'.repeat(64))],
    [
      'wrong verifier manifest',
      (receipts) => (receipts[0].verifierManifestSha256 = 'd'.repeat(64)),
    ],
    [
      'wrong verifier',
      (receipts) =>
        (receipts.find((receipt) => receipt.caseId === 'PWK-UC-014').verifierId =
          'tr026-semantic-v1'),
    ],
    [
      'wrong surface',
      (receipts) => (receipts.find((receipt) => receipt.caseId === 'MPV-061').surface = 'telegram'),
    ],
    ['replayed nonce', (receipts) => (receipts[0].receiptNonce = receipts[1].receiptNonce)],
    ['stale evidence', (receipts) => (receipts[0].runAt = '2000-01-01T00:00:00.000Z')],
    [
      'wrong attestation purpose',
      (receipts) => (receipts[0].attestationPurpose = 'fixture.invalid'),
    ],
    [
      'unsupported attestation contract',
      (receipts) => (receipts[0].attestationContractVersion = 2),
    ],
    ['invalid sequence', (receipts) => (receipts[0].attestationSequence = 0)],
    ['missing producer evidence', (receipts) => (receipts[0].producerAttestations = [])],
    [
      'missing service evidence',
      (receipts) =>
        (receipts.find((receipt) => receipt.caseId === 'TR-026').serviceAcknowledgements = []),
    ],
    [
      'wrong service session',
      (receipts) =>
        (receipts.find((receipt) => receipt.caseId === 'TR-026').serviceAckSessionRef =
          `qa_${'e'.repeat(24)}`),
    ],
    [
      'wrong service digest',
      (receipts) =>
        (receipts.find((receipt) => receipt.caseId === 'TR-026').serviceAckDigest =
          `sha256:${'f'.repeat(64)}`),
    ],
    [
      'owner-readable HMAC added to release evidence',
      (receipts) => (receipts[0].attestation = `hmac-sha256:${'0'.repeat(64)}`),
    ],
  ])('rejects cryptographic release evidence with %s', (_label, mutate) => {
    tamperReleaseEvidence(mutate);
    const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');

    expect(parallelWorkReleaseGateSnapshot()).toEqual(
      expect.objectContaining({ available: false, releaseReady: false, label: 'NOT READY' }),
    );
  });

  test.each([
    [
      'missing publisher policy',
      ['Installed Viventium', 'scripts', 'viventium', 'qa_release_attestation_policy.json'],
    ],
    ['missing external rollback witness', ['synthetic-external-witness.json']],
    ['missing signed release ledger', ['runtime', 'parallel-work-release-attestation-ledger.json']],
  ])('rejects independently signed evidence with a %s', (_label, segments) => {
    const target = path.join(externalFixture.releaseRoot, ...segments);
    const original = fs.readFileSync(target);
    fs.rmSync(target);
    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({ available: false, releaseReady: false, label: 'NOT READY' }),
      );
    } finally {
      fs.writeFileSync(target, original, { mode: 0o600 });
      if (segments[0] === 'Installed Viventium') fs.chmodSync(target, 0o644);
    }
  });

  test('rejects a rolled-back external ledger checkpoint', () => {
    const witnessPath = path.join(externalFixture.releaseRoot, 'synthetic-external-witness.json');
    const original = fs.readFileSync(witnessPath);
    const witness = JSON.parse(original);
    const [scope] = Object.keys(witness);
    witness[scope].sequence -= 1;
    fs.writeFileSync(witnessPath, JSON.stringify(witness));
    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({ available: false, releaseReady: false, label: 'NOT READY' }),
      );
    } finally {
      fs.writeFileSync(witnessPath, original, { mode: 0o600 });
    }
  });

  test('verifies release evidence only with isolated root-owned system Python', () => {
    const previous = {
      configured: process.env.VIVENTIUM_PYTHON_BIN,
      home: process.env.PYTHONHOME,
      modulePath: process.env.PYTHONPATH,
    };
    process.env.VIVENTIUM_PYTHON_BIN = '/tmp/synthetic-owner-python';
    process.env.PYTHONHOME = '/tmp/synthetic-owner-python-home';
    process.env.PYTHONPATH = '/tmp/synthetic-owner-python-modules';
    const subprocess = jest.spyOn(require('child_process'), 'execFileSync');
    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({ available: true, releaseReady: true, label: 'READY' }),
      );
      const verificationCalls = subprocess.mock.calls.filter(
        ([, args]) =>
          Array.isArray(args) &&
          (args.includes('--validate-snapshot') || args.includes('--validate-owner-state')),
      );
      expect(verificationCalls.length).toBeGreaterThan(0);
      for (const [interpreter, args, options] of verificationCalls) {
        expect(interpreter).toBe('/usr/bin/python3');
        expect(args.slice(0, 3)).toEqual(['-I', '-B', '-c']);
        expect(options.env).toEqual({
          PATH: '/usr/bin:/bin',
          LC_ALL: 'C',
          PYTHONNOUSERSITE: '1',
          PYTHONSAFEPATH: '1',
        });
      }
    } finally {
      subprocess.mockRestore();
      for (const [key, value] of Object.entries({
        VIVENTIUM_PYTHON_BIN: previous.configured,
        PYTHONHOME: previous.home,
        PYTHONPATH: previous.modulePath,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test.each([
    ['owner-writable interpreter', (details) => ({ ...details, uid: process.getuid() })],
    ['group-writable interpreter', (details) => ({ ...details, mode: details.mode | 0o020 })],
  ])('rejects a %s as the final release verifier', (_label, mutate) => {
    const originalStat = fs.statSync;
    const stat = jest.spyOn(fs, 'statSync').mockImplementation((target, ...options) => {
      const details = originalStat(target, ...options);
      return target === '/usr/bin/python3'
        ? { ...mutate(details), isFile: () => details.isFile() }
        : details;
    });
    try {
      const { parallelWorkReleaseGateSnapshot } = require('../ViventiumOrchestrationMode');
      expect(parallelWorkReleaseGateSnapshot()).toEqual(
        expect.objectContaining({ available: false, releaseReady: false, label: 'NOT READY' }),
      );
    } finally {
      stat.mockRestore();
    }
  });
});
