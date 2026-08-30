#!/usr/bin/env node

/* === VIVENTIUM START ===
 * Purpose: Publish an immutable npm package version only when a successful
 * registry response proves that exact name@version is absent.
 */

const fs = require('node:fs');

function requireSafeArgument(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function exactVersionDecision(packageName, packageVersion, registryJson) {
  const exactName = requireSafeArgument(packageName, 'package name');
  const exactVersion = requireSafeArgument(packageVersion, 'package version');
  const parsed = JSON.parse(registryJson);
  if (!Array.isArray(parsed) || !parsed.every((version) => typeof version === 'string')) {
    throw new Error(`Registry versions for ${exactName} were not a string array`);
  }
  return {
    packageName: exactName,
    packageVersion: exactVersion,
    skip: parsed.includes(exactVersion),
  };
}

function run(argv = process.argv.slice(2), environment = process.env) {
  const [packageName, packageVersion, versionsFile] = argv;
  const exactVersionsFile = requireSafeArgument(versionsFile, 'registry versions file');
  const outputFile = requireSafeArgument(environment.GITHUB_OUTPUT, 'GitHub output file');
  const decision = exactVersionDecision(
    packageName,
    packageVersion,
    fs.readFileSync(exactVersionsFile, 'utf8'),
  );
  fs.appendFileSync(outputFile, `skip=${decision.skip}\n`, 'utf8');
  process.stdout.write(
    decision.skip
      ? `Exact immutable version ${decision.packageName}@${decision.packageVersion} already exists; skipping publish.\n`
      : `Registry confirms ${decision.packageName}@${decision.packageVersion} is absent; publish may proceed.\n`,
  );
  return decision;
}

if (require.main === module) {
  run();
}

module.exports = { exactVersionDecision, run };

/* === VIVENTIUM END === */
