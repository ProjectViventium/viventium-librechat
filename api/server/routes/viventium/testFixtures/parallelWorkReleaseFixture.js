const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SERVICE_ACK_CASES = new Set([
  'TR-026',
  'EMO-UC-047',
  'EMO-UC-048',
  'PWK-UC-016',
  'PWK-UC-017',
  'REL-UC-004',
]);
const RECEIPT_VERIFIER_IDS = Object.freeze({
  'EMO-UC-047': 'emo047-semantic-v1',
  'EMO-UC-048': 'emo048-semantic-v1',
  'MPV-061': 'mpv061-semantic-v1',
  'PWK-UC-014': 'pwk-installed-journey-v1',
  'REL-UC-004': 'rel004-semantic-v1',
  'TGDOC-010': 'tgd010-semantic-v1',
  'TR-026': 'tr026-semantic-v1',
});
const EXTERNAL_FIXTURE_SERVICE_PRODUCERS = Object.freeze({
  'EMO-UC-047': ['glasshive-runtime', 'librechat-core'],
  'EMO-UC-048': ['librechat-core', 'telegram-bot'],
  'REL-UC-004': ['librechat-core'],
  'TR-026': ['librechat-core', 'telegram-bot'],
});
const EXTERNAL_FIXTURE_SIGNERS = Object.freeze([
  'publisher',
  'observation-producer',
  'glasshive-runtime',
  'librechat-core',
  'telegram-bot',
]);
const EXTERNAL_FIXTURE_PYTHON = '/usr/bin/python3';
const EXTERNAL_FIXTURE_PYTHON_ENVIRONMENT = Object.freeze({
  PATH: '/usr/bin:/bin',
  LC_ALL: 'C',
  PYTHONNOUSERSITE: '1',
  PYTHONSAFEPATH: '1',
});
const EXTERNAL_RECEIPT_ISSUER = String.raw`
import dataclasses, datetime, hashlib, importlib.util, inspect, json, os, pathlib, subprocess, sys

if "follow_symlinks" not in inspect.signature(pathlib.Path.stat).parameters:
    pathlib.Path.stat = lambda self, *, follow_symlinks=True: os.stat(self, follow_symlinks=follow_symlinks)
if "slots" not in inspect.signature(dataclasses.dataclass).parameters:
    original_dataclass = dataclasses.dataclass
    def compatible_dataclass(cls=None, **options):
        options.pop("slots", None)
        return original_dataclass(cls, **options)
    dataclasses.dataclass = compatible_dataclass
if sys.version_info < (3, 11):
    class CompatibleDateTime(datetime.datetime):
        @classmethod
        def fromisoformat(cls, value):
            if isinstance(value, str) and value.endswith("Z"):
                value = value[:-1] + "+00:00"
            return super().fromisoformat(value)
    datetime.datetime = CompatibleDateTime

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
runtime = pathlib.Path(sys.argv[2]).resolve(strict=True)
key_root = pathlib.Path(sys.argv[3]).resolve(strict=True)
witness_path = pathlib.Path(sys.argv[4])
expected_policy_sha256 = sys.argv[5]
request = json.load(sys.stdin)
module_path = root / "scripts" / "viventium" / "qa_release_attestation.py"
spec = importlib.util.spec_from_file_location("viventium_fixture_qa_release_attestation", module_path)
if spec is None or spec.loader is None:
    raise RuntimeError("fixture release attestation is unavailable")
attestation = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = attestation
spec.loader.exec_module(attestation)
policy = attestation.load_trust_policy(
    root,
    expected_policy_sha256=expected_policy_sha256,
    expected_candidate_digest=request["candidateDigest"],
)

class ExternalFixtureSigner:
    def __init__(self, name):
        self.path = key_root / name

    def sign(self, payload, namespace):
        result = subprocess.run(
            ["/usr/bin/ssh-keygen", "-Y", "sign", "-f", str(self.path), "-n", namespace],
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"},
            timeout=15,
            check=True,
        )
        return result.stdout.decode("ascii")

class ExternalFixtureWitness:
    def current(self, scope):
        try:
            state = json.loads(witness_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return None
        value = state.get(scope)
        if value is None:
            return None
        return attestation.LedgerHead(int(value["sequence"]), str(value["entryDigest"]))

    def advance(self, scope, *, expected, head):
        if self.current(scope) != expected:
            return False
        try:
            state = json.loads(witness_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            state = {}
        state[scope] = {"sequence": head.sequence, "entryDigest": head.entry_digest}
        witness_path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
        witness_path.chmod(0o600)
        return True

witness = ExternalFixtureWitness()
issued = []
for raw in request["receipts"]:
    receipt = dict(raw)
    case_id = str(receipt["caseId"])
    now = datetime.datetime.fromisoformat(str(receipt["runAt"]))
    services = []
    for service_id in request["caseServices"].get(case_id, []):
        signed = attestation.sign_service_acknowledgement(
            {
                "caseId": case_id,
                "surface": receipt["surface"],
                "candidateDigest": receipt["candidateDigest"],
                "artifactDigest": receipt["artifactDigest"],
                "ownerBindingSha256": receipt["ownerBindingSha256"],
                "serviceId": service_id,
                "sessionRef": receipt["serviceAckSessionRef"],
                "acknowledgedAt": receipt["runAt"],
                "acknowledgementDigest": "sha256:" + hashlib.sha256(
                    ("fixture-service:" + case_id + ":" + service_id).encode()
                ).hexdigest(),
                "processIdentityDigest": hashlib.sha256(
                    ("fixture-process:" + case_id + ":" + service_id).encode()
                ).hexdigest(),
            },
            producer_id=service_id,
            policy=policy,
            signer=ExternalFixtureSigner(service_id),
            now=now,
        )
        services.append(signed)
    if services:
        receipt["serviceAckDigest"] = attestation.service_acknowledgement_digest(services)
    producer = attestation.sign_producer_observation(
        {
            "caseId": case_id,
            "surface": receipt["surface"],
            "candidateDigest": receipt["candidateDigest"],
            "artifactDigest": receipt["artifactDigest"],
            "ownerBindingSha256": receipt["ownerBindingSha256"],
            "evidenceDigest": receipt["evidenceDigest"],
            "receiptNonce": receipt["receiptNonce"],
            "verifierId": receipt["verifierId"],
            "verifierManifestSha256": receipt["verifierManifestSha256"],
            "observedAt": receipt["runAt"],
            "observationNonce": hashlib.sha256(
                ("fixture-observation:" + case_id + ":" + receipt["receiptNonce"]).encode()
            ).hexdigest()[:32],
            "serviceAckDigest": receipt.get("serviceAckDigest", ""),
            "serviceAckSessionRef": receipt.get("serviceAckSessionRef", ""),
        },
        producer_id="observation-producer",
        policy=policy,
        signer=ExternalFixtureSigner("observation-producer"),
        now=now,
    )
    issued.append(
        attestation.issue_release_receipt(
            receipt,
            producer_attestations=[producer],
            service_acknowledgements=services,
            policy=policy,
            signer=ExternalFixtureSigner("publisher"),
            ledger_path=runtime / "parallel-work-release-attestation-ledger.json",
            ledger_witness=witness,
            now=now,
        )
    )
json.dump({"receipts": issued}, sys.stdout, sort_keys=True, separators=(",", ":"))
`;
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

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = (value) =>
  JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
