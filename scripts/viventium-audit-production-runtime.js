const path = require('node:path');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..');

function loadBuiltApi(root = projectRoot) {
  const requireFromRoot = createRequire(path.join(root, 'package.json'));
  const apiEntry = requireFromRoot.resolve('@librechat/api');
  return requireFromRoot(apiEntry);
}

function main() {
  loadBuiltApi();
  console.log('PASS: pruned production runtime loads the built @librechat/api entrypoint.');
}

if (require.main === module) {
  main();
}

module.exports = { loadBuiltApi };
