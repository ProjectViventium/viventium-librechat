import { createMainContinuityService, mainCompactionCandidateDigest } from './mainContinuity';
import type {
  AcceptedMainTurn,
  MainContinuityState,
  MainContinuityHistory,
} from './mainContinuity';

const identity = {
  ownerId: 'legacy-owner',
  agentId: 'main',
  stableAuthoritySha256: 'a'.repeat(64),
};
const summary = {
  version: 1 as const,
  summary: 'Historic work remains pending.',
  pendingAsks: [],
  commitments: [],
  corrections: [],
  decisions: [],
  durableIdentifiers: [],
  recurrenceOutcomes: [],
  toolPairs: [],
};

function fixture(count: number, bytes = 1000, historicalSummary = false) {
  const states = new Map<string, MainContinuityState>();
  const unavailable = new Set<number>(),
    retired = new Set<number>();
  let generation = 0;
  const turns: AcceptedMainTurn[] = Array.from({ length: count }, (_, i) => ({
    logicalTurnId: `old-${i}`,
    revision: 1,
    conversationId: 'old-conversation',
    userMessageId: `u-${i}`,
    assistantMessageId: `a-${i}`,
    origin: 'interactive',
    userText: `Whole source ${i}: ${'x'.repeat(bytes)} END-${i}`,
    assistantText: `Answer ${i}.`,
    committedAt: new Date(0),
    toolPairs: [],
  }));
  const legacy: MainContinuityHistory['legacy'] = async (_identity, cursor) => {
    if (cursor.state === 'artifact' && !cursor.range)
      return { artifact: null, stateCursor: 'artifact', messageCursor: '', complete: true };
    const start = cursor.range?.start ?? cursor.sourceOffset ?? 0;
    const end = cursor.range?.end ?? Math.min(start + 64, count);
    const refs = turns.slice(start, end);
    return {
      artifact: {
        kind: 'legacy_state',
        id: 'artifact',
        semanticCompaction: historicalSummary ? summary : null,
        sourceTurns: refs,
        sourceRange: { artifactId: 'artifact', start, end, total: count },
        retiredSources: refs
          .filter((t) => retired.has(Number(t.logicalTurnId.slice(4))))
          .map((t) => ({ logicalTurnId: t.logicalTurnId, revision: 1, reason: 'source_deleted' })),
      },
      stateCursor: 'artifact',
      messageCursor: '',
      complete: false,
    };
  };
  const create = () =>
    createMainContinuityService({
      logger: { warn: jest.fn() },
      history: {
        read: async () => ({ position: 0, generation, count: 0, turns: [], legacyAvailable: true }),
        legacy,
        fence: async (_identity, _turns, operation) => operation(),
      },
      persistence: {
        read: async (key) => states.get(key) || null,
        create: async (state) => {
          states.set(state.domainEpochKey, state);
          return true;
        },
        compareAndSwap: async (key, version, state) => {
          if (states.get(key)?.version !== version) return false;
          states.set(key, { ...state, version: version + 1 });
          return true;
        },
      },
      loadPresentations: async (owner, ids) =>
        ids.flatMap((id) => {
          const i = Number(id.slice(2)),
            turn = turns[i];
          if (!turn || unavailable.has(i)) return [];
          return [
            {
              assistant: {
                user: owner,
                messageId: id,
                parentMessageId: turn.userMessageId,
                conversationId: turn.conversationId,
                text: turn.assistantText,
                metadata: { viventium: { mainContext: { agentId: 'main' } } },
              },
              userMessage: {
                user: owner,
                messageId: turn.userMessageId,
                conversationId: turn.conversationId,
                isCreatedByUser: true,
                text: turn.userText,
              },
              conversation: { user: owner, conversationId: turn.conversationId, agent_id: 'main' },
            },
          ];
        }),
    });
  const complete = (service: ReturnType<typeof create>, claim: Record<string, unknown>) =>
    service.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: summary,
      semanticReview: {
        version: 1,
        approved: true,
        sourceDigest: claim.sourceDigest,
        candidateDigest: mainCompactionCandidateDigest(summary),
      },
    });
  return {
    create,
    complete,
    turns,
    states,
    unavailable,
    retired,
    changeGeneration: () => generation++,
  };
}

test('many independent legacy turns progress as whole bounded prefixes across reload', async () => {
  const f = fixture(70, 5000),
    original = JSON.stringify(f.turns),
    seen: string[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    const service = f.create();
    const claim = await service.claimAcceptedMainCompaction(identity);
    if (claim.status === 'empty') break;
    expect(claim.status).toBe('claimed');
    const artifacts = claim.legacyInputs as Array<{ sourceTurns: AcceptedMainTurn[] }>;
    expect(artifacts[0].sourceTurns.length).toBeLessThan(64);
    for (const t of artifacts[0].sourceTurns) {
      expect(t.userText.endsWith(`END-${t.logicalTurnId.slice(4)}`)).toBe(true);
      seen.push(t.logicalTurnId);
    }
    expect(await f.complete(service, claim)).toMatchObject({ status: 'compacted' });
  }
  expect(seen).toEqual(f.turns.map((t) => t.logicalTurnId));
  expect(JSON.stringify(f.turns)).toBe(original);
});

