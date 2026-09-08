/* === VIVENTIUM START === Prove normal startup activates retained-result recovery. === */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test.each([false, true])('launch reconciliation startup respects quiesced=%s', async (quiesced) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../../index.js'), 'utf8');
  const start = source.indexOf('const onServerListening = async (err) => {');
  const end = source.indexOf('const admitTraffic =', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const startRecovery = jest.fn();
  const modules = {
    './services/viventium/channelAdminService': { restoreChannelWorkers: async () => {} },
    './services/viventium/memoryWriterCoordinator': { startMemoryWriterRecovery: jest.fn() },
    './services/viventium/nativeResponseService': { installNativeResponseRecovery: async () => {} },
    './services/viventium/GlassHiveLaunchReconciliationService': {
      startGlassHiveLaunchReconciliation: startRecovery,
    },
    '~/models': {},
  };
  const required = jest.fn((name) => {
    if (!(name in modules)) throw new Error('Unexpected startup module: ' + name);
    return modules[name];
  });
  const context = {
    require: required,
    apiListenTarget: {}, host: '127.0.0.1', port: 3000,
    logger: { info: jest.fn(), error: jest.fn() },
    quiescedApiStartup: quiesced,
    initializeMCPs: async () => {}, initializeOAuthReconnectManager: async () => {},
    checkMigrations: async () => {}, recoverStaleCortexMessages: async () => {},
    getStaleCortexRecoveryIntervalMs: () => 0,
    upgradeFinalization: {
      recordCompleted: jest.fn(), markReady: jest.fn(), isArmed: () => false,
    },
    process: { execArgv: [], env: {}, exit: jest.fn() },
    isEnabled: () => false, memoryDiagnostics: { start: jest.fn() },
  };
  await vm.runInNewContext(source.slice(start, end) + '\nonServerListening();', context);
  expect(startRecovery).toHaveBeenCalledTimes(quiesced ? 0 : 1);
  if (quiesced) expect(required).not.toHaveBeenCalled();
  else expect(context.upgradeFinalization.markReady).toHaveBeenCalledTimes(1);
});
/* === VIVENTIUM END === */
