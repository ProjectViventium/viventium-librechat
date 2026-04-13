const { logger } = require('@librechat/data-schemas');

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('~/server/services/viventium/registrationGate', () => ({
  isBrowserRegistrationOpen: jest.fn(),
}));

const { isBrowserRegistrationOpen } = require('~/server/services/viventium/registrationGate');
const validateRegistration = require('./validateRegistration');

describe('validateRegistration', () => {
  let req;
  let res;
  let next;

  beforeEach(() => {
    req = {};
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
    jest.clearAllMocks();
    delete process.env.LDAP_URL;
    delete process.env.LDAP_USER_SEARCH_BASE;
  });

  it('allows invited users without checking registration state', async () => {
    req.invite = { token: 'invite-token' };

    await validateRegistration(req, res, next);

    expect(isBrowserRegistrationOpen).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows registration when browser sign-up is open', async () => {
    isBrowserRegistrationOpen.mockResolvedValue(true);

    await validateRegistration(req, res, next);

    expect(isBrowserRegistrationOpen).toHaveBeenCalledWith({ ldapEnabled: false });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('passes LDAP state through to the registration gate', async () => {
    process.env.LDAP_URL = 'ldaps://ldap.example.com';
    process.env.LDAP_USER_SEARCH_BASE = 'ou=people,dc=example,dc=com';
    isBrowserRegistrationOpen.mockResolvedValue(false);

    await validateRegistration(req, res, next);

    expect(isBrowserRegistrationOpen).toHaveBeenCalledWith({ ldapEnabled: true });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when registration state lookup throws', async () => {
    isBrowserRegistrationOpen.mockRejectedValue(new Error('mongo warming'));

    await validateRegistration(req, res, next);

    expect(logger.error).toHaveBeenCalledWith(
      '[validateRegistration] Failed to resolve browser registration state',
      expect.any(Error),
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Registration is not allowed.' });
    expect(next).not.toHaveBeenCalled();
  });
});
