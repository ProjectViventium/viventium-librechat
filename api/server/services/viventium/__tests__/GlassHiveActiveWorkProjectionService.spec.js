let mockCreateIndex;
let mockFind;
let mockFindOne;
let mockFindOneAndUpdate;

jest.mock('mongoose', () => ({
  connection: {
    collection: (name) => {
      if (name !== 'viventium_external_work') throw new Error(`Unexpected collection ${name}`);
      return {
        createIndex: (...args) => mockCreateIndex(...args),
        find: (...args) => mockFind(...args),
        findOne: (...args) => mockFindOne(...args),
        findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
      };
    },
  },
}));

const {
  dismissCoreOnlyPreDispatchAttention,
  enrichActiveWorkSnapshot,
} = require('../GlassHiveActiveWorkProjectionService');

describe('GlassHiveActiveWorkProjectionService', () => {
  beforeEach(() => {
    mockCreateIndex = jest.fn().mockResolvedValue('ok');
    mockFind = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    mockFindOne = jest.fn().mockResolvedValue(null);
    mockFindOneAndUpdate = jest.fn().mockResolvedValue(null);
  });

  test('joins only the asserted owner and maps Core delivery truth by opaque workRef', async () => {
    mockFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          workRef: 'work-delivered',
          deliveryState: 'sent',
          adjudicationState: 'completed',
          attentionPending: false,
        },
        {
          workRef: 'work-silent',
          deliveryState: 'suppressed',
          adjudicationState: 'silent',
          attentionPending: false,
        },
        {
          workRef: 'work-acknowledged',
          deliveryState: 'acknowledged',
          adjudicationState: 'completed',
          attentionPending: false,
        },
        {
          workRef: 'work-failed',
          deliveryState: 'failed',
          adjudicationState: 'failed',
          attentionPending: true,
        },
        {
          workRef: 'work-partial',
          deliveryState: 'unresolved',
          adjudicationState: 'completed',
          attentionPending: true,
        },
        {
          workRef: 'work-enqueued',
          deliveryState: 'enqueued',
          adjudicationState: 'completed',
          attentionPending: true,
        },
      ]),
    });
    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-1',
      snapshot: {
        snapshot: 'fresh',
        overflowCount: 0,
        work: [
          { workRef: 'work-delivered', state: 'completed', delivery: { state: 'pending' }, actions: ['retry', 'dismiss'] },
          { workRef: 'work-silent', state: 'completed', delivery: { state: 'pending' }, actions: ['dismiss'] },
          { workRef: 'work-acknowledged', state: 'completed', delivery: { state: 'pending' }, actions: ['dismiss'] },
          { workRef: 'work-failed', state: 'failed', delivery: { state: 'pending' }, actions: ['retry', 'dismiss'] },
          { workRef: 'work-partial', state: 'completed', delivery: { state: 'pending' }, actions: ['dismiss'] },
          { workRef: 'work-enqueued', state: 'completed', delivery: { state: 'pending' }, actions: ['dismiss'] },
          { workRef: 'legacy-work', state: 'running', delivery: { state: 'pending' }, actions: ['stop', 'dismiss'] },
        ],
      },
    });

    expect(mockFind).toHaveBeenCalledWith(
      { ownerId: 'owner-1', workRef: { $in: expect.arrayContaining(['work-delivered']) } },
      expect.objectContaining({ projection: expect.any(Object) }),
    );
    expect(mockCreateIndex).toHaveBeenCalledWith(
      { ownerId: 1, workRef: 1 },
      expect.objectContaining({ name: 'owner_work_ref' }),
    );
    expect(mockCreateIndex.mock.calls.map(([, options]) => options.name)).toEqual(
      expect.arrayContaining([
        'owner_work_ref',
        'owner_state_updated',
        'owner_launch_external',
        'owner_launch_attention',
        'owner_launch_delivery',
        'owner_scheduler_dispatch',
        'owner_schedule_occurrence',
        'launch_reconciliation',
      ]),
    );
    expect(snapshot.work).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workRef: 'work-delivered',
          delivery: { state: 'delivered', unreadTerminal: false },
          actions: ['retry', 'dismiss'],
        }),
        expect.objectContaining({
          workRef: 'work-silent',
          delivery: { state: 'silent', unreadTerminal: false },
          actions: ['dismiss'],
        }),
        expect.objectContaining({
          workRef: 'work-acknowledged',
          delivery: { state: 'acknowledged', unreadTerminal: false },
          actions: ['dismiss'],
        }),
        expect.objectContaining({
          workRef: 'work-failed',
          delivery: { state: 'failed', unreadTerminal: true },
          actions: ['retry'],
        }),
        expect.objectContaining({
          workRef: 'work-partial',
          delivery: { state: 'failed', unreadTerminal: true },
          actions: [],
        }),
        expect.objectContaining({
          workRef: 'work-enqueued',
          delivery: { state: 'pending', unreadTerminal: true },
          actions: [],
        }),
        expect.objectContaining({ workRef: 'legacy-work', delivery: { state: 'pending' }, actions: ['stop'] }),
      ]),
    );
  });

  test('does not query when the snapshot is unavailable or empty', async () => {
    await expect(
      enrichActiveWorkSnapshot({
        ownerId: 'owner-1',
        snapshot: { snapshot: 'unavailable', work: null, overflowCount: null },
      }),
    ).resolves.toMatchObject({ snapshot: 'unavailable', work: null });
    expect(mockFind).not.toHaveBeenCalled();
  });

  test('projects only local pre-dispatch attention into an unavailable snapshot', async () => {
    const cursor = {
      sort: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([
        {
          _id: 'origin-cold-outage',
          ownerId: 'owner-a',
          workRef: '',
          originRef: 'origin-cold-outage',
          launchState: 'not_dispatched',
          externalState: 'failed',
          attentionPending: true,
          configuredDestinations: ['librechat'],
        },
      ]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    mockFind.mockReturnValue(cursor);

    await expect(
      enrichActiveWorkSnapshot({
        ownerId: 'owner-a',
        snapshot: { snapshot: 'unavailable', work: null, overflowCount: null },
        includeCoreOnly: true,
      }),
    ).resolves.toMatchObject({
      snapshot: 'unavailable',
      overflowCount: null,
      work: [
        {
          workRef: 'origin-cold-outage',
          title: 'Mission could not start',
          state: 'failed',
          actions: ['dismiss'],
        },
      ],
    });
  });

  test('projects an owner-scoped pre-dispatch failure as durable attention without inventing GlassHive work', async () => {
    const cursor = {
      sort: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([
        {
          _id: 'ghi_failed_launch',
          originRef: 'ghi_failed_launch',
          workRef: '',
          ownerId: 'owner-1',
          launchState: 'not_dispatched',
          externalState: 'failed',
          attentionPending: true,
          deliveryState: 'failed',
          preDispatchFailureCode: 'parallel_execution_isolation_required',
          configuredDestinations: ['librechat'],
          createdAt: new Date('2026-08-15T12:00:00.000Z'),
          updatedAt: new Date('2026-08-15T12:00:01.000Z'),
        },
      ]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    mockFind.mockReturnValue(cursor);

    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-1',
      snapshot: { snapshot: 'fresh', work: [], overflowCount: 0 },
      includeCoreOnly: true,
    });

    expect(mockFind).toHaveBeenCalledWith(
      {
        ownerId: 'owner-1',
        workRef: '',
        launchState: 'not_dispatched',
        externalState: 'failed',
        attentionPending: { $ne: false },
      },
      expect.objectContaining({
        projection: expect.objectContaining({
          _id: 1,
          originRef: 1,
          configuredDestinations: 1,
        }),
      }),
    );
    const projection = mockFind.mock.calls[0][1].projection;
    expect(projection).not.toHaveProperty('sourceEventId');
    expect(projection).not.toHaveProperty('objectiveDigest');
    expect(projection).not.toHaveProperty('callIdentityDigest');
    expect(snapshot).toEqual({
      snapshot: 'fresh',
      overflowCount: 0,
      work: [
        {
          workRef: 'ghi_failed_launch',
          title: 'Mission could not start',
          state: 'failed',
          statusSummary: 'No worker was started.',
          attention: {
            kind: 'launch_failed',
            summary:
              'Parallel work could not start this mission. You can dismiss this notice and try again from the conversation.',
          },
          provider: '',
          originSurface: 'librechat',
          delivery: { state: 'failed', unreadTerminal: true },
          createdAt: '2026-08-15T12:00:00.000Z',
          updatedAt: '2026-08-15T12:00:01.000Z',
          actions: ['dismiss'],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain('parallel_execution_isolation_required');
  });

  test('dismisses a pre-dispatch attention row owner-scoped and replays the same operation stably', async () => {
    mockFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'ghi_failed_launch',
      ownerId: 'owner-1',
      dismissOperationId: 'operation-1',
    });

    const first = await dismissCoreOnlyPreDispatchAttention({
      ownerId: 'owner-1',
      originRef: 'ghi_failed_launch',
      operationId: 'operation-1',
    });
    expect(first).toEqual({
      accepted: true,
      action: 'dismiss',
      workRef: 'ghi_failed_launch',
      state: 'dismissed',
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: 'ghi_failed_launch',
        ownerId: 'owner-1',
        workRef: '',
        launchState: 'not_dispatched',
        externalState: 'failed',
        attentionPending: { $ne: false },
        $or: [
          { dismissOperationId: { $exists: false } },
          { dismissOperationId: 'operation-1' },
        ],
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          attentionPending: false,
          deliveryState: 'acknowledged',
          dismissOperationId: 'operation-1',
        }),
      }),
      { returnDocument: 'after' },
    );

    mockFindOneAndUpdate.mockResolvedValueOnce(null);
    mockFindOne.mockResolvedValueOnce({
      _id: 'ghi_failed_launch',
      ownerId: 'owner-1',
      dismissOperationId: 'operation-1',
    });
    await expect(
      dismissCoreOnlyPreDispatchAttention({
        ownerId: 'owner-1',
        originRef: 'ghi_failed_launch',
        operationId: 'operation-1',
      }),
    ).resolves.toEqual(first);
    expect(mockFindOne).toHaveBeenCalledWith(
      {
        _id: 'ghi_failed_launch',
        ownerId: 'owner-1',
        workRef: '',
        launchState: 'not_dispatched',
        externalState: 'failed',
      },
      { projection: { _id: 1, dismissOperationId: 1 } },
    );
  });
});
