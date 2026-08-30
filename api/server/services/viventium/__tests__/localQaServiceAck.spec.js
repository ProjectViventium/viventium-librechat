/* === VIVENTIUM START ===
 * Feature: Fail-closed local-QA service startup acknowledgement.
 * === VIVENTIUM END === */

const { EventEmitter } = require('events');

const {
  acknowledgeLocalQaServiceStartup,
  registerLocalQaServiceAck,
} = require('../localQaServiceAck');

const SAFE_FAILURE_MARKER = '[VIVENTIUM][local-qa-service-ack] acknowledgement_failed';

const createOptions = (overrides = {}) => {
  const fileSystem = {
    constants: { X_OK: 1 },
    lstatSync: jest.fn(() => ({ isFile: () => true, isSymbolicLink: () => false })),
    realpathSync: jest.fn(() => '/qa/bin/service-ack'),
    statSync: jest.fn(() => ({ isFile: () => true })),
    accessSync: jest.fn(),
  };
  const spawn = jest.fn(() => ({ status: 0 }));
  const log = { error: jest.fn() };

  return {
    env: {
      VIVENTIUM_LOCAL_QA_CASE_ID: 'PWK-UC-016',
      VIVENTIUM_LOCAL_QA_SESSION_REF: 'qa_session_1',
      VIVENTIUM_LOCAL_QA_CASE_TOKEN: 'synthetic-test-token',
    },
    executable: '/runtime/node',
    fileSystem,
    installedRoot: '/installed',
    log,
    pid: 4242,
    spawn,
    ...overrides,
  };
};

describe('localQaServiceAck', () => {
  test.each([
    {},
    { VIVENTIUM_LOCAL_QA_CASE_ID: 'PWK-UC-016' },
    { VIVENTIUM_LOCAL_QA_SESSION_REF: 'qa_session_1' },
  ])('does nothing unless both local-QA identity fields are set', (env) => {
    const options = createOptions({ env });

    expect(acknowledgeLocalQaServiceStartup(options)).toEqual({ status: 'inactive' });
    expect(options.fileSystem.realpathSync).not.toHaveBeenCalled();
    expect(options.spawn).not.toHaveBeenCalled();
    expect(options.log.error).not.toHaveBeenCalled();
  });

  test.each([
    {
      name: 'non-file helper',
      configure: (options) => {
        options.fileSystem.lstatSync.mockReturnValue({
          isFile: () => false,
          isSymbolicLink: () => false,
        });
      },
    },
    {
      name: 'symbolic-link helper',
      configure: (options) => {
        options.fileSystem.lstatSync.mockReturnValue({
          isFile: () => true,
          isSymbolicLink: () => true,
        });
      },
    },
    {
      name: 'non-executable helper',
      configure: (options) => {
        options.fileSystem.accessSync.mockImplementation(() => {
          throw new Error('not executable');
        });
      },
    },
  ])('rejects an unsafe $name with one safe marker', ({ configure }) => {
    const options = createOptions();
    configure(options);

    expect(acknowledgeLocalQaServiceStartup(options)).toEqual({ status: 'failed' });
    expect(options.spawn).not.toHaveBeenCalled();
    expect(options.log.error).toHaveBeenCalledTimes(1);
    expect(options.log.error).toHaveBeenCalledWith(SAFE_FAILURE_MARKER);
  });

  test('invokes the resolved helper synchronously with the exact contract', () => {
    const options = createOptions();
    options.env.VIVENTIUM_LOCAL_QA_SERVICE_ACK_HELPER = '/untrusted/ambient-helper';

    expect(acknowledgeLocalQaServiceStartup(options)).toEqual({ status: 'acknowledged' });
    expect(options.fileSystem.realpathSync).toHaveBeenCalledWith(
      '/installed/scripts/viventium/local_qa_service_ack.py',
    );
    expect(options.fileSystem.statSync).toHaveBeenCalledWith('/qa/bin/service-ack');
    expect(options.fileSystem.accessSync).toHaveBeenCalledWith('/qa/bin/service-ack', 1);
    expect(options.spawn).toHaveBeenCalledWith(
      '/qa/bin/service-ack',
      [
        'acknowledge',
        '--service-id',
        'librechat-core',
        '--pid',
        '4242',
        '--executable',
        '/runtime/node',
      ],
      {
        env: options.env,
        stdio: 'ignore',
        timeout: 5000,
        windowsHide: true,
      },
    );
    expect(options.log.error).not.toHaveBeenCalled();
  });

  test('keeps startup available when the helper exits nonzero', () => {
    const options = createOptions({ spawn: jest.fn(() => ({ status: 9 })) });

    expect(acknowledgeLocalQaServiceStartup(options)).toEqual({ status: 'failed' });
    expect(options.log.error).toHaveBeenCalledTimes(1);
    expect(options.log.error).toHaveBeenCalledWith(SAFE_FAILURE_MARKER);
  });

  test.each([
    {
      name: 'timeout',
      spawn: () => ({ status: null, error: new Error('synthetic child failure') }),
    },
    {
      name: 'throw',
      spawn: () => {
        throw new Error('synthetic helper failure');
      },
    },
  ])('redacts helper $name failures', ({ spawn }) => {
    const options = createOptions({ spawn: jest.fn(spawn) });

    expect(acknowledgeLocalQaServiceStartup(options)).toEqual({ status: 'failed' });
    expect(options.log.error).toHaveBeenCalledTimes(1);
    expect(options.log.error).toHaveBeenCalledWith(SAFE_FAILURE_MARKER);
  });

  test('runs once only after the server reports that it is listening', () => {
    const server = new EventEmitter();
    server.listening = false;
    const options = createOptions();

    expect(registerLocalQaServiceAck(server, options)).toEqual({ status: 'pending' });
    expect(options.spawn).not.toHaveBeenCalled();

    server.listening = true;
    server.emit('listening');
    server.emit('listening');

    expect(options.spawn).toHaveBeenCalledTimes(1);
  });

  test('does not register a listener for an inactive local-QA session', () => {
    const server = new EventEmitter();
    server.listening = false;
    jest.spyOn(server, 'once');
    const options = createOptions({ env: {} });

    expect(registerLocalQaServiceAck(server, options)).toEqual({ status: 'inactive' });
    expect(server.once).not.toHaveBeenCalled();
    expect(options.spawn).not.toHaveBeenCalled();
  });

  test('runs immediately when registration follows an established listener', () => {
    const server = new EventEmitter();
    server.listening = true;
    const options = createOptions();

    expect(registerLocalQaServiceAck(server, options)).toEqual({ status: 'acknowledged' });
    expect(options.spawn).toHaveBeenCalledTimes(1);
  });
});
