/* === VIVENTIUM START ===
 * Feature: local operator-only password reset link issuance without enabling the public browser endpoint.
 * === VIVENTIUM END === */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
require('module-alias')({ base: path.resolve(__dirname, '..', 'api') });

function parseArgs(argv) {
  const args = [...argv];
  let email = '';
  while (args.length > 0) {
    const current = args.shift();
    if (current === '--email') {
      email = String(args.shift() || '').trim();
      continue;
    }
    if (!email && !current.startsWith('-')) {
      email = current.trim();
      continue;
    }
    throw new Error(`Unknown argument: ${current}`);
  }
  if (!email) {
    throw new Error('email is required');
  }
  return { email };
}

function applyRuntimeFallbacks() {
  if (!process.env.MONGO_URI) {
    const mongoPort = String(process.env.VIVENTIUM_LOCAL_MONGO_PORT || '27117').trim();
    const mongoDb = String(process.env.VIVENTIUM_LOCAL_MONGO_DB || 'LibreChatViventium').trim();
    process.env.MONGO_URI = `mongodb://127.0.0.1:${mongoPort}/${mongoDb}`;
  }

  if (!process.env.DOMAIN_CLIENT) {
    const fallbackClientOrigin = String(
      process.env.VIVENTIUM_PUBLIC_CLIENT_URL || process.env.CLIENT_URL || '',
    ).trim();
    if (fallbackClientOrigin) {
      process.env.DOMAIN_CLIENT = fallbackClientOrigin;
    }
  }
}

async function main() {
  const { email } = parseArgs(process.argv.slice(2));
  applyRuntimeFallbacks();
  const domainClient = String(process.env.DOMAIN_CLIENT || '').trim();
  if (!domainClient) {
    throw new Error(
      'DOMAIN_CLIENT is not configured. Start Viventium through bin/viventium first so the local runtime environment is loaded.',
    );
  }

  const connect = require('./connect');
  const { issueLocalPasswordResetLink } = require('~/server/services/viventium/localPasswordResetService');
  await connect();
  const payload = await issueLocalPasswordResetLink({
    email,
    clientOrigin: domainClient,
  });
  process.stdout.write(
    JSON.stringify(payload, null, 2) + '\n',
  );
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
