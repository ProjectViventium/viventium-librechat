const path = require('path');

const {
  buildProvisionArgs,
} = require('../../../scripts/viventium-provision-connected-accounts-agent');

describe('viventium connected-account provisioning compatibility entrypoint', () => {
  test('delegates owner-bound provisioning to the canonical managed seeder', () => {
    const args = buildProvisionArgs({
      argv: ['--dry-run'],
      env: { VIVENTIUM_PROVISION_OWNER_ID: 'synthetic-owner-id' },
    });

    expect(path.basename(args[0])).toBe('viventium-seed-agents.js');
    expect(args).toContain('--dry-run');
    expect(args).toContain('--owner-id=synthetic-owner-id');
  });

  test('does not duplicate an explicit owner selection', () => {
    const args = buildProvisionArgs({
      argv: ['--owner-id=explicit-owner'],
      env: { VIVENTIUM_PROVISION_OWNER_ID: 'environment-owner' },
    });

    expect(args.filter((arg) => arg.startsWith('--owner-id='))).toEqual([
      '--owner-id=explicit-owner',
    ]);
  });
});
