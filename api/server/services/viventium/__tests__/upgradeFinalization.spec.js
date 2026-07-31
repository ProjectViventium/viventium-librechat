const fs = require('fs');
const os = require('os');
const path = require('path');

const { REQUIRED_STAGES, createUpgradeFinalization } = require('../upgradeFinalization');

describe('Viventium post-commit API finalization', () => {
  let tempRoot;
  let supportDir;
  let env;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-finalization-'));
    supportDir = path.join(tempRoot, 'support');
    fs.mkdirSync(supportDir, { mode: 0o700 });
    env = {
      VIVENTIUM_APP_SUPPORT_DIR: supportDir,
      VIVENTIUM_POSTCOMMIT_FINALIZATION_ID: 'a'.repeat(64),
      VIVENTIUM_POSTCOMMIT_SOURCE_ID: 'b'.repeat(40),
    };
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('writes an owner-only complete receipt and gates traffic until ready', () => {
    const finalization = createUpgradeFinalization({ env });
    const pendingResponse = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      json: jest.fn(),
    };
    const pendingNext = jest.fn();

    expect(finalization.isArmed()).toBe(true);
    expect(finalization.isReady()).toBe(false);
    finalization.health({}, pendingResponse);
    finalization.requireReady({}, pendingResponse, pendingNext);
    expect(pendingResponse.status).toHaveBeenCalledWith(503);
    expect(pendingResponse.send).toHaveBeenCalledWith('STARTING');
    expect(pendingResponse.json).toHaveBeenCalledWith({
      code: 'viventium_postcommit_finalization_pending',
      status: 'starting',
    });
    expect(pendingNext).not.toHaveBeenCalled();
    expect(finalization.beginAttempt()).toBe(1);

    for (const stage of REQUIRED_STAGES) {
      finalization.recordCompleted(stage);
    }
    finalization.markReady();

    const receiptPath = path.join(
      supportDir,
      'state',
      'continuity',
      'postcommit-api-finalization.json',
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runId: env.VIVENTIUM_POSTCOMMIT_FINALIZATION_ID,
      sourceId: env.VIVENTIUM_POSTCOMMIT_SOURCE_ID,
      status: 'ready',
      stage: 'ready',
      attempt: 1,
      completed: REQUIRED_STAGES,
      degraded: [
        {
          stage: 'derived-search-index',
          code: 'best-effort-derived-state',
        },
      ],
    });
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(supportDir, 'state')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(supportDir, 'state', 'continuity')).mode & 0o777).toBe(0o700);
    expect(finalization.isReady()).toBe(true);

    const readyResponse = {
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const readyNext = jest.fn();
    finalization.health({}, readyResponse);
    finalization.requireReady({}, readyResponse, readyNext);
    expect(readyResponse.status).toHaveBeenCalledWith(200);
    expect(readyResponse.send).toHaveBeenCalledWith('OK');
    expect(readyNext).toHaveBeenCalledTimes(1);
  });

  test('same-run retry increments the durable attempt and converges', () => {
    const first = createUpgradeFinalization({ env });
    expect(first.beginAttempt()).toBe(1);
    first.recordCompleted(REQUIRED_STAGES[0]);
    first.markFailed(new Error('/private/path and secret details must not persist'));

    const second = createUpgradeFinalization({ env });
    expect(second.beginAttempt()).toBe(2);
    for (const stage of REQUIRED_STAGES) {
      second.recordCompleted(stage);
    }
    second.markReady();

    const receipt = JSON.parse(
      fs.readFileSync(
        path.join(supportDir, 'state', 'continuity', 'postcommit-api-finalization.json'),
        'utf8',
      ),
    );
    expect(receipt.attempt).toBe(2);
    expect(receipt.status).toBe('ready');
    expect(JSON.stringify(receipt)).not.toContain('/private/path');
    expect(JSON.stringify(receipt)).not.toContain('secret details');
  });

  test('refuses unsafe receipt symlinks instead of following them', () => {
    const continuityDir = path.join(supportDir, 'state', 'continuity');
    fs.mkdirSync(continuityDir, { recursive: true, mode: 0o700 });
    const outside = path.join(tempRoot, 'outside.json');
    fs.writeFileSync(outside, 'sentinel\n', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(continuityDir, 'postcommit-api-finalization.json'));

    const finalization = createUpgradeFinalization({ env });
    expect(() => finalization.beginAttempt()).toThrow(/unsafe/i);
    expect(fs.readFileSync(outside, 'utf8')).toBe('sentinel\n');
  });

  test('refuses a broken receipt symlink instead of replacing it', () => {
    const continuityDir = path.join(supportDir, 'state', 'continuity');
    fs.mkdirSync(continuityDir, { recursive: true, mode: 0o700 });
    const receiptPath = path.join(continuityDir, 'postcommit-api-finalization.json');
    fs.symlinkSync(path.join(tempRoot, 'missing.json'), receiptPath);

    const finalization = createUpgradeFinalization({ env });
    expect(() => finalization.beginAttempt()).toThrow(/unsafe/i);
    expect(fs.lstatSync(receiptPath).isSymbolicLink()).toBe(true);
  });

  test('refuses a non-private receipt directory', () => {
    const stateDir = path.join(supportDir, 'state');
    fs.mkdirSync(stateDir, { mode: 0o755 });

    const finalization = createUpgradeFinalization({ env });
    expect(() => finalization.beginAttempt()).toThrow(/unsafe/i);
    expect(fs.statSync(stateDir).mode & 0o777).toBe(0o755);
  });

  test('fails closed on incomplete identity and never arms ordinary startup', () => {
    expect(() =>
      createUpgradeFinalization({
        env: {
          VIVENTIUM_APP_SUPPORT_DIR: supportDir,
          VIVENTIUM_POSTCOMMIT_FINALIZATION_ID: 'a'.repeat(64),
        },
      }),
    ).toThrow(/identity/i);

    const ordinary = createUpgradeFinalization({ env: {} });
    expect(ordinary.isArmed()).toBe(false);
    expect(ordinary.beginAttempt()).toBe(0);
    expect(ordinary.isReady()).toBe(true);
  });

  test('quiesced validation blocks ordinary routes without creating a receipt', () => {
    const finalization = createUpgradeFinalization({
      env: { VIVENTIUM_QUIESCED_API_STARTUP: '1' },
    });
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    finalization.requireReady({}, response, next);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      code: 'viventium_startup_quiesced',
      status: 'starting',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
