/* === VIVENTIUM START === Append-only orchestration trace ledger adversarial tests. === VIVENTIUM END === */

import {
  OrchestrationTraceConflictError,
  OrchestrationTraceValidationError,
  appendOrchestrationTraceEvent,
  readOrchestrationTraceLedger,
} from '../orchestrationTraceLedger';

import type {
  OrchestrationTraceEventRow,
  OrchestrationTraceLedgerStore,
} from '../orchestrationTraceLedger';

class MemoryLedgerStore implements OrchestrationTraceLedgerStore {
  rows: OrchestrationTraceEventRow[] = [];

  async findByEventKey(query: {
    ownerScopeHash: string;
    originRefHash: string;
    eventKeyHash: string;
  }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.eventKeyHash === query.eventKeyHash,
      ) || null
    );
  }

  async findLatest(query: { ownerScopeHash: string; originRefHash: string }) {
    return (
      this.rows
        .filter(
          (row) =>
            row.ownerScopeHash === query.ownerScopeHash &&
            row.originRefHash === query.originRefHash,
        )
        .sort((left, right) => right.sequence - left.sequence)[0] || null
    );
  }

  async findBySequence(query: { ownerScopeHash: string; originRefHash: string; sequence: number }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence === query.sequence,
      ) || null
    );
  }

  async insert(row: OrchestrationTraceEventRow) {
    if (
      this.rows.some(
        (item) =>
          item.ownerScopeHash === row.ownerScopeHash &&
          item.originRefHash === row.originRefHash &&
          item.sequence === row.sequence,
      )
    ) {
      const error = new Error('duplicate sequence');
      Object.assign(error, { code: 11000 });
      throw error;
    }
    this.rows.push({ ...row, facts: { ...row.facts } });
    return row;
  }

  async listPage(query: {
    ownerScopeHash: string;
    originRefHash: string;
    afterSequence: number;
    limit: number;
  }) {
    return this.rows
      .filter(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence > query.afterSequence,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, query.limit);
  }

  async countAfter(query: {
    ownerScopeHash: string;
    originRefHash: string;
    afterSequence: number;
  }) {
    return this.rows.filter(
      (row) =>
        row.ownerScopeHash === query.ownerScopeHash &&
        row.originRefHash === query.originRefHash &&
        row.sequence > query.afterSequence,
    ).length;
  }
}

const base = {
  ownerId: 'private-owner-id',
  originRef: 'private-origin-id',
  eventKey: 'private-event-id',
  stage: 'source.bound' as const,
  at: '2026-08-22T12:00:00.000Z',
  facts: {
    sourceEventRef: 'telegram-private-update-id',
    workRef: 'private-work-id',
  },
};

