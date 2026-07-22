const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const projectRoot = path.resolve(__dirname, '..');
const minimumSafeDOMPurify = '3.4.12';

function readJSON(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), 'utf8'));
}

function productionTreeProblems() {
  try {
    const output = execFileSync('npm', ['ls', '--all', '--omit=dev', '--json'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(output).problems ?? [];
  } catch (error) {
    return parseFailedNpmList(error);
  }
}

function parseFailedNpmList(error) {
  if (!error.stdout) {
    throw new Error('npm ls failed without JSON output', { cause: error });
  }

  let result;
  try {
    result = JSON.parse(error.stdout);
  } catch (parseError) {
    throw new Error('npm ls failed without valid JSON', { cause: parseError });
  }

  if (!Array.isArray(result.problems)) {
    throw new Error('npm ls failed without a structured problems array', { cause: error });
  }

  return result.problems;
}

function isAuditedMonacoDOMPurifyOverride(problem) {
  if (!problem.startsWith('invalid: dompurify@')) {
    return false;
  }

  const rootPackage = readJSON('package.json');
  const installedDOMPurify = readJSON('node_modules/dompurify/package.json');
  const installedMonaco = readJSON('node_modules/monaco-editor/package.json');
  const override = rootPackage.overrides?.['monaco-editor']?.dompurify;
  const monacoRange = installedMonaco.dependencies?.dompurify;

  return (
    override === `^${minimumSafeDOMPurify}` &&
    semver.gte(installedDOMPurify.version, minimumSafeDOMPurify) &&
    typeof monacoRange === 'string' &&
    !semver.satisfies(installedDOMPurify.version, monacoRange)
  );
}

function main() {
  const problems = productionTreeProblems();
  const unexpected = problems.filter((problem) => !isAuditedMonacoDOMPurifyOverride(problem));

  if (unexpected.length > 0) {
    console.error('Unexpected production dependency-tree problems:');
    for (const problem of unexpected) {
      console.error(`- ${problem}`);
    }
    process.exitCode = 1;
    return;
  }

  if (problems.length === 1) {
    console.log(
      `PASS: production tree has only the audited Monaco DOMPurify security override (>=${minimumSafeDOMPurify}).`,
    );
  } else {
    console.log('PASS: production dependency tree is clean.');
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseFailedNpmList };
