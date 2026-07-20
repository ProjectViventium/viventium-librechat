import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx']);

type NativeEnvironment = Readonly<Record<string, string | undefined>>;

type NativeHeicRequestBoundary = {
  platform: string;
  environment: NativeEnvironment;
  origin?: string;
  host?: string;
};

export const NATIVE_HEIC_INPUT_LIMIT_BYTES = 20 * 1024 * 1024;
export const NATIVE_HEIC_OUTPUT_LIMIT_BYTES = 50 * 1024 * 1024;
export const NATIVE_HEIC_MAX_DIMENSION = 8192;
export const NATIVE_HEIC_MAX_PIXELS = 40_000_000;
export const NATIVE_HEIC_CONCURRENCY = 2;

type NativeHeicErrorCode =
  'busy' | 'invalid_input' | 'unsafe_runtime' | 'unsupported_dimensions' | 'conversion_failed';

export class NativeHeicError extends Error {
  constructor(
    public readonly code: NativeHeicErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NativeHeicError';
  }
}

type ExecFileResult = { stdout: string; stderr: string };
type ExecFileRunner = (
  executable: string,
  args: readonly string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    env: Readonly<Record<string, string>>;
  },
) => Promise<ExecFileResult>;

type ConverterDependencies = {
  run?: ExecFileRunner;
  getUid?: () => number;
  removeTemporaryDirectory?: (directory: string) => Promise<void>;
};

const runExecFile: ExecFileRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

function dimensionsFromSips(stdout: string): { width: number; height: number } {
  const width = Number(/^\s*pixelWidth:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
  const height = Number(/^\s*pixelHeight:\s*(\d+)\s*$/m.exec(stdout)?.[1]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new NativeHeicError('conversion_failed', 'Image dimensions could not be verified');
  }
  return { width, height };
}

async function assertPrivateDirectory(directory: string, uid: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== uid) {
    throw new NativeHeicError('unsafe_runtime', 'Native conversion directory is not private');
  }
  await fs.chmod(directory, 0o700);
  const after = await fs.lstat(directory);
  if (
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    after.uid !== uid ||
    (after.mode & 0o777) !== 0o700
  ) {
    throw new NativeHeicError('unsafe_runtime', 'Native conversion directory could not be secured');
  }
}

