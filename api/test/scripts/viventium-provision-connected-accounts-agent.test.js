const path = require('path');

const {
  DEFAULT_BUNDLE_PATH,
  buildProvisionArgs,
} = require('../../../scripts/viventium-provision-connected-accounts-agent');

describe('viventium connected-account provisioning compatibility entrypoint', () => {
  test('delegates owner-bound provisioning to the canonical managed seeder', () => {
    const args = buildProvisionArgs({
      argv: ['--dry-run'],
      env: {
        VIVENTIUM_APP_SUPPORT_DIR: '/synthetic/support',
        VIVENTIUM_PROVISION_OWNER_ID: 'synthetic-owner-id',
      },
    });

    expect(path.basename(args[0])).toBe('viventium-seed-agents.js');
    expect(args).toContain('--dry-run');
    expect(args).toContain('--owner-id=synthetic-owner-id');
    expect(args).toContain(`--bundle=${DEFAULT_BUNDLE_PATH}`);
    expect(args).toContain(
      `--managed-baseline=${path.join(
        '/synthetic/support',
        'state',
        'agent-managed-baseline.json',
      )}`,
    );
  });

  test('does not duplicate explicit owner, bundle, or baseline selections', () => {
    const explicitBundle = '/synthetic/custom-bundle.yaml';
    const explicitBaseline = '/synthetic/custom-baseline.json';
    const args = buildProvisionArgs({
      argv: [
        '--owner-id=explicit-owner',
        `--bundle=${explicitBundle}`,
        `--managed-baseline=${explicitBaseline}`,
      ],
      env: {
        VIVENTIUM_APP_SUPPORT_DIR: '/synthetic/support',
        VIVENTIUM_PROVISION_OWNER_ID: 'environment-owner',
      },
    });

    expect(args.filter((arg) => arg.startsWith('--owner-id='))).toEqual([
      '--owner-id=explicit-owner',
    ]);
    expect(args.filter((arg) => arg.startsWith('--bundle='))).toEqual([
      `--bundle=${explicitBundle}`,
    ]);
    expect(args.filter((arg) => arg.startsWith('--managed-baseline='))).toEqual([
      `--managed-baseline=${explicitBaseline}`,
    ]);
  });
});
