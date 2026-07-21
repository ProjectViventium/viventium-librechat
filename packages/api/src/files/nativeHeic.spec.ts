import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createNativeHeicHandler,
  createNativeHeicConverter,
  isHeicContainer,
  isNativeHeicRequestAllowed,
  NativeHeicError,
  scavengeNativeHeicTemporaryFiles,
} from './nativeHeic';
import type { Request, Response } from 'express';

const nativeEnvironment = {
  VIVENTIUM_INSTALL_MODE: 'native',
  VIVENTIUM_RUNTIME_PROFILE: 'native',
  VIVENTIUM_NATIVE_API_SOCKET: '/private/runtime/librechat-api.sock',
  VIVENTIUM_APP_SUPPORT_DIR: '/private',
  VIVENTIUM_NATIVE_PROXY_LISTEN_PORT: '3190',
};

describe('Native HEIC conversion policy', () => {
  test('recognizes HEVC-backed HEIF containers from their ftyp brands', () => {
    const header = Buffer.from(
      '00000024667479706d736631000000006d73663168657663686569636d69663169736f38',
      'hex',
    );

    expect(isHeicContainer(header)).toBe(true);
  });

  test('rejects AVIF and truncated containers', () => {
    const avif = Buffer.from('00000018667479706176696600000000617669666d696631', 'hex');

    expect(isHeicContainer(avif)).toBe(false);
    expect(isHeicContainer(Buffer.from('0000000c66747970', 'hex'))).toBe(false);
  });

  test('allows only the exact local Native runtime origin and host', () => {
    expect(
      isNativeHeicRequestAllowed({
        platform: 'darwin',
        environment: nativeEnvironment,
        origin: 'http://127.0.0.1:3190',
        host: '127.0.0.1:3190',
      }),
    ).toBe(true);
  });

  test.each([
    ['linux', nativeEnvironment, 'http://127.0.0.1:3190', '127.0.0.1:3190'],
    [
      'darwin',
      { ...nativeEnvironment, VIVENTIUM_INSTALL_MODE: 'docker' },
      'http://127.0.0.1:3190',
      '127.0.0.1:3190',
    ],
    [
      'darwin',
      { ...nativeEnvironment, VIVENTIUM_RUNTIME_PROFILE: 'isolated' },
      'http://127.0.0.1:3190',
      '127.0.0.1:3190',
    ],
    [
      'darwin',
      { ...nativeEnvironment, VIVENTIUM_NATIVE_API_SOCKET: '/private/forged/librechat-api.sock' },
      'http://127.0.0.1:3190',
      '127.0.0.1:3190',
    ],
    ['darwin', nativeEnvironment, 'http://localhost:3190', '127.0.0.1:3190'],
    ['darwin', nativeEnvironment, 'http://127.0.0.1:3190', 'localhost:3190'],
  ])(
    'fails closed outside the Native macOS local boundary',
    (platform, environment, origin, host) => {
      expect(
        isNativeHeicRequestAllowed({
          platform,
          environment,
          origin,
          host,
        }),
      ).toBe(false);
    },
  );
});

