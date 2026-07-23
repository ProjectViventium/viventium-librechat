import crypto from 'node:crypto';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const mongoUri = process.env.MONGO_URI ?? '';
const databaseName = mongoUri ? new URL(mongoUri).pathname.replace(/^\//, '') : '';
if (
  process.env.VIVENTIUM_E2E_CHANNEL_FIXTURES !== 'true' ||
  !/(?:qa|test|e2e)/i.test(databaseName) ||
  !process.env.E2E_USER_EMAIL?.endsWith('@example.test') ||
  !process.env.E2E_USER_PASSWORD
) {
  throw new Error(
    'Channels E2E requires explicit fixture opt-in, a QA/test Mongo database, and synthetic example.test credentials',
  );
}

const repositoryRoot = process.cwd();
const serverPath = path.resolve(repositoryRoot, 'api/server/index.js');
const configPath = path.resolve(repositoryRoot, 'e2e/librechat.channels.yaml');

export default defineConfig({
  globalSetup: require.resolve('./setup/global-setup'),
  globalTeardown: require.resolve('./setup/global-teardown'),
  testDir: 'specs',
  testMatch: 'connected-channels.spec.ts',
  outputDir: 'specs/.test-results/channels',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/channels', open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:3080',
    channel: 'chrome',
    headless: process.env.VIVENTIUM_QA_HEADED !== 'true',
    storageState: path.resolve(repositoryRoot, 'e2e/storageState.json'),
    screenshot: 'on',
    trace: 'retain-on-failure',
    video: 'off',
  },
  expect: { timeout: 10_000 },
  webServer: {
    command: `node ${serverPath}`,
    cwd: repositoryRoot,
    url: 'http://127.0.0.1:3080',
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'CI',
      HOST: '127.0.0.1',
      PORT: '3080',
      CONFIG_PATH: configPath,
      ALLOW_REGISTRATION: 'true',
      SEARCH: 'false',
      EMAIL_HOST: '',
      SESSION_EXPIRY: '60000',
      REFRESH_TOKEN_EXPIRY: '300000',
      VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED: 'true',
      VIVENTIUM_INSTALL_EXPERIENCE: 'easy',
      VIVENTIUM_PUBLIC_SERVER_URL: 'https://qa.example.test',
      CREDS_KEY: crypto.randomBytes(32).toString('hex'),
      CREDS_IV: crypto.randomBytes(16).toString('hex'),
      JWT_SECRET: crypto.randomBytes(32).toString('base64url'),
      JWT_REFRESH_SECRET: crypto.randomBytes(32).toString('base64url'),
    },
  },
});
