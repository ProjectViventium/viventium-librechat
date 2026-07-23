#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const LIBRECHAT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(
  LIBRECHAT_ROOT,
  'viventium',
  'source_of_truth',
  'managed-agent-baseline-migration.json',
);
const DEFAULT_PARENT_REV = 'origin/main';
const SUPPORT_FLOOR = Object.freeze({
  parent_commit: '8d5b9913356aa17a3303981979ccec096ef0e0dd',
  predecessor_source_ref: '07c1960c9105e547c312f7eab6f43c1dd2ba17ab',
  published_at: '2026-04-02T00:22:54-04:00',
});
const INVALID_PREDECESSORS = Object.freeze({
  '327dec04af80c3f6f6fbfe9eaeb7eb756b9fbe6b': '60127a8c03e6c0dcbd8415ca0882d0755a30f290',
  ee96bdc2c5c74fd924d48f8cf571432d7e88cb16: '8e751db46fe999e9ce1799ad84d953b5488a20b0',
  cd87a5d36843daa0d113448776f2660e91da4ca5: '6f9bc9b0ee87e3f99896cd37258397332c7e692f',
});
const BUNDLE_PATHS = Object.freeze([
  'viventium/source_of_truth/local.viventium-agents.yaml',
  'tmp/viventium-agents.yaml',
  'scripts/viventium-agents.yaml',
  'scripts/viventium-agents-260127.yaml',
  'scripts/viventium-agents-260127-b.yaml',
  'scripts/viventium-agents-clawd.yaml',
]);
const MANAGED_FIELDS = Object.freeze([
  'name',
  'description',
  'instructions',
  'provider',
  'model',
  'tools',
  'tool_kwargs',
  'model_parameters',
  'end_after_tools',
  'hide_sequential_outputs',
  'support_contact',
  'background_cortices',
  'voice_llm_model',
  'voice_llm_provider',
  'voice_llm_model_parameters',
  'voice_fallback_llm_model',
  'voice_fallback_llm_provider',
  'voice_fallback_llm_model_parameters',
  'fallback_llm_model',
  'fallback_llm_provider',
  'fallback_llm_model_parameters',
  'agent_ids',
  'edges',
  'conversation_starters',
  'category',
]);
const PROMPT_VARIABLE_RE = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function runGit(args, { cwd = LIBRECHAT_ROOT, allowFailure = false } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`Git history audit failed: ${args.join(' ')}`);
  }
  return result;
}

function gitText(args, options) {
  return runGit(args, options).stdout.toString('utf8').trim();
}

function gitBlob(ref, filePath) {
  const result = runGit(['show', `${ref}:${filePath}`], {
    cwd: LIBRECHAT_ROOT,
    allowFailure: true,
  });
  return result.status === 0 ? result.stdout : null;
}

function findBundle(ref) {
  for (const filePath of BUNDLE_PATHS) {
    const contents = gitBlob(ref, filePath);
    if (contents) {
      return { filePath, contents };
    }
  }
  throw new Error(`Published LibreChat ref ${ref} has no supported agent bundle.`);
}

function collectPromptIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPromptIds(item, output));
  } else if (value && typeof value === 'object') {
    if (value.promptRef) {
      output.add(String(value.promptRef));
    }
    if (Array.isArray(value.promptRefs)) {
      value.promptRefs.forEach((item) => output.add(String(item)));
    }
    Object.values(value).forEach((item) => collectPromptIds(item, output));
  }
  return output;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function loadPromptRegistry(ref, bundle) {
  const wanted = collectPromptIds(bundle);
  const registry = new Map();
  while ([...wanted].some((id) => !registry.has(id))) {
    const pending = [...wanted].filter((id) => !registry.has(id));
    const pattern = `^id: (${pending.map(escapeRegex).join('|')})$`;
    const result = runGit(
      ['grep', '-l', '-E', pattern, ref, '--', 'viventium/source_of_truth/prompts'],
      { cwd: LIBRECHAT_ROOT, allowFailure: true },
    );
    if (result.status !== 0) {
      throw new Error(`Published ref ${ref} is missing prompt ids: ${pending.join(', ')}`);
    }
    for (const rawLine of result.stdout.toString('utf8').trim().split('\n').filter(Boolean)) {
      const separator = rawLine.indexOf(':');
      const filePath = rawLine.slice(separator + 1);
      const contents = gitBlob(ref, filePath)?.toString('utf8') || '';
      if (!contents.startsWith('---\n')) {
        throw new Error(`Published prompt lacks frontmatter: ${ref}:${filePath}`);
      }
      const end = contents.indexOf('\n---\n', 4);
      if (end < 0) {
        throw new Error(`Published prompt frontmatter is incomplete: ${ref}:${filePath}`);
      }
      const metadata = yaml.load(contents.slice(4, end), { schema: yaml.JSON_SCHEMA }) || {};
      const id = String(metadata.id || '');
      registry.set(id, { metadata, body: contents.slice(end + 5).trimEnd() });
      for (const include of Array.isArray(metadata.includes) ? metadata.includes : []) {
        wanted.add(String(include));
      }
    }
  }
  return registry;
}

