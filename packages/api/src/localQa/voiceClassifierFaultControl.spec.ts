import { createHash, createHmac } from 'crypto';
import {
  createMongooseVoiceClassifierFaultControlStore,
  createVoiceClassifierFaultControlManager,
  type VoiceClassifierFaultControlRow,
  type VoiceClassifierFaultControlManagerOptions,
  type VoiceClassifierFaultControlStore,
  type VoiceClassifierFaultTurnBinding,
} from './voiceClassifierFaultControl';

const TOKEN = Buffer.alloc(32, 7).toString('base64url');
const HASH = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const NOW = new Date('2026-08-26T12:00:00.000Z');

class MemoryStore implements VoiceClassifierFaultControlStore {
  readonly rows: VoiceClassifierFaultControlRow[] = [];
  unavailable = false;

  private assertAvailable() {
    if (this.unavailable) throw new Error('database unavailable');
  }

  async insert(row: VoiceClassifierFaultControlRow) {
    this.assertAvailable();
    if (this.rows.some((candidate) => candidate.armBindingHash === row.armBindingHash)) {
      throw Object.assign(new Error('duplicate'), { code: 11000 });
    }
    this.rows.push(structuredClone(row));
    return structuredClone(row);
  }

  async findByArmBinding(armBindingHash: string) {
    this.assertAvailable();
    const row = this.rows.find((candidate) => candidate.armBindingHash === armBindingHash);
    return row ? structuredClone(row) : null;
  }

  async findByControlId(controlId: string) {
    this.assertAvailable();
    const row = this.rows.find((candidate) => candidate.controlId === controlId);
    return row ? structuredClone(row) : null;
  }

  async challenge(query: Parameters<VoiceClassifierFaultControlStore['challenge']>[0]) {
    this.assertAvailable();
    const row = this.rows.find(
      (candidate) =>
        candidate.controlId === query.controlId &&
        candidate.armBindingHash === query.armBindingHash &&
        candidate.state === 'armed' &&
        candidate.expiresAt === query.expectedExpiresAt &&
        new Date(candidate.expiresAt).getTime() > new Date(query.issuedAt).getTime(),
    );
    if (!row) return null;
    Object.assign(row, query.challenge, { state: 'challenged' as const });
    return structuredClone(row);
  }

  async approve(query: Parameters<VoiceClassifierFaultControlStore['approve']>[0]) {
    this.assertAvailable();
    const row = this.rows.find(
      (candidate) =>
        candidate.controlId === query.controlId &&
        candidate.challengeId === query.challengeId &&
        candidate.state === 'challenged' &&
        candidate.challengeExpiresAt === query.expectedChallengeExpiresAt &&
        new Date(candidate.challengeExpiresAt).getTime() > new Date(query.checkedAt).getTime(),
    );
    if (!row) return null;
    row.state = 'approved';
    row.approvedAt = query.approvedAt;
    row.approvalProof = query.approvalProof;
    return structuredClone(row);
  }

  async consume(query: Parameters<VoiceClassifierFaultControlStore['consume']>[0]) {
    this.assertAvailable();
    const row = this.rows.find(
      (candidate) =>
        candidate.controlId === query.controlId &&
        candidate.challengeId === query.challengeId &&
        candidate.state === 'approved' &&
        candidate.challengeExpiresAt === query.expectedChallengeExpiresAt &&
        new Date(candidate.challengeExpiresAt).getTime() > new Date(query.checkedAt).getTime(),
    );
    if (!row) return null;
    row.state = 'consumed';
    row.consumedAt = query.consumedAt;
    row.receiptExpiresAt = query.receiptExpiresAt;
    row.receiptDigest = query.receiptDigest;
    return structuredClone(row);
  }

  async clear(query: Parameters<VoiceClassifierFaultControlStore['clear']>[0]) {
    this.assertAvailable();
    let changed = 0;
    for (const row of this.rows) {
      if (row.armBindingHash !== query.armBindingHash || row.state === 'consumed') continue;
      row.state = 'cleared';
      row.clearedAt = query.clearedAt;
      changed += 1;
    }
    return changed;
  }