describe('orchestration trace ledger', () => {
  test('stores only fingerprints and a verifiable hash chain', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({ store, ...base });
    await appendOrchestrationTraceEvent({
      store,
      ...base,
      eventKey: 'second-private-event-id',
      stage: 'launch.accepted',
      at: '2026-08-22T12:00:01.000Z',
    });
    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      limit: 10,
    });

    expect(page.chain).toMatchObject({ pageVerified: true, fullChainVerified: true });
    expect(page.events.map((event) => event.sequence)).toEqual([1, 2]);
    expect(page.events[1]?.previousEventHash).toBe(page.events[0]?.eventHash);
    const serialized = JSON.stringify(store.rows);
    for (const forbidden of [
      base.ownerId,
      base.originRef,
      base.eventKey,
      base.facts.sourceEventRef,
      base.facts.workRef,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('records a real provider-forwarding receipt without request content or raw identity', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      eventKey: 'glasshive.provider.request.v1:ghpr_private',
      stage: 'provider.request.forwarded',
      at: '2026-08-22T12:00:02.000Z',
      facts: {
        workRef: 'private-work-id',
        runRef: 'private-run-id',
        providerRequestRef: 'ghpr_private',
        provider: 'openai',
        providerStatus: 'completed',
      },
    });

    expect(store.rows[0]).toMatchObject({
      stage: 'provider.request.forwarded',
      facts: {
        provider: 'openai',
        providerStatus: 'completed',
        providerRequestRefHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    const serialized = JSON.stringify(store.rows);
    expect(serialized).not.toContain('ghpr_private');
    expect(serialized).not.toContain('private-run-id');
  });

  test('keeps runtime observations strict across changed time or facts', async () => {
    const store = new MemoryLedgerStore();
    const runtime = {
      ...base,
      eventKey: 'work.running:private-run-id:1',
      stage: 'work.running' as const,
      facts: {
        workRef: 'private-work-id',
        runRef: 'private-run-id',
        attemptNumber: 1,
      },
    };
    const first = await appendOrchestrationTraceEvent({ store, ...runtime });
    const replay = await appendOrchestrationTraceEvent({ store, ...runtime });
    expect(replay).toEqual(first);
    expect(store.rows).toHaveLength(1);

    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...runtime,
        at: '2026-08-22T12:05:00.000Z',
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceConflictError);

    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...runtime,
        facts: { ...runtime.facts, state: 'completed' },
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceConflictError);
  });

  test('keeps the first immutable launch intent when an exact retry occurs later', async () => {
    const store = new MemoryLedgerStore();
    const intent = [
      {
        eventKey: 'source.bound:private-source-id',
        stage: 'source.bound' as const,
        facts: { sourceEventRef: 'private-source-id', logicalTurnRef: 'private-turn-id' },
      },
      {
        eventKey: 'prompt.layers:verified:1:0',
        stage: 'prompt.layers.verified' as const,
        facts: { promptLayerContractVersion: 1, unknownPromptLayerCount: 0 },
      },
      {
        eventKey: 'launch.prepared:private-origin-id',
        stage: 'launch.prepared' as const,
        facts: {},
      },
    ];
    const first = [];
    for (const event of intent) {
      first.push(
        await appendOrchestrationTraceEvent({
          store,
          ownerId: base.ownerId,
          originRef: base.originRef,
          ...event,
          at: '2026-08-22T12:00:00.000Z',
        }),
      );
    }

    for (const [index, event] of intent.entries()) {
      const replay = await appendOrchestrationTraceEvent({
        store,
        ownerId: base.ownerId,
        originRef: base.originRef,
        ...event,
        at: '2026-08-22T12:00:05.000Z',
      });
      expect(replay).toEqual(first[index]);
      expect(replay.at).toBe('2026-08-22T12:00:00.000Z');
    }
    expect(store.rows).toHaveLength(3);

    await expect(
      appendOrchestrationTraceEvent({
        store,
        ownerId: base.ownerId,
        originRef: base.originRef,
        ...intent[0],
        at: '2026-08-22T12:00:10.000Z',
        facts: { ...intent[0].facts, logicalTurnRef: 'changed-private-turn-id' },
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceConflictError);
  });

  test('keeps the first callback acceptance time on an exact ingress replay', async () => {
    const store = new MemoryLedgerStore();
    const callback = {
      ...base,
      eventKey: 'callback.accepted:callback_sha256:replay:1',
      stage: 'callback.accepted' as const,
      at: '2026-08-22T12:00:00.100Z',
      facts: {
        workRef: 'private-work-id',
        runRef: 'private-run-id',
        callbackRef: `callback_sha256:${'1'.repeat(64)}`,
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
        attemptNumber: 1,
      },
    };
    const first = await appendOrchestrationTraceEvent({ store, ...callback });
    const replay = await appendOrchestrationTraceEvent({
      store,
      ...callback,
      at: '2026-08-22T12:00:05.900Z',
    });

    expect(replay).toEqual(first);
    expect(replay.at).toBe('2026-08-22T12:00:00.100Z');
    expect(store.rows).toHaveLength(1);

    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...callback,
        at: '2026-08-22T12:00:05.900Z',
        facts: { ...callback.facts, state: 'failed' },
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceConflictError);
  });

  test('keeps the first launch acceptance time when callback confirmation replays it', async () => {
    const store = new MemoryLedgerStore();
    const acceptance = {
      ...base,
      eventKey: 'launch.accepted:private-work-id',
      stage: 'launch.accepted' as const,
      at: '2026-08-22T12:00:00.100Z',
      facts: { workRef: 'private-work-id' },
    };
    const first = await appendOrchestrationTraceEvent({ store, ...acceptance });
    const replay = await appendOrchestrationTraceEvent({
      store,
      ...acceptance,
      at: '2026-08-22T12:00:05.900Z',
    });

    expect(replay).toEqual(first);
    expect(replay.at).toBe('2026-08-22T12:00:00.100Z');
    expect(store.rows).toHaveLength(1);
  });

  test('rejects unknown sensitive fields instead of filtering them', async () => {
    const store = new MemoryLedgerStore();
    for (const key of [
      'promptText',
      'chatText',
      'hostId',
      'path',
      'url',
      'token',
      'argv',
      'pid',
      'privateId',
    ]) {
      await expect(
        appendOrchestrationTraceEvent({
          store,
          ...base,
          facts: { ...base.facts, [key]: 'must-never-persist' },
        }),
      ).rejects.toBeInstanceOf(OrchestrationTraceValidationError);
    }
    expect(store.rows).toHaveLength(0);
  });

  test('accepts privacy-safe Voice stages bound to owner, call, turn, and candidate', async () => {
    const store = new MemoryLedgerStore();
    const voiceStages = [
      'action.accepted',
      'control.completed',
      'tool.completed',
      'controller.completed',
      'cortex.completed',
      'live_memory.completed',
      'recall.completed',
      'title_model.completed',
      'response.completed',
      'tts.completed',
      'audio.completed',
      'provider.attempt.completed',
      'provider.fallback.completed',
    ] as const;

    for (const [index, stage] of voiceStages.entries()) {
      await appendOrchestrationTraceEvent({
        store,
        ownerId: 'voice-owner-private',
        originRef: 'voice-call-private',
        eventKey: `voice-event-private-${index}`,
        stage,
        facts: {
          callSessionRef: 'voice-call-private',
          logicalTurnRef: 'voice-turn-private',
          candidateDigest: `sha256:${'1'.repeat(64)}`,
          runtimeOwnerBindingHash: `sha256:${'2'.repeat(64)}`,
          installedArtifactDigest: `sha256:${'5'.repeat(64)}`,
          effectPlane:
            stage === 'action.accepted'
              ? 'control'
              : stage === 'live_memory.completed'
                ? 'liveMemory'
                : stage === 'title_model.completed'
                  ? 'titleModel'
                  : stage.split('.')[0],
          outcome: stage === 'action.accepted' ? 'accepted' : 'completed',
        },
      });
    }

    const serialized = JSON.stringify(store.rows);
    expect(store.rows).toHaveLength(voiceStages.length);
    expect(serialized).not.toContain('voice-owner-private');
    expect(serialized).not.toContain('voice-call-private');
    expect(serialized).not.toContain('voice-turn-private');
    expect(store.rows[0]?.facts).toMatchObject({
      candidateDigest: `sha256:${'1'.repeat(64)}`,
      runtimeOwnerBindingHash: `sha256:${'2'.repeat(64)}`,
      installedArtifactDigest: `sha256:${'5'.repeat(64)}`,
      effectPlane: 'control',
      outcome: 'accepted',
    });
  });

  test('stores typed provider and action facts without private identifiers', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({
      store,
      ...base,
      stage: 'provider.fallback.completed',
      facts: {
        callSessionRef: 'private-call',
        logicalTurnRef: 'private-turn',
        primaryAttemptRef: 'private-primary-attempt',
        fallbackAttemptRef: 'private-fallback-attempt',
        candidateDigest: `sha256:${'3'.repeat(64)}`,
        runtimeOwnerBindingHash: `sha256:${'4'.repeat(64)}`,
        installedArtifactDigest: `sha256:${'6'.repeat(64)}`,
        effectPlane: 'provider',
        outcome: 'completed',
        primaryProvider: 'xai',
        primaryModel: 'grok-4.5',
        primaryProviderStatus: 'failed',
        fallbackProvider: 'openai',
        fallbackModel: 'gpt-5.6-terra',
        fallbackProviderStatus: 'completed',
        configuredFallback: true,
        requiredCapabilitiesPreserved: true,
      },
    });
    await appendOrchestrationTraceEvent({
      store,
      ...base,
      eventKey: 'private-action-event',
      stage: 'action.accepted',
      facts: {
        callSessionRef: 'private-call',
        logicalTurnRef: 'private-turn',
        workRef: 'private-work',
        actionRef: 'private-operation',
        receiptRef: 'private-receipt',
        candidateDigest: `sha256:${'3'.repeat(64)}`,
        runtimeOwnerBindingHash: `sha256:${'4'.repeat(64)}`,
        installedArtifactDigest: `sha256:${'6'.repeat(64)}`,
        effectPlane: 'control',
        outcome: 'accepted',
        action: 'message',
      },
    });

    const serialized = JSON.stringify(store.rows);
    for (const forbidden of [
      'private-call',
      'private-turn',
      'private-primary-attempt',
      'private-fallback-attempt',
      'private-work',
      'private-operation',
      'private-receipt',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(store.rows[0]?.facts).toMatchObject({
      primaryProvider: 'xai',
      primaryModel: 'grok-4.5',
      fallbackProviderStatus: 'completed',
      configuredFallback: true,
      requiredCapabilitiesPreserved: true,
    });
  });

  test.each([
    { provider: 'private provider text' },
    { model: 'model with spaces' },
    { action: 'private-action' },
    { effectPlane: 'private-plane' },
    { outcome: 'private-outcome' },
    { candidateDigest: `sha256:${'x'.repeat(64)}` },
    { runtimeOwnerBindingHash: 'owner-machine-path' },
    { installedArtifactDigest: 'installed-machine-path' },
  ])('rejects unbounded or invalid Voice fact %p', async (facts) => {
    const store = new MemoryLedgerStore();
    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...base,
        stage: 'response.completed',
        facts,
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceValidationError);
    expect(store.rows).toHaveLength(0);
  });

  test('rejects private identifiers disguised as state, surface, event, or delivery labels', async () => {
    const store = new MemoryLedgerStore();
    for (const facts of [
      { state: 'private-owner-id' },
      { surface: 'private-host-id' },
      { callbackEvent: 'private.callback.id' },
      { deliveryState: 'private-delivery-id' },
    ]) {
      await expect(appendOrchestrationTraceEvent({ store, ...base, facts })).rejects.toBeInstanceOf(
        OrchestrationTraceValidationError,
      );
    }
    expect(store.rows).toHaveLength(0);
  });

  test('accepts the bounded GlassHive callback event vocabulary', async () => {
    const store = new MemoryLedgerStore();
    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...base,
        stage: 'callback.accepted',
        facts: { callbackEvent: 'run.queue_status' },
      }),
    ).resolves.toMatchObject({ stage: 'callback.accepted' });
  });

  test('detects event mutation and chain breakage', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({ store, ...base });
    await appendOrchestrationTraceEvent({
      store,
      ...base,
      eventKey: 'second',
      stage: 'launch.accepted',
    });
    store.rows[0] = { ...store.rows[0], stage: 'work.completed' };

    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      limit: 10,
    });
    expect(page.chain).toMatchObject({ pageVerified: false, fullChainVerified: false });
    expect(page.chain.errors).toContain('event_hash_mismatch:1');
  });

  test('binds the idempotency event key into the immutable event hash', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({ store, ...base });
    store.rows[0] = {
      ...store.rows[0],
      eventKeyHash: `sha256:${'9'.repeat(64)}`,
    };

    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      limit: 10,
    });

    expect(page.chain.fullChainVerified).toBe(false);
    expect(page.chain.errors).toContain('event_hash_mismatch:1');
  });

  test('rejects a changed bound producer fingerprint under the same event key', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({
      store,
      ...base,
      facts: { producerPromptHash: `sha256:${'1'.repeat(64)}` },
    });

    await expect(
      appendOrchestrationTraceEvent({
        store,
        ...base,
        facts: { producerPromptHash: `sha256:${'2'.repeat(64)}` },
      }),
    ).rejects.toBeInstanceOf(OrchestrationTraceConflictError);
  });

  test('bounds pages and reports explicit overflow and cursor', async () => {
    const store = new MemoryLedgerStore();
    for (let index = 0; index < 4; index += 1) {
      await appendOrchestrationTraceEvent({
        store,
        ...base,
        eventKey: `event-${index}`,
        stage: index === 0 ? 'source.bound' : 'launch.accepted',
        facts: { workRef: `work-${index}` },
      });
    }

    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      limit: 2,
    });
    expect(page.events).toHaveLength(2);
    expect(page.pagination).toEqual({
      afterSequence: 0,
      limit: 2,
      returned: 2,
      remaining: null,
      hasMore: true,
      overflow: true,
      nextCursor: 2,
    });
    expect(page.chain.fullChainVerified).toBe(false);
  });

  test('uses the bounded overflow row instead of a racing total count', async () => {
    const store = new MemoryLedgerStore();
    for (let index = 0; index < 4; index += 1) {
      await appendOrchestrationTraceEvent({
        store,
        ...base,
        eventKey: `racing-count-event-${index}`,
        facts: { workRef: `racing-count-work-${index}` },
      });
    }
    store.countAfter = async () => 0;

    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: base.ownerId,
      originRef: base.originRef,
      limit: 2,
    });

    expect(page.pagination).toMatchObject({ hasMore: true, overflow: true, remaining: null });
    expect(page.chain.fullChainVerified).toBe(false);
  });

  test('isolates owners even when origin references collide', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({ store, ...base });
    await appendOrchestrationTraceEvent({ store, ...base, ownerId: 'other-owner' });

    const page = await readOrchestrationTraceLedger({
      store,
      ownerId: 'other-owner',
      originRef: base.originRef,
      limit: 10,
    });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.sequence).toBe(1);
    expect(page.ownerScopeHash).not.toBe(store.rows[0]?.ownerScopeHash);
    expect(store.rows[1]?.eventHash).not.toBe(store.rows[0]?.eventHash);
  });
});