const canonicalJsonDeep = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonDeep).join(',')}]`;
  if (value != null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonDeep(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};
const READINESS_FLOAT_FIELDS = new Set(['usedPercent', 'thresholdPercent', 'warningMarginPercent']);
const canonicalReadinessJson = (value, field = '') => {
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
};
const normalized = (value) =>
  String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
const pythonIsoTimestamp = (value = new Date()) => value.toISOString().replace(/Z$/, '+00:00');
const sha256Tree = (root) => {
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
};
const runtimeServiceArtifactDigests = (root, manifestPath) => {
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
};
const git = (cwd, args) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Release Fixture',
      GIT_AUTHOR_EMAIL: 'release-fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Release Fixture',
      GIT_COMMITTER_EMAIL: 'release-fixture@example.invalid',
    },
  }).trim();

function installExternalReleaseFixtureAuthority({ installedGateScript, ownerRepo, releaseRoot }) {
  const keyRoot = path.join(releaseRoot, 'synthetic-external-signers');
  const witnessPath = path.join(releaseRoot, 'synthetic-external-witness.json');
  fs.mkdirSync(keyRoot, { mode: 0o700 });
  fs.chmodSync(keyRoot, 0o700);
  const signerKeys = new Map();
  for (const name of EXTERNAL_FIXTURE_SIGNERS) {
    const privateKey = path.join(keyRoot, name);
    execFileSync(
      '/usr/bin/ssh-keygen',
      ['-q', '-t', 'ed25519', '-N', '', '-C', `${name}@fixture.example.invalid`, '-f', privateKey],
      { env: EXTERNAL_FIXTURE_PYTHON_ENVIRONMENT, stdio: 'ignore', timeout: 15_000 },
    );
    const [type, encoded] = fs.readFileSync(`${privateKey}.pub`, 'utf8').trim().split(/\s+/);
    if (type !== 'ssh-ed25519' || !encoded) {
      throw new Error('fixture publisher trust root is invalid');
    }
    signerKeys.set(name, {
      identity: `${name}@fixture.example.invalid`,
      fingerprint: `SHA256:${crypto
        .createHash('sha256')
        .update(Buffer.from(encoded, 'base64'))
        .digest('base64')
        .replace(/=+$/, '')}`,
      publicKey: `${type} ${encoded}`,
    });
  }

  const allowedSignersPath = path.join(
    ownerRepo,
    'qa',
    'trust',
    'parallel-work-release.allowed_signers',
  );
  fs.mkdirSync(path.dirname(allowedSignersPath), { recursive: true });
  fs.writeFileSync(
    allowedSignersPath,
    [...signerKeys.values()]
      .map(({ identity, publicKey }) => `${identity} ${publicKey}\n`)
      .join(''),
  );
  const producerKeys = Object.fromEntries(
    [...signerKeys]
      .filter(([name]) => name !== 'publisher')
      .map(([name, signer]) => [
        name,
        {
          identity: signer.identity,
          fingerprint: signer.fingerprint,
          role: name === 'observation-producer' ? 'observation' : 'service',
          ...(name === 'observation-producer' ? {} : { serviceId: name }),
        },
      ]),
  );
  const policy = {
    contractVersion: 1,
    allowedSigners: {
      path: 'qa/trust/parallel-work-release.allowed_signers',
      sha256: sha256(fs.readFileSync(allowedSignersPath)),
    },
    publisher: {
      identity: signerKeys.get('publisher').identity,
      fingerprint: signerKeys.get('publisher').fingerprint,
    },
    producers: producerKeys,
    cases: Object.fromEntries(
      Object.entries(RECEIPT_VERIFIER_IDS).map(([caseId, verifierId]) => [
        caseId,
        {
          surface: caseId === 'MPV-061' ? 'voice' : 'telegram',
          verifierId,
          producerIds: ['observation-producer'],
          serviceProducerIds: EXTERNAL_FIXTURE_SERVICE_PRODUCERS[caseId] || [],
        },
      ]),
    ),
    maximumReceiptAgeSeconds: 86_400,
    maximumFutureSkewSeconds: 60,
  };
  const policyPath = path.join(
    ownerRepo,
    'scripts',
    'viventium',
    'qa_release_attestation_policy.json',
  );
  fs.writeFileSync(policyPath, `${canonicalJsonDeep(policy)}\n`);
  const policySha256 = sha256(fs.readFileSync(policyPath));
  const resolverMarker =
    '    """Resolve only an independently provisioned, publisher-signed authority."""\n';
  const fixtureResolver = [
    '    if installed_root is None or runtime_owner_state is None:',
    '        return None',
    '    try:',
    '        root = Path(installed_root).resolve(strict=True)',
    '        if root != Path(__file__).resolve(strict=True).parents[2]:',
    '            return None',
    '        owner = json.loads(Path(runtime_owner_state).read_text(encoding="utf-8"))',
    '        if Path(str(owner["repoRoot"])).resolve(strict=True) != root:',
    '            return None',
    '        runtime = Path(str(owner["runtimeDir"])).resolve(strict=True)',
    `        witness_path = Path(${JSON.stringify(witnessPath)})`,
    '        class FixtureWitness:',
    '            def current(self, scope):',
    '                try:',
    '                    value = json.loads(witness_path.read_text(encoding="utf-8")).get(scope)',
    '                except FileNotFoundError:',
    '                    return None',
    '                if value is None:',
    '                    return None',
    '                module = _load_external_release_attestation()',
    '                return module.LedgerHead(int(value["sequence"]), str(value["entryDigest"]))',
    '            def advance(self, scope, *, expected, head):',
    '                return False',
    '        return ExternalReleaseAttestationAuthority(',
    `            expected_policy_sha256=${JSON.stringify(policySha256)},`,
    '            ledger_path=runtime / QA_RELEASE_ATTESTATION_LEDGER_NAME,',
    '            ledger_witness=FixtureWitness(),',
    '        )',
    '    except (OSError, RuntimeError, TypeError, ValueError, KeyError, json.JSONDecodeError):',
    '        return None',
  ].join('\n');
  const gateSource = fs.readFileSync(installedGateScript, 'utf8');
  if (gateSource.split(resolverMarker).length !== 2) {
    throw new Error('fixture release authority requires the protected resolver marker');
  }
  const readinessMarker = '\ndef load_required_gates(';
  if (gateSource.split(readinessMarker).length !== 2) {
    throw new Error('fixture readiness authority requires the canonical gate marker');
  }
  const fixtureReadinessAuthority = [
    '',
    'def _fixture_remeasure_storage_pressure(readiness_facts, installed_prompt_bundle_path):',
    '    del installed_prompt_bundle_path',
    '    return readiness_facts',
    '',
    '_remeasure_storage_pressure = _fixture_remeasure_storage_pressure',
    '',
  ].join('\n');
  const fixtureGateSource = gateSource
    .replace(resolverMarker, `${resolverMarker}${fixtureResolver}\n`)
    .replace(readinessMarker, `${fixtureReadinessAuthority}${readinessMarker}`);
  fs.writeFileSync(installedGateScript, fixtureGateSource);
  return { keyRoot, policySha256, witnessPath };
}

function createParallelWorkReleaseFixture(prefix) {
  const productionRoot = path.resolve(
    process.env.VIVENTIUM_TEST_PRODUCTION_ROOT || path.resolve(__dirname, '../../../../../../../'),
  );
  const releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const releaseDir = path.join(releaseRoot, 'runtime');
  const releasePath = path.join(releaseDir, 'parallel-work-release-gate.json');
  const promptBundlePath = path.join(releaseDir, 'prompt-bundle.json');
  const ownerRepo = path.join(releaseRoot, 'Installed Viventium');
  const ownerExecutable = path.join(ownerRepo, 'bin', 'viventium');
  const ownerConfig = path.join(releaseRoot, 'config.yaml');
  const ownerLock = path.join(ownerRepo, 'components.lock.json');
  const nestedRepo = path.join(ownerRepo, 'components', 'worker');
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
  let cleaned = false;

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.chmodSync(releaseDir, 0o700);
  const receiptAttestationKey = crypto.randomBytes(32);
  const receiptAttestationKeyPath = path.join(releaseDir, 'parallel-work-qa-attestation.key');
  fs.writeFileSync(receiptAttestationKeyPath, receiptAttestationKey, { mode: 0o600 });
  fs.chmodSync(receiptAttestationKeyPath, 0o600);
  fs.mkdirSync(nestedRepo, { recursive: true });
  fs.writeFileSync(path.join(nestedRepo, 'worker.txt'), 'worker source\n');
  git(nestedRepo, ['init', '-q']);
  git(nestedRepo, ['add', 'worker.txt']);
  git(nestedRepo, ['commit', '-qm', 'fixture worker']);
  const nestedRevision = git(nestedRepo, ['rev-parse', 'HEAD']);

  fs.mkdirSync(path.dirname(ownerExecutable), { recursive: true });
  fs.writeFileSync(
    ownerExecutable,
    [
      '#!/bin/sh',
      "child=''",
      'stop_owner() { test -z "$child" || kill "$child" 2>/dev/null; exit 0; }',
      "trap 'stop_owner' TERM INT HUP",
      'while :; do sleep 60 & child=$!; wait "$child"; done',
      '',
    ].join('\n'),
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
  const helperSourceDigest = crypto.createHash('sha256');
  for (const relative of helperSourceFiles) {
    const target = path.join(helperRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `fixture:${relative}\n`);
    helperSourceDigest.update(relative);
    helperSourceDigest.update('\0');
    helperSourceDigest.update(fs.readFileSync(target));
    helperSourceDigest.update('\0');
  }
  const helperPrebuilt = path.join(helperRoot, 'prebuilt');
  const helperBinary = path.join(helperPrebuilt, 'ViventiumHelper-universal');
  fs.mkdirSync(helperPrebuilt, { recursive: true });
  fs.writeFileSync(helperBinary, 'synthetic prebuilt fixture\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(helperPrebuilt, 'source.sha256'),
    `${helperSourceDigest.digest('hex')}\n`,
  );
  fs.writeFileSync(
    path.join(helperPrebuilt, 'binary.sha256'),
    `${sha256(fs.readFileSync(helperBinary))}\n`,
  );

  fs.mkdirSync(path.dirname(installedGateScript), { recursive: true });
  fs.copyFileSync(
    path.join(productionRoot, 'scripts', 'viventium', 'parallel_work_release_gate.py'),
    installedGateScript,
  );
  fs.chmodSync(installedGateScript, 0o755);
  fs.copyFileSync(
    path.join(productionRoot, 'scripts', 'viventium', 'qa_release_attestation.py'),
    path.join(ownerRepo, 'scripts', 'viventium', 'qa_release_attestation.py'),
  );
  fs.copyFileSync(
    path.join(productionRoot, 'scripts', 'viventium', 'runtime_owner_command_contract.json'),
    installedCommandContract,
  );
  fs.copyFileSync(
    path.join(
      productionRoot,
      'scripts',
      'viventium',
      'parallel_work_runtime_artifact_manifest.json',
    ),
    installedRuntimeArtifactManifest,
  );
  const runtimeArtifactManifest = JSON.parse(
    fs.readFileSync(installedRuntimeArtifactManifest, 'utf8'),
  );
  for (const entry of runtimeArtifactManifest.entries) {
    if (entry.kind !== 'file' || entry.path === 'bin/viventium') {
      continue;
    }
    const target = path.join(ownerRepo, entry.path);
    if (fs.existsSync(target)) {
      continue;
    }
    const source = path.join(productionRoot, entry.path);
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
    'qa/modern-playground-voice/cases.md': `## MPV-061: Trusted Wing Worker control