export function createNativeHeicConverter(
  dependencies: ConverterDependencies = {},
): (input: Buffer, appSupportDirectory: string) => Promise<Buffer> {
  const run = dependencies.run ?? runExecFile;
  const getUid = dependencies.getUid ?? process.getuid;
  const removeTemporaryDirectory =
    dependencies.removeTemporaryDirectory ??
    ((directory: string) => fs.rm(directory, { recursive: true, force: true }));
  let activeConversions = 0;

  return async (input: Buffer, appSupportDirectory: string): Promise<Buffer> => {
    if (
      input.length === 0 ||
      input.length > NATIVE_HEIC_INPUT_LIMIT_BYTES ||
      !isHeicContainer(input)
    ) {
      throw new NativeHeicError('invalid_input', 'Input is not a supported HEIC/HEIF container');
    }
    if (
      !path.isAbsolute(appSupportDirectory) ||
      appSupportDirectory !== appSupportDirectory.trim()
    ) {
      throw new NativeHeicError('unsafe_runtime', 'Native runtime directory is invalid');
    }
    if (activeConversions >= NATIVE_HEIC_CONCURRENCY) {
      throw new NativeHeicError('busy', 'Native HEIC conversion is busy');
    }

    activeConversions += 1;
    let temporaryDirectory: string | undefined;
    let conversionResult: Buffer | undefined;
    let conversionError: NativeHeicError | undefined;
    try {
      if (typeof getUid !== 'function') {
        throw new NativeHeicError('unsafe_runtime', 'Native runtime ownership cannot be verified');
      }
      const uid = getUid();
      const temporaryRoot = path.join(appSupportDirectory, 'runtime', 'heic-tmp');
      await assertPrivateDirectory(temporaryRoot, uid);
      temporaryDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'conversion-'));
      await fs.chmod(temporaryDirectory, 0o700);

      const inputPath = path.join(temporaryDirectory, 'input.heic');
      const outputPath = path.join(temporaryDirectory, 'output.jpg');
      await fs.writeFile(inputPath, input, { flag: 'wx', mode: 0o600 });
      await fs.writeFile(outputPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });

      const childOptions = {
        timeout: 15_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      } as const;
      const dimensions = dimensionsFromSips(
        (
          await run(
            '/usr/bin/sips',
            ['-g', 'pixelWidth', '-g', 'pixelHeight', inputPath],
            childOptions,
          )
        ).stdout,
      );
      if (
        dimensions.width > NATIVE_HEIC_MAX_DIMENSION ||
        dimensions.height > NATIVE_HEIC_MAX_DIMENSION ||
        dimensions.width * dimensions.height > NATIVE_HEIC_MAX_PIXELS
      ) {
        throw new NativeHeicError('unsupported_dimensions', 'Image dimensions exceed safe limits');
      }

      await run(
        '/usr/bin/sips',
        ['-s', 'format', 'jpeg', inputPath, '--out', outputPath],
        childOptions,
      );
      let outputStat = await fs.lstat(outputPath);
      if (
        outputStat.isSymbolicLink() ||
        !outputStat.isFile() ||
        outputStat.uid !== uid ||
        outputStat.size === 0 ||
        outputStat.size > NATIVE_HEIC_OUTPUT_LIMIT_BYTES
      ) {
        throw new NativeHeicError('conversion_failed', 'Converted image failed output validation');
      }
      await fs.chmod(outputPath, 0o600);
      outputStat = await fs.lstat(outputPath);
      if (
        outputStat.isSymbolicLink() ||
        !outputStat.isFile() ||
        outputStat.uid !== uid ||
        (outputStat.mode & 0o777) !== 0o600
      ) {
        throw new NativeHeicError(
          'conversion_failed',
          'Converted image permissions failed validation',
        );
      }
      const output = await fs.readFile(outputPath);
      if (output.length < 3 || output[0] !== 0xff || output[1] !== 0xd8 || output[2] !== 0xff) {
        throw new NativeHeicError('conversion_failed', 'Converted image is not a JPEG');
      }
      const outputDimensions = dimensionsFromSips(
        (
          await run(
            '/usr/bin/sips',
            ['-g', 'pixelWidth', '-g', 'pixelHeight', outputPath],
            childOptions,
          )
        ).stdout,
      );
      if (
        outputDimensions.width !== dimensions.width ||
        outputDimensions.height !== dimensions.height ||
        outputDimensions.width > NATIVE_HEIC_MAX_DIMENSION ||
        outputDimensions.height > NATIVE_HEIC_MAX_DIMENSION ||
        outputDimensions.width * outputDimensions.height > NATIVE_HEIC_MAX_PIXELS
      ) {
        throw new NativeHeicError(
          'conversion_failed',
          'Converted image dimensions failed validation',
        );
      }
      conversionResult = output;
    } catch (error) {
      conversionError =
        error instanceof NativeHeicError
          ? error
          : new NativeHeicError('conversion_failed', 'Native HEIC conversion failed');
    }

    let cleanupFailed = false;
    try {
      if (temporaryDirectory) {
        await removeTemporaryDirectory(temporaryDirectory);
      }
    } catch {
      cleanupFailed = true;
    } finally {
      activeConversions -= 1;
    }

    if (cleanupFailed) {
      throw new NativeHeicError(
        'unsafe_runtime',
        'Temporary conversion files could not be removed',
      );
    }
    if (conversionError) {
      throw conversionError;
    }
    if (!conversionResult) {
      throw new NativeHeicError('conversion_failed', 'Native HEIC conversion produced no output');
    }
    return conversionResult;
  };
}

export const convertHeicWithSips = createNativeHeicConverter();