function lookupVariable(variables, key) {
  let current = variables || {};
  for (const segment of String(key).split('.')) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return null;
    }
    current = current[segment];
  }
  if (Array.isArray(current)) {
    return current.map(String).join(', ');
  }
  return current == null ? null : String(current);
}

function renderPrompt(promptId, registry, stack = [], variables = {}) {
  if (stack.includes(promptId)) {
    throw new Error(`Published prompt include cycle: ${[...stack, promptId].join(' -> ')}`);
  }
  const entry = registry.get(promptId);
  if (!entry) {
    throw new Error(`Published bundle references unknown prompt: ${promptId}`);
  }
  const parts = (Array.isArray(entry.metadata.includes) ? entry.metadata.includes : []).map(
    (include) => renderPrompt(String(include), registry, [...stack, promptId], variables).trim(),
  );
  parts.push(entry.body.trim());
  return parts
    .filter(Boolean)
    .join('\n\n')
    .replace(PROMPT_VARIABLE_RE, (match, key) => lookupVariable(variables, key) ?? match);
}

function resolvePromptRefs(value, registry) {
  if (Array.isArray(value)) {
    return value.map((item) => resolvePromptRefs(item, registry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const keys = Object.keys(value);
  const onlyPromptKeys = keys.every((key) =>
    ['promptRef', 'promptRefs', 'promptVars', 'separator'].includes(key),
  );
  if (value.promptRef && onlyPromptKeys) {
    return renderPrompt(String(value.promptRef), registry, [], value.promptVars || {}).trim();
  }
  if (value.promptRefs && onlyPromptKeys) {
    const separator = typeof value.separator === 'string' ? value.separator : '\n\n';
    return value.promptRefs
      .map((id) => renderPrompt(String(id), registry, [], value.promptVars || {}).trim())
      .join(separator);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, resolvePromptRefs(nested, registry)]),
  );
}

function buildHistoricalManagedBaseline(bundle) {
  const agents = [bundle.mainAgent, ...(bundle.backgroundAgents || [])].filter(
    (agent) => agent && agent.id && !agent.missing,
  );
  const managed = {};
  for (const agent of agents) {
    const fields = {};
    for (const field of MANAGED_FIELDS) {
      if (Object.hasOwn(agent, field)) {
        fields[field] = agent[field];
      }
    }
    managed[agent.id] = { fields };
  }
  return { agents: managed };
}

function fingerprintBaseline(fullBaseline, currentBaseline = null) {
  const agents = {};
  for (const [agentId, agent] of Object.entries(fullBaseline.agents)) {
    const currentFields = currentBaseline?.agents?.[agentId]?.fields || null;
    if (currentBaseline && !currentFields) {
      continue;
    }
    const fields = {};
    for (const [field, value] of Object.entries(agent.fields)) {
      if (
        currentFields &&
        (!Object.hasOwn(currentFields, field) ||
          stableSerialize(currentFields[field]) === stableSerialize(value))
      ) {
        continue;
      }
      fields[field] = { $viventium_managed_sha256: sha256(stableSerialize(value)) };
    }
    if (Object.keys(fields).length > 0) {
      agents[agentId] = { fields };
    }
  }
  return {
    schema_version: 1,
    bundle_sha256: sha256(stableSerialize({ agents })),
    agents,
  };
}

function collectPublishedPins(parentRev = DEFAULT_PARENT_REV, parentRoot) {
  if (!parentRoot) {
    throw new Error('A validated parent root is required for the public lock-history audit.');
  }
  const resolvedParentRoot = path.resolve(parentRoot);
  const topLevel = gitText(['rev-parse', '--show-toplevel'], { cwd: resolvedParentRoot });
  if (path.resolve(topLevel) !== resolvedParentRoot) {
    throw new Error('The supplied parent root is not an exact Git repository root.');
  }
  const commits = gitText(['rev-list', '--reverse', parentRev, '--', 'components.lock.json'], {
    cwd: resolvedParentRoot,
  })
    .split('\n')
    .filter(Boolean);
  const pins = [];
  for (const parentCommit of commits) {
    const lock = JSON.parse(
      gitText(['show', `${parentCommit}:components.lock.json`], { cwd: resolvedParentRoot }),
    );
    const component = lock.components?.find(
      (item) => item.name === 'LibreChat' || item.path === 'viventium_v0_4/LibreChat',
    );
    const ref = String(component?.ref || '');
    if (!/^[a-f0-9]{40}$/.test(ref)) {
      throw new Error(`Parent ${parentCommit} has an invalid LibreChat pin.`);
    }
    if (!pins.some((item) => item.ref === ref)) {
      pins.push({
        ref,
        parentCommit,
        publishedAt: gitText(['show', '-s', '--format=%cI', parentCommit], {
          cwd: resolvedParentRoot,
        }),
      });
    }
  }
  return { commits, pins };
}

function buildArtifact({ parentRev = DEFAULT_PARENT_REV, parentRoot, includeAudit = false } = {}) {
  const { commits, pins } = collectPublishedPins(parentRev, parentRoot);
  if (commits.length === 0) {
    throw new Error('Public parent history has no component-lock revisions.');
  }
  const boundaryCommit = commits[commits.length - 1];
  const historyBoundary = {
    parent_commit: boundaryCommit,
    published_at: gitText(['show', '-s', '--format=%cI', boundaryCommit], {
      cwd: path.resolve(parentRoot),
    }),
  };
  const currentRef = gitText(['rev-parse', 'HEAD'], { cwd: LIBRECHAT_ROOT });
  const currentSource = findBundle(currentRef).contents;
  const currentRawBundle = yaml.load(currentSource.toString('utf8'), { schema: yaml.JSON_SCHEMA });
  const currentBaseline = buildHistoricalManagedBaseline(
    resolvePromptRefs(currentRawBundle, loadPromptRegistry(currentRef, currentRawBundle)),
  );
  const invalid = [];
  const groups = new Map();
  for (const pin of pins) {
    const exists =
      runGit(['cat-file', '-e', `${pin.ref}^{commit}`], {
        cwd: LIBRECHAT_ROOT,
        allowFailure: true,
      }).status === 0;
    if (!exists) {
      if (INVALID_PREDECESSORS[pin.ref] !== pin.parentCommit) {
        throw new Error(`Unreviewed missing published LibreChat pin: ${pin.ref}`);
      }
      invalid.push({
        predecessor_source_ref: pin.ref,
        parent_commit: pin.parentCommit,
        reason: 'nested_object_was_never_published',
      });
      continue;
    }
    if (
      runGit(['merge-base', '--is-ancestor', pin.ref, 'origin/main'], {
        cwd: LIBRECHAT_ROOT,
        allowFailure: true,
      }).status !== 0
    ) {
      throw new Error(`Published LibreChat pin is outside public nested main: ${pin.ref}`);
    }
    const { contents } = findBundle(pin.ref);
    const rawBundleSha256 = sha256(contents);
    const rawBundle = yaml.load(contents.toString('utf8'), { schema: yaml.JSON_SCHEMA });
    const resolvedBundle = resolvePromptRefs(rawBundle, loadPromptRegistry(pin.ref, rawBundle));
    const fullBaseline = buildHistoricalManagedBaseline(resolvedBundle);
    const managedSha256 = sha256(stableSerialize(fullBaseline));
    const groupKey = `${rawBundleSha256}:${managedSha256}`;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        predecessor_source_bundle_sha256: rawBundleSha256,
        predecessor_managed_bundle_sha256: managedSha256,
        baseline: fingerprintBaseline(fullBaseline, currentBaseline),
        fullBaseline,
        predecessor_source_refs: [],
      });
    }
    groups.get(groupKey).predecessor_source_refs.push(pin.ref);
  }
  const observedInvalid = new Set(invalid.map((item) => item.predecessor_source_ref));
  for (const expected of Object.keys(INVALID_PREDECESSORS)) {
    if (!observedInvalid.has(expected)) {
      throw new Error(`Expected invalid historical pin is no longer represented: ${expected}`);
    }
  }
  const migrations = [...groups.values()].map((group, index) => ({
    migration_id: `public-components-lock-group-${String(index + 1).padStart(2, '0')}`,
    predecessor_source_refs: group.predecessor_source_refs.sort(),
    predecessor_source_bundle_sha256: group.predecessor_source_bundle_sha256,
    predecessor_managed_bundle_sha256: group.predecessor_managed_bundle_sha256,
    baseline: group.baseline,
  }));
  const content = {
    schema_version: 2,
    support_floor: SUPPORT_FLOOR,
    history_boundary: historyBoundary,
    public_lock_revision_count: commits.length,
    invalid_predecessors: invalid.sort((left, right) =>
      left.predecessor_source_ref.localeCompare(right.predecessor_source_ref),
    ),
    migrations,
  };
  const artifact = { ...content, artifact_sha256: sha256(stableSerialize(content)) };
  if (includeAudit) {
    return {
      artifact,
      currentBaseline,
      groups: [...groups.values()].map((group) => ({
        ...group,
        predecessor_source_refs: [...group.predecessor_source_refs],
      })),
    };
  }
  return artifact;
}

