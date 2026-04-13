jest.mock('~/models', () => ({
  countUsers: jest.fn(),
}));

const { countUsers } = require('~/models');
const { isBrowserRegistrationOpen } = require('../registrationGate');

describe('registrationGate', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.ALLOW_REGISTRATION;
    delete process.env.VIVENTIUM_BOOTSTRAP_REGISTRATION_ONCE;
  });

  it('closes browser registration when LDAP owns auth', async () => {
    process.env.ALLOW_REGISTRATION = 'true';

    await expect(isBrowserRegistrationOpen({ ldapEnabled: true })).resolves.toBe(false);
    expect(countUsers).not.toHaveBeenCalled();
  });

  it('closes browser registration when ALLOW_REGISTRATION is disabled', async () => {
    process.env.ALLOW_REGISTRATION = 'false';

    await expect(isBrowserRegistrationOpen()).resolves.toBe(false);
    expect(countUsers).not.toHaveBeenCalled();
  });

  it('keeps browser registration open when bootstrap-once mode is off', async () => {
    process.env.ALLOW_REGISTRATION = 'true';

    await expect(isBrowserRegistrationOpen()).resolves.toBe(true);
    expect(countUsers).not.toHaveBeenCalled();
  });

  it('allows only the first browser registration when bootstrap-once mode is enabled', async () => {
    process.env.ALLOW_REGISTRATION = 'true';
    process.env.VIVENTIUM_BOOTSTRAP_REGISTRATION_ONCE = 'true';
    countUsers.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(isBrowserRegistrationOpen()).resolves.toBe(true);
    await expect(isBrowserRegistrationOpen()).resolves.toBe(false);
    expect(countUsers).toHaveBeenCalledTimes(2);
  });
});
