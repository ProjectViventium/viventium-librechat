const api = require('./nativeCoordinatorWork');
const owner = { ownerId: 'owner-one', tenantId: 'tenant-one' };
const binding = {
  ...owner,
  _id: 'binding-one',
  active: true,
  conversationId: 'chat-one',
  nativeConversationId: 'native-one',
};
const make = () => {
  const snapshots = [
    {
      binding: { ...binding },
      snapshot: {
        conversation_id: 'native-one',
        goals: [
          {
            goal_id: 'goal-one',
            source_turn_id: 'source-one',
            text: 'Original work',
            state: 'running',
            work_ref: 'backend-one',
          },
        ],
        turns: [
          {
            turn_id: 'turn-one',
            source_turn_id: 'source-one',
            origin: 'interactive',
            state: 'failed',
            message: 'Original planning',
          },
        ],
      },
    },
  ];
  const source = {
    _id: 'binding-one:source-one',
    kind: 'native_coordinator_source',
    bindingRef: 'binding-one',
    turnId: 'source-one',
    requestBody: {
      conversationId: 'chat-one',
      parentMessageId: 'derived-parent',
      viventiumTriggeringSourceSegments: ['original-one', 'original-two'].map(
        (source_message_id) => ({ source_message_id, source_persisted: true }),
      ),
    },
  };
  const messages = ['original-one', 'original-two'].map((messageId) => ({
    user: 'owner-one',
    conversationId: 'chat-one',
    messageId,
    deletedAt: new Date(),
    cleanupTombstone: { contractVersion: 1 },
  }));
  return { snapshots, source, messages };
};
const getRefs = (f, scope = 'active', overrides = {}) =>
  api.nativeCoordinatorCleanedSourceWorkRefs({
    ...owner,
    snapshots: f.snapshots,
    scope,
    readSource: async () => f.source,
    readMessages: async () => f.messages,
    ...overrides,
  });
const project = (f, refs, scope = 'active') =>
  api.mergeHostedAndNativeRoster({
    ...owner,
    scope,
    cleanedSourceWorkRefs: refs,
    native: { snapshot: 'fresh', snapshots: f.snapshots },
    hosted: {
      snapshot: 'fresh',
      cursor: 'page-one',
      overflowCount: 2,
      work: [
        { workRef: 'backend-one', state: 'running' },
        { workRef: api.nativeCoordinatorTurnRef('native-one', 'turn-one'), state: 'failed' },
        { workRef: 'unrelated-hosted', state: 'running', delivery: { state: 'sent' } },
      ],
    },
  });

it('removes only proven all-originals-cleaned goals and turns, including hosted mirrors', async () => {
  const f = make();
  const before = JSON.stringify(f);
  const readSource = jest.fn(async () => f.source);
  const readMessages = jest.fn(async () => f.messages);
  const refs = await getRefs(f, 'active', { readSource, readMessages });
  expect(refs).toEqual(
    [
      api.nativeCoordinatorWorkRef('native-one', 'goal-one'),
      api.nativeCoordinatorTurnRef('native-one', 'turn-one'),
      'backend-one',
    ].sort(),
  );
  const result = project(f, refs);
  expect(result.work.map((w) => w.workRef)).toEqual(['unrelated-hosted']);
  expect(result.cursor).toBe('page-one');
  expect(result.overflowCount).toBe(2);
  expect(readSource).toHaveBeenCalledTimes(1);
  expect(readMessages).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f)).toBe(before);
});

it('preserves mixed live originals regardless of a cleaned derived parent', async () => {
  const f = make();
  f.messages[1].deletedAt = null;
  f.messages.push({ ...f.messages[0], messageId: 'derived-parent' });
  expect(await getRefs(f)).toEqual([]);
  expect(project(f, []).work.map((w) => w.workRef)).toEqual(
    expect.arrayContaining([
      'unrelated-hosted',
      api.nativeCoordinatorWorkRef('native-one', 'goal-one'),
      api.nativeCoordinatorTurnRef('native-one', 'turn-one'),
    ]),
  );
});

it('preserves incomplete or missing originals and rejects unreadable provenance', async () => {
  const variants = [
    null,
    [],
    [{ source_message_id: 'original-one', source_persisted: false }],
    [{ source_message_id: 'original-one', source_persisted: true }, null],
  ];
  for (const segments of variants) {
    const f = make();
    f.source.requestBody.viventiumTriggeringSourceSegments = segments;
    expect(await getRefs(f)).toEqual([]);
  }
  const f = make();
  f.source.requestBody.viventiumTriggeringSourceSegmentsOverflowCount = 1;
  expect(await getRefs(f)).toEqual([]);
  expect(await getRefs(make(), 'active', { readSource: async () => null })).toEqual([]);
  await expect(
    getRefs(make(), 'active', {
      readMessages: async () => {
        throw new Error('unavailable');
      },
    }),
  ).rejects.toThrow('unavailable');
  const g = make();
  delete g.snapshots[0].snapshot.goals[0].source_turn_id;
  delete g.snapshots[0].snapshot.turns[0].source_turn_id;
  expect(
    await getRefs(g, 'active', {
      readSource: async (ref, turn) => (turn === 'source-one' ? g.source : null),
    }),
  ).toEqual([]);
});

it('requires exact source binding, turn, conversation, and owned active snapshot', async () => {
  for (const field of ['_id', 'kind', 'bindingRef', 'turnId']) {
    const f = make();
    f.source[field] = 'foreign';
    expect(await getRefs(f)).toEqual([]);
  }
  const f = make();
  f.source.requestBody.conversationId = 'foreign';
  expect(await getRefs(f)).toEqual([]);
  for (const [field, value] of [
    ['ownerId', 'foreign'],
    ['tenantId', 'foreign'],
    ['active', false],
    ['nativeConversationId', 'foreign'],
    ['_id', ''],
  ]) {
    const g = make();
    g.snapshots[0].binding[field] = value;
    expect(await getRefs(g)).toEqual([]);
  }
});

it('does not equate ordinary deletion, other versions, or foreign/missing messages with cleanup', async () => {
  for (const patch of [
    { cleanupTombstone: undefined },
    { cleanupTombstone: { contractVersion: 2 } },
    { deletedAt: null },
    { user: 'foreign' },
    { conversationId: 'foreign' },
    { messageId: 'other' },
  ]) {
    const f = make();
    Object.assign(f.messages[0], patch);
    expect(await getRefs(f)).toEqual([]);
  }
  const f = make();
  f.messages.pop();
  expect(await getRefs(f)).toEqual([]);
});

it('retains history without cleanup reads or snapshot mutation', async () => {
  const f = make();
  f.snapshots[0].snapshot.goals[0].state = 'completed';
  const before = JSON.stringify(f);
  const readSource = jest.fn();
  const readMessages = jest.fn();
  expect(await getRefs(f, 'history', { readSource, readMessages })).toEqual([]);
  expect(readSource).not.toHaveBeenCalled();
  expect(readMessages).not.toHaveBeenCalled();
  const refs = [
    api.nativeCoordinatorWorkRef('native-one', 'goal-one'),
    api.nativeCoordinatorTurnRef('native-one', 'turn-one'),
    'backend-one',
  ];
  expect(project(f, refs, 'history').work.map((w) => w.workRef)).toEqual(
    expect.arrayContaining(refs.slice(0, 2)),
  );
  expect(JSON.stringify(f)).toBe(before);
});
