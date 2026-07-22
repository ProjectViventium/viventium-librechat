/**
 * === VIVENTIUM START ===
 * Release gate: prove Docker excludes synthetic machine-local state without excluding source.
 * === VIVENTIUM END ===
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const context = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-docker-context-'));
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-docker-output-'));
const excludedDirectories = [
  'data-node',
  'data-node-synthetic',
  'meili_data_v1.35.1',
  'images',
  'uploads',
  '.rag-pgdata',
];

try {
  fs.copyFileSync(path.join(repositoryRoot, '.dockerignore'), path.join(context, '.dockerignore'));
  fs.writeFileSync(path.join(context, 'Dockerfile'), 'FROM scratch\nCOPY . /context\n');
  for (const directory of excludedDirectories) {
    fs.mkdirSync(path.join(context, directory), { recursive: true });
    fs.writeFileSync(path.join(context, directory, 'synthetic-private-state.txt'), 'exclude me\n');
  }
  fs.mkdirSync(path.join(context, 'client', 'src'), { recursive: true });
  fs.writeFileSync(path.join(context, 'client', 'src', 'synthetic-source.ts'), 'export {};\n');
  fs.mkdirSync(path.join(context, 'client', 'public', 'images'), { recursive: true });
  fs.writeFileSync(
    path.join(context, 'client', 'public', 'images', 'synthetic-source.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  );

  const build = spawnSync(
    'docker',
    [
      'buildx',
      'build',
      '--file',
      path.join(context, 'Dockerfile'),
      '--output',
      `type=local,dest=${output}`,
      context,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout);
    process.exitCode = build.status ?? 1;
  } else {
    for (const directory of excludedDirectories) {
      if (fs.existsSync(path.join(output, 'context', directory))) {
        throw new Error(`private state entered BuildKit context: ${directory}`);
      }
    }
    if (!fs.existsSync(path.join(output, 'context', 'client', 'src', 'synthetic-source.ts'))) {
      throw new Error('required source was excluded from BuildKit context');
    }
    if (
      !fs.existsSync(
        path.join(output, 'context', 'client', 'public', 'images', 'synthetic-source.svg'),
      )
    ) {
      throw new Error('nested public image assets were excluded from BuildKit context');
    }
    console.log(
      JSON.stringify({ excludedDirectories, sourcePreserved: 'client/src/synthetic-source.ts' }),
    );
  }
} finally {
  fs.rmSync(context, { recursive: true, force: true });
  fs.rmSync(output, { recursive: true, force: true });
}
