import { resolveSelectedHistoryAttachments, resolveSelectedDelegationAttachments } from './selectedHistoryAttachments';
import { trustedUploadedFilesFromRequestBody } from '~/glasshive/sourceSelection';

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
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...file(audio), media_group_index: 2 }]);
  expect(db.getMessages).toHaveBeenCalledWith({ user: 'owner', conversationId }, 'messageId parentMessageId files attachments');
  expect(db.getFiles).toHaveBeenCalledWith({ user: 'owner', file_id: { $in: [audio, document] } }, null, 'file_id filename type bytes source context text messageId');
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
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...file(audio), media_group_index: 0 }]);
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
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...file(nativeId), media_group_index: 0 }]);
  expect(db.getFiles).toHaveBeenCalledWith(
    { user: 'owner', file_id: { $in: [nativeId] } }, null,
    'file_id filename type bytes source context text messageId',
  );
});

test.each([null, {}, 'not-an-array', 42])('ignores malformed Mixed attachment container (%p)', async (attachments) => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent, attachments, files: [{ file_id: audio }] }]),
    getFiles: jest.fn().mockResolvedValue([file(audio)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...file(audio), media_group_index: 0 }]);
});

test('normalizes nullable and malformed Mixed entries before shared traversal', async () => {
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent,
      files: [null, { file_id: audio }, 'invalid'],
      attachments: [null, {}, { file_id: 4 }, [], { file_id: nativeId }, { file_id: '../file' }],
    }]),
    getFiles: jest.fn().mockResolvedValue([file(nativeId), file(audio)]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...file(audio), media_group_index: 1 }, { ...file(nativeId), media_group_index: 4 }]);
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
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent,
      files: [{ file_id: nativeId }], attachments: [{ file_id: nativeId, filename: 'stale.txt', bytes: 18 }],
    }]),
    getFiles: jest.fn().mockResolvedValue([current]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...current, media_group_index: 0 }]);
});

test('prior native results preserve the existing 64 selected-file bound', async () => {
  const ids = Array.from({ length: 70 }, (_, n) => 'native_' + n.toString(16).padStart(64, '0'));
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent, attachments: ids.map(file) }]),
    getFiles: jest.fn().mockResolvedValue(ids.slice(0, 64).map(file)),
  };
  expect((await resolveSelectedHistoryAttachments(scope, db)).map((row) => row.file_id)).toEqual(ids.slice(0, 64));
});


test('owner-selected text attachments retain their stored parsed body for subsequent turns', async () => {
  const body = { ...file(document), filename: 'note.txt', type: 'text/plain', source: 'text', text: 'Exact stored body.\n' };
  const db = {
    getMessages: jest.fn().mockResolvedValue([{ messageId: parent, files: [{ file_id: document }] }]),
    getFiles: jest.fn().mockResolvedValue([body]),
  };
  expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([{ ...body, media_group_index: 0 }]);
  expect(db.getFiles).toHaveBeenCalledWith({ user: 'owner', file_id: { $in: [document] } }, null,
    'file_id filename type bytes source context text messageId');
});