async function isNativeSocketSecure(
  environment: NativeEnvironment,
  getUid: (() => number) | undefined = process.getuid,
): Promise<boolean> {
  const socketPath = environment.VIVENTIUM_NATIVE_API_SOCKET;
  if (!socketPath || typeof getUid !== 'function') {
    return false;
  }
  try {
    const socket = await fs.lstat(socketPath);
    return (
      !socket.isSymbolicLink() &&
      socket.isSocket() &&
      socket.uid === getUid() &&
      (socket.mode & 0o777) === 0o600
    );
  } catch {
    return false;
  }
}

type NativeHeicRequest = Request & { file?: Express.Multer.File };
type NativeHeicHandlerDependencies = {
  platform?: string;
  environment?: NativeEnvironment;
  verifySocket?: (environment: NativeEnvironment) => Promise<boolean>;
  convert?: (input: Buffer, appSupportDirectory: string) => Promise<Buffer>;
};

export function createNativeHeicHandler(dependencies: NativeHeicHandlerDependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? process.env;
  const verifySocket = dependencies.verifySocket ?? isNativeSocketSecure;
  const convert = dependencies.convert ?? convertHeicWithSips;

  return async (request: NativeHeicRequest, response: Response): Promise<void> => {
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const host = typeof request.headers.host === 'string' ? request.headers.host : undefined;
    if (
      !isNativeHeicRequestAllowed({ platform, environment, origin, host }) ||
      !(await verifySocket(environment))
    ) {
      response.status(403).json({ code: 'native_heic_unavailable' });
      return;
    }

    const file = request.file;
    if (
      !file ||
      !Buffer.isBuffer(file.buffer) ||
      file.size !== file.buffer.length ||
      file.size > NATIVE_HEIC_INPUT_LIMIT_BYTES ||
      !['image/heic', 'image/heif'].includes(file.mimetype.toLowerCase()) ||
      !isHeicContainer(file.buffer)
    ) {
      response.status(400).json({ code: 'invalid_heic' });
      return;
    }

    try {
      const output = await convert(file.buffer, environment.VIVENTIUM_APP_SUPPORT_DIR as string);
      response.set({
        'Cache-Control': 'no-store',
        'Content-Disposition': 'attachment; filename="converted.jpg"',
        'Content-Length': String(output.length),
        'Content-Type': 'image/jpeg',
        'X-Content-Type-Options': 'nosniff',
      });
      response.status(200).send(output);
    } catch (error) {
      const code = error instanceof NativeHeicError ? error.code : 'conversion_failed';
      const status = code === 'busy' || code === 'unsafe_runtime' ? 503 : 422;
      response.status(status).json({ code: `native_heic_${code}` });
    }
  };
}

export function isHeicContainer(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') {
    return false;
  }

  const boxSize = buffer.readUInt32BE(0);
  if (boxSize < 16 || boxSize > buffer.length || boxSize % 4 !== 0) {
    return false;
  }

  for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
    if (offset === 12) {
      continue;
    }
    if (HEIC_BRANDS.has(buffer.toString('ascii', offset, offset + 4))) {
      return true;
    }
  }
  return false;
}

export function isNativeHeicRequestAllowed({
  platform,
  environment,
  origin,
  host,
}: NativeHeicRequestBoundary): boolean {
  if (
    platform !== 'darwin' ||
    environment.VIVENTIUM_INSTALL_MODE !== 'native' ||
    environment.VIVENTIUM_RUNTIME_PROFILE !== 'native'
  ) {
    return false;
  }

  const appSupport = environment.VIVENTIUM_APP_SUPPORT_DIR;
  const socketPath = environment.VIVENTIUM_NATIVE_API_SOCKET;
  const proxyPort = environment.VIVENTIUM_NATIVE_PROXY_LISTEN_PORT;
  if (
    !appSupport ||
    !socketPath ||
    !path.isAbsolute(appSupport) ||
    !path.isAbsolute(socketPath) ||
    appSupport !== appSupport.trim() ||
    socketPath !== socketPath.trim() ||
    socketPath !== path.join(appSupport, 'runtime', 'librechat-api.sock') ||
    proxyPort !== '3190'
  ) {
    return false;
  }

  const expectedAuthority = `127.0.0.1:${proxyPort}`;
  return origin === `http://${expectedAuthority}` && host === expectedAuthority;
}
