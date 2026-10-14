const sharp = require('sharp');
const { Readable } = require('stream');
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  logAxiosError: jest.fn(),
  validateImage: jest.fn().mockResolvedValue({ isValid: true }),
}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { validateImage } = require('@librechat/api');
const { FileSources, VisionModes } = require('librechat-data-provider');
const { encodeAndFormat } = require('./encode');
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="blue"/></svg>',
);
const original = {
  file_id: 'synthetic-file',
  filename: 'drawing.svg',
  type: 'image/svg+xml',
  filepath: '/uploads/synthetic-owner/drawing.svg',
  source: FileSources.local,
  width: 4000,
  height: 3000,
};
const req = (caps = { workspace_binding: true, worker_native_tools: true }) => ({
  body: { imageDetail: 'high' },
  config: {
    endpoints: {
      agents: {
        providerCapabilities: {
          'synthetic-workspace': caps,
        },
      },
    },
  },
});
beforeEach(() => {
  jest.clearAllMocks();
  validateImage.mockResolvedValue({ isValid: true });
  getStrategyFunctions.mockReturnValue({
    prepareImagePayload: jest
      .fn()
      .mockImplementation(async (_req, file) => [file, svg.toString('base64')]),
    getDownloadStream: jest.fn().mockImplementation(async () => Readable.from([svg])),
  });
});
test.each([FileSources.local, FileSources.s3])(
  'native SVG %s uses bounded PNG frame and retains raw file metadata',
  async (source) => {
    const file = { ...original, source };
    const output = await encodeAndFormat(
      req(),
      [file],
      { provider: 'synthetic-workspace', endpoint: 'agents' },
      VisionModes.agents,
    );
    expect(output.files[0]).toEqual(
      expect.objectContaining({
        file_id: file.file_id,
        filepath: file.filepath,
        filename: file.filename,
        type: file.type,
      }),
    );
    const url = output.image_urls[0].image_url.url;
    expect(url).toMatch(/^data:image\/png;base64,/);
    const buffer = Buffer.from(url.split(',')[1], 'base64');
    const metadata = await sharp(buffer).metadata();
    expect(metadata.format).toBe('png');
    expect(Math.min(metadata.width, metadata.height)).toBeLessThanOrEqual(768);
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(2000);
    expect(
      svg.equals(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="3000"><rect width="4000" height="3000" fill="blue"/></svg>',
        ),
      ),
    ).toBe(true);
    expect(validateImage).toHaveBeenCalledWith(buffer, buffer.length, 'agents', undefined);
  },
);
test.each(['workspace_binding', 'worker_native_tools'])(
  'missing %s keeps ordinary frame contract',
  async (missing) => {
    const output = await encodeAndFormat(
      req({ workspace_binding: true, worker_native_tools: true, [missing]: false }),
      [original],
      { provider: 'synthetic-workspace', endpoint: 'agents' },
      VisionModes.agents,
    );
    expect(output.image_urls[0].image_url.url).toBe(
      `data:image/svg+xml;base64,${svg.toString('base64')}`,
    );
  },
);
test('invalid SVG fails instead of inventing a vision frame', async () => {
  getStrategyFunctions.mockReturnValue({
    prepareImagePayload: jest
      .fn()
      .mockResolvedValue([original, Buffer.from('invalid SVG').toString('base64')]),
  });
  await expect(
    encodeAndFormat(
      req(),
      [original],
      { provider: 'synthetic-workspace', endpoint: 'agents' },
      VisionModes.agents,
    ),
  ).rejects.toThrow();
});
test.each(['png', 'jpeg', 'tiff'])(
  'native %s uses bounded PNG vision without changing original file MIME',
  async (format) => {
    const originalBuffer = await sharp({
      create: { width: 3000, height: 2400, channels: 3, background: 'blue' },
    })
      .toFormat(format)
      .toBuffer();
    const file = { ...original, type: `image/${format}`, filename: `drawing.${format}` };
    getStrategyFunctions.mockReturnValue({
      prepareImagePayload: jest.fn().mockResolvedValue([file, originalBuffer.toString('base64')]),
    });
    const output = await encodeAndFormat(
      req(),
      [file],
      { provider: 'synthetic-workspace', endpoint: 'agents' },
      VisionModes.agents,
    );
    expect(output.files[0].type).toBe(file.type);
    const url = output.image_urls[0].image_url.url;
    expect(url).toMatch(/^data:image\/png;base64,/);
    const metadata = await sharp(Buffer.from(url.split(',')[1], 'base64')).metadata();
    expect(metadata.format).toBe('png');
    expect(Math.min(metadata.width, metadata.height)).toBeLessThanOrEqual(768);
    expect(Math.max(metadata.width, metadata.height)).toBeLessThanOrEqual(2000);
  },
);
test('configured image validation failure remains enforced', async () => {
  validateImage.mockResolvedValueOnce({ isValid: false, error: 'configured limit' });
  await expect(
    encodeAndFormat(
      req(),
      [original],
      { provider: 'synthetic-workspace', endpoint: 'agents' },
      VisionModes.agents,
    ),
  ).rejects.toThrow('configured limit');
});

