/* === VIVENTIUM START ===
 * Feature: WHOOP owner onboarding command boundary.
 * Purpose: Prove credentials, callback codes, and health exports cross only stdin.
 * === VIVENTIUM END === */

import {
  beginWhoopAuthorization,
  completeWhoopOnboarding,
  configureWhoopClient,
  getWhoopStatus,
  importWhoopEvidence,
  importWhoopExport,
  type HealthCommandRunner,
} from '../whoop';

class FakeRunner implements HealthCommandRunner {
  calls: Array<{ mode: 'run' | 'start'; args: string[]; input?: string | Buffer }> = [];
  output = '{}';

  async run(args: string[], input?: string | Buffer): Promise<string> {
    this.calls.push({ mode: 'run', args, input });
    return this.output;
  }

  async start(args: string[], input?: string | Buffer): Promise<void> {
    this.calls.push({ mode: 'start', args, input });
  }
}

describe('WHOOP health command boundary', () => {
  test('configures the self-managed client through stdin only', async () => {
    const runner = new FakeRunner();
    runner.output = JSON.stringify({
      status: 'configured',
      requested_scopes: [
        'read:cycles',
        'read:recovery',
        'read:sleep',
        'read:workout',
        'read:profile',
        'read:body_measurement',
        'offline',
      ],
    });

    const result = await configureWhoopClient(
      {
        clientId: 'public-client',
        clientSecret: 'private-secret',
        redirectUri: 'viventium://oauth/whoop',
      },
      runner,
    );

    expect(result.status).toBe('configured');
    expect(runner.calls[0].args).toEqual(['whoop', 'configure', '--json-stdin']);
    expect(JSON.parse(String(runner.calls[0].input))).toEqual({
      client_id: 'public-client',
      client_secret: 'private-secret',
      redirect_uri: 'viventium://oauth/whoop',
    });
    expect(JSON.stringify(runner.calls[0].args)).not.toContain('private-secret');
  });

  test('accepts only the official authorization origin from the component', async () => {
    const runner = new FakeRunner();
    runner.output = JSON.stringify({
      status: 'authorization_pending',
      authorization_url: 'https://api.prod.whoop.com/oauth/oauth2/auth?client_id=x&state=Abc123Xy',
    });

    const result = await beginWhoopAuthorization(runner);
    expect(result.authorizationUrl).toContain('api.prod.whoop.com/oauth/oauth2/auth');
    expect(runner.calls[0].args).toEqual(['whoop', 'connect', '--json']);

    runner.output = JSON.stringify({
      status: 'authorization_pending',
      authorization_url: 'https://attacker.example/collect',
    });
    await expect(beginWhoopAuthorization(runner)).rejects.toMatchObject({
      code: 'invalid_component_response',
    });
  });

  test('starts all-history onboarding with the callback in stdin and no secret-bearing args', async () => {
    const runner = new FakeRunner();
    const callback = 'viventium://oauth/whoop?code=private-code&state=Abc123Xy';

    await completeWhoopOnboarding(callback, runner);

    expect(runner.calls[0]).toEqual({
      mode: 'start',
      args: ['whoop', 'onboard', '--callback-stdin'],
      input: `${callback}\n`,
    });
    expect(JSON.stringify(runner.calls[0].args)).not.toContain('private-code');
  });

  test('streams the exact bounded export through stdin and strips archive identifiers', async () => {
    const runner = new FakeRunner();
    const bundle = Buffer.from('PK\u0003\u0004synthetic');
    runner.output = JSON.stringify({
      run_id: 'private-run-id',
      status: 'complete',
      record_count: 6,
      file_count: 5,
      resource_file_counts: { journal_entries: 1, sleeps: 1 },
    });

    const result = await importWhoopExport(bundle, runner);

    expect(runner.calls[0]).toEqual({
      mode: 'run',
      args: ['import', 'whoop-export', '--stdin'],
      input: bundle,
    });
    expect(result).toEqual({
      status: 'complete',
      recordCount: 6,
      fileCount: 5,
      resourceFileCounts: { journal_entries: 1, sleeps: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('private-run-id');
  });

  test('reports an exact duplicate export as already imported without leaking identifiers', async () => {
    const runner = new FakeRunner();
    const bundle = Buffer.from('PK\u0003\u0004synthetic');
    runner.output = JSON.stringify({
      run_id: 'private-existing-run-id',
      status: 'already_imported',
      record_count: 5,
      file_count: 4,
      resource_file_counts: { journal_entries: 1, sleeps: 1 },
    });

    const result = await importWhoopExport(bundle, runner);

    expect(result.status).toBe('already_imported');
    expect(JSON.stringify(result)).not.toContain('private-existing-run-id');
  });

  test('streams bounded image evidence through stdin without a file name or archive identifier', async () => {
    const runner = new FakeRunner();
    const screenshot = Buffer.from('\x89PNG\r\n\x1a\nsynthetic');
    runner.output = JSON.stringify({
      run_id: 'private-evidence-run',
      status: 'complete',
      record_count: 1,
      item_count: 1,
    });

    const result = await importWhoopEvidence(screenshot, 'image/png', runner);

    expect(runner.calls[0]).toEqual({
      mode: 'run',
      args: ['import', 'whoop-evidence', '--stdin', '--media-type', 'image/png'],
      input: screenshot,
    });
    expect(result).toEqual({ status: 'complete', recordCount: 1, itemCount: 1 });
    expect(JSON.stringify(result)).not.toContain('private-evidence-run');
  });

  test('returns only the approved status shape', async () => {
    const runner = new FakeRunner();
    runner.output = JSON.stringify({
      schema_version: 1,
      provider: 'whoop',
      state: 'setup_required',
      client_configured: false,
      authorized: false,
      authorization_recovery_required: true,
      requested_scopes: [],
      granted_scopes: [],
      coverage: { api: {}, export: {} },
      latest_api_run: null,
      latest_export_run: null,
      manual_evidence: { item_count: 2, latest_at: '2026-08-10T12:00:00Z' },
      schedule: { state: 'not_configured', configured: false, loaded: false },
      onboarding: null,
      limitations: {
        stress_monitor: 'manual_evidence_only',
        api_export_boundary: 'official_sources_only',
      },
      injected_private_field: '/private/path',
    });

    const result = await getWhoopStatus(runner);

    expect(result.state).toBe('setup_required');
    expect(result.authorizationRecoveryRequired).toBe(true);
    expect(result.manualEvidence).toEqual({ itemCount: 2, latestAt: '2026-08-10T12:00:00Z' });
    expect(JSON.stringify(result)).not.toContain('injected_private_field');
    expect(JSON.stringify(result)).not.toContain('/private/path');
  });
});
