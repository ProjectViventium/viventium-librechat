import { resolveSelectedHistoryAttachments } from './selectedHistoryAttachments';

const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const earlier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const audio = '11111111-1111-4111-8111-111111111111';
const document = '22222222-2222-4222-8222-222222222222';
const sibling = '33333333-3333-4333-8333-333333333333';
const scope = { userId: 'owner', conversationId, parentMessageId: parent };
const file = (file_id: string) => ({
  file_id,
  filename: 'attachment',
  type: 'audio/mp4',
  bytes: 4,
  source: 'local',
});

test('uses selected history and current owner File rows, excluding siblings, malformed IDs and deleted files', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([
      { messageId: parent, parentMessageId: earlier, files: [{ file_id: audio }] },
      {
        messageId: earlier,
        files: [{ file_id: document }, { file_id: 'recall' }, { file_id: audio }],
      },
      { messageId: 'other-branch', files: [{ file_id: sibling }] },
    ]),
    getFiles: jest.fn().mockResolvedValue([file(audio)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio)]);
  expect(db.getMessages).toHaveBeenCalledWith(
    { user: 'owner', conversationId },
    'messageId parentMessageId files attachments',
  );
  expect(db.getFiles).toHaveBeenCalledWith(
    { user: 'owner', file_id: { $in: [audio, document] } },
    null,
    'file_id filename type bytes source context text',
  );
});

test.each([{ userId: '' }, { conversationId: 'new' }, { parentMessageId: '/private/file' }])(
  'does not resolve an invalid or absent authority (%p)',
  async (override) => {
    const db = { getMessages: jest.fn(), getFiles: jest.fn() };
    expect(await resolveSelectedHistoryAttachments({ ...scope, ...override }, db)).toEqual([]);
    expect(db.getMessages).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  },
);

test('a foreign conversation or an unselected missing parent grants no file', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: earlier, files: [{ file_id: audio }] }]),
    getFiles: jest.fn(),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([]);
  expect(db.getFiles).not.toHaveBeenCalled();
});

test('a deleted or revoked File stays unavailable on a later resolution', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent, files: [{ file_id: audio }] }]),
    getFiles: jest
      .fn()
      .mockResolvedValueOnce([file(audio)])
      .mockResolvedValueOnce([]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio)]);
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([]);
});

const nativeId = 'native_' + 'a'.repeat(64);
test('retains an owner-owned delivered result from selected assistant ancestry', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([
      { messageId: parent, parentMessageId: earlier },
      { messageId: earlier, attachments: [{ file_id: nativeId }] },
    ]),
    getFiles: jest.fn().mockResolvedValue([file(nativeId)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(nativeId)]);
  expect(db.getFiles).toHaveBeenCalledWith(
    { user: 'owner', file_id: { $in: [nativeId] } },
    null,
    'file_id filename type bytes source context text',
  );
});

test.each([null, {}, 'not-an-array', 42])(
  'ignores malformed Mixed attachment container (%p)',
  async (attachments) => {
    const db = {
      getMessages: jest
        .fn()
        .mockResolvedValue([{ messageId: parent, attachments, files: [{ file_id: audio }] }]),
      getFiles: jest.fn().mockResolvedValue([file(audio)]),
    };
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio)]);
  },
);

test('normalizes nullable and malformed Mixed entries before shared traversal', async () => {
  const db = {
    getMessages: jest
      .fn()
      .mockResolvedValue([
        {
          messageId: parent,
          files: [null, { file_id: audio }, 'invalid'],
          attachments: [
            null,
            {},
            { file_id: 4 },
            [],
            { file_id: nativeId },
            { file_id: '../file' },
          ],
        },
      ]),
    getFiles: jest.fn().mockResolvedValue([file(nativeId), file(audio)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio), file(nativeId)]);
});

test('does not accept another owner result or an unselected sibling result', async () => {
  const foreignId = 'native_' + 'b'.repeat(64);
  const db = {
    getMessages: jest.fn().mockResolvedValue([
      { messageId: parent, attachments: [{ file_id: nativeId }] },
      { messageId: earlier, attachments: [{ file_id: foreignId }] },
    ]),
    getFiles: jest.fn().mockResolvedValue([]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([]);
  expect(db.getFiles.mock.calls[0][0]).toEqual({ user: 'owner', file_id: { $in: [nativeId] } });
});

test('new current File metadata replaces old display metadata and duplicate refs remain once', async () => {
  const current = { ...file(nativeId), filename: 'current.txt', bytes: 19 };
  const db = {
    getMessages: jest
      .fn()
      .mockResolvedValue([
        {
          messageId: parent,
          files: [{ file_id: nativeId }],
          attachments: [{ file_id: nativeId, filename: 'stale.txt', bytes: 18 }],
        },
      ]),
    getFiles: jest.fn().mockResolvedValue([current]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([current]);
});

test('prior native results preserve the existing 64 selected-file bound', async () => {
  const ids = Array.from({ length: 70 }, (_, n) => 'native_' + n.toString(16).padStart(64, '0'));
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent, attachments: ids.map(file) }]),
    getFiles: jest.fn().mockResolvedValue(ids.slice(0, 64).map(file)),
  };
  expect((await resolveSelectedHistoryAttachments(scope, db)).map((row) => row.file_id)).toEqual(
    ids.slice(0, 64),
  );
});

test('owner-selected text attachments retain their stored parsed body for subsequent turns', async () => {
  const body = {
    ...file(document),
    filename: 'note.txt',
    type: 'text/plain',
    source: 'text',
    text: 'Exact stored body.\n',
  };
  const db = {
    getMessages: jest
      .fn()
      .mockResolvedValue([{ messageId: parent, files: [{ file_id: document }] }]),
    getFiles: jest.fn().mockResolvedValue([body]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([body]);
  expect(db.getFiles).toHaveBeenCalledWith(
    { user: 'owner', file_id: { $in: [document] } },
    null,
    'file_id filename type bytes source context text',
  );
});
