/* === VIVENTIUM START ===
 * Feature: Connected Accounts provider-source truth.
 * Purpose: Keep startup UI policy aligned with provider execution auth mode.
 * === VIVENTIUM END === */
jest.mock('~/cache', () => ({
  getLogStores: () => ({ get: jest.fn().mockResolvedValue(null), set: jest.fn() }),
}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Config/ldap', () => ({ getLdapConfig: () => ({}) }));
jest.mock('~/server/services/viventium/registrationGate', () => ({
  isBrowserRegistrationOpen: jest.fn(),
}));
jest.mock('~/server/services/viventium/ViventiumOrchestrationMode', () => ({
  parallelWorkAvailable: jest.fn().mockReturnValue(false),
}));
jest.mock('~/models/Project', () => ({
  getProjectByName: jest.fn().mockResolvedValue({ _id: { toString: () => 'project-test' } }),
}));

const request = require('supertest');
const express = require('express');
const configRoute = require('../config');

const app = express();
app.disable('x-powered-by');
app.use('/api/config', configRoute);

afterEach(() => {
  delete process.env.VIVENTIUM_OPENAI_AUTH_MODE;
  delete process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE;
  delete process.env.VIVENTIUM_PRIMARY_AUTH_MODE;
  delete process.env.VIVENTIUM_SECONDARY_AUTH_MODE;
});

describe('startup config Connected Accounts auth policy', () => {
  it('projects provider-specific connected-account requirements without credentials', async () => {
    process.env.VIVENTIUM_OPENAI_AUTH_MODE = 'connected_account';
    process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE = 'platform';

    const response = await request(app).get('/api/config').expect(200);

    expect(response.body.viventiumOpenAIConnectedAccountRequired).toBe(true);
    expect(response.body.viventiumAnthropicConnectedAccountRequired).toBe(false);
  });

  it('honors the shared primary and secondary connected-account modes', async () => {
    process.env.VIVENTIUM_PRIMARY_AUTH_MODE = 'connected_account';
    process.env.VIVENTIUM_SECONDARY_AUTH_MODE = 'connected_account';

    const response = await request(app).get('/api/config').expect(200);

    expect(response.body.viventiumOpenAIConnectedAccountRequired).toBe(true);
    expect(response.body.viventiumAnthropicConnectedAccountRequired).toBe(true);
  });
});
