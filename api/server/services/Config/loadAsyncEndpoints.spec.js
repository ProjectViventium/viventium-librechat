/**
 * === VIVENTIUM START ===
 * Regression: pristine installs must not probe or log an absent optional Google service key.
 * === VIVENTIUM END ===
 */

const mockLoadServiceKey = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@librechat/api', () => ({
  isUserProvided: (value) => value === 'user_provided',
  loadServiceKey: (...args) => mockLoadServiceKey(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: (...args) => mockLoggerError(...args) },
}));

jest.mock('./EndpointService', () => ({
  config: { googleKey: undefined },
}));

const loadAsyncEndpoints = require('./loadAsyncEndpoints');

describe('loadAsyncEndpoints first-run auth discovery', () => {
  const originalServiceKeyFile = process.env.GOOGLE_SERVICE_KEY_FILE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GOOGLE_SERVICE_KEY_FILE;
  });

  afterAll(() => {
    if (originalServiceKeyFile === undefined) {
      delete process.env.GOOGLE_SERVICE_KEY_FILE;
    } else {
      process.env.GOOGLE_SERVICE_KEY_FILE = originalServiceKeyFile;
    }
  });

  test('does not probe or log a missing implicit auth.json on a pristine install', async () => {
    await expect(loadAsyncEndpoints()).resolves.toEqual({ google: false });

    expect(mockLoadServiceKey).not.toHaveBeenCalled();
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
