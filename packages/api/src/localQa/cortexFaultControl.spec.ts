import {
  CORTEX_LOCAL_QA_FAULT_BOUNDARIES,
  createCortexLocalQaFaultControlManager,
  type CortexLocalQaFaultControlRow,
  type CortexLocalQaFaultControlStore,
} from './cortexFaultControl';

const CASE_TOKEN = 'A'.repeat(43);
const COMPONENT_ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;
const SCOPE = {
  ownerId: 'synthetic-owner-id',
  conversationId: 'synthetic-conversation-id',
  parentMessageId: 'synthetic-parent-id',
};

class MemoryFaultStore implements CortexLocalQaFaultControlStore {
  readonly rows: CortexLocalQaFaultControlRow[] = [];

  async insert(row: CortexLocalQaFaultControlRow): Promise<CortexLocalQaFaultControlRow> {
    if (
      this.rows.some(
        (candidate) =>
          candidate.caseTokenHash === row.caseTokenHash &&
          candidate.componentArtifactDigest === row.componentArtifactDigest &&
          candidate.boundary === row.boundary &&
          candidate.ownerScopeHash === row.ownerScopeHash &&
          candidate.conversationScopeHash === row.conversationScopeHash &&
          candidate.parentScopeHash === row.parentScopeHash,
      )
    ) {
      const error = new Error('duplicate');
      Object.assign(error, { code: 11000 });
      throw error;
    }
    this.rows.push(structuredClone(row));
    return structuredClone(row);
  }

  async consume(
    query: Parameters<CortexLocalQaFaultControlStore['consume']>[0],
  ): Promise<CortexLocalQaFaultControlRow | null> {
    const row = this.rows.find(
      (candidate) =>
        candidate.schemaVersion === 1 &&
        candidate.controlId === query.controlId &&
        candidate.capabilityKey === query.capabilityKey &&
        candidate.caseTokenHash === query.caseTokenHash &&
        candidate.componentArtifactDigest === query.componentArtifactDigest &&
        candidate.boundary === query.boundary &&
        candidate.ownerScopeHash === query.ownerScopeHash &&
        candidate.conversationScopeHash === query.conversationScopeHash &&
        candidate.parentScopeHash === query.parentScopeHash &&
        candidate.syntheticScope === true &&
        candidate.state === 'armed' &&
        candidate.armedAt === query.armedAt &&
        candidate.expiresAt === query.expiresAt &&
        candidate.purgeAt === query.purgeAt &&
        new Date(candidate.expiresAt).getTime() > new Date(query.at).getTime(),
    );
    if (!row) return null;
    row.state = 'consumed';
    row.consumedAt = query.at;
    row.audit.push(query.auditEvent);
    return structuredClone(row);
  }

  async expire(query: Parameters<CortexLocalQaFaultControlStore['expire']>[0]): Promise<number> {
    const row = this.rows.find(
      (candidate) =>
        candidate.controlId === query.controlId &&
        candidate.capabilityKey === query.capabilityKey &&
        candidate.caseTokenHash === query.caseTokenHash &&
        candidate.componentArtifactDigest === query.componentArtifactDigest &&
        candidate.boundary === query.boundary &&
        candidate.ownerScopeHash === query.ownerScopeHash &&
        candidate.conversationScopeHash === query.conversationScopeHash &&
        candidate.parentScopeHash === query.parentScopeHash &&
        candidate.state === 'armed' &&
        candidate.armedAt === query.armedAt &&
        candidate.expiresAt === query.expiresAt &&
        candidate.purgeAt === query.purgeAt &&
        new Date(candidate.expiresAt).getTime() <= new Date(query.at).getTime(),
    );
    if (!row) return 0;
    row.state = 'expired';
    row.audit.push(query.auditEvent);
    return 1;
  }