  async removeConsumed(query: Parameters<VoiceClassifierFaultControlStore['removeConsumed']>[0]) {
    this.assertAvailable();
    const index = this.rows.findIndex(
      (row) =>
        row.controlId === query.controlId &&
        row.state === 'consumed' &&
        row.receiptDigest === query.receiptDigest,
    );
    if (index < 0) return 0;
    this.rows.splice(index, 1);
    return 1;
  }
}

function env(): NodeJS.ProcessEnv {
  return {
    VIVENTIUM_LOCAL_QA_CASE_ID: 'MPV-061',
    VIVENTIUM_LOCAL_QA_MODE: 'mpv_061',
    VIVENTIUM_LOCAL_QA_CASE_TOKEN: TOKEN,
    VIVENTIUM_LOCAL_QA_SESSION_REF: 'qa_0123456789abcdef01234567',
    VIVENTIUM_LOCAL_QA_COMPONENT_ARTIFACT_DIGEST: HASH('component'),
    VIVENTIUM_LOCAL_QA_CANDIDATE_DIGEST: HASH('candidate'),
  };
}

function binding(
  overrides: Partial<VoiceClassifierFaultTurnBinding> = {},
): VoiceClassifierFaultTurnBinding {
  return {
    caseId: 'MPV-061',
    sessionRef: 'qa_0123456789abcdef01234567',
    candidateDigest: HASH('candidate'),
    componentArtifactDigest: HASH('component'),
    installedArtifactDigest: HASH('installed'),
    runtimeOwnerBindingHash: HASH('runtime-owner'),
    ownerId: '64a000000000000000000001',
    callSessionId: 'call-synthetic-1',
    turnId: 'turn-synthetic-1',
    segments: [
      { segmentId: 'segment-a', revision: 2 },
      { segmentId: 'segment-b', revision: 1 },
    ],
    utteranceHash: HASH('canonical owner utterance'),
    primary: { provider: 'xai', model: 'grok-4.5' },
    fallback: { provider: 'openAI', model: 'gpt-5.6-terra' },
    ...overrides,
  };
}

function manager(
  store: MemoryStore,
  options: Partial<VoiceClassifierFaultControlManagerOptions> = {},
) {
  return createVoiceClassifierFaultControlManager({
    store,
    env: env(),
    now: () => NOW,
    randomBytes: (size) => Buffer.alloc(size, 9),
    coreSigningKey: Buffer.alloc(32, 11),
    verifySyntheticOwner: async ({ ownerId, callSessionId }) =>
      ownerId === binding().ownerId && callSessionId === binding().callSessionId,
    ...options,
  });
}

function managerRowFixture(): VoiceClassifierFaultControlRow {
  const current = binding();
  return {
    schemaVersion: 1,
    controlId: 'mpv061_' + Buffer.alloc(18, 1).toString('base64url'),
    caseId: 'MPV-061',
    sessionRefHash: HASH(current.sessionRef),
    sessionCandidateDigest: HASH('candidate'),
    caseTokenHash: HASH('token'),
    candidateDigest: current.candidateDigest,
    componentArtifactDigest: current.componentArtifactDigest,
    installedArtifactDigest: current.installedArtifactDigest,
    runtimeOwnerBindingHash: current.runtimeOwnerBindingHash,
    ownerScopeHash: HASH(current.ownerId),
    callScopeHash: HASH(current.callSessionId),
    utteranceHash: current.utteranceHash,
    primaryProvider: current.primary.provider,
    primaryModel: current.primary.model,
    fallbackProvider: current.fallback.provider,
    fallbackModel: current.fallback.model,
    armBindingHash: HASH('arm'),
    syntheticScope: true,
    state: 'armed',
    armedAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    purgeAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
  };
}

