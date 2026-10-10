/* === VIVENTIUM START ===
 * Feature: Content-free numeric Voice stage telemetry.
 * Purpose: Exercise the real stage owners through the existing truncated log formatter.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../../../..');
const MESSAGE = Symbol.for('message');
const SPLAT = Symbol.for('splat');

const timingModule = { exports: {} };
vm.runInNewContext(
  fs.readFileSync(path.join(root, 'api/server/services/viventium/voiceLatencyTiming.js'), 'utf8'),
  {
    module: timingModule,
    require: (name) =>
      name === 'perf_hooks' ? { performance: { now: () => 1234.5 } } : require(name),
  },
);
const timing = timingModule.exports;
const parserModule = { exports: {} };
const parserSource = fs.readFileSync(
  path.join(root, 'packages/data-schemas/src/config/parsers.ts'),
  'utf8',
);
vm.runInNewContext(
  ts.transpileModule(parserSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText,
  {
    module: parserModule,
    exports: parserModule.exports,
    require: (name) => (name === 'winston' ? jest.requireActual(name) : require(name)),
    process: { env: { DEBUG_MESSAGE_LENGTH: '180' } },
  },
);
const format = (level, message, metadata) =>
  String(
    parserModule.exports.debugTraverse.transform(
      {
        level,
        message,
        timestamp: '2000-01-01T00:00:00.000Z',
        ...(metadata ? { [SPLAT]: [metadata] } : {}),
      },
      parserModule.exports.debugTraverse.options,
    )[MESSAGE],
  );

const owners = [
  ['route', 'api/server/routes/viventium/voice.js', 'logVoiceRouteStage'],
  ['request', 'api/server/controllers/agents/request.js', 'logVoiceLatencyStage'],
  ['initialize', 'api/server/services/Endpoints/agents/initialize.js', 'logVoiceInitLatencyStage'],
  ['client', 'api/server/controllers/agents/client.js', 'logVoiceLatencyStage'],
  ['callback', 'api/server/controllers/agents/callbacks.js', 'logVoiceLatencyStage'],
];

function stageOwner(file, name, logger) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const start = source.indexOf(`const ${name} = `);
  const end = source.indexOf('\n};', start);
  if (start < 0 || end < 0) throw new Error('Owning stage definition unavailable');
  return vm.runInNewContext(`${source.slice(start, end + 3)}\n${name}`, {
    logger,
    isVoiceLatencyEnabled: (req) => req?.viventiumVoiceLogLatency === true,
    getVoiceLatencyRequestId: (req) => req.viventiumVoiceRequestId || 'unknown',
    hashPrivateDeliveryIdentifierForLog: () => '1'.repeat(64),
    formatVoiceLatencyTiming: timing.formatVoiceLatencyTiming,
    logVoiceLatencyNumericStage: timing.logVoiceLatencyNumericStage,
  });
}

const request = () => ({
  viventiumVoiceLogLatency: true,
  viventiumVoiceRequestId: 'synthetic-request',
  viventiumVoicePerfStartAt: 1000,
  body: { messages: [{ content: 'PUBLIC_CONTENT_MUST_NOT_ENTER_NUMERIC_LOG' }] },
  headers: { authorization: 'SYNTHETIC_AUTH_MUST_NOT_ENTER_NUMERIC_LOG' },
});

it.each(owners)(
  '%s retains numeric clocks after the ordinary info line truncates',
  (owner, file, name) => {
    const logger = { info: jest.fn(), debug: jest.fn() };
    stageOwner(file, name, logger)(request(), 'first_public_delta', 1200, ' detail='.repeat(60));
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toContain('stage=first_public_delta');
    expect(format('info', logger.info.mock.calls[0][0])).toContain('[truncated]');
    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [message, fields] = logger.debug.mock.calls[0];
    expect(fields).toEqual({
      source: owner,
      stage: 'first_public_delta',
      ...(owner === 'client'
        ? { request_sha256: '1'.repeat(64) }
        : { request_id: 'synthetic-request' }),
      total_ms: 235,
      total_ms_f: 234.5,
      stage_ms: 35,
      stage_ms_f: 34.5,
    });
    const actual = format('debug', message, fields);
    expect(actual).not.toContain('[truncated]');
    expect(actual).toContain('"total_ms_f": 234.5');
    expect(actual).toContain('"stage_ms_f": 34.5');
    expect(actual).not.toContain('MUST_NOT_ENTER');
  },
);

it.each(owners)(
  '%s emits neither log when the existing latency flag is off',
  (_owner, file, name) => {
    const logger = { info: jest.fn(), debug: jest.fn() };
    stageOwner(file, name, logger)(
      { ...request(), viventiumVoiceLogLatency: false },
      'unused',
      1200,
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  },
);

it('omits absent clocks instead of manufacturing zero', () => {
  const logger = { debug: jest.fn() };
  timing.logVoiceLatencyNumericStage(
    logger,
    {
      viventiumVoiceLogLatency: true,
      viventiumVoiceRequestId: 'synthetic-request',
    },
    'client',
    'start',
  );
  expect(logger.debug.mock.calls[0][1]).toEqual({
    source: 'client',
    stage: 'start',
    request_id: 'synthetic-request',
  });
});

it('preserves the current formatter behavior for info metadata', () => {
  expect(format('info', '[VoiceLatency][LC]', { stage_ms_f: 34.5 })).not.toContain('34.5');
});
/* === VIVENTIUM END === */
