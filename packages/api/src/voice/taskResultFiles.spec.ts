import { resolveVoiceTaskResultFilenames, voiceTaskCommittedPresentationKey } from './taskResultFiles';

const scope = {
  userId: 'owner',
  callSessionId: 'call',
  task: {
    taskId: 'task',
    userId: 'owner',
    callSessionId: 'call',
    conversationId: 'chat',
  },
  event: {
    taskId: 'task',
    callSessionId: 'call',
    conversationId: 'chat',
    state: 'completed',
    resultMessageId: 'reply',
  },
};
type Database = Parameters<typeof resolveVoiceTaskResultFilenames>[1];
function database(): jest.Mocked<Parameters<typeof resolveVoiceTaskResultFilenames>[1]> {
  return {
    conversationExists: jest
      .fn<ReturnType<Database['conversationExists']>, Parameters<Database['conversationExists']>>()
      .mockResolvedValue(true),
    getResultMessage: jest
      .fn<ReturnType<Database['getResultMessage']>, Parameters<Database['getResultMessage']>>()
      .mockResolvedValue({
        files: [
          {
            file_id: 'file-2',
            filename: 'Untrusted title',
            filepath: '/private/unused',
          },
          { file_id: 'file-1' },
          { file_id: 'file-2' },
          {
            filename: 'Unavailable',
            nativeOutputFile: { status: 'unavailable' },
          },
          null,
        ],
      }),
    getResultFiles: jest
      .fn<ReturnType<Database['getResultFiles']>, Parameters<Database['getResultFiles']>>()
      .mockResolvedValue([
        { file_id: 'file-1', filename: 'report.csv' },
        { file_id: 'file-2', filename: 'summary.txt' },
        { file_id: 'unlinked', filename: 'private.txt' },
      ]),
  };
}
test('projects current File filenames in exact completed message order, with no attachment paths or URLs', async () => {
  const db = database();
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual(['summary.txt', 'report.csv']);
  expect(db.conversationExists).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: 'chat',
  });
  expect(db.getResultMessage).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: 'chat',
    messageId: 'reply',
    isCreatedByUser: false,
    unfinished: { $ne: true },
    error: { $ne: true },
    'metadata.viventium.visibility': { $ne: 'internal' },
  });
  expect(db.getResultFiles).toHaveBeenCalledWith({
    user: 'owner',
    conversationId: 'chat',
    messageId: 'reply',
    file_id: { $in: ['file-2', 'file-1'] },
  });
});
test.each([
  ['foreign task owner', { task: { ...scope.task, userId: 'foreign' } }],
  ['missing task owner', { task: { ...scope.task, userId: '' } }],
  ['foreign task call', { task: { ...scope.task, callSessionId: 'foreign' } }],
  ['foreign event call', { event: { ...scope.event, callSessionId: 'foreign' } }],
  ['foreign event task', { event: { ...scope.event, taskId: 'foreign' } }],
  ['foreign event conversation', { event: { ...scope.event, conversationId: 'foreign' } }],
  ['missing conversation', { task: { ...scope.task, conversationId: undefined } }],
  ['failed result', { event: { ...scope.event, state: 'failed' } }],
  ['running result', { event: { ...scope.event, state: 'running' } }],
  ['missing result message', { event: { ...scope.event, resultMessageId: undefined } }],
  ['missing request owner', { userId: '' }],
  ['missing request call', { callSessionId: '' }],
])('%s performs no database read', async (_label, changed) => {
  const db = database();
  expect(await resolveVoiceTaskResultFilenames({ ...scope, ...changed }, db)).toEqual([]);
  expect(db.conversationExists).not.toHaveBeenCalled();
});
test('deleted or foreign conversation performs no message or File read', async () => {
  const db = database();
  db.conversationExists.mockResolvedValue(false);
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual([]);
  expect(db.getResultMessage).not.toHaveBeenCalled();
  expect(db.getResultFiles).not.toHaveBeenCalled();
});
test('deleted, foreign, internal, user, unfinished or error message has no File lookup', async () => {
  const db = database();
  db.getResultMessage.mockResolvedValue(null);
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual([]);
  expect(db.getResultFiles).not.toHaveBeenCalled();
});
test('missing File rows and unavailable descriptors produce no false file card', async () => {
  const db = database();
  db.getResultFiles.mockResolvedValue([]);
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual([]);
});
test('database unavailable propagates failure instead of inventing an empty success', async () => {
  const db = database();
  db.getResultFiles.mockRejectedValue(new Error('unavailable'));
  await expect(resolveVoiceTaskResultFilenames(scope, db)).rejects.toThrow('unavailable');
});


test('projects a native attachments-only completed result through its current File row', async () => {
  const db = database();
  db.getResultMessage.mockResolvedValue({
    attachments: [{ file_id: 'native-file', filename: 'Untrusted title', filepath: '/private/unused' }],
  });
  db.getResultFiles.mockResolvedValue([{ file_id: 'native-file', filename: 'summary.txt' }]);
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual(['summary.txt']);
  expect(db.getResultFiles).toHaveBeenCalledWith({
    user: 'owner', conversationId: 'chat', messageId: 'reply', file_id: { $in: ['native-file'] },
  });
});

