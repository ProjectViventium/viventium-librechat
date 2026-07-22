/**
 * === VIVENTIUM START ===
 * Regression: pristine installs must not probe or log an absent optional Google service key.
 * === VIVENTIUM END ===
 */

const mockLoadServiceKey = jest.fn();
const mockLoggerError = jest.fn();
/* === VIVENTIUM START ===
 * Regression: parallel API suites may create the conventional auth.json while this pristine test runs.
 * Purpose: Model the missing-file state deterministically without weakening the production existence check.
 */
const mockExistsSync = jest.fn(() => false);

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: (...args) => mockExistsSync(...args),
}));
/* === VIVENTIUM END === */

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
    mockExistsSync.mockReturnValue(false);
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

  test('still loads an explicitly configured service-key path', async () => {
    process.env.GOOGLE_SERVICE_KEY_FILE = '/path/to/google-service-key.json';
    mockLoadServiceKey.mockResolvedValue({ client_email: 'service@example.com' });

    await expect(loadAsyncEndpoints()).resolves.toEqual({ google: { userProvide: undefined } });
    expect(mockLoadServiceKey).toHaveBeenCalledWith('/path/to/google-service-key.json');
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
