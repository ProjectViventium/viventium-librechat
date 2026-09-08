let mockCreateIndex;
let mockFind;
let mockFindOne;
let mockFindOneAndUpdate;
let mockUpdateOne;
let mockMissionFind;

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connection: {
      collection: (name) => {
        if (name === 'viventium_glasshive_mission_evidence') {
          return { find: (...args) => mockMissionFind(...args) };
        }
        if (name !== 'viventium_external_work') throw new Error(`Unexpected collection ${name}`);
        return {
          createIndex: (...args) => mockCreateIndex(...args),
          find: (...args) => mockFind(...args),
          findOne: (...args) => mockFindOne(...args),
          findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
          updateOne: (...args) => mockUpdateOne(...args),
        };
      },
    },
  };
});

const {
  dismissCoreOnlyPreDispatchAttention,
  enrichActiveWorkSnapshot,
  getCoreWorkOriginRef,
  getCoreWorkDelivery,
} = require('../GlassHiveActiveWorkProjectionService');

describe('GlassHiveActiveWorkProjectionService', () => {
  beforeEach(() => {
    mockCreateIndex = jest.fn().mockResolvedValue('ok');
    mockFind = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
    mockFindOne = jest.fn().mockResolvedValue(null);
    mockFindOneAndUpdate = jest.fn().mockResolvedValue(null);
    mockUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
    mockMissionFind = jest.fn().mockReturnValue({ toArray: jest.fn().mockResolvedValue([]) });
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
        {
          workRef: 'work-unknown',
          deliveryState: 'unknown',
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
          {
            workRef: 'work-delivered',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['retry', 'dismiss'],
          },
          {
            workRef: 'work-silent',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
          {
            workRef: 'work-acknowledged',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
          {
            workRef: 'work-failed',
            state: 'failed',
            delivery: { state: 'pending' },
            actions: ['retry', 'dismiss'],
          },
          {
            workRef: 'work-partial',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
          {
            workRef: 'work-enqueued',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
          {
            workRef: 'work-unknown',
            state: 'completed',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
          {
            workRef: 'legacy-work',
            state: 'running',
            delivery: { state: 'pending' },
            actions: ['stop', 'dismiss'],
          },
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
        expect.objectContaining({
          workRef: 'work-unknown',
          delivery: { state: 'unknown', unreadTerminal: true },
          actions: [],
        }),
        expect.objectContaining({
          workRef: 'legacy-work',
          delivery: { state: 'pending' },
          actions: ['stop'],
        }),
      ]),
    );
  });

  test('exposes a later Main presentation even when a retried mission remains delivered', async () => {
    const executionTime = '2026-05-03T03:04:00.000Z';
    const presentationTime = '2026-05-03T03:05:00.000Z';
    const snapshot = {
      snapshot: 'fresh',
      work: [
        {
          workRef: 'work-retried',
          state: 'completed',
          updatedAt: executionTime,
          delivery: { state: 'pending' },
          actions: ['retry'],
        },
      ],
    };
    const project = async (updatedAt) => {
      mockFind.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            workRef: 'work-retried',
            externalState: 'completed',
            deliveryState: 'sent',
            updatedAt,
          },
        ]),
      });
      return enrichActiveWorkSnapshot({ ownerId: 'owner-1', snapshot });
    };
    const first = await project(new Date(executionTime));
    const delivered = await project(new Date(presentationTime));
    const repeated = await project(new Date(presentationTime));
    expect(first.work[0].delivery.state).toBe('delivered');
    expect(delivered.work[0].delivery.state).toBe('delivered');
    expect(first.work[0].updatedAt).toBe(executionTime);
    expect(delivered.work[0].updatedAt).toBe(presentationTime);
    expect(repeated).toEqual(delivered);
    expect(mockFind).toHaveBeenLastCalledWith(
      { ownerId: 'owner-1', workRef: { $in: ['work-retried'] } },
      expect.objectContaining({ projection: expect.objectContaining({ updatedAt: 1 }) }),
    );
  });

  test.each([undefined, 'invalid-date', '2026-05-03T03:03:00.000Z'])(
    'keeps the execution timestamp when Core has no later valid update: %s',
    async (updatedAt) => {
      mockFind.mockReturnValue({
        toArray: jest.fn().mockResolvedValue([
          {
            workRef: 'work-1',
            externalState: 'completed',
            deliveryState: 'sent',
            updatedAt,
          },
        ]),
      });
      const projected = await enrichActiveWorkSnapshot({
        ownerId: 'owner-1',
        snapshot: {
          snapshot: 'fresh',
          work: [{ workRef: 'work-1', state: 'completed', updatedAt: '2026-05-03T03:04:00.000Z' }],
        },
      });
      expect(projected.work[0].updatedAt).toBe('2026-05-03T03:04:00.000Z');
    },
  );

  test('does not query when the snapshot is unavailable or empty', async () => {
    await expect(
      enrichActiveWorkSnapshot({
        ownerId: 'owner-1',
        snapshot: { snapshot: 'unavailable', work: null, overflowCount: null },
      }),
    ).resolves.toMatchObject({ snapshot: 'unavailable', work: null });
    expect(mockFind).not.toHaveBeenCalled();
  });

  test('repairs stale Core execution truth without changing an unknown delivery outcome', async () => {
    mockFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          workRef: 'work-terminal',
          externalState: 'running',
          deliveryState: 'unknown',
          attentionPending: true,
        },
      ]),
    });

    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-terminal',
      snapshot: {
        snapshot: 'fresh',
        work: [
          {
            workRef: 'work-terminal',
            state: 'completed',
            updatedAt: '2026-08-25T12:00:00.000Z',
            delivery: { state: 'pending' },
            actions: ['dismiss'],
          },
        ],
      },
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        ownerId: 'owner-terminal',
        workRef: 'work-terminal',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      },
      {
        $set: expect.objectContaining({
          externalState: 'completed',
          attentionPending: true,
          terminalAt: new Date('2026-08-25T12:00:00.000Z'),
          stateReconciliationAppliedAt: expect.any(Date),
          stateReconciliationPendingAt: null,
        }),
      },
    );
    expect(mockUpdateOne.mock.calls[0][1].$set).not.toHaveProperty('deliveryState');
    expect(snapshot.work[0]).toMatchObject({
      state: 'completed',
      delivery: { state: 'unknown', unreadTerminal: true },
      actions: [],
    });
  });

  test('durably schedules a failed terminal projection and still shows authoritative work truth', async () => {
    mockFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          workRef: 'work-retry',
          externalState: 'running',
          deliveryState: 'pending',
          stateReconciliationAttempts: 2,
        },
      ]),
    });
    mockUpdateOne
      .mockRejectedValueOnce(Object.assign(new Error('write interrupted'), { code: 'mongo_retry' }))
      .mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 });

    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-retry',
      snapshot: {
        snapshot: 'fresh',
        work: [{ workRef: 'work-retry', state: 'failed', delivery: { state: 'pending' } }],
      },
    });

    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(mockUpdateOne.mock.calls[1]).toEqual([
      {
        ownerId: 'owner-retry',
        workRef: 'work-retry',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      },
      {
        $set: expect.objectContaining({
          stateReconciliationPendingAt: expect.any(Date),
          stateReconciliationNextAt: expect.any(Date),
          stateReconciliationErrorCode: 'mongo_retry',
        }),
        $inc: { stateReconciliationAttempts: 1 },
      },
    ]);
    expect(snapshot.work[0].state).toBe('failed');
  });

  test('never persists untrusted trace context or malformed run and attempt references', async () => {
    mockFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          workRef: 'work-untrusted-trace',
          externalState: 'running',
          deliveryState: 'pending',
        },
      ]),
    });

    await enrichActiveWorkSnapshot({
      ownerId: 'owner-untrusted-trace',
      snapshot: {
        snapshot: 'fresh',
        work: [
          {
            workRef: 'work-untrusted-trace',
            state: 'completed',
            runRef: 'external-run-without-a-canonical-fingerprint',
            lifecycle: { attemptNumber: -7 },
            traceparent: 'external-untrusted-trace',
            baggage: 'private=synthetic',
          },
        ],
      },
    });

    const persisted = mockUpdateOne.mock.calls[0][1].$set;
    expect(persisted).not.toHaveProperty('stateReconciliationRunRef');
    expect(persisted).not.toHaveProperty('stateReconciliationAttemptNumber');
    expect(persisted).not.toHaveProperty('traceparent');
    expect(persisted).not.toHaveProperty('baggage');
    expect(JSON.stringify(persisted)).not.toContain('private=synthetic');
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
        updatedAt: { $gte: expect.any(Date) },
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

  test('moves old or dismissed pre-dispatch failures into read-only History', async () => {
    const cursor = {
      sort: jest.fn(),
      limit: jest.fn(),
      toArray: jest.fn().mockResolvedValue([
        {
          _id: 'origin-old-failure',
          originRef: 'origin-old-failure',
          configuredDestinations: ['telegram'],
          attentionPending: true,
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
          updatedAt: new Date('2026-08-01T12:00:01.000Z'),
        },
      ]),
    };
    cursor.sort.mockReturnValue(cursor);
    cursor.limit.mockReturnValue(cursor);
    mockFind.mockReturnValue(cursor);

    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-1',
      snapshot: { snapshot: 'fresh', work: [], overflowCount: 0 },
      includeCoreOnlyHistory: true,
    });

    expect(mockFind).toHaveBeenCalledWith(
      {
        ownerId: 'owner-1',
        workRef: '',
        launchState: 'not_dispatched',
        externalState: 'failed',
        $or: [{ attentionPending: false }, { updatedAt: { $lt: expect.any(Date) } }],
      },
      expect.objectContaining({ projection: expect.any(Object) }),
    );
    expect(snapshot.work).toEqual([
      expect.objectContaining({
        workRef: 'origin-old-failure',
        state: 'failed',
        delivery: { state: 'failed', unreadTerminal: false },
        actions: [],
      }),
    ]);
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
        $or: [{ dismissOperationId: { $exists: false } }, { dismissOperationId: 'operation-1' }],
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

  test('resolves the exact original launch origin by owner and work reference', async () => {
    mockFindOne.mockResolvedValueOnce({
      _id: 'ghi_original_launch',
      originRef: 'ghi_original_launch',
    });

    await expect(getCoreWorkOriginRef({ ownerId: 'owner-1', workRef: 'work-1' })).resolves.toBe(
      'ghi_original_launch',
    );
    expect(mockFindOne).toHaveBeenCalledWith(
      { ownerId: 'owner-1', workRef: 'work-1' },
      { projection: { _id: 1, originRef: 1 } },
    );
  });
  test('a previous delivered result cannot hide a failed current Main presentation', async () => {
    mockFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        {
          workRef: 'work-followup',
          deliveryState: 'sent',
          adjudicationState: 'failed',
          attentionPending: false,
        },
      ]),
    });
    const snapshot = await enrichActiveWorkSnapshot({
      ownerId: 'owner-1',
      snapshot: { work: [{ workRef: 'work-followup', state: 'completed' }] },
    });
    expect(snapshot.work[0].delivery).toEqual({ state: 'failed', unreadTerminal: true });
  });

  function currentResultFixture(state = 'pending') {
    const row = {
      originRef: 'origin-1',
      workRef: 'work-followup',
      externalState: 'completed',
      deliveryState: 'sent',
      adjudicationState: 'completed',
      attentionPending: false,
      followUpMessageId: 'prior-delivered-message',
      terminalCallbackId: `cb_terminal_${'a'.repeat(64)}`,
      terminalCallbackRunId: 'run-current',
      terminalCallbackResultDigest: `sha256:${'b'.repeat(64)}`,
      terminalCallbackResultRevision: 2,
      terminalCallbackAcceptedOperationId: 'c'.repeat(32),
    };
    const evidence = {
      ...row,
      _id: 'ghe_0d05af79a2fbf525454227555abc9bd4',
      ownerId: 'owner-1',
      runId: 'run-current',
      state,
    };
    return { row, evidence };
  }

  test.each(['pending', 'processing'])(
    'current %s result does not inherit an older delivered presentation',
    async (state) => {
      const { row, evidence } = currentResultFixture(state);
      const original = JSON.parse(JSON.stringify(row));
      mockFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([row]) });
      mockMissionFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([evidence]) });
      const snapshot = await enrichActiveWorkSnapshot({
        ownerId: 'owner-1',
        snapshot: {
          work: [{ workRef: row.workRef, state: 'completed', actions: ['dismiss', 'retry'] }],
        },
      });
      expect(snapshot.work[0]).toMatchObject({
        delivery: { state: 'pending', unreadTerminal: true },
        actions: ['retry'],
      });
      expect(mockMissionFind).toHaveBeenCalledTimes(1);
      expect(mockMissionFind).toHaveBeenCalledWith(
        {
          ownerId: 'owner-1',
          _id: {
            $in: [evidence._id, row.terminalCallbackId],
          },
        },
        expect.objectContaining({ projection: expect.not.objectContaining({ evidence: 1 }) }),
      );
      expect(row).toEqual(original);
      expect(mockUpdateOne).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test('a silent current result does not inherit an internal or older sent receipt', async () => {
    const { row, evidence } = currentResultFixture('silent');
    mockFindOne.mockResolvedValue(row);
    mockMissionFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([evidence]) });
    await expect(
      getCoreWorkDelivery({ ownerId: 'owner-1', workRef: row.workRef }),
    ).resolves.toEqual({ state: 'silent', unreadTerminal: false });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('silent adjudication is not a visible delivery even when its status receipt was sent', async () => {
    mockFindOne.mockResolvedValue({
      workRef: 'work-silent-status',
      deliveryState: 'sent',
      adjudicationState: 'silent',
      attentionPending: false,
    });
    await expect(
      getCoreWorkDelivery({ ownerId: 'owner-1', workRef: 'work-silent-status' }),
    ).resolves.toEqual({ state: 'silent', unreadTerminal: false });
  });

  test('the dismiss delivery gate also reads the current result identity', async () => {
    const { row, evidence } = currentResultFixture();
    mockFindOne.mockResolvedValue(row);
    mockMissionFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([evidence]) });
    await expect(
      getCoreWorkDelivery({ ownerId: 'owner-1', workRef: row.workRef }),
    ).resolves.toEqual({
      state: 'pending',
      unreadTerminal: true,
    });
  });

  test.each([
    ['ownerId', 'another-owner'],
    ['originRef', 'another-origin'],
    ['workRef', 'another-work'],
    ['runId', 'run-previous'],
    ['terminalCallbackResultRevision', 1],
    ['terminalCallbackAcceptedOperationId', 'd'.repeat(32)],
    ['terminalCallbackResultDigest', `sha256:${'e'.repeat(64)}`],
  ])('a mismatched %s cannot change this work presentation', async (field, value) => {
    const { row, evidence } = currentResultFixture();
    evidence[field] = value;
    mockFindOne.mockResolvedValue(row);
    mockMissionFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([evidence]) });
    await expect(
      getCoreWorkDelivery({ ownerId: 'owner-1', workRef: row.workRef }),
    ).resolves.toEqual({
      state: 'delivered',
      unreadTerminal: false,
    });
  });

  test('settled current evidence and repeated reads preserve delivered history', async () => {
    const { row, evidence } = currentResultFixture('completed');
    mockFindOne.mockResolvedValue(row);
    mockMissionFind.mockReturnValue({ toArray: jest.fn().mockResolvedValue([evidence]) });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        getCoreWorkDelivery({ ownerId: 'owner-1', workRef: row.workRef }),
      ).resolves.toEqual({
        state: 'delivered',
        unreadTerminal: false,
      });
    }
    expect(row.followUpMessageId).toBe('prior-delivered-message');
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });
});