function artifactContent(artifact) {
  return {
    schema_version: artifact.schema_version,
    support_floor: artifact.support_floor,
    history_boundary: artifact.history_boundary,
    public_lock_revision_count: artifact.public_lock_revision_count,
    invalid_predecessors: artifact.invalid_predecessors,
    migrations: artifact.migrations,
  };
}

function auditHermeticArtifact(artifact) {
  if (!artifact || artifact.schema_version !== 2) {
    throw new Error('Managed agent migration artifact schema is unsupported.');
  }
  if (stableSerialize(artifact.support_floor) !== stableSerialize(SUPPORT_FLOOR)) {
    throw new Error('Managed agent migration support floor is not the reviewed public floor.');
  }
  if (
    !/^[a-f0-9]{40}$/.test(String(artifact.history_boundary?.parent_commit || '')) ||
    typeof artifact.history_boundary?.published_at !== 'string' ||
    !Number.isInteger(artifact.public_lock_revision_count) ||
    artifact.public_lock_revision_count < 1
  ) {
    throw new Error('Managed agent migration history boundary is invalid.');
  }
  const invalid = Array.isArray(artifact.invalid_predecessors) ? artifact.invalid_predecessors : [];
  if (
    invalid.length !== Object.keys(INVALID_PREDECESSORS).length ||
    invalid.some(
      (entry) =>
        INVALID_PREDECESSORS[entry.predecessor_source_ref] !== entry.parent_commit ||
        entry.reason !== 'nested_object_was_never_published',
    )
  ) {
    throw new Error('Managed agent migration tombstones changed without review.');
  }
  const migrations = Array.isArray(artifact.migrations) ? artifact.migrations : [];
  const predecessorRefs = migrations.flatMap(
    (migration) => migration.predecessor_source_refs || [],
  );
  if (
    migrations.length === 0 ||
    predecessorRefs.length === 0 ||
    new Set(predecessorRefs).size !== predecessorRefs.length
  ) {
    throw new Error('Managed agent migration public predecessor coverage is incomplete.');
  }
  const expectedArtifactHash = sha256(stableSerialize(artifactContent(artifact)));
  if (artifact.artifact_sha256 !== expectedArtifactHash) {
    throw new Error('Managed agent migration artifact content hash is invalid.');
  }

  const currentRef = gitText(['rev-parse', 'HEAD'], { cwd: LIBRECHAT_ROOT });
  const currentSource = findBundle(currentRef).contents;
  const currentRawBundle = yaml.load(currentSource.toString('utf8'), { schema: yaml.JSON_SCHEMA });
  const currentBaseline = buildHistoricalManagedBaseline(
    resolvePromptRefs(currentRawBundle, loadPromptRegistry(currentRef, currentRawBundle)),
  );
  const groups = [];
  for (const migration of migrations) {
    if (
      !/^public-components-lock-group-[0-9]{2}$/.test(String(migration.migration_id || '')) ||
      !/^[a-f0-9]{64}$/.test(String(migration.predecessor_source_bundle_sha256 || '')) ||
      !/^[a-f0-9]{64}$/.test(String(migration.predecessor_managed_bundle_sha256 || ''))
    ) {
      throw new Error(
        `Managed migration group identity is invalid: ${migration.migration_id || '?'}`,
      );
    }
    let groupFullBaseline = null;
    for (const predecessorRef of migration.predecessor_source_refs) {
      if (!/^[a-f0-9]{40}$/.test(predecessorRef)) {
        throw new Error(`Managed migration predecessor ref is invalid: ${predecessorRef}`);
      }
      const { contents } = findBundle(predecessorRef);
      if (sha256(contents) !== migration.predecessor_source_bundle_sha256) {
        throw new Error(`Managed migration source hash differs for ${predecessorRef}.`);
      }
      const rawBundle = yaml.load(contents.toString('utf8'), { schema: yaml.JSON_SCHEMA });
      const resolvedBundle = resolvePromptRefs(
        rawBundle,
        loadPromptRegistry(predecessorRef, rawBundle),
      );
      const fullBaseline = buildHistoricalManagedBaseline(resolvedBundle);
      groupFullBaseline ||= fullBaseline;
      if (sha256(stableSerialize(fullBaseline)) !== migration.predecessor_managed_bundle_sha256) {
        throw new Error(`Managed migration resolved baseline differs for ${predecessorRef}.`);
      }
      if (
        stableSerialize(fingerprintBaseline(fullBaseline, currentBaseline)) !==
        stableSerialize(migration.baseline)
      ) {
        throw new Error(`Managed migration fingerprint differs for ${predecessorRef}.`);
      }
    }
    groups.push({
      ...migration,
      fullBaseline: groupFullBaseline,
      predecessor_source_refs: [...migration.predecessor_source_refs],
    });
  }
  return { artifact, currentBaseline, groups };
}