- **Last run:** NOT RUN
`,
  };
  for (const [relative, content] of Object.entries(runtimeLoadedFiles)) {
    const target = path.join(ownerRepo, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(
    path.join(ownerRepo, 'config.schema.yaml'),
    [
      'properties:',
      '  integrations:',
      '    properties:',
      '      glasshive:',
      '        properties:',
      '          orchestration:',
      '            properties:',
      '              available:',
      '                type: boolean',
      '                default: false',
      '              default_mode:',
      '                type: string',
      '                default: focused',
      '',
    ].join('\n'),
  );
  const externalAuthority = installExternalReleaseFixtureAuthority({
    installedGateScript,
    ownerRepo,
    releaseRoot,
  });
  git(ownerRepo, ['init', '-q']);
  git(ownerRepo, ['add', '.']);
  git(ownerRepo, ['commit', '-qm', 'clean owner fixture']);
  const runtimeEnvPath = path.join(releaseDir, 'runtime.env');
  const libreChatConfigPath = path.join(releaseDir, 'librechat.yaml');
  const frontendBuildRoot = path.join(ownerRepo, 'viventium_v0_4', 'LibreChat', 'client', 'dist');
  const apiBuildRoot = path.join(
    ownerRepo,
    'viventium_v0_4',
    'LibreChat',
    'packages',
    'api',
    'dist',
  );
  fs.mkdirSync(frontendBuildRoot, { recursive: true });
  fs.mkdirSync(apiBuildRoot, { recursive: true });
  fs.writeFileSync(path.join(frontendBuildRoot, 'index.html'), '<main>fixture</main>\n');
  fs.writeFileSync(path.join(apiBuildRoot, 'index.js'), 'export const fixture = true;\n');
  fs.writeFileSync(
    runtimeEnvPath,
    'VIVENTIUM_PARALLEL_WORK_AVAILABLE=false\nVIVENTIUM_PARALLEL_WORK_DEFAULT_MODE=focused\n',
  );
  fs.writeFileSync(libreChatConfigPath, 'version: 1.2.1\n');

  const commandContract = JSON.parse(fs.readFileSync(installedCommandContract, 'utf8'));
  const commandValues = {
    ownerExecutablePath: fs.realpathSync(ownerExecutable),
    appSupportDir: fs.realpathSync(releaseRoot),
    configFile: fs.realpathSync(ownerConfig),
    runtimeDir: fs.realpathSync(releaseDir),
    componentsLockFile: fs.realpathSync(ownerLock),
  };
  const ownerArgv = commandContract.detached.argvTemplate.map((token) =>
    token.replace(/\{([^}]+)\}/g, (_match, key) => commandValues[key]),
  );
  const ownerProcess = spawn(ownerArgv[0], ownerArgv.slice(1), {
    cwd: ownerRepo,
    stdio: 'ignore',
  });
  const validPromptRegistryHash = sha256(
    JSON.stringify([
      {
        contentHash: 'a1',
        id: 'main.answer',
        ownerLayer: 'main',
        status: 'active',
        version: 1,
      },
    ]),
  );

  function writeValidOwnerState() {
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
      ownerPid: String(ownerProcess.pid),
      ownerExecutablePath: fs.realpathSync(ownerExecutable),
      ownerProcessCwd: fs.realpathSync(ownerRepo),
      ownerProcessStartedAt: normalized(
        execFileSync('ps', ['-p', String(ownerProcess.pid), '-o', 'lstart='], { encoding: 'utf8' }),
      ),
      ownerProcessCommand: normalized(
        execFileSync('ps', ['-p', String(ownerProcess.pid), '-o', 'command='], {
          encoding: 'utf8',
        }),
      ),
    };
    payload.ownerBindingSha256 = sha256(canonicalJson(payload));
    payload.updatedAt = pythonIsoTimestamp();
    const ownerPath = path.join(releaseRoot, 'state', 'runtime', 'isolated', 'stack-owner.json');
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, `${JSON.stringify(payload, null, 2)}\n`);
    fs.chmodSync(ownerPath, 0o600);
    return { ownerPath, payload };
  }

  function validOwnerBinding() {
    const { ownerPath, payload } = writeValidOwnerState();
    const generatedAt = new Date();
    return {
      contractVersion: 1,
      runtimeProfile: payload.runtimeProfile,
      command: payload.command,
      ownerLaunchMode: payload.ownerLaunchMode,
      ownerPid: payload.ownerPid,
      ownerProcessStartedAt: payload.ownerProcessStartedAt,
      ownerBindingSha256: payload.ownerBindingSha256,
      ownerStateSha256: sha256(fs.readFileSync(ownerPath)),
      repoRootSha256: sha256(payload.repoRoot),
      runtimeDirSha256: sha256(payload.runtimeDir),
      configFileSha256: sha256(payload.configFile),
      componentsLockFileSha256: sha256(payload.componentsLockFile),
      ownerExecutablePathSha256: sha256(payload.ownerExecutablePath),
      ownerProcessCwdSha256: sha256(payload.ownerProcessCwd),
      ownerProcessCommandSha256: sha256(payload.ownerProcessCommand),
      generatedAt: pythonIsoTimestamp(generatedAt),
      expiresAt: pythonIsoTimestamp(new Date(generatedAt.getTime() + 86_400_000)),
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
        registryHash: validPromptRegistryHash,
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

  function validReadinessIdentity() {
    const facts = validReadinessFacts();
    const storage = facts.storagePressure;
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
    };
    return {
      factsSha256: sha256(canonicalReadinessJson(facts)),
      storagePolicySha256: sha256(canonicalReadinessJson(policy)),
      storageMeasurementSha256: sha256(canonicalReadinessJson(measurement)),
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
    const nestedComponents = [
      {
        name: 'worker',
        pin: currentNestedRevision,
        revision: currentNestedRevision,
        clean: nestedStatus === '',
        worktreeHash: sha256(nestedStatus),
      },
    ];
    const runtimeService = runtimeServiceArtifactDigests(
      ownerRepo,
      installedRuntimeArtifactManifest,
    );
    return {
      contractVersion: 1,
      readiness: validReadinessIdentity(),
      source: {
        revision: sourceRevision,
        clean: sourceStatus === '',
        worktreeHash: sha256(sourceStatus),
        componentsLockSha256: lockSha256,
      },
      nestedComponents,
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
        nestedRevisionsHash: sha256(
          JSON.stringify(
            nestedComponents.map(({ name, pin, revision }) => ({ name, pin, revision })),
          ),
        ),
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
        ownerUid: Number(fs.statSync(releaseDir).uid),
        repoRootSha256: ownerBinding?.repoRootSha256,
        runtimeDirSha256: ownerBinding?.runtimeDirSha256,
        runtimeProfile: ownerBinding?.runtimeProfile,
      }),
    );
  }

  const externalReceiptCache = new Map();

  function issueExternalFixtureReceipts(receipts, candidateDigest, artifactDigest, ownerBinding) {
    const cacheKey = canonicalJsonDeep({
      candidateDigest,
      artifactDigest,
      ownerBindingSha256: stableReceiptOwnerBinding(ownerBinding),
      caseIds: receipts.map((receipt) => receipt.caseId),
    });
    if (!externalReceiptCache.has(cacheKey)) {
      const output = execFileSync(
        EXTERNAL_FIXTURE_PYTHON,
        [
          '-I',
          '-B',
          '-c',
          EXTERNAL_RECEIPT_ISSUER,
          ownerRepo,
          releaseDir,
          externalAuthority.keyRoot,
          externalAuthority.witnessPath,
          externalAuthority.policySha256,
        ],
        {
          cwd: ownerRepo,
          encoding: 'utf8',
          env: EXTERNAL_FIXTURE_PYTHON_ENVIRONMENT,
          input: JSON.stringify({
            candidateDigest,
            receipts,
            caseServices: EXTERNAL_FIXTURE_SERVICE_PRODUCERS,
          }),
          maxBuffer: 1024 * 1024,
          timeout: 120_000,
        },
      );
      const signed = JSON.parse(output);
      if (!Array.isArray(signed.receipts) || signed.receipts.length !== receipts.length) {
        throw new Error('fixture publisher did not return complete release evidence');
      }
      externalReceiptCache.set(cacheKey, signed.receipts);
    }
    return externalReceiptCache.get(cacheKey).map((receipt) => ({ ...receipt }));
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
    if (payload.mode !== 'local-qa' && payload.release_ready !== true) {
      payload.gates = payload.gates.map((gate) =>
        gate.status === 'PASS' ? openGate(gate.case_id) : gate,
      );
      payload.open_gates = payload.gates.filter((gate) => gate.status !== 'PASS');
      payload.gate_count = payload.gates.length;
      payload.open_gate_count = payload.open_gates.length;
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
    const unsignedReceipts = payload.gates
      .filter((gate) => gate.source.startsWith('qa/') && gate.status === 'PASS')
      .map((gate) => {
        const receipt = {
          caseId: gate.case_id,
          runAt: pythonIsoTimestamp(),
          candidateDigest,
          artifactDigest,
          evidenceDigest: sha256(`fixture:${gate.case_id}`),
          surface: gate.case_id === 'MPV-061' ? 'voice' : 'telegram',
          status: 'PASS',
          ownerBindingSha256: stableReceiptOwnerBinding(ownerBinding),
          receiptNonce: crypto.randomBytes(16).toString('hex'),
          verifierId: RECEIPT_VERIFIER_IDS[gate.case_id],
          verifierManifestSha256: sha256(`fixture-manifest:${gate.case_id}`),
        };
        if (SERVICE_ACK_CASES.has(gate.case_id)) {
          receipt.serviceAckDigest = `sha256:${sha256(`fixture-service:${gate.case_id}`)}`;
          receipt.serviceAckSessionRef = `qa_${sha256(gate.case_id).slice(0, 24)}`;
        }
        return receipt;
      });
    let receipts = [];
    if (payload.mode === 'local-qa') {
      receipts = unsignedReceipts.map((receipt) => ({
        ...receipt,
        attestation: `hmac-sha256:${crypto
          .createHmac('sha256', receiptAttestationKey)
          .update(canonicalJsonDeep(receipt))
          .digest('hex')}`,
      }));
    } else if (payload.release_ready === true) {
      receipts = issueExternalFixtureReceipts(
        unsignedReceipts,
        candidateDigest,
        artifactDigest,
        ownerBinding,
      );
    }
    const receiptPayload = { contractVersion: 1, receipts };
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
    return payload;
  }

  function reset() {
    fs.writeFileSync(promptBundlePath, `${JSON.stringify(VALID_PROMPT_BUNDLE)}\n`);
    writeReleaseSnapshot();
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    try {
      ownerProcess.kill('SIGTERM');
    } catch (_error) {
      // The owner may already be gone after an intentional failure test.
    }
    fs.rmSync(releaseRoot, { recursive: true, force: true });
  }

  return {
    cleanup,
    openGate,
    promptBundlePath,
    releaseDir,
    releasePath,
    releaseRoot,
    reset,
    validArtifactChecks,
    validArtifactIdentity,
    validGate,
    validGates,
    validReadinessFacts,
    writeReleaseSnapshot,
  };
}

module.exports = { createParallelWorkReleaseFixture };