describe('exact mission attachment selection', () => {
  const current = { ...file(audio), filename: 'current.csv', text: 'Current source text.' };
  const historical = { ...file(document), filename: 'original.csv', type: 'text/csv', bytes: 117 };
  const makeDb = (rows = [historical]) => ({
    getMessages: jest.fn().mockResolvedValue([
      { messageId: parent, files: [{ file_id: document }] },
      { messageId: earlier, files: [{ file_id: sibling }] },
    ]),
    getFiles: jest.fn().mockImplementation(async (filter) =>
      rows.filter((row) => filter.file_id.$in.includes(row.file_id))),
  });

  test('defaults to current source files without reading historical messages', async () => {
    const db = makeDb();
    expect(await resolveSelectedDelegationAttachments(scope, [current], undefined, db))
      .toEqual({ files: [current] });
    expect(db.getMessages).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  });

  test('adds only explicitly selected owned ancestry and preserves current metadata and order', async () => {
    const db = makeDb([current, historical]);
    expect(await resolveSelectedDelegationAttachments(scope, [current], [document, audio], db))
      .toEqual({ files: [current, { ...historical, media_group_index: 0 }] });
    expect(db.getMessages).toHaveBeenCalledWith({ user: 'owner', conversationId },
      'messageId parentMessageId files attachments');
    expect(db.getFiles).toHaveBeenCalledWith({ user: 'owner', file_id: { $in: [audio] } }, null,
      'file_id filename type bytes source context text');
  });

  test.each([
    ['missing', [historical], '44444444-4444-4444-8444-444444444444'],
    ['deleted', [], document],
    ['foreign', [], document],
    ['off-branch', [historical, file(sibling)], sibling],
    ['deleted-current', [historical], audio],
  ])('rejects the complete selection before launch when one file is %s', async (_kind, rows, id) => {
    const db = makeDb(rows);
    expect(await resolveSelectedDelegationAttachments(scope, [current], [document, id], db))
      .toEqual({ error: 'delegation_file_selection_unauthorized' });
  });

  test('rechecks an explicitly selected file after deletion rather than caching its prior authority', async () => {
    const db = makeDb();
    expect(await resolveSelectedDelegationAttachments(scope, [], [document], db))
      .toEqual({ files: [{ ...historical, media_group_index: 0 }] });
    db.getFiles.mockResolvedValue([]);
    expect(await resolveSelectedDelegationAttachments(scope, [], [document], db))
      .toEqual({ error: 'delegation_file_selection_unauthorized' });
  });

  test('rejects an oversized combined selection instead of dropping the selected original file', async () => {
    const currentFiles = Array.from({ length: 64 }, (_, index) =>
      file('native_' + index.toString(16).padStart(64, '0')));
    expect(await resolveSelectedDelegationAttachments(scope, currentFiles, [document], makeDb()))
      .toEqual({ error: 'delegation_file_selection_unauthorized' });
  });

  test('does not reclassify an unselected current sibling as historical ancestry', async () => {
    const db = makeDb([current, historical]);
    expect(await resolveSelectedDelegationAttachments(scope, [current], [document], db,
      [current, historical])).toEqual({ error: 'delegation_file_selection_unauthorized' });
    expect(db.getMessages).not.toHaveBeenCalled();
    expect(db.getFiles).not.toHaveBeenCalled();
  });

  test('selects one older owned branch file without spending the bound on unselected recent history', async () => {
    const ids = Array.from({ length: 65 }, (_, index) =>
      'native_' + index.toString(16).padStart(64, '0'));
    const db = {
      getMessages: jest.fn().mockResolvedValue([{ messageId: parent, attachments: ids.map(file) },
        { messageId: earlier, attachments: [{ file_id: sibling }] }]),
      getFiles: jest.fn().mockImplementation(async (filter) => filter.file_id.$in.map(file)),
    };
    expect(await resolveSelectedDelegationAttachments(scope, [], [ids[64]], db))
      .toEqual({ files: [{ ...file(ids[64]), media_group_index: 64 }] });
    expect(db.getFiles).toHaveBeenCalledWith({ user: 'owner', file_id: { $in: [ids[64]] } }, null,
      'file_id filename type bytes source context text messageId');
    expect(await resolveSelectedDelegationAttachments(scope, [], [sibling], db))
      .toEqual({ error: 'delegation_file_selection_unauthorized' });
  });
});