function verifyHermeticArtifact(artifact) {
  auditHermeticArtifact(artifact);
  return artifact;
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    parentRev: DEFAULT_PARENT_REV,
    parentRoot: '',
    write: false,
    check: false,
  };
  for (const arg of argv) {
    if (arg === '--write') args.write = true;
    else if (arg === '--check') args.check = true;
    else if (arg.startsWith('--output=')) args.output = path.resolve(arg.slice('--output='.length));
    else if (arg.startsWith('--parent-rev=')) args.parentRev = arg.slice('--parent-rev='.length);
    else if (arg.startsWith('--parent-root='))
      args.parentRoot = path.resolve(arg.slice('--parent-root='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.write === args.check) {
    throw new Error('Choose exactly one of --write or --check.');
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.write) {
    if (!args.parentRoot) {
      throw new Error('--write requires --parent-root=<exact parent repository root>.');
    }
    const output = `${JSON.stringify(
      buildArtifact({ parentRev: args.parentRev, parentRoot: args.parentRoot }),
      null,
      2,
    )}\n`;
    fs.writeFileSync(args.output, output, { encoding: 'utf8', mode: 0o644 });
    process.stdout.write(`Wrote ${args.output}\n`);
    return;
  }
  const existing = fs.readFileSync(args.output, 'utf8');
  const artifact = JSON.parse(existing);
  verifyHermeticArtifact(artifact);
  if (args.parentRoot) {
    if (
      runGit(
        ['merge-base', '--is-ancestor', artifact.history_boundary.parent_commit, args.parentRev],
        { cwd: args.parentRoot, allowFailure: true },
      ).status !== 0
    ) {
      throw new Error(
        'Recorded managed-agent history boundary is outside the requested parent history.',
      );
    }
    const output = `${JSON.stringify(
      buildArtifact({
        parentRev: artifact.history_boundary.parent_commit,
        parentRoot: args.parentRoot,
      }),
      null,
      2,
    )}\n`;
    if (existing !== output) {
      throw new Error('Managed agent migration artifact does not match public history.');
    }
  }
  process.stdout.write(
    args.parentRoot
      ? 'Managed agent migration artifact matches public history through its recorded history boundary.\n'
      : `Managed agent migration artifact is self-contained and matches all ${artifact.migrations.flatMap((migration) => migration.predecessor_source_refs || []).length} predecessor objects.\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  auditHermeticArtifact,
  buildArtifact,
  buildHistoricalManagedBaseline,
  collectPublishedPins,
  fingerprintBaseline,
  resolvePromptRefs,
  stableSerialize,
  verifyHermeticArtifact,
};