test('missing reference stops coverage; restoration resumes that exact position', async () => {
  const f = fixture(4);
  f.unavailable.add(1);
  const s = f.create(),
    first = await s.claimAcceptedMainCompaction(identity);
  expect(
    (first.legacyInputs as Array<{ sourceTurns: AcceptedMainTurn[] }>)[0].sourceTurns,
  ).toHaveLength(1);
  expect(await f.complete(s, first)).toMatchObject({ status: 'compacted' });
  expect(await s.claimAcceptedMainCompaction(identity)).toMatchObject({
    status: 'degraded',
    reason: 'source_unavailable',
  });
  f.unavailable.delete(1);
  const next = await f.create().claimAcceptedMainCompaction(identity);
  expect(
    (next.legacyInputs as Array<{ sourceTurns: AcceptedMainTurn[] }>)[0].sourceTurns[0]
      .logicalTurnId,
  ).toBe('old-1');
});

test('rejected review and another epoch cannot consume a claimed prefix', async () => {
  const f = fixture(25, 5000),
    s = f.create(),
    first = await s.claimAcceptedMainCompaction(identity);
  await s.rejectAcceptedMainCompaction({
    ...identity,
    leaseId: first.leaseId,
    reason: 'review_unavailable',
  });
  const next = await f.create().claimAcceptedMainCompaction(identity);
  expect(next.sourceDigest).toBe(first.sourceDigest);
  const other = await s.claimAcceptedMainCompaction({
    ...identity,
    stableAuthoritySha256: 'b'.repeat(64),
  });
  expect(other.legacyInputs).toEqual(first.legacyInputs);
});

test('completion uses the leased range even if a cache offset changes', async () => {
  const f = fixture(25, 5000),
    s = f.create(),
    claim = await s.claimAcceptedMainCompaction(identity);
  const [key, state] = [...f.states.entries()][0];
  f.states.set(key, { ...state, legacySourceOffset: 20 });
  expect(await f.complete(s, claim)).toMatchObject({ status: 'compacted' });
  expect(f.states.get(key)?.legacySourceOffset).toBeLessThan(20);
});

test.each([false, true])('retired-only artifact with historical summary=%s', async (hasSummary) => {
  const f = fixture(4, 1000, hasSummary);
  [0, 1, 2, 3].forEach((i) => f.retired.add(i));
  const claim = await f.create().claimAcceptedMainCompaction(identity);
  expect(claim.status).toBe(hasSummary ? 'claimed' : 'empty');
});

test('later retired-only slice still reconciles the historical summary it can change', async () => {
  const f = fixture(70, 20, true);
  for (let i = 64; i < 70; i++) f.retired.add(i);
  const s = f.create(),
    first = await s.claimAcceptedMainCompaction(identity);
  expect(await f.complete(s, first)).toMatchObject({ status: 'compacted' });
  const next = await f.create().claimAcceptedMainCompaction(identity);
  expect(next.status).toBe('claimed');
  const artifact = (next.legacyInputs as Array<Record<string, unknown>>)[0];
  expect(artifact.sourceRange).toMatchObject({ start: 64, end: 70 });
  expect(artifact.sourceTurns).toEqual([]);
  expect(artifact.retiredSources).toHaveLength(6);
  expect(artifact.semanticCompaction).not.toBeNull();
  await s.rejectAcceptedMainCompaction({
    ...identity,
    leaseId: next.leaseId,
    reason: 'semantic_fidelity',
  });
  expect([...f.states.values()][0].legacySourceOffset).toBe(64);
});

test('one oversized turn remains whole and unconsumed after provider failure', async () => {
  const f = fixture(1, 100000),
    s = f.create(),
    claim = await s.claimAcceptedMainCompaction(identity);
  expect(
    (claim.legacyInputs as Array<{ sourceTurns: AcceptedMainTurn[] }>)[0].sourceTurns[0].userText,
  ).toBe(f.turns[0].userText);
  await s.rejectAcceptedMainCompaction({
    ...identity,
    leaseId: claim.leaseId,
    reason: 'provider_context_rejected',
  });
  expect((await s.claimAcceptedMainCompaction(identity)).sourceDigest).toBe(claim.sourceDigest);
});

test('deletion or edited source after claim rejects promotion without advancing coverage', async () => {
  const f = fixture(4),
    s = f.create(),
    claim = await s.claimAcceptedMainCompaction(identity);
  f.unavailable.add(0);
  f.changeGeneration();
  expect(await f.complete(s, claim)).toMatchObject({ status: 'stale_source' });
  expect([...f.states.values()][0].legacyStateCursor).toBe('');
});
