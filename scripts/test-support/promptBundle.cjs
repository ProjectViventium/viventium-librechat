// Test-only schema-v1 bundle fixture. Production compiler validation is owned by
// Viventium Core's prompt_registry tests; these tests exercise LibreChat consumers.
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

function buildPromptBundleFixture(sourceRoot) {
  const prompts = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(source);
      else if (entry.name.endsWith('.md') && entry.name.toUpperCase() !== 'README.MD') {
        const text = fs.readFileSync(source, 'utf8');
        const end = text.indexOf('\n---\n', 4);
        if (!text.startsWith('---\n') || end < 0) throw new Error('Invalid test prompt frontmatter');
        const metadata = yaml.load(text.slice(4, end));
        if (!metadata?.id || prompts[metadata.id]) throw new Error('Invalid test prompt identity');
        prompts[metadata.id] = { metadata, body: `${text.slice(end + 5).trimEnd()}\n` };
      }
    }
  }
  visit(sourceRoot);
  return { schema_version: 1, prompts };
}
module.exports = { buildPromptBundleFixture };
