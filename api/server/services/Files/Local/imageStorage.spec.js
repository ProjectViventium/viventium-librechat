/* === VIVENTIUM START: Real-byte coverage for writable image storage in sealed native releases. === */
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const express = require('express');
const request = require('supertest');

jest.mock('axios', () => jest.fn());
jest.mock('@librechat/api', () => ({ deleteRagFile: jest.fn(), isEnabled: () => false }));
jest.mock('~/models', () => ({ updateUser: jest.fn(), updateFile: jest.fn((file) => file) }));
jest.mock('~/server/utils', () => ({
  getBufferMetadata: jest.fn(async (buffer) => ({
    bytes: buffer.length,
    type: 'image/png',
    dimensions: { width: 2, height: 2 },
    extension: 'png',
  })),
}));
jest.mock('~/server/services/Files/images/resize', () => ({
  resizeImageBuffer: jest.fn(async (buffer) => ({ buffer, width: 2, height: 2 })),
}));
jest.mock('@librechat/agents/langchain/tools', () => ({ Tool: class {} }));

let root;
let paths;
let req;
let image;
let crud;
let images;

beforeEach(async () => {
  jest.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-image-storage-'));
  paths = {
    publicPath: path.join(root, 'sealed/public'),
    uploads: path.join(root, 'data/uploads'),
    imageOutput: path.join(root, 'data/uploads/images'),
  };
  fs.mkdirSync(paths.publicPath, { recursive: true });
  fs.chmodSync(paths.publicPath, 0o555);
  jest.doMock('~/config/paths', () => paths);
  req = { user: { id: 'owner' }, config: { paths, imageOutputType: 'png' } };
  image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } })
    .png()
    .toBuffer();
  crud = require('./crud');
  images = require('./images');
});

afterEach(() => {
  fs.chmodSync(paths.publicPath, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

test('buffer save, model read, static HTTP and deletion share one writable root and stable URL', async () => {
  const url = await crud.saveLocalBuffer({
    userId: 'owner',
    buffer: image,
    fileName: 'result.png',
  });
  expect(url).toBe('/images/owner/result.png');
  const [, encoded] = await images.prepareImagesLocal(req, {
    file_id: 'image-file',
    filepath: url,
  });
  expect(Buffer.from(encoded, 'base64')).toEqual(image);
  const app = express();
  app.use('/images', require('~/server/routes/static'));
  const served = await request(app).get(url).expect(200);
  expect(served.body).toEqual(image);
  expect(fs.existsSync(path.join(paths.publicPath, 'images'))).toBe(false);
  await crud.deleteLocalFile(req, { file_id: 'image-file', filepath: url });
  expect(fs.existsSync(path.join(paths.imageOutput, 'owner/result.png'))).toBe(false);
  await request(app).get(url).expect(404);
});

test('uploaded images and avatars use the same root without changing public URLs', async () => {
  const temporary = path.join(root, 'input.png');
  fs.writeFileSync(temporary, image);
  const uploaded = await images.uploadLocalImage({
    req,
    file: { path: temporary },
    file_id: 'upload',
  });
  expect(uploaded.filepath).toBe('/images/owner/upload__input.png');
  expect(fs.readFileSync(path.join(paths.imageOutput, 'owner/upload__input.png'))).toEqual(image);
  const avatar = await images.processLocalAvatar({
    buffer: image,
    userId: 'owner',
    manual: 'true',
  });
  expect(avatar).toMatch(/^\/images\/owner\/avatar-\d+\.png\?manual=true$/);
  const [, encoded] = await images.prepareImagesLocal(req, {
    file_id: 'uploaded-image',
    filepath: uploaded.filepath,
  });
  expect(Buffer.from(encoded, 'base64')).toEqual(image);
  expect(jest.requireMock('~/models').updateUser).toHaveBeenCalledWith('owner', { avatar });
  expect(fs.existsSync(path.join(paths.publicPath, 'images'))).toBe(false);
});

test('downloaded images go to the image root while non-image buffers keep the uploads root', async () => {
  jest.requireMock('axios').mockResolvedValue({ data: image });
  await crud.saveFileFromURL({
    userId: 'owner',
    URL: 'https://images.example.test/image',
    fileName: 'download.jpg',
  });
  expect(fs.readFileSync(path.join(paths.imageOutput, 'owner/download.png'))).toEqual(image);
  const url = await crud.saveLocalBuffer({
    userId: 'owner',
    buffer: Buffer.from('file bytes'),
    fileName: 'note.txt',
    basePath: 'uploads',
  });
  expect(url).toBe('/uploads/owner/note.txt');
  expect(fs.readFileSync(path.join(paths.uploads, 'owner/note.txt'), 'utf8')).toBe('file bytes');
});

test('image reads and deletes reject traversal and sibling-account prefix paths', async () => {
  await crud.saveLocalBuffer({ userId: 'owner-other', buffer: image, fileName: 'private.png' });
  await expect(
    crud.deleteLocalFile(req, {
      file_id: 'other-image',
      filepath: '/images/owner-other/private.png',
    }),
  ).rejects.toThrow('Invalid file path');
  expect(fs.readFileSync(path.join(paths.imageOutput, 'owner-other/private.png'))).toEqual(image);
  await expect(
    images.prepareImagesLocal(req, { file_id: 'escape', filepath: '/images/../../outside.png' }),
  ).rejects.toThrow('Invalid file path');
  await expect(
    images.prepareImagesLocal(req, {
      file_id: 'absolute',
      filepath: path.join(root, 'private.png'),
    }),
  ).rejects.toThrow('Invalid image file path');
});

test('Stable Diffusion markdown is a public image URL independent of the storage directory', () => {
  const StableDiffusion = require('~/app/clients/tools/structured/StableDiffusion');
  expect(
    StableDiffusion.prototype.getMarkdownImageUrl.call(
      { userId: 'owner', relativePath: '../../private-storage' },
      'result.png',
    ),
  ).toBe('![generated image](/images/owner/result.png)');
});
/* === VIVENTIUM END === */