  async clear(query: Parameters<CortexLocalQaFaultControlStore['clear']>[0]): Promise<number> {
    const row = this.rows.find(
      (candidate) =>
        candidate.controlId === query.controlId &&
        candidate.capabilityKey === query.capabilityKey &&
        candidate.caseTokenHash === query.caseTokenHash &&
        candidate.componentArtifactDigest === query.componentArtifactDigest &&
        candidate.boundary === query.boundary &&
        candidate.ownerScopeHash === query.ownerScopeHash &&
        candidate.conversationScopeHash === query.conversationScopeHash &&
        candidate.parentScopeHash === query.parentScopeHash &&
        candidate.state === 'armed' &&
        candidate.armedAt === query.armedAt &&
        candidate.expiresAt === query.expiresAt &&
        candidate.purgeAt === query.purgeAt &&
        new Date(candidate.expiresAt).getTime() > new Date(query.at).getTime(),
    );
    if (!row) return 0;
    row.state = 'cleared';
    row.clearedAt = query.at;
    row.audit.push(query.auditEvent);
    return 1;
  }

  async list(
    query: Parameters<CortexLocalQaFaultControlStore['list']>[0],
  ): Promise<CortexLocalQaFaultControlRow[]> {
    return this.rows
      .filter(
        (row) =>
          row.caseTokenHash === query.caseTokenHash &&
          row.componentArtifactDigest === query.componentArtifactDigest &&
          row.ownerScopeHash === query.ownerScopeHash &&
          row.conversationScopeHash === query.conversationScopeHash &&
          row.parentScopeHash === query.parentScopeHash &&
          (!query.boundary || row.boundary === query.boundary),
      )
      .map((row) => structuredClone(row));
  }
}

function enabledEnv(token = CASE_TOKEN): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    VIVENTIUM_LOCAL_QA_MODE: 'emo_uc_048',
    VIVENTIUM_LOCAL_QA_CASE_TOKEN: token,
    VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: COMPONENT_ARTIFACT_DIGEST,
  };
}

const verifySyntheticScope = async () => true;