test('normalized provider uses the resolved native capability endpoint for its frame', async () => {
  const output = await encodeAndFormat(
    req(),
    [original],
    { provider: 'openAI', endpoint: 'agents', capabilityEndpoint: 'synthetic-workspace' },
    VisionModes.agents,
  );
  expect(output.image_urls[0].image_url.url).toMatch(/^data:image\/png;base64,/);
  const buffer = Buffer.from(output.image_urls[0].image_url.url.split(',')[1], 'base64');
  expect(buffer.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect((await sharp(buffer).metadata()).format).toBe('png');
  expect(output.files[0].type).toBe(original.type);
  expect(output.files[0].filepath).toBe(original.filepath);
});

test('explicit nonnative provider capabilities take precedence over native endpoint', async () => {
  const request = req();
  request.config.endpoints.agents.providerCapabilities.openAI = {
    workspace_binding: false,
    worker_native_tools: false,
  };
  const output = await encodeAndFormat(
    request,
    [original],
    { provider: 'openAI', endpoint: 'agents', capabilityEndpoint: 'synthetic-workspace' },
    VisionModes.agents,
  );
  expect(output.image_urls[0].image_url.url).toBe(
    'data:image/svg+xml;base64,' + svg.toString('base64'),
  );
});

test.each(['workspace_binding', 'worker_native_tools'])(
  'resolved endpoint still requires strict declared %s',
  async (missing) => {
    const output = await encodeAndFormat(
      req({ workspace_binding: true, worker_native_tools: true, [missing]: 'true' }),
      [original],
      { provider: 'openAI', endpoint: 'agents', capabilityEndpoint: 'synthetic-workspace' },
      VisionModes.agents,
    );
    expect(output.image_urls[0].image_url.url).toBe(
      'data:image/svg+xml;base64,' + svg.toString('base64'),
    );
  },
);

test.each(['main', 'fallback', 'cortex'])(
  'real AgentClient %s image caller retains resolved native endpoint after provider normalization',
  async (role) => {
    const AgentClient = require('~/server/controllers/agents/client');
    const request = req();
    const message = { messageId: 'synthetic-' + role };
    const context = {
      options: {
        req: request,
        endpoint: 'agents',
        agent: {
          id: 'synthetic-' + role,
          provider: 'openAI',
          endpoint: 'synthetic-workspace',
        },
      },
    };
    const files = await AgentClient.prototype.addImageURLs.call(context, message, [original]);
    expect(message.image_urls[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(
      (
        await sharp(
          Buffer.from(message.image_urls[0].image_url.url.split(',')[1], 'base64'),
        ).metadata()
      ).format,
    ).toBe('png');
    expect(files[0]).toEqual(
      expect.objectContaining({
        file_id: original.file_id,
        type: original.type,
        filepath: original.filepath,
        filename: original.filename,
      }),
    );
  },
);

test('request body cannot supply a native capability endpoint to the real caller', async () => {
  const AgentClient = require('~/server/controllers/agents/client');
  const request = req();
  request.body.capabilityEndpoint = 'synthetic-workspace';
  const message = { messageId: 'synthetic-unbound' };
  const context = {
    options: {
      req: request,
      endpoint: 'agents',
      agent: { provider: 'openAI', endpoint: 'ordinary-endpoint' },
    },
  };
  await AgentClient.prototype.addImageURLs.call(context, message, [original]);
  expect(message.image_urls[0].image_url.url).toBe(
    'data:image/svg+xml;base64,' + svg.toString('base64'),
  );
});