test('deduplicates file references across files and native attachments in carrier order', async () => {
  const db = database();
  db.getResultMessage.mockResolvedValue({
    files: [{ file_id: 'file-2' }, null, { file_id: 'file-2' }],
    attachments: [null, { file_id: 'file-1' }, { file_id: 'file-2' }, { file_id: 'file-1' },
      { filename: 'Unavailable', nativeOutputFile: { status: 'unavailable' } }],
  });
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual(['summary.txt', 'report.csv']);
  expect(db.getResultFiles).toHaveBeenCalledWith({
    user: 'owner', conversationId: 'chat', messageId: 'reply',
    file_id: { $in: ['file-2', 'file-1'] },
  });
});

test.each([{}, { files: [] }, { attachments: [] }, { files: [null], attachments: [null, {}] }])(
  'missing or null file references perform no File lookup', async (message) => {
    const db = database();
    db.getResultMessage.mockResolvedValue(message);
    expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual([]);
    expect(db.getResultFiles).not.toHaveBeenCalled();
  },
);

test('deleted or foreign native File rows do not expose attachment-provided names', async () => {
  const db = database();
  db.getResultMessage.mockResolvedValue({ attachments: [{ file_id: 'file-2', filename: 'Untrusted title' }] });
  db.getResultFiles.mockResolvedValue([]);
  expect(await resolveVoiceTaskResultFilenames(scope, db)).toEqual([]);
  expect(db.getResultFiles).toHaveBeenCalledWith({
    user: 'owner', conversationId: 'chat', messageId: 'reply', file_id: { $in: ['file-2'] },
  });
});


describe('committed Voice presentation snapshot identity', () => {
  type Result = Parameters<typeof voiceTaskCommittedPresentationKey>[0];
  type Task = NonNullable<Parameters<typeof voiceTaskCommittedPresentationKey>[1]>;
  function result(): Result {
    return {
      status: 'recorded',
      ownerStreamId: 'stream',
      acknowledgement: { logical_turn_id: 'turn', revision: 1, state: 'committed' },
      presentation: {
        userId: 'owner', conversationId: 'chat', responseMessageId: 'reply',
        interactionContext: {
          actor_kind: 'external_user', origin: 'interactive', surface: 'voice',
          logical_turn_id: 'turn', revision: 1, conversation_id: 'chat', source_event_id: 'source',
        },
      },
    };
  }
  function task(): Task {
    return {
      ...scope.task, state: 'completed', logicalTurnId: 'turn', streamId: 'stream',
      owner: { kind: 'generation_job', id: 'stream' }, current: { resultMessageId: 'reply' },
    };
  }
  test('binds only the exact committed owner result and makes one stable deduplication key', () => {
    expect(voiceTaskCommittedPresentationKey(result(), task())).toBe('voice_presentation:1:reply');
    expect(voiceTaskCommittedPresentationKey({ ...result(), idempotent: true }, task()))
      .toBe('voice_presentation:1:reply');
  });
  test.each(['failed', 'partial_removed'] as const)('does not publish %s delivery', (state) => {
    const changed = result(); changed.acknowledgement!.state = state;
    expect(voiceTaskCommittedPresentationKey(changed, task())).toBeNull();
  });
  test.each(['userId', 'conversationId', 'logicalTurnId', 'streamId', 'state', 'callSessionId'] as const)
    ('rejects foreign or missing task %s', (key) => {
      expect(voiceTaskCommittedPresentationKey(result(), { ...task(), [key]: key === 'callSessionId' ? '' : 'foreign' }))
        .toBeNull();
    });
  test.each(['status', 'ownerStreamId'] as const)('rejects foreign receipt %s', (key) => {
    const changed = result(); if (key === 'status') changed.status = 'stale_revision';
    else changed.ownerStreamId = 'foreign';
    expect(voiceTaskCommittedPresentationKey(changed, task())).toBeNull();
  });
  test('rejects a stale acknowledgement revision and foreign result identity', () => {
    const changed = result(); changed.acknowledgement!.revision = 2;
    expect(voiceTaskCommittedPresentationKey(changed, task())).toBeNull();
    expect(voiceTaskCommittedPresentationKey(result(), { ...task(), current: { resultMessageId: 'foreign' } }))
      .toBeNull();
  });
  test('rejects Web, transport-only, failed, suppressed and non-generation tasks', () => {
    const changed = result(); changed.presentation!.interactionContext!.surface = 'web';
    expect(voiceTaskCommittedPresentationKey(changed, task())).toBeNull();
    expect(voiceTaskCommittedPresentationKey({ ...result(), transportOnly: true }, task())).toBeNull();
    expect(voiceTaskCommittedPresentationKey(result(), { ...task(), current: { resultMessageId: 'reply', error: { code: 'unavailable' } } })).toBeNull();
    expect(voiceTaskCommittedPresentationKey(result(), { ...task(), suppressed: true })).toBeNull();
    expect(voiceTaskCommittedPresentationKey(result(), { ...task(), owner: { kind: 'glasshive_run', id: 'stream' } })).toBeNull();
  });
});