describe('EMO-UC-048 local-QA fault controls', () => {
  test('refuses to arm when durable synthetic-fixture authority is absent', async () => {
    const store = new MemoryFaultStore();
    const verifySyntheticScope = jest.fn().mockResolvedValue(false);
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });

    await expect(
      manager.arm({
        boundary: 'cortex_ledger_first_write',
        ...SCOPE,
      }),
    ).rejects.toMatchObject({ code: 'cortex_local_qa_synthetic_fixture_unverified' });
    expect(verifySyntheticScope).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
  });

  test('remain disabled in production unless the explicit local-QA mode is active', async () => {
    const store = new MemoryFaultStore();
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: { NODE_ENV: 'production', VIVENTIUM_LOCAL_QA_CASE_TOKEN: CASE_TOKEN },
    });

    await expect(
      manager.arm({
        boundary: 'cortex_ledger_first_write',
        ...SCOPE,
      }),
    ).rejects.toMatchObject({ code: 'cortex_local_qa_fault_controls_disabled' });
    await expect(
      manager.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'disabled' });
    expect(store.rows).toHaveLength(0);
  });

  test.each(['short', 'not+base64url/'.repeat(8)])(
    'fails closed for malformed case token %s',
    async (caseToken) => {
      const store = new MemoryFaultStore();
      const manager = createCortexLocalQaFaultControlManager({
        store,
        env: enabledEnv(caseToken),
      });

      await expect(
        manager.arm({
          boundary: 'cortex_ledger_first_write',
          ...SCOPE,
        }),
      ).rejects.toMatchObject({ code: 'cortex_local_qa_case_token_invalid' });
      await expect(
        manager.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
      ).resolves.toEqual({ triggered: false, reason: 'invalid_token' });
    },
  );

  test('atomically consumes one armed fault once and keeps a redacted durable audit', async () => {
    const store = new MemoryFaultStore();
    let uuid = 0;
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}`,
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      verifySyntheticScope,
    });
    const armed = await manager.arm({
      boundary: 'web_replay_persistence',
      ...SCOPE,
      expiresInMs: 60_000,
    });

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        manager.consume({ boundary: 'web_replay_persistence', ...SCOPE }),
      ),
    );
    expect(attempts.filter((result) => result.triggered)).toHaveLength(1);
    expect(attempts.filter((result) => !result.triggered)).toHaveLength(19);

    const [control] = await manager.query({ boundary: 'web_replay_persistence', ...SCOPE });
    expect(control).toMatchObject({
      controlId: armed.controlId,
      boundary: 'web_replay_persistence',
      state: 'consumed',
      syntheticScope: true,
      audit: [{ event: 'armed' }, { event: 'consumed' }],
    });
    expect(JSON.stringify(control)).not.toContain(CASE_TOKEN);
    expect(JSON.stringify(control)).not.toContain(SCOPE.ownerId);
    expect(JSON.stringify(control)).not.toContain(SCOPE.conversationId);
    expect(JSON.stringify(control)).not.toContain(SCOPE.parentMessageId);
  });

  test('binds every durable row and exact consume update to the current candidate identity', async () => {
    const store = new MemoryFaultStore();
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      now: () => new Date('2026-08-23T12:00:00.000Z'),
      verifySyntheticScope,
    });
    const consume = jest.spyOn(store, 'consume');
    const armed = await manager.arm({
      boundary: 'web_redis_publish_ack',
      ...SCOPE,
      expiresInMs: 60_000,
    });

    expect(store.rows[0]).toMatchObject({
      controlId: armed.controlId,
      componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
      capabilityKey: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await manager.consume({ boundary: 'web_redis_publish_ack', ...SCOPE });
    expect(consume).toHaveBeenCalledWith(
      expect.objectContaining({
        controlId: armed.controlId,
        componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
        capabilityKey: store.rows[0].capabilityKey,
        caseTokenHash: store.rows[0].caseTokenHash,
        boundary: store.rows[0].boundary,
        ownerScopeHash: store.rows[0].ownerScopeHash,
        conversationScopeHash: store.rows[0].conversationScopeHash,
        parentScopeHash: store.rows[0].parentScopeHash,
        expiresAt: store.rows[0].expiresAt,
      }),
    );
  });

  test('uses exact single-row identities for clear and expiry transitions', async () => {
    const store = new MemoryFaultStore();
    let now = new Date('2026-08-23T12:00:00.000Z');
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      now: () => now,
      verifySyntheticScope,
    });
    const expire = jest.spyOn(store, 'expire');
    const clear = jest.spyOn(store, 'clear');
    const expiredControl = await manager.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
      expiresInMs: 1_000,
    });
    const clearControl = await manager.arm({
      boundary: 'web_replay_persistence',
      ...SCOPE,
      expiresInMs: 60_000,
    });
    now = new Date('2026-08-23T12:00:02.000Z');

    await manager.clear({ boundary: 'web_replay_persistence', ...SCOPE });
    await manager.query({ ...SCOPE });

    expect(expire).toHaveBeenCalledWith(
      expect.objectContaining({
        controlId: expiredControl.controlId,
        componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
        state: 'armed',
      }),
    );
    expect(clear).toHaveBeenCalledWith(
      expect.objectContaining({
        controlId: clearControl.controlId,
        componentArtifactDigest: COMPONENT_ARTIFACT_DIGEST,
        state: 'armed',
      }),
    );
  });

  test('uses the root canonical millisecond UTC offset for every receipt timestamp', async () => {
    const store = new MemoryFaultStore();
    const verify = jest.fn().mockResolvedValue(true);
    const now = new Date('2026-08-23T12:00:00.123Z');
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      now: () => now,
      verifySyntheticScope: verify,
    });

    const armed = await manager.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
      expiresInMs: 1_000,
    });

    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        armedAt: '2026-08-23T12:00:00.123+00:00',
        expiresAt: '2026-08-23T12:00:01.123+00:00',
      }),
    );
    expect(armed).toMatchObject({
      armedAt: '2026-08-23T12:00:00.123+00:00',
      expiresAt: '2026-08-23T12:00:01.123+00:00',
      purgeAt: '2026-08-24T12:00:01.123+00:00',
      audit: [{ at: '2026-08-23T12:00:00.123+00:00' }],
    });
  });

  test.each([
    ['Z suffix', (value: string) => value.replace('+00:00', 'Z')],
    ['missing milliseconds', (value: string) => value.replace('.000+00:00', '+00:00')],
    ['extra fractional digit', (value: string) => value.replace('.000+00:00', '.0000+00:00')],
  ])('rejects durable rows with %s timestamps at the manager boundary', async (_label, mutate) => {
    const store = new MemoryFaultStore();
    const fixedNow = new Date('2026-08-23T12:00:00.000Z');
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      now: () => fixedNow,
      verifySyntheticScope,
    });
    await manager.arm({
      boundary: 'web_replay_persistence',
      ...SCOPE,
      expiresInMs: 60_000,
    });
    const row = store.rows[0];
    row.armedAt = mutate(row.armedAt);
    row.expiresAt = mutate(row.expiresAt);
    row.purgeAt = mutate(row.purgeAt);
    row.audit = row.audit.map((event) => ({ ...event, at: mutate(event.at) }));

    await expect(manager.query({ boundary: 'web_replay_persistence', ...SCOPE })).resolves.toEqual(
      [],
    );
  });

  test('survives manager restart and consumes from the same durable store', async () => {
    const store = new MemoryFaultStore();
    const firstBoot = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });
    await firstBoot.arm({
      boundary: 'web_redis_publish_ack',
      ...SCOPE,
    });

    const secondBoot = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });
    await expect(
      secondBoot.consume({ boundary: 'web_redis_publish_ack', ...SCOPE }),
    ).resolves.toMatchObject({ triggered: true });
  });

  test('fails closed when durable control audit state is malformed', async () => {
    const store = new MemoryFaultStore();
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });
    await manager.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
    });
    store.rows[0].audit[0] = {
      sequence: 1,
      event: 'consumed',
      at: store.rows[0].armedAt,
    };

    await expect(
      manager.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
  });

  test('does not inject a fault when durable control storage is unavailable', async () => {
    const store = new MemoryFaultStore();
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });
    jest.spyOn(store, 'expire').mockRejectedValue(new Error('control storage unavailable'));

    await expect(
      manager.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
  });

  test.each([
    { ...SCOPE, ownerId: 'other-owner' },
    { ...SCOPE, conversationId: 'other-conversation' },
    { ...SCOPE, parentMessageId: 'other-parent' },
  ])('does not consume a cross-scope control: %#', async (wrongScope) => {
    const store = new MemoryFaultStore();
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      verifySyntheticScope,
    });
    await manager.arm({
      boundary: 'telegram_promoted_parent_presentation',
      ...SCOPE,
    });

    await expect(
      manager.consume({ boundary: 'telegram_promoted_parent_presentation', ...wrongScope }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
    await expect(
      manager.consume({ boundary: 'telegram_promoted_parent_presentation', ...SCOPE }),
    ).resolves.toMatchObject({ triggered: true });
  });

  test('expires, clears, and bounds every control without firing stale state', async () => {
    const store = new MemoryFaultStore();
    let now = new Date('2026-08-23T12:00:00.000Z');
    const manager = createCortexLocalQaFaultControlManager({
      store,
      env: enabledEnv(),
      now: () => now,
      verifySyntheticScope,
    });
    await manager.arm({
      boundary: 'cortex_ledger_first_write',
      ...SCOPE,
      expiresInMs: 1_000,
    });
    await manager.arm({
      boundary: 'web_replay_persistence',
      ...SCOPE,
      expiresInMs: 60_000,
    });
    now = new Date('2026-08-23T12:00:02.000Z');

    await expect(
      manager.consume({ boundary: 'cortex_ledger_first_write', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });
    await expect(manager.clear({ boundary: 'web_replay_persistence', ...SCOPE })).resolves.toEqual({
      cleared: 1,
    });
    await expect(
      manager.consume({ boundary: 'web_replay_persistence', ...SCOPE }),
    ).resolves.toEqual({ triggered: false, reason: 'not_armed' });

    const controls = await manager.query({ ...SCOPE });
    expect(controls.map((control) => control.state).sort()).toEqual(['cleared', 'expired']);
    expect(
      controls.every(
        (control) =>
          new Date(control.purgeAt).getTime() - new Date(control.expiresAt).getTime() <=
          24 * 60 * 60 * 1000,
      ),
    ).toBe(true);
  });

  test('supports exactly the four EMO-UC-048 boundaries', () => {
    expect(CORTEX_LOCAL_QA_FAULT_BOUNDARIES).toEqual([
      'cortex_ledger_first_write',
      'web_replay_persistence',
      'web_redis_publish_ack',
      'telegram_promoted_parent_presentation',
    ]);
  });
});
