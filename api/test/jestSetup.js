// See .env.test.example for an example of the '.env.test' file.
require('dotenv').config({ path: './test/.env.test' });
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/dummy-uri';
process.env.BAN_VIOLATIONS = 'true';
process.env.BAN_DURATION = '7200000';
process.env.BAN_INTERVAL = '20';
process.env.CI = 'true';
process.env.JWT_SECRET = 'test';
process.env.JWT_REFRESH_SECRET = 'test';
process.env.CREDS_KEY = 'test';
process.env.CREDS_IV = 'test';
process.env.ALLOW_EMAIL_LOGIN = 'true';

// Set global test timeout high enough for cold MongoMemoryServer startups in full-suite runs.
// Individual tests can still override this lower when they need tighter bounds.
jest.setTimeout(120000);

/* === VIVENTIUM START ===
 * Feature: Test stability (mongodb-memory-server cold start)
 * Purpose: Prevent full-suite flakiness from the library's 10s default instance launch timeout.
 * Added: 2026-03-08
 */
const originalMongoMemoryServerCreate = MongoMemoryServer.create.bind(MongoMemoryServer);
MongoMemoryServer.create = (options = {}) =>
  originalMongoMemoryServerCreate({
    ...options,
    instance: {
      launchTimeout: 45_000,
      ...(options.instance ?? {}),
    },
  });
/* === VIVENTIUM END === */
process.env.OPENAI_API_KEY = 'test';