describe('original source upload position', () => {
  const messages = [{ messageId: parent, files: [{ file_id: audio }, { file_id: document }, { file_id: sibling }] }];
  const makeDb = (source = messages, stored = [file(sibling), file(audio), file(document)]) => ({
    getMessages: jest.fn().mockResolvedValue(source),
    getFiles: jest.fn().mockResolvedValue(stored),
  });

  test('reversed selected historical IDs keep selected order and original source positions', async () => {
    const db = makeDb();
    const selected = await resolveSelectedDelegationAttachments(scope, [], [sibling, document, audio], db);
    expect(selected).toEqual({ files: [
      { ...file(sibling), media_group_index: 2 },
      { ...file(document), media_group_index: 1 },
      { ...file(audio), media_group_index: 0 },
    ] });
    if ('files' in selected) {
      const normalized = trustedUploadedFilesFromRequestBody({ files: selected.files });
      expect(normalized.map((row) => [row.file_id, row.media_group_index])).toEqual([
        [sibling, 2], [document, 1], [audio, 0],
      ]);
    }
    expect(db.getFiles).toHaveBeenCalledTimes(1);
    expect(db.getMessages).toHaveBeenCalledTimes(1);
  });

  test('a subset keeps its source-local ordinal rather than renumbering from zero', async () => {
    const selected = await resolveSelectedDelegationAttachments(scope, [], [sibling], makeDb());
    expect(selected).toEqual({ files: [{ ...file(sibling), media_group_index: 2 }] });
  });

  test('canonical source descriptor retains explicit group metadata and its adapter alias', async () => {
    const db = makeDb([{ messageId: parent, files: [
      { file_id: audio, media_group_index: 8 },
      { file_id: document, viventium_media_group_index: 3 },
    ] }]);
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([
      { ...file(audio), media_group_index: 8 }, { ...file(document), media_group_index: 3 },
    ]);
  });

  test.each([-1, 2.5, '7', null, true, Number.MAX_SAFE_INTEGER + 1])(
    'invalid original descriptor metadata %p uses its actual stored position', async (invalid) => {
      const db = makeDb([{ messageId: parent, files: [
        { file_id: audio }, { file_id: document, media_group_index: invalid },
      ] }]);
      expect(await resolveSelectedHistoryAttachments(scope, db, [document])).toEqual([
        { ...file(document), media_group_index: 1 },
      ]);
    },
  );

  test('repeated old ref uses earliest selected-branch source position without global group renumbering', async () => {
    const db = makeDb([
      { messageId: parent, parentMessageId: earlier, files: [{ file_id: document }, { file_id: audio }] },
      { messageId: earlier, files: [{ file_id: audio }, { file_id: sibling }] },
    ]);
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([
      { ...file(document), media_group_index: 0 }, { ...file(audio), media_group_index: 0 },
      { ...file(sibling), media_group_index: 1 },
    ]);
  });

  test('canonical File source message owns the position when present', async () => {
    const canonical = { ...file(audio), messageId: parent };
    const db = makeDb([
      { messageId: parent, parentMessageId: earlier, files: [{ file_id: document }, { file_id: audio }] },
      { messageId: earlier, files: [{ file_id: audio }] },
    ], [canonical, file(document)]);
    expect(await resolveSelectedHistoryAttachments(scope, db, [audio])).toEqual([
      { ...canonical, media_group_index: 1 },
    ]);
  });

  test.each(['off-branch', earlier])('an owned reattached File keeps selected-branch access when creation message %s is unavailable', async (messageId) => {
    const canonical = { ...file(document), messageId };
    const db = makeDb([
      ...messages,
      { messageId: 'off-branch', files: [{ file_id: document }] },
    ], [canonical]);
    expect(await resolveSelectedDelegationAttachments(scope, [], [document], db))
      .toEqual({ files: [{ ...canonical, media_group_index: 1 }] });
  });

  test('an off-branch-only file remains unauthorized even when its creation binding is known', async () => {
    const db = makeDb([
      { messageId: parent, files: [{ file_id: audio }] },
      { messageId: 'off-branch', files: [{ file_id: document }] },
    ], [{ ...file(document), messageId: 'off-branch' }]);
    expect(await resolveSelectedDelegationAttachments(scope, [], [document], db))
      .toEqual({ error: 'delegation_file_selection_unauthorized' });
  });

  test('same-source attachment alias replaces a bare duplicate fallback with valid original metadata', async () => {
    const db = makeDb([{ messageId: parent, files: [{ file_id: audio }],
      attachments: [{ file_id: audio, viventium_media_group_index: 7 }] }], [file(audio)]);
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([
      { ...file(audio), media_group_index: 7 },
    ]);
  });

  test('the first valid explicit position wins conflicting duplicates within the same source', async () => {
    const db = makeDb([{ messageId: parent,
      files: [{ file_id: audio, media_group_index: 5 }],
      attachments: [{ file_id: audio, media_group_index: 8 }] }], [file(audio)]);
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([
      { ...file(audio), media_group_index: 5 },
    ]);
  });

  test('a malformed primary position does not hide a valid adapter alias', async () => {
    const db = makeDb([{ messageId: parent,
      files: [{ file_id: audio, media_group_index: -1, viventium_media_group_index: 4 }] }], [file(audio)]);
    expect(await resolveSelectedHistoryAttachments(scope, db)).toEqual([
      { ...file(audio), media_group_index: 4 },
    ]);
  });

  test('canonical owned Message provenance is not replaced by copied File display group metadata', async () => {
    const canonical = { ...file(document), media_group_index: 99 };
    expect(await resolveSelectedDelegationAttachments(scope, [], [document], makeDb(messages, [canonical])))
      .toEqual({ files: [{ ...canonical, media_group_index: 1 }] });
  });
});


test('one request reuses only its exact authorized branch and selection read', async () => {
  const request = {};
  const db = { getMessages: jest.fn().mockResolvedValue([{ messageId: parent, files: [{ file_id: audio }] }]),
    getFiles: jest.fn(async (filter) => filter.user === 'owner' ? [file(audio)] : []) };
  const values = await Promise.all([resolveSelectedHistoryAttachments(scope, db, undefined, request),
    resolveSelectedHistoryAttachments(scope, db, undefined, request)]);
  expect(values[0]).toEqual(values[1]);
  expect(db.getMessages).toHaveBeenCalledTimes(1);
  expect(db.getFiles).toHaveBeenCalledTimes(1);
  expect(await resolveSelectedHistoryAttachments(scope, db, [], request)).toEqual([]);
  expect(db.getMessages).toHaveBeenCalledTimes(2);
  expect(await resolveSelectedHistoryAttachments({ ...scope, userId: 'another-owner' }, db, undefined, request)).toEqual([]);
  expect(db.getFiles).toHaveBeenCalledTimes(2);
  db.getFiles.mockResolvedValue([]);
  expect(await resolveSelectedHistoryAttachments(scope, db, undefined, {})).toEqual([]);
  expect(db.getFiles).toHaveBeenCalledTimes(3);
});

test('failed request projection is not cached for capability refresh', async () => {
  const request = {};
  const db = { getMessages: jest.fn().mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValue([{ messageId: parent, files: [{ file_id: audio }] }]),
    getFiles: jest.fn().mockResolvedValue([file(audio)]) };
  await expect(resolveSelectedHistoryAttachments(scope, db, undefined, request)).rejects.toThrow('read failed');
  expect(await resolveSelectedHistoryAttachments(scope, db, undefined, request)).toEqual([
    { ...file(audio), media_group_index: 0 },
  ]);
  expect(db.getMessages).toHaveBeenCalledTimes(2);
});
