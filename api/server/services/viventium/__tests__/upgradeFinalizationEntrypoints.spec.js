const fs = require('fs');
const path = require('path');

describe('Viventium API finalization entrypoint contracts', () => {
  const serverRoot = path.resolve(__dirname, '..', '..', '..');
  const standardSource = fs.readFileSync(path.join(serverRoot, 'index.js'), 'utf8');
  const clusteredSource = fs.readFileSync(path.join(serverRoot, 'experimental.js'), 'utf8');

  test.each([
    ['standard', standardSource],
    ['clustered', clusteredSource],
  ])('%s startup exits directly only for an armed finalization failure', (_label, source) => {
    expect(source).toContain('if (!upgradeFinalization.isArmed()) {');
    expect(source).toContain('throw startupError;');
  });

  test('clustered startup elects one receipt writer and backs off replacement failures', () => {
    expect(clusteredSource).toContain('VIVENTIUM_POSTCOMMIT_RECEIPT_WRITER');
    expect(clusteredSource).toContain('receiptWriter: i === 0');
    expect(clusteredSource).toContain('finalizationReceiptWriterId');
    expect(clusteredSource).toContain('consecutiveStartupFailures');
    expect(clusteredSource).toContain('restartDelayMs');
    expect(clusteredSource).toContain('setTimeout(() => {');
  });
});
