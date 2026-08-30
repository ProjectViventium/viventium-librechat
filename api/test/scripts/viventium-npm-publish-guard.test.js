const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  exactVersionDecision,
  run,
} = require('../../../scripts/npm-exact-version-publish-guard.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOWS = ['client.yml', 'data-provider.yml', 'data-schemas.yml'];

describe('immutable npm package publish guard', () => {
  test('skips an exact historical version even when a newer version exists', () => {
    expect(exactVersionDecision('@librechat/example', '1.2.3', '["1.2.3","1.2.30"]')).toMatchObject(
      { skip: true, packageVersion: '1.2.3' },
    );
  });

  test('allows publishing only when the successful registry list lacks the exact version', () => {
    expect(exactVersionDecision('@librechat/example', '1.2.3', '["1.2.2","1.2.30"]')).toMatchObject(
      { skip: false, packageVersion: '1.2.3' },
    );
  });

  test.each(['not-json', '{}', '["1.2.3",null]'])(
    'fails closed for an unusable registry response: %s',
    (registryJson) => {
      expect(() => exactVersionDecision('@librechat/example', '1.2.3', registryJson)).toThrow();
    },
  );

  test('writes one exact GitHub output decision from a saved registry response', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-publish-guard-'));
    const versionsFile = path.join(directory, 'versions.json');
    const outputFile = path.join(directory, 'github-output.txt');
    fs.writeFileSync(versionsFile, '["0.4.53","0.4.54"]');

    expect(
      run(['@librechat/client', '0.4.54', versionsFile], { GITHUB_OUTPUT: outputFile }),
    ).toMatchObject({ skip: true });
    expect(fs.readFileSync(outputFile, 'utf8')).toBe('skip=true\n');
  });

  test.each(WORKFLOWS)('%s fails closed and checks full exact version membership', (fileName) => {
    const workflow = fs.readFileSync(
      path.join(REPOSITORY_ROOT, '.github/workflows', fileName),
      'utf8',
    );
    const guard = workflow.match(
      /- name: Check exact published version[\s\S]*?(?=\n\s+- name:|\n\s+- run:)/,
    )?.[0];

    expect(guard).toContain('set -euo pipefail');
    expect(guard).toContain('npm view "$PACKAGE_NAME" versions --json > "$VERSIONS_FILE"');
    expect(guard).toContain('${RUNNER_TEMP}');
    expect(guard).toContain('npm-exact-version-publish-guard.cjs');
    expect(guard).not.toMatch(/npm view[^\n]*(\|\||;\s*true)/);
    expect(guard).not.toContain('PUBLISHED_VERSION=');
    expect(workflow).toContain("if: steps.check.outputs.skip != 'true'");
  });
});
