/* === VIVENTIUM START === Downloads preserve the authorized stored representation. === */
const express = require('express');
const request = require('supertest');
const { Readable } = require('stream');
const { FileSources } = require('librechat-data-provider');

jest.mock('@librechat/agents', () => ({ EnvVar: {} }));
jest.mock('~/server/services/Files/process', () => ({}));
jest.mock('~/server/services/Files/strategies', () => ({ getStrategyFunctions: jest.fn() }));
jest.mock('~/server/controllers/assistants/helpers', () => ({ getOpenAIClient: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({
  getEffectivePermissions: jest.fn(),
  checkPermission: jest.fn(),
}));
jest.mock('~/server/services/Tools/credentials', () => ({ loadAuthValues: jest.fn() }));
jest.mock('~/server/services/Files/S3/crud', () => ({ refreshS3FileUrls: jest.fn() }));
jest.mock('~/server/services/Files', () => ({ hasAccessToFilesViaAgent: jest.fn() }));
jest.mock('~/models', () => ({ getFiles: jest.fn(), batchUpdateFiles: jest.fn() }));
jest.mock('~/models/Assistant', () => ({ getAssistant: jest.fn() }));
jest.mock('~/models/Agent', () => ({ getAgent: jest.fn(), getAgents: jest.fn() }));
jest.mock('~/cache', () => ({ getLogStores: jest.fn() }));

const { getFiles } = require('~/models');
const { getAgents } = require('~/models/Agent');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const router = require('./files');
let stored, actor;
const app = express();
app.use((req, res, next) => {
  req.user = actor;
  next();
});
app.use('/files', router);

beforeEach(() => {
  actor = { id: 'owner', role: 'user' };
  stored = {
    user: 'owner',
    file_id: 'file',
    source: FileSources.text,
    filename: 'report.pdf',
    filepath: '/removed/upload/report.pdf',
    text: '  café\nline two\n',
  };
  getFiles.mockImplementation(async (filter, sort, projection) => {
    if (Object.entries(filter).some(([key, value]) => stored[key] !== value)) return [];
    if (projection?.text === 1) return [{ text: stored.text }];
    const { text: _text, ...metadata } = stored;
    return [metadata];
  });
  getAgents.mockResolvedValue([]);
  getStrategyFunctions.mockReturnValue({
    getDownloadStream: jest.fn(async () => Readable.from(['raw stored bytes'])),
  });
});

test('extracted text downloads exact stored bytes under a text filename, without the expired original', async () => {
  const response = await request(app).get('/files/download/owner/file');
  expect(response.status).toBe(200);
  expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
  expect(response.headers['content-disposition']).toBe('attachment; filename="report.pdf.txt"');
  expect(response.text).toBe(stored.text);
  expect(JSON.parse(response.headers['x-file-metadata'])).not.toHaveProperty('text');
  expect(getFiles).toHaveBeenLastCalledWith(
    { file_id: 'file', user: 'owner', source: FileSources.text },
    undefined,
    { text: 1 },
  );
  expect(getStrategyFunctions).not.toHaveBeenCalled();
});

test('empty extracted text remains a valid zero-byte download', async () => {
  stored.text = '';
  stored.filename = 'empty.TXT';
  const response = await request(app).get('/files/download/owner/file');
  expect(response.status).toBe(200);
  expect(response.text).toBe('');
  expect(response.headers['content-disposition']).toBe('attachment; filename="empty.TXT"');
  expect(getStrategyFunctions).not.toHaveBeenCalled();
});

test.each([undefined, null])(
  'missing extracted text (%s) returns unavailable without filesystem fallback',
  async (text) => {
    stored.text = text;
    const response = await request(app).get('/files/download/owner/file');
    expect(response.status).toBe(404);
    expect(getStrategyFunctions).not.toHaveBeenCalled();
  },
);

test('a foreign requester cannot fetch text by naming the owner in the URL', async () => {
  actor = { id: 'foreign', role: 'user' };
  const response = await request(app).get('/files/download/owner/file');
  expect(response.status).toBe(403);
  expect(getFiles).toHaveBeenCalledTimes(1);
  expect(getStrategyFunctions).not.toHaveBeenCalled();
});

test('missing authentication does not expose stored text', async () => {
  actor = undefined;
  const response = await request(app).get('/files/download/owner/file');
  expect(response.status).toBe(401);
  expect(getFiles).not.toHaveBeenCalled();
});

test('ordinary local files retain the existing stream and filename', async () => {
  stored.source = FileSources.local;
  stored.filename = 'input.wav';
  const response = await request(app).get('/files/download/owner/file');
  expect(response.status).toBe(200);
  expect(response.headers['content-disposition']).toBe('attachment; filename="input.wav"');
  expect(response.body.toString()).toBe('raw stored bytes');
  expect(getFiles).toHaveBeenCalledTimes(1);
  expect(getStrategyFunctions).toHaveBeenCalledWith(FileSources.local);
});
/* === VIVENTIUM END === */