describe('Native HEIC converter', () => {
  const heic = Buffer.from(
    '00000024667479706d736631000000006d73663168657663686569636d69663169736f38',
    'hex',
  );
  let appSupportDirectory: string;

  beforeEach(async () => {
    appSupportDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-heic-test-'));
  });

  afterEach(async () => {
    await fs.rm(appSupportDirectory, { recursive: true, force: true });
  });

  const fixturePath = process.env.VIVENTIUM_SYNTHETIC_HEIC_FIXTURE;
  if (fixturePath) {
    test('converts a real synthetic HEIC fixture with macOS sips', async () => {
      const input = await fs.readFile(fixturePath as string);
      const result = await createNativeHeicConverter()(input, appSupportDirectory);

      expect(result.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    });
  } else {
    test.skip('requires a synthetic HEIC fixture for the real macOS sips check', () => {
      expect(fixturePath).toBeDefined();
    });
  }

  test('uses only absolute sips with fixed arguments and removes temporary files', async () => {
    const calls: Array<{ executable: string; args: readonly string[] }> = [];
    const convert = createNativeHeicConverter({
      run: async (executable, args) => {
        calls.push({ executable, args });
        if (args[0] === '-g') {
          return { stdout: '  pixelWidth: 1280\n  pixelHeight: 720\n', stderr: '' };
        }
        await fs.writeFile(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return { stdout: '', stderr: '' };
      },
    });

    await expect(convert(heic, appSupportDirectory)).resolves.toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
    expect(calls).toHaveLength(3);
    expect(calls.every(({ executable }) => executable === '/usr/bin/sips')).toBe(true);
    expect(calls[0].args.slice(0, 4)).toEqual(['-g', 'pixelWidth', '-g', 'pixelHeight']);
    expect(calls[1].args.slice(0, 3)).toEqual(['-s', 'format', 'jpeg']);
    expect(calls[2].args.slice(0, 4)).toEqual(['-g', 'pixelWidth', '-g', 'pixelHeight']);
    await expect(
      fs.readdir(path.join(appSupportDirectory, 'runtime', 'heic-tmp')),
    ).resolves.toEqual([]);
  });

  test('rejects unsafe dimensions before conversion and still cleans up', async () => {
    let calls = 0;
    const convert = createNativeHeicConverter({
      run: async () => {
        calls += 1;
        return { stdout: 'pixelWidth: 9000\npixelHeight: 720\n', stderr: '' };
      },
    });

    await expect(convert(heic, appSupportDirectory)).rejects.toMatchObject({
      code: 'unsupported_dimensions',
    });
    expect(calls).toBe(1);
    await expect(
      fs.readdir(path.join(appSupportDirectory, 'runtime', 'heic-tmp')),
    ).resolves.toEqual([]);
  });

  test('retries transient cleanup failures without leaking temporary files', async () => {
    let removalAttempts = 0;
    const convert = createNativeHeicConverter({
      run: async (_executable, args) => {
        if (args[0] === '-g') {
          return { stdout: 'pixelWidth: 2\npixelHeight: 2\n', stderr: '' };
        }
        await fs.writeFile(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return { stdout: '', stderr: '' };
      },
      removeTemporaryDirectory: async (directory) => {
        removalAttempts += 1;
        if (removalAttempts === 1) {
          throw new Error('synthetic cleanup failure');
        }
        await fs.rm(directory, { recursive: true, force: true });
      },
    });

    await expect(convert(heic, appSupportDirectory)).resolves.toEqual(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    );
    expect(removalAttempts).toBe(2);
    await expect(
      fs.readdir(path.join(appSupportDirectory, 'runtime', 'heic-tmp')),
    ).resolves.toEqual([]);
  });

  test('startup scavenging removes a conversion directory abandoned by a crashed process', async () => {
    const temporaryRoot = path.join(appSupportDirectory, 'runtime', 'heic-tmp');
    const abandoned = path.join(temporaryRoot, 'conversion-abandoned');
    await fs.mkdir(abandoned, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(abandoned, 'input.heic'), heic, { mode: 0o600 });

    await scavengeNativeHeicTemporaryFiles(appSupportDirectory, { minimumAgeMs: 0 });

    await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
  });

  test('startup recovery removes files left after all in-process cleanup retries fail', async () => {
    const convert = createNativeHeicConverter({
      run: async (_executable, args) => {
        if (args[0] === '-g') {
          return { stdout: 'pixelWidth: 2\npixelHeight: 2\n', stderr: '' };
        }
        await fs.writeFile(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return { stdout: '', stderr: '' };
      },
      removeTemporaryDirectory: async () => {
        throw new Error('synthetic persistent cleanup failure');
      },
    });

    await expect(convert(heic, appSupportDirectory)).rejects.toMatchObject({
      code: 'unsafe_runtime',
    });
    await scavengeNativeHeicTemporaryFiles(appSupportDirectory, { minimumAgeMs: 0 });

    await expect(
      fs.readdir(path.join(appSupportDirectory, 'runtime', 'heic-tmp')),
    ).resolves.toEqual([]);
  });

  test('fails closed at the bounded startup scan limit instead of traversing arbitrary state', async () => {
    const temporaryRoot = path.join(appSupportDirectory, 'runtime', 'heic-tmp');
    await fs.mkdir(path.join(temporaryRoot, 'conversion-one'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(temporaryRoot, 'conversion-two'), { recursive: true, mode: 0o700 });

    await expect(
      scavengeNativeHeicTemporaryFiles(appSupportDirectory, {
        maxEntries: 1,
        minimumAgeMs: 0,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_runtime' });
  });

  test('bounds concurrent conversion without queueing extra work', async () => {
    let releaseConversions: () => void = () => undefined;
    const conversionGate = new Promise<void>((resolve) => {
      releaseConversions = resolve;
    });
    let signalBothStarted: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => {
      signalBothStarted = resolve;
    });
    let started = 0;
    const convert = createNativeHeicConverter({
      run: async (_executable, args) => {
        if (args[0] === '-g' && args[args.length - 1].endsWith('.heic')) {
          started += 1;
          if (started === 2) {
            signalBothStarted();
          }
          await conversionGate;
          return { stdout: 'pixelWidth: 2\npixelHeight: 2\n', stderr: '' };
        }
        if (args[0] === '-g') {
          return { stdout: 'pixelWidth: 2\npixelHeight: 2\n', stderr: '' };
        }
        await fs.writeFile(args[args.length - 1], Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        return { stdout: '', stderr: '' };
      },
    });

    const first = convert(heic, appSupportDirectory);
    const second = convert(heic, appSupportDirectory);
    await bothStarted;
    await expect(convert(heic, appSupportDirectory)).rejects.toEqual(
      expect.objectContaining<Partial<NativeHeicError>>({ code: 'busy' }),
    );
    releaseConversions();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});

describe('Native HEIC HTTP handler', () => {
  const heic = Buffer.from(
    '00000024667479706d736631000000006d73663168657663686569636d69663169736f38',
    'hex',
  );

  function createResponse() {
    const response = {
      json: jest.fn(),
      send: jest.fn(),
      set: jest.fn(),
      status: jest.fn(),
    };
    response.status.mockReturnValue(response);
    return response;
  }

  function createRequest(overrides: Record<string, unknown> = {}) {
    return {
      headers: { origin: 'http://127.0.0.1:3190', host: '127.0.0.1:3190' },
      file: {
        buffer: heic,
        mimetype: 'image/heic',
        size: heic.length,
      },
      ...overrides,
    };
  }

  test('returns a no-store JPEG only inside the verified Native boundary', async () => {
    const response = createResponse();
    const output = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const handler = createNativeHeicHandler({
      platform: 'darwin',
      environment: nativeEnvironment,
      verifySocket: async () => true,
      convert: async () => output,
    });

    await handler(createRequest() as unknown as Request, response as unknown as Response);

    expect(response.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Cache-Control': 'no-store',
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
      }),
    );
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith(output);
  });

  test.each(['', 'application/octet-stream'])(
    'accepts signature-verified HEIC when upload MIME is %j',
    async (mimetype) => {
      const response = createResponse();
      const output = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      const convert = jest.fn(async () => output);
      const handler = createNativeHeicHandler({
        platform: 'darwin',
        environment: nativeEnvironment,
        verifySocket: async () => true,
        convert,
      });

      await handler(
        createRequest({
          file: { buffer: heic, mimetype, size: heic.length },
        }) as unknown as Request,
        response as unknown as Response,
      );

      expect(convert).toHaveBeenCalledWith(heic, '/private');
      expect(response.status).toHaveBeenCalledWith(200);
      expect(response.send).toHaveBeenCalledWith(output);
    },
  );

  test.each(['', 'application/octet-stream'])(
    'rejects %j uploads without a verified HEIC/HEIF signature',
    async (mimetype) => {
      const response = createResponse();
      const convert = jest.fn();
      const handler = createNativeHeicHandler({
        platform: 'darwin',
        environment: nativeEnvironment,
        verifySocket: async () => true,
        convert,
      });
      const invalid = Buffer.from('not-a-heic-container');

      await handler(
        createRequest({
          file: { buffer: invalid, mimetype, size: invalid.length },
        }) as unknown as Request,
        response as unknown as Response,
      );

      expect(convert).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith({ code: 'invalid_heic' });
    },
  );

  test('does not invoke conversion when the socket or local origin is unverified', async () => {
    const response = createResponse();
    const convert = jest.fn();
    const handler = createNativeHeicHandler({
      platform: 'darwin',
      environment: nativeEnvironment,
      verifySocket: async () => false,
      convert,
    });

    await handler(createRequest() as unknown as Request, response as unknown as Response);

    expect(convert).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ code: 'native_heic_unavailable' });
  });

  test('rejects MIME-spoofed or invalid input before conversion', async () => {
    const response = createResponse();
    const convert = jest.fn();
    const handler = createNativeHeicHandler({
      platform: 'darwin',
      environment: nativeEnvironment,
      verifySocket: async () => true,
      convert,
    });

    await handler(
      createRequest({
        file: { buffer: heic, mimetype: 'image/png', size: heic.length },
      }) as unknown as Request,
      response as unknown as Response,
    );

    expect(convert).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ code: 'invalid_heic' });
  });
});
