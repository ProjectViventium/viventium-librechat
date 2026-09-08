import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { buildPromptBundleFixture } = require('../../../../../scripts/test-support/promptBundle.cjs');

export function feelingPromptBundle() {
  const root = path.resolve(__dirname, '../../../../..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feeling-prompt-contract-'));
  const sources = path.join(directory, 'prompts');
  const bundle = path.join(directory, 'bundle.json');
  const previous = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  fs.cpSync(
    path.join(root, 'viventium/source_of_truth/prompts'),
    sources,
    { recursive: true },
  );
  const compile = () => {
    fs.writeFileSync(bundle, JSON.stringify(buildPromptBundleFixture(sources)));
    process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundle;
  };
  compile();
  return {
    sources,
    bundle,
    compile,
    close() {
      if (previous === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
      else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
