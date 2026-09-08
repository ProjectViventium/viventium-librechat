import { resolveSelectedHistoryAttachments } from './selectedHistoryAttachments';

const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const earlier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const audio = '11111111-1111-4111-8111-111111111111';
const document = '22222222-2222-4222-8222-222222222222';
const sibling = '33333333-3333-4333-8333-333333333333';
const scope = { userId: 'owner', conversationId, parentMessageId: parent };
const file = (file_id: string) => ({ file_id, filename: 'attachment', type: 'audio/mp4', bytes: 4, source: 'local' });

test('uses selected history and current owner File rows, excluding siblings, malformed IDs and deleted files', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([
      { messageId: parent, parentMessageId: earlier, files: [{ file_id: audio }] },
      { messageId: earlier, files: [{ file_id: document }, { file_id: 'recall' }, { file_id: audio }] },
      { messageId: 'other-branch', files: [{ file_id: sibling }] },
    ]),
    getFiles: jest.fn().mockResolvedValue([file(audio)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio)]);
  expect(db.getMessages).toHaveBeenCalledWith({ user: 'owner', conversationId }, 'messageId parentMessageId files');
  expect(db.getFiles).toHaveBeenCalledWith({ user: 'owner', file_id: { $in: [audio, document] } }, null, 'file_id filename type bytes source context');
});

test.each([{ userId: '' }, { conversationId: 'new' }, { parentMessageId: '/private/file' }])(
  'does not resolve an invalid or absent authority (%p)', async (override) => {
    const db = { getMessages: jest.fn(), getFiles: jest.fn() };
    expect(await resolveSelectedHistoryAttachments({ ...scope, ...override }, db)).toEqual([]);
    expect(db.getMessages).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  },
);

test('a foreign conversation or an unselected missing parent grants no file', async () => {
  const db = { getMessages: jest.fn().mockResolvedValue([{ messageId: earlier, files: [{ file_id: audio }] }]), getFiles: jest.fn() };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([]);
  expect(db.getFiles).not.toHaveBeenCalled();
});

test('a deleted or revoked File stays unavailable on a later resolution', async () => {
  const db = { getMessages: jest.fn().mockResolvedValue([{ messageId: parent, files: [{ file_id: audio }] }]),
    getFiles: jest.fn().mockResolvedValueOnce([file(audio)]).mockResolvedValueOnce([]) };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([file(audio)]);
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([]);
});