describe('MPV-061 strict Voice classifier fallback control', () => {
  test('Mongo adapter uses exact CAS filters and receipt-bound cleanup', async () => {
    const created = { toObject: () => ({ ...managerRowFixture(), armedAt: NOW }) };
    const findOneAndUpdate = jest.fn().mockResolvedValue(created);
    const deleteOne = jest.fn().mockResolvedValue({ deletedCount: 1 });
    const model = {
      create: jest.fn().mockResolvedValue(created),
      findOne: jest.fn(() => ({ lean: async () => null })),
      findOneAndUpdate,
      deleteOne,
    };
    const mongo = createMongooseVoiceClassifierFaultControlStore(model);
    const row = managerRowFixture();

    await mongo.challenge({
      controlId: row.controlId,
      armBindingHash: row.armBindingHash,
      expectedExpiresAt: row.expiresAt,
      issuedAt: NOW.toISOString(),
      challenge: {
        challengeId: 'mpv061_ch_' + Buffer.alloc(18, 2).toString('base64url'),
        challengeIssuedAt: NOW.toISOString(),
        challengeExpiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
        replayExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        turnId: 'turn-synthetic-1',
        segments: [{ segmentId: 'segment-a', revision: 1 }],
        turnScopeHash: HASH('turn'),
        segmentSetHash: HASH('segments'),
        turnBindingHash: HASH('turn-binding'),
        utteranceHash: HASH('utterance'),
        coreProof: Buffer.alloc(32, 3).toString('base64url'),
      },
    });
    expect(findOneAndUpdate).toHaveBeenCalledWith(
      {
        controlId: row.controlId,
        armBindingHash: row.armBindingHash,
        state: 'armed',
        expiresAt: {
          $eq: new Date(row.expiresAt),
          $gt: NOW,
        },
      },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'challenged' }) }),
      { new: true, runValidators: true },
    );

    const challengeExpiresAt = new Date(NOW.getTime() + 5_000).toISOString();
    await mongo.approve({
      controlId: row.controlId,
      challengeId: 'mpv061_ch_' + Buffer.alloc(18, 2).toString('base64url'),
      expectedChallengeExpiresAt: challengeExpiresAt,
      checkedAt: NOW.toISOString(),
      approvedAt: NOW.toISOString(),
      approvalProof: Buffer.alloc(32, 4).toString('base64url'),
    });
    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      2,
      {
        controlId: row.controlId,
        challengeId: 'mpv061_ch_' + Buffer.alloc(18, 2).toString('base64url'),
        state: 'challenged',
        challengeExpiresAt: {
          $eq: new Date(challengeExpiresAt),
          $gt: NOW,
        },
      },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'approved' }) }),
      { new: true, runValidators: true },
    );

    await mongo.consume({
      controlId: row.controlId,
      challengeId: 'mpv061_ch_' + Buffer.alloc(18, 2).toString('base64url'),
      expectedChallengeExpiresAt: challengeExpiresAt,
      checkedAt: NOW.toISOString(),
      consumedAt: NOW.toISOString(),
      receiptExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      receiptDigest: HASH('receipt'),
    });
    expect(findOneAndUpdate).toHaveBeenNthCalledWith(
      3,
      {
        controlId: row.controlId,
        challengeId: 'mpv061_ch_' + Buffer.alloc(18, 2).toString('base64url'),
        state: 'approved',
        challengeExpiresAt: {
          $eq: new Date(challengeExpiresAt),
          $gt: NOW,
        },
      },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'consumed' }) }),
      { new: true, runValidators: true },
    );

    await mongo.removeConsumed({ controlId: row.controlId, receiptDigest: HASH('receipt') });
    expect(deleteOne).toHaveBeenCalledWith({
      controlId: row.controlId,
      state: 'consumed',
      receiptDigest: HASH('receipt'),
    });
  });
  test('remains inactive unless the exact local PRE-GATE session is enabled', async () => {
    const store = new MemoryStore();
    const control = createVoiceClassifierFaultControlManager({
      store,
      env: {},
      now: () => NOW,
      randomBytes: (size) => Buffer.alloc(size, 9),
      coreSigningKey: Buffer.alloc(32, 11),
      verifySyntheticOwner: async () => true,
    });

    await expect(control.issueChallenge(binding())).resolves.toEqual({ active: false });
    expect(store.rows).toHaveLength(0);
  });

  test('an enabled environment alone cannot mint or trigger a fault', async () => {
    const store = new MemoryStore();

    await expect(manager(store).issueChallenge(binding())).resolves.toEqual({ active: false });
    expect(store.rows).toHaveLength(0);
  });

  test('rejects personal or unverified owners before durable arm', async () => {
    const store = new MemoryStore();
    const control = manager(store, { verifySyntheticOwner: async () => false });

    await expect(control.arm(binding())).rejects.toMatchObject({
      code: 'voice_classifier_qa_synthetic_owner_unverified',
    });
    expect(store.rows).toHaveLength(0);
  });

  test('an exact arm leaves an adjacent synthetic call inactive', async () => {
    const store = new MemoryStore();
    const control = manager(store);
    await control.arm(binding());

    await expect(
      control.issueChallenge(binding({ callSessionId: 'adjacent-synthetic-call' })),
    ).resolves.toEqual({ active: false });
    expect(store.rows[0]).toMatchObject({ state: 'armed' });
  });

  test('uses arm -> Core challenge -> parent approval -> atomic consume', async () => {
    const store = new MemoryStore();
    const control = manager(store);
    const armed = await control.arm(binding());
    expect(store.rows[0]).toMatchObject({
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
      purgeAt: new Date(NOW.getTime() + 24 * 60 * 60_000).toISOString(),
    });
    const challenge = await control.issueChallenge(binding());
    expect(challenge).toMatchObject({ active: true, controlId: armed.controlId });
    if (!challenge.active) throw new Error('challenge missing');
    expect(store.rows[0]).toMatchObject({
      turnId: binding().turnId,
      segments: binding().segments,
      utteranceHash: binding().utteranceHash,
      challengeExpiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
      replayExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
    });

    const approvalProof = createHmac('sha256', Buffer.from(TOKEN, 'base64url'))
      .update(challenge.approvalPayload)
      .digest('base64url');
    await control.approve({
      controlId: challenge.controlId,
      challengeId: challenge.challengeId,
      binding: binding(),
      approvalProof,
    });
    const consumed = await control.consume({
      controlId: challenge.controlId,
      challengeId: challenge.challengeId,
      binding: binding(),
    });

    expect(consumed).toMatchObject({
      consumed: true,
      controlId: armed.controlId,
      receiptExpiresAt: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
      failure: 'provider_temporarily_unavailable',
      preModel: true,
    });
    expect(consumed.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    await expect(
      control.consume({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
      }),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_control_replayed' });
  });

  test('rejects duplicate arms and stale challenges with typed errors', async () => {
    const store = new MemoryStore();
    let current = NOW;
    const control = manager(store, { now: () => current });
    await control.arm(binding());
    await expect(control.arm(binding())).rejects.toMatchObject({
      code: 'voice_classifier_qa_control_already_armed',
    });
    const challenge = await control.issueChallenge(binding());
    if (!challenge.active) throw new Error('challenge missing');
    current = new Date(NOW.getTime() + 5_001);
    const approvalProof = createHmac('sha256', Buffer.from(TOKEN, 'base64url'))
      .update(challenge.approvalPayload)
      .digest('base64url');
    await expect(
      control.approve({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
        approvalProof,
      }),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_challenge_expired' });
  });

  test.each([
    ['candidateDigest', HASH('wrong-candidate')],
    ['componentArtifactDigest', HASH('wrong-component')],
    ['installedArtifactDigest', HASH('wrong-install')],
    ['runtimeOwnerBindingHash', HASH('wrong-runtime')],
    ['ownerId', '64a000000000000000000002'],
    ['callSessionId', 'wrong-call'],
    ['turnId', 'wrong-turn'],
    ['utteranceHash', HASH('wrong-utterance')],
    ['segments', [{ segmentId: 'segment-a', revision: 3 }]],
    ['segments', [{ segmentId: 'wrong-segment', revision: 2 }]],
    ['primary', { provider: 'wrong-primary', model: 'grok-4.5' }],
    ['primary', { provider: 'xai', model: 'wrong-primary' }],
    ['fallback', { provider: 'wrong-fallback', model: 'gpt-5.6-terra' }],
    ['fallback', { provider: 'openAI', model: 'wrong-fallback' }],
  ])('rejects a mismatched %s binding', async (field, value) => {
    const store = new MemoryStore();
    const control = manager(store);
    await control.arm(binding());
    const challenge = await control.issueChallenge(binding());
    expect(challenge.active).toBe(true);
    if (!challenge.active) throw new Error('challenge missing');
    const approvalProof = createHmac('sha256', Buffer.from(TOKEN, 'base64url'))
      .update(challenge.approvalPayload)
      .digest('base64url');
    await control.approve({
      controlId: challenge.controlId,
      challengeId: challenge.challengeId,
      binding: binding(),
      approvalProof,
    });

    await expect(
      control.consume({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding({ [field]: value }),
      }),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_binding_mismatch' });
  });

  test('rejects a mismatched local-QA session binding', async () => {
    const store = new MemoryStore();
    const control = manager(store);
    await control.arm(binding());

    await expect(
      control.issueChallenge(binding({ sessionRef: 'qa_ffffffffffffffffffffffff' })),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_binding_invalid' });
  });

  test('rejects forged parent approval and a challenge from an older Core process', async () => {
    const store = new MemoryStore();
    const firstCore = manager(store);
    await firstCore.arm(binding());
    const challenge = await firstCore.issueChallenge(binding());
    expect(challenge.active).toBe(true);
    if (!challenge.active) throw new Error('challenge missing');
    await expect(
      firstCore.approve({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
        approvalProof: Buffer.alloc(32, 4).toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_parent_proof_invalid' });

    const secondCore = manager(store, { coreSigningKey: Buffer.alloc(32, 12) });
    await expect(
      secondCore.consume({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
      }),
    ).rejects.toMatchObject({ code: 'voice_classifier_qa_restart_challenge_invalid' });
  });

  test('fails closed on parent or database unavailability only after an exact arm is found', async () => {
    const store = new MemoryStore();
    const control = manager(store, {
      sleep: async () => {},
      approvalWaitMs: 1,
      pollIntervalMs: 1,
    });
    await control.arm(binding());
    await expect(control.run(binding())).rejects.toMatchObject({
      code: 'voice_classifier_qa_parent_unavailable',
      status: 503,
    });

    store.unavailable = true;
    await expect(control.issueChallenge(binding())).rejects.toMatchObject({
      code: 'voice_classifier_qa_store_unavailable',
      status: 503,
    });
  });

  test('permits exactly one concurrent consume and removes only the copied receipt', async () => {
    const store = new MemoryStore();
    const control = manager(store);
    const armed = await control.arm(binding());
    const challenge = await control.issueChallenge(binding());
    if (!challenge.active) throw new Error('challenge missing');
    const approvalProof = createHmac('sha256', Buffer.from(TOKEN, 'base64url'))
      .update(challenge.approvalPayload)
      .digest('base64url');
    await control.approve({
      controlId: challenge.controlId,
      challengeId: challenge.challengeId,
      binding: binding(),
      approvalProof,
    });
    const settled = await Promise.allSettled([
      control.consume({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
      }),
      control.consume({
        controlId: challenge.controlId,
        challengeId: challenge.challengeId,
        binding: binding(),
      }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const receipt = settled.find((result) => result.status === 'fulfilled');
    if (!receipt || receipt.status !== 'fulfilled') throw new Error('receipt missing');
    await expect(
      control.cleanup({
        controlId: armed.controlId,
        receiptDigest: receipt.value.receiptDigest,
      }),
    ).resolves.toEqual({ removed: 1 });
    expect(store.rows).toHaveLength(0);
  });
});
