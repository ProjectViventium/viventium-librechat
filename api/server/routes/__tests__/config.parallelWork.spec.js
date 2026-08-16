const express = require('express');
const request = require('supertest');

const mockParallelWorkAvailable = jest.fn();
const mockCacheGet = jest.fn();

jest.mock('~/cache', () => ({
  getLogStores: () => ({ get: (...args) => mockCacheGet(...args), set: jest.fn() }),
}));
jest.mock('~/server/services/viventium/ViventiumOrchestrationMode', () => ({
  parallelWorkAvailable: () => mockParallelWorkAvailable(),
}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Config/ldap', () => ({ getLdapConfig: () => ({}) }));
jest.mock('~/server/services/viventium/registrationGate', () => ({
  isBrowserRegistrationOpen: jest.fn(),
}));
jest.mock('~/models/Project', () => ({ getProjectByName: jest.fn() }));

function createApp() {
  const app = express();
  app.use('/api/config', require('../config'));
  return app;
}

describe('startup config Parallel work availability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_BOOTSTRAP_REGISTRATION_ONCE = 'false';
    mockCacheGet.mockResolvedValue({ appTitle: 'Viventium', viventiumParallelWorkAvailable: true });
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_BOOTSTRAP_REGISTRATION_ONCE;
  });

  test.each([false, true])(
    'overrides cached raw-env availability with the local isolation-readiness snapshot (%s)',
    async (available) => {
      mockParallelWorkAvailable.mockReturnValue(available);

      const response = await request(createApp()).get('/api/config').expect(200);

      expect(response.body).toMatchObject({
        appTitle: 'Viventium',
        viventiumParallelWorkAvailable: available,
      });
      expect(mockParallelWorkAvailable).toHaveBeenCalledTimes(1);
    },
  );
});
