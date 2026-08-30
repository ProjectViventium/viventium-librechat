const fs = require('fs');
const path = require('path');

describe('Viventium API finalization entrypoint contracts', () => {
  const serverRoot = path.resolve(__dirname, '..', '..', '..');
  const standardSource = fs.readFileSync(path.join(serverRoot, 'index.js'), 'utf8');
  const clusteredSource = fs.readFileSync(path.join(serverRoot, 'experimental.js'), 'utf8');

  test('standard startup preserves ordinary unarmed rejection behavior', () => {
    expect(standardSource).toContain('if (!upgradeFinalization.isArmed()) {');
    expect(standardSource).toContain('throw startupError;');
  });

  test('clustered outer startup failures always terminate the failed worker', () => {
    const outerCatchStart = clusteredSource.indexOf('startServer().catch((err) => {');
    const outerCatchEnd = clusteredSource.indexOf(
      '/** Export app for testing purposes',
      outerCatchStart,
    );
    const outerCatch = clusteredSource.slice(outerCatchStart, outerCatchEnd);

    expect(outerCatchStart).toBeGreaterThanOrEqual(0);
    expect(outerCatchEnd).toBeGreaterThan(outerCatchStart);
    expect(outerCatch).toContain('if (upgradeFinalization.isArmed()) {');
    expect(outerCatch).toContain('upgradeFinalization.markFailed(err);');
    expect(outerCatch).toContain('process.exit(1);');
    expect(outerCatch).not.toContain('if (!upgradeFinalization.isArmed()) {');
    expect(clusteredSource).toContain(
      'if (!upgradeFinalization.isArmed()) {\n          throw startupError;',
    );
  });

  test('clustered startup elects one receipt writer and backs off replacement failures', () => {
    expect(clusteredSource).toContain('VIVENTIUM_POSTCOMMIT_RECEIPT_WRITER');
    expect(clusteredSource).toContain('receiptWriter: i === 0');
    expect(clusteredSource).toContain('finalizationReceiptWriterId');
    expect(clusteredSource).toContain('consecutiveStartupFailures');
    expect(clusteredSource).toContain('restartDelayMs');
    expect(clusteredSource).toContain('setTimeout(() => {');
  });

  test.each([
    ['standard', standardSource],
    ['clustered', clusteredSource],
  ])('%s startup initializes stream persistence before opening traffic', (_name, source) => {
    const admissionFactory = source.indexOf('const admitTraffic = () => app.listen(');
    const admissionHelper = source.indexOf('await initializeStreamServicesBeforeTraffic({');

    expect(source).toContain('initializeStreamServicesBeforeTraffic,');
    expect(admissionFactory).toBeGreaterThanOrEqual(0);
    expect(admissionHelper).toBeGreaterThan(admissionFactory);
    expect(source.match(/app\.listen\(/g)).toHaveLength(1);
    expect(source).not.toContain('GenerationJobManager.initialize();');
  });
});
