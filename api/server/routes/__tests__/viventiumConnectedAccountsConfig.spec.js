const request = require('supertest');
const express = require('express');

const mockCache = {
  get: jest.fn(async () => null),
  set: jest.fn(async () => undefined),
  delete: jest.fn(async () => undefined),
};

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => mockCache),
}));
jest.mock('~/server/services/Config/ldap', () => ({
  getLdapConfig: jest.fn(() => null),
}));
jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: jest.fn(async () => ({
    registration: { socialLogins: [] },
    interfaceConfig: {},
  })),
}));
jest.mock('~/models/Project', () => ({
  getProjectByName: jest.fn(async () => ({ _id: { toString: () => 'project_fixture' } })),
}));
jest.mock('~/server/services/viventium/registrationGate', () => ({
  isBrowserRegistrationOpen: jest.fn(async () => false),
}));

const configRoute = require('../config');
const app = express();
app.disable('x-powered-by');
app.use('/api/config', configRoute);

const capabilityKeys = [
  'VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED',
  'VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH',
  'VIVENTIUM_EXPERIMENTAL_DIRECT_SUBSCRIPTION_AUTH',
  'VIVENTIUM_VOICE_ENABLED',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
];

beforeEach(() => {
  for (const key of capabilityKeys) {
    delete process.env[key];
  }
});

afterEach(() => {
  mockCache.get.mockClear();
  mockCache.set.mockClear();
});

describe('GET /api/config connected-account capability', () => {
  it('projects Voice as disabled unless the runtime explicitly enables it', async () => {
    let response = await request(app).get('/api/config');
    expect(response.body.viventiumVoiceEnabled).toBe(false);

    process.env.VIVENTIUM_VOICE_ENABLED = 'true';
    response = await request(app).get('/api/config');
    expect(response.body.viventiumVoiceEnabled).toBe(true);
  });

  it('projects the Native capability without enabling experimental direct OAuth', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED = 'true';

    const response = await request(app).get('/api/config');

    expect(response.statusCode).toBe(200);
    expect(response.body.viventiumConnectedAccountsEnabled).toBe(true);
    expect(response.body.viventiumExperimentalDirectSubscriptionAuth).toBe(false);
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('keeps an explicit false capability authoritative over legacy signals', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED = 'false';
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';
    process.env.OPENAI_API_KEY = 'user_provided';

    const response = await request(app).get('/api/config');

    expect(response.statusCode).toBe(200);
    expect(response.body.viventiumConnectedAccountsEnabled).toBe(false);
    expect(response.body.viventiumExperimentalDirectSubscriptionAuth).toBe(false);
  });

  it.each([
    ['local subscription compatibility', 'VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH'],
    ['OpenAI user-key compatibility', 'OPENAI_API_KEY'],
    ['Anthropic user-key compatibility', 'ANTHROPIC_API_KEY'],
  ])('preserves %s when the explicit capability is absent', async (_label, key) => {
    process.env[key] = key.endsWith('_API_KEY') ? 'user_provided' : 'true';

    const response = await request(app).get('/api/config');

    expect(response.statusCode).toBe(200);
    expect(response.body.viventiumConnectedAccountsEnabled).toBe(true);
    expect(response.body.viventiumExperimentalDirectSubscriptionAuth).toBe(false);
  });
});
