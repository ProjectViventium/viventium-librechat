import {
  createMainContinuityService,
  mainMessageDelivery,
  isAcceptedMainProjectionComplete,
  projectAcceptedMainMessages,
  prepareMainContinuityCarrier,
  buildMainContinuityHeaders,
  assertMainContinuityCarrier,
  createMainContinuityFetch,
  withMainContinuityCallbacks,
  prepareMainCompactionCandidate,
  inspectMainCompactionCandidate,
  mainCompactionOutputConstraints,
  mainCompactionCandidateDigest,
  buildAcceptedMainContextCapsule,
  canDeferAcceptedMainCompaction,
} from './mainContinuity';
import type { AcceptedMainTurn, MainContinuityState } from './mainContinuity';
import { ChatOpenAI } from '@langchain/openai';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { formatAgentMessages, formatContentStrings } from '@librechat/agents';

describe('native source carrier preparation', () => {
  test('preserves tool results and non-text blocks and leaves other routes untouched', () => {
    const messages = [
      new ToolMessage({
        id: 'tool-result',
        tool_call_id: 'tool-call',
        content: [{ type: 'text', text: 'Exact tool result.' }],
      }),
      new AIMessage({
        id: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Preserved native block.', signature: 'synthetic' },
          { type: 'text', text: 'Visible result.' },
        ],
      }),
    ];
    const before = messages.map((message) => message.toDict());
    expect(prepareMainContinuityCarrier(messages, false)).toBe(messages);
    expect(prepareMainContinuityCarrier(messages, true).map((message) => message.toDict())).toEqual(
      before,
    );
  });

  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'preserves a fourth turn through the SDK (legacy=%s, stream=%s)',
    async (legacy, streaming) => {
      const payload = Array.from({ length: 7 }, (_, index) => ({
        messageId: `source-${index}`,
        role: index % 2 ? 'assistant' : 'user',
        ...(index % 2
          ? { content: [{ type: 'text' as const, text: `Synthetic answer ${index}.` }] }
          : { text: `Synthetic question ${index}.` }),
      }));
      const formatted = formatAgentMessages(payload).messages;
      const messages = prepareMainContinuityCarrier(formatted, legacy);
      const protectedIds = payload.slice(0, 6).map((message) => message.messageId);
      const chainKey = 'X-Viventium-Visible-Message-Chain-B64';
      const headers = buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages,
        sourceMessageIds: protectedIds,
        logicalTurnId: 'fourth-turn',
      });
      // The real graph repeats its own native formatter immediately before SDK invocation.
      if (legacy) formatContentStrings(messages);
      const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(
          body.metadata.visible_message_chain
            .filter((item: { accepted_source: boolean }) => item.accepted_source)
            .map((item: { id: string }) => item.id),
        ).toEqual(protectedIds);
        expect(
          body.messages.map((message: { content: string | Array<{ text: string }> }) =>
            typeof message.content === 'string'
              ? message.content
              : message.content.map((part) => part.text).join('\n'),
          ),
        ).toEqual(
          payload.map((_, index) => `Synthetic ${index % 2 ? 'answer' : 'question'} ${index}.`),
        );
        if (streaming)
          return new Response(
            'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Kept."},"finish_reason":null}]}\n\ndata: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return new Response(
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion',
            model: 'synthetic',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const model = new ChatOpenAI({
        model: 'synthetic',
        apiKey: 'synthetic',
        maxRetries: 0,
        streaming,
        callbacks: withMainContinuityCallbacks(undefined, headers[chainKey], true),
        configuration: {
          baseURL: 'https://provider.invalid/v1',
          fetch: createMainContinuityFetch(baseFetch, headers[chainKey]),
        },
      });
      if (streaming)
        for await (const _chunk of await model.stream(messages)) {
          /* consume */
        }
      else await model.invoke(messages);
      expect(baseFetch).toHaveBeenCalledTimes(1);
    },
  );

  test('leaves multimodal content intact and rejects later source changes', () => {
    const user = new HumanMessage({
      id: 'image-source',
      content: [
        { type: 'text', text: 'Describe this image.' },
        { type: 'image_url', image_url: { url: 'https://synthetic.invalid/source.png' } },
      ],
    });
    const assistant = new AIMessage({
      id: 'answer-source',
      content: [
        { type: 'text', text: 'First paragraph.' },
        { type: 'text', text: 'Second paragraph.' },
      ],
    });
    const imageContent = structuredClone(user.content);
    const messages = prepareMainContinuityCarrier([user, assistant], true);
    const chain = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages,
      sourceMessageIds: ['image-source', 'answer-source'],
      logicalTurnId: 'turn',
    })['X-Viventium-Visible-Message-Chain-B64'];
    formatContentStrings(messages);
    expect(user.content).toEqual(imageContent);
    expect(assistant.content).toBe('First paragraph.\nSecond paragraph.');
    expect(() => assertMainContinuityCarrier(messages, chain, true)).not.toThrow();
    for (const changed of [
      [user],
      [assistant, user],
      [user, new AIMessage({ id: 'answer-source', content: 'Different source.' })],
      [user, new AIMessage({ id: 'replacement', content: assistant.content })],
      [
        new HumanMessage({
          id: 'image-source',
          content: [
            { type: 'text', text: 'Describe this image.' },
            { type: 'image_url', image_url: { url: 'https://synthetic.invalid/replacement.png' } },
          ],
        }),
        assistant,
      ],
    ])
      expect(() => assertMainContinuityCarrier(changed, chain, true)).toThrow(
        'A protected original source was removed or changed before provider dispatch',
      );
  });
});

function fixture(sourceRecords?: Map<string, Record<string, unknown>>) {
  const states = new Map<string, MainContinuityState>();
  const accepted = new Map<string, AcceptedMainTurn>();
  let position = 0,
    generation = 0;
  const service = createMainContinuityService({
    logger: { warn: jest.fn() },
    history: {
      read: async (_identity, options = {}) => {
        const turns = [...accepted.values()]
          .filter(
            (turn) =>
              (turn.acceptedPosition || 0) > (options.after || 0) &&
              (turn.acceptedPosition || 0) <= (options.through ?? position),
          )
          .sort(
            (a, b) =>
              ((a.acceptedPosition || 0) - (b.acceptedPosition || 0)) *
              (options.descending ? -1 : 1),
          );
        return {
          position,
          generation,
          count: turns.length,
          legacyAvailable: false,
          turns: turns.slice(0, options.limit || 64),
        };
      },
      legacy: async () => ({ artifact: null, stateCursor: '', messageCursor: '', complete: true }),
      fence: async (_identity, _turns, operation) => operation(),
    },
    commitPresentation: async (_identity, turn, operation) => {
      const prior = accepted.get(turn.logicalTurnId);
      if (prior && prior.revision >= turn.revision)
        return { status: 'already_committed', acceptedRevision: prior.revision };
      const result = await operation();
      if (result.status !== 'committed') return result;
      if (prior) generation++;
      accepted.set(turn.logicalTurnId, {
        ...turn,
        acceptedPosition: ++position,
        ...(sourceRecords ? { userText: '', assistantText: '', toolPairs: [] } : {}),
      });
      return { status: 'committed', version: position, compactionNeeded: true };
    },
    ...(sourceRecords
      ? {
          loadPresentations: async (_owner: string, ids: readonly string[]) =>
            ids.map((id) => {
              const assistant = sourceRecords.get(id) || null;
              return {
                assistant,
                userMessage: assistant
                  ? sourceRecords.get(String(assistant.parentMessageId)) || null
                  : null,
                conversation: assistant
                  ? { user: _owner, conversationId: assistant.conversationId, agent_id: 'main' }
                  : null,
              };
            }),
        }
      : {}),
    persistence: {
      async read(key) {
        return states.get(key) ?? null;
      },
      async create(state) {
        if (states.has(state.domainEpochKey)) return false;
        states.set(state.domainEpochKey, state);
        return true;
      },
      async compareAndSwap(key, version, state) {
        if (states.get(key)?.version !== version) return false;
        states.set(key, { ...state, version: version + 1 });
        return true;
      },
    },
  });
  const identity = {
    ownerId: 'synthetic-owner',
    agentId: 'main',
    stableAuthoritySha256: 'a'.repeat(64),
  };
  const sourceText = 'Prepare the Harbor Studio draft. Never publish before my written approval.';
  async function seed() {
    for (let index = 0; index < 4; index += 1) {
      await service.commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `turn-${index}`,
        revision: 1,
        conversationId: 'synthetic-conversation',
        userMessageId: `user-${index}`,
        assistantMessageId: `assistant-${index}`,
        userText: index === 0 ? sourceText : `Unrelated later request ${index}.`,
        assistantText:
          index === 0 ? 'I will keep the draft private until you approve.' : `Answer ${index}.`,
        origin: 'interactive',
      });
    }
    return service.claimAcceptedMainCompaction(identity);
  }
  return { service, identity, seed, sourceText, states, accepted };
}

const inverse = {
  version: 1,
  summary: 'Harbor Studio: publish the draft immediately without approval.',
  pendingAsks: [],
  commitments: [],
  corrections: [],
  decisions: [],
  durableIdentifiers: [],
  recurrenceOutcomes: [],
  toolPairs: [],
};

describe('accepted compaction fidelity boundary', () => {
  test('does not replace the approval source with an unreviewed polarity inversion', async () => {
    const { service, identity, seed, sourceText } = fixture();
    const claim = await seed();
    const result = await service.completeAcceptedMainCompaction({
      ...identity,
      leaseId: claim.leaseId,
      sourceDigest: claim.sourceDigest,
      semanticCompaction: inverse,
    });
    expect(result.status).toBe('invalid_summary');
    const context = await service.loadAcceptedMainContext(identity);
    expect(context.semanticCompaction).toBeNull();
    expect(context.capsule).toContain(sourceText);
    expect(context.capsule).not.toContain(inverse.summary);
  });
});

const faithful = {
  ...inverse,
  summary: 'The Harbor Studio draft must stay private until the owner approves in writing.',
};

describe('model-owned reference materiality and structural feedback', () => {
  const source = {
    previousSemanticCompaction: null,
    sourceTurns: [
      {
        userText: Array.from({ length: 40 }, (_, i) => `CASE-${i}`).join(', '),
        assistantText: 'Only the first five references concern pending work.',
      },
    ] as AcceptedMainTurn[],
  };
  test('does not force incidental references into a faithful model proposal', () => {
    const candidate = {
      ...faithful,
      durableIdentifiers: ['CASE-0', 'CASE-1', 'CASE-2', 'CASE-3', 'CASE-4'],
    };
    expect(prepareMainCompactionCandidate(candidate, source)).toEqual(candidate);
  });
  test('keeps forty meaningful references verbatim within bounded summary text', () => {
    const candidate = {
      ...faithful,
      summary: `Every case needs review: ${source.sourceTurns[0].userText}`,
    };
    expect(prepareMainCompactionCandidate(candidate, source)).toEqual(candidate);
  });
  test('reports the actual array constraint without truncating an invalid proposal', () => {
    const candidate = {
      ...faithful,
      durableIdentifiers: Array.from({ length: 33 }, (_, i) => `case ${i}`),
    };
    expect(inspectMainCompactionCandidate(candidate)).toEqual({
      ok: false,
      issue: {
        path: 'durableIdentifiers',
        constraint: 'max_items',
        actual: 33,
        limit: mainCompactionOutputConstraints.maxItemsPerArray,
        unit: 'items',
      },
    });
    expect(prepareMainCompactionCandidate(candidate, source)).toBeNull();
  });
  test('reports UTF-8 byte limits without treating characters as bytes', () => {
    const candidate = { ...faithful, pendingAsks: ['é'.repeat(513)] };
    expect(inspectMainCompactionCandidate(candidate)).toEqual({
      ok: false,
      issue: {
        path: 'pendingAsks.0',
        constraint: 'max_bytes',
        actual: 1026,
        limit: mainCompactionOutputConstraints.maxStringItemUtf8Bytes,
        unit: 'utf8_bytes',
      },
    });
  });
});

function reviewFor(claim: Record<string, unknown>, candidate: typeof inverse) {
  const prepared = prepareMainCompactionCandidate(candidate, {
    previousSemanticCompaction: null,
    sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
  });
  if (!prepared) throw new Error('invalid test candidate');
  return {
    version: 1,
    approved: true,
    sourceDigest: claim.sourceDigest,
    candidateDigest: mainCompactionCandidateDigest(prepared),
  };
}

test('accepts a reviewed faithful paraphrase and survives reloading the persisted state', async () => {
  const { service, identity, seed } = fixture();
  const claim = await seed();
  expect(
    await service.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: faithful,
      semanticReview: reviewFor(claim, faithful),
    }),
  ).toMatchObject({ status: 'compacted' });
  const loaded = await service.loadAcceptedMainContext(identity);
  expect(loaded.pendingCompactionTurns).toEqual([]);
  expect(loaded.capsule).toContain(faithful.summary);
  expect((await service.loadAcceptedMainContext(identity)).capsule).toBe(loaded.capsule);
});

test.each(['candidate', 'source'])(
  'rejects an approval bound to a different %s',
  async (changed) => {
    const { service, identity, seed } = fixture();
    const claim = await seed();
    const review = reviewFor(claim, faithful);
    if (changed === 'source') review.sourceDigest = 'b'.repeat(64);
    expect(
      await service.completeAcceptedMainCompaction({
        ...identity,
        ...claim,
        semanticCompaction: changed === 'candidate' ? inverse : faithful,
        semanticReview: review,
      }),
    ).toMatchObject({ status: 'invalid_summary', reason: 'semantic_review_required' });
    expect((await service.loadAcceptedMainContext(identity)).semanticCompaction).toBeNull();
  },
);

test('rejects an oversized summary instead of truncating away its final restriction', async () => {
  const { service, identity, seed } = fixture();
  const claim = await seed();
  expect(
    await service.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: { ...inverse, summary: 'Context '.repeat(1000) + 'Do not publish.' },
    }),
  ).toMatchObject({ status: 'invalid_summary', reason: 'schema_invalid' });
  expect((await service.loadAcceptedMainContext(identity)).semanticCompaction).toBeNull();
});

test('never byte-slices a reviewed summary into a different delivered meaning', () => {
  const summary =
    'A <quoted> draft remains pending. '.repeat(150) + 'Written approval is still required.';
  const capsule = buildAcceptedMainContextCapsule({ semanticCompaction: { ...faithful, summary } });
  if (capsule.includes('<semantic_compaction version=')) {
    expect(capsule).toContain('Written approval is still required.');
    expect(capsule).not.toContain('...');
  } else {
    expect(capsule).toContain('<semantic_compaction_unavailable reason="context_budget" />');
  }
});

describe('automatic compaction pressure', () => {
  const turn = (index: number, userText = `Request ${index}.`): AcceptedMainTurn => ({
    logicalTurnId: `pending-${index}`,
    revision: 1,
    conversationId: 'synthetic',
    userMessageId: `user-${index}`,
    assistantMessageId: `assistant-${index}`,
    origin: 'interactive',
    userText,
    assistantText: 'Still pending.',
    toolPairs: [],
    committedAt: new Date('2026-09-04T00:00:00Z'),
  });
  test('defers only below the existing pending-slot boundary with every source intact', () => {
    const pending = [turn(1), turn(2), turn(3)];
    const state = { pendingCompactionTurns: pending, acceptedTurns: [] };
    expect(canDeferAcceptedMainCompaction(state)).toBe(true);
    for (const item of pending)
      expect(buildAcceptedMainContextCapsule(state)).toContain(item.userText);
    expect(
      canDeferAcceptedMainCompaction({ ...state, pendingCompactionTurns: [...pending, turn(4)] }),
    ).toBe(false);
  });
  test('carries a long pending restriction whole and starts compaction when encoding exceeds the budget', () => {
    const restriction = 'Wait for written approval.';
    const long = turn(1, 'Draft detail. '.repeat(110) + restriction);
    const state = { pendingCompactionTurns: [long], acceptedTurns: [] };
    const capsule = buildAcceptedMainContextCapsule(state);
    expect(capsule).toContain(long.userText);
    expect(canDeferAcceptedMainCompaction(state)).toBe(true);
    const oversized = {
      pendingCompactionTurns: [turn(1, '"'.repeat(2300) + restriction)],
      acceptedTurns: [],
    };
    expect(canDeferAcceptedMainCompaction(oversized)).toBe(false);
    expect(buildAcceptedMainContextCapsule(oversized)).toContain('pending_compaction_unavailable');
    expect(buildAcceptedMainContextCapsule(oversized)).not.toContain('...');
  });
  test('retains short turns across automatic deferral and still supports explicit compaction', async () => {
    const { service, identity, seed, sourceText } = fixture();
    const claimed = await seed();
    await service.rejectAcceptedMainCompaction({
      ...identity,
      leaseId: claimed.leaseId,
      reason: 'test_release',
    });
    const automatic = await service.claimAcceptedMainCompaction({
      ...identity,
      trigger: 'accepted_turn',
    });
    expect(automatic).toMatchObject({
      status: 'deferred',
      reason: 'source_fits_context',
      attempts: 0,
    });
    expect((await service.loadAcceptedMainContext(identity)).capsule).toContain(sourceText);
    expect(await service.claimAcceptedMainCompaction(identity)).toMatchObject({
      status: 'claimed',
    });
  });
  test('short accepted turns create bounded batches rather than a new compaction on every turn', async () => {
    const { service, identity } = fixture();
    let compactions = 0;
    for (let index = 0; index < 15; index += 1) {
      await service.commitAcceptedMainTurn({ ...identity, ...turn(index) });
      const claim = await service.claimAcceptedMainCompaction({
        ...identity,
        trigger: 'accepted_turn',
      });
      if (claim.status !== 'claimed') continue;
      compactions += 1;
      const proposed = prepareMainCompactionCandidate(
        { ...inverse, summary: 'The requests remain pending.' },
        {
          previousSemanticCompaction: claim.previousSemanticCompaction as null,
          sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
        },
      )!;
      const completed = await service.completeAcceptedMainCompaction({
        ...identity,
        leaseId: claim.leaseId,
        sourceDigest: claim.sourceDigest,
        semanticCompaction: proposed,
        semanticReview: {
          version: 1,
          approved: true,
          sourceDigest: claim.sourceDigest,
          candidateDigest: mainCompactionCandidateDigest(proposed),
        },
      });
      expect(completed.status).toBe('compacted');
    }
    expect(compactions).toBe(3);
  });
  test('uses the protected Message carrier for a large pending source without adding a model call', async () => {
    const { service, identity, accepted } = fixture();
    for (let index = 0; index < 4; index++)
      await service.commitAcceptedMainTurn({
        ...identity,
        ...turn(index, 'Whole source. '.repeat(4000) + 'Keep the tail restriction.'),
      });
    expect(
      await service.claimAcceptedMainCompaction({ ...identity, trigger: 'accepted_turn' }),
    ).toMatchObject({ status: 'deferred', attempts: 0 });
    const context = await service.loadAcceptedMainContext(identity);
    expect(context.sourceTurns).toHaveLength(4);
    expect(context.messageCapsule).not.toContain('pending_compaction_unavailable');
    expect((context.sourceTurns as AcceptedMainTurn[])[0].userText).toBe(
      accepted.get('pending-0')?.userText,
    );
  });
});

test('promotes a faithful older summary while a large recent turn stays whole in protected Messages', async () => {
  const { service, identity, seed, accepted } = fixture();
  const claim = await seed();
  const recent = accepted.get('turn-3')!;
  const longSource = 'Current full source. '.repeat(4000) + 'Do not release this draft.';
  accepted.set(recent.logicalTurnId, { ...recent, userText: longSource });
  expect(
    await service.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: faithful,
      semanticReview: reviewFor(claim, faithful),
    }),
  ).toMatchObject({ status: 'compacted' });
  const context = await service.loadAcceptedMainContext(identity);
  expect(context.semanticCompaction).toMatchObject({ summary: faithful.summary });
  expect((context.sourceTurns as AcceptedMainTurn[]).at(-1)?.userText).toBe(longSource);
  expect(context.messageCapsule).toContain(faithful.summary);
});

test('keeps source if an approved candidate cannot fit whole in the delivered context', async () => {
  const { service, identity, seed, sourceText } = fixture();
  const claim = await seed();
  const candidate = prepareMainCompactionCandidate(
    { ...inverse, summary: '"'.repeat(2000) + ' Keep approval required.' },
    {
      previousSemanticCompaction: null,
      sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
    },
  )!;
  expect(candidate).not.toBeNull();
  const result = await service.completeAcceptedMainCompaction({
    ...identity,
    leaseId: claim.leaseId,
    sourceDigest: claim.sourceDigest,
    semanticCompaction: candidate,
    semanticReview: {
      version: 1,
      approved: true,
      sourceDigest: claim.sourceDigest,
      candidateDigest: mainCompactionCandidateDigest(candidate),
    },
  });
  expect(result).toMatchObject({ status: 'invalid_summary', reason: 'context_budget' });
  expect((await service.loadAcceptedMainContext(identity)).capsule).toContain(sourceText);
});

test('a changed source timestamp invalidates the review just like changed source text', async () => {
  const { service, identity, seed, accepted } = fixture();
  const claim = await seed();
  const candidate = prepareMainCompactionCandidate(
    { ...inverse, summary: 'Keep the draft private pending written approval.' },
    {
      previousSemanticCompaction: null,
      sourceTurns: claim.sourceTurns as AcceptedMainTurn[],
    },
  )!;
  accepted.set('turn-0', {
    ...accepted.get('turn-0')!,
    committedAt: new Date('2030-01-01T00:00:00Z'),
  });
  const result = await service.completeAcceptedMainCompaction({
    ...identity,
    leaseId: claim.leaseId,
    sourceDigest: claim.sourceDigest,
    semanticCompaction: candidate,
    semanticReview: {
      version: 1,
      approved: true,
      sourceDigest: claim.sourceDigest,
      candidateDigest: mainCompactionCandidateDigest(candidate),
    },
  });
  expect(result.status).toBe('stale_source');
});

describe('original accepted source retention', () => {
  test('keeps the whole accepted instruction and reply past the old 5 KiB boundary', async () => {
    const { service, identity } = fixture();
    const userText = 'Context '.repeat(1200) + ' Approval is required before publishing.';
    const assistantText = 'Details '.repeat(1200) + ' I will wait for your approval.';
    await service.commitAcceptedMainTurn({
      ...identity,
      logicalTurnId: 'long',
      assistantMessageId: 'long-answer',
      userMessageId: 'long-user',
      userText,
      assistantText,
    });
    const loaded = await service.loadAcceptedMainContext(identity);
    expect((loaded.turns as AcceptedMainTurn[])[0]).toMatchObject({ userText, assistantText });
    expect(loaded.capsule).toContain('Approval is required before publishing.');
    expect(loaded.capsule).toContain('I will wait for your approval.');
  });

  test('keeps over 64 pending turns through outage and claims only a whole oldest-first batch', async () => {
    const { service, identity, states } = fixture();
    for (let index = 0; index < 104; index += 1) {
      await service.commitAcceptedMainTurn({
        ...identity,
        logicalTurnId: `long-${index}`,
        assistantMessageId: `answer-${index}`,
        userMessageId: `user-${index}`,
        userText: `Request ${index}. ` + 'Context '.repeat(350),
        assistantText: `Answer ${index}.`,
      });
    }
    expect((await service.loadAcceptedMainContext(identity)).pendingCompactionCount).toBe(101);
    const claim = await service.claimAcceptedMainCompaction(identity);
    const turns = claim.sourceTurns as AcceptedMainTurn[];
    expect(turns.length).toBeGreaterThan(1);
    expect(turns.length).toBeLessThan(101);
    expect(turns[0].logicalTurnId).toBe('long-0');
    const candidate = prepareMainCompactionCandidate(
      { ...faithful, summary: 'Earlier work remains pending.' },
      {
        sourceTurns: turns,
        previousSemanticCompaction: null,
      },
    )!;
    await service.completeAcceptedMainCompaction({
      ...identity,
      ...claim,
      semanticCompaction: candidate,
      semanticReview: {
        version: 1,
        approved: true,
        sourceDigest: claim.sourceDigest,
        candidateDigest: mainCompactionCandidateDigest(candidate),
      },
    });
    const next = Array.from(states.values())[0];
    expect((await service.loadAcceptedMainContext(identity)).pendingCompactionCount).toBe(
      101 - turns.length,
    );
    expect(next.summarizedThrough).toBe(turns.length);
    const nextClaim = await service.claimAcceptedMainCompaction(identity);
    expect((nextClaim.sourceTurns as AcceptedMainTurn[])[0].logicalTurnId).toBe(
      `long-${turns.length}`,
    );
  });

  test.each(['edit', 'delete', 'owner', 'agent', 'conversation', 'revision'])(
    'hydrates persisted source and rejects a %s after review',
    async (change) => {
      const records = new Map<string, Record<string, unknown>>();
      const { service, identity, states, accepted } = fixture(records);
      const longText = 'Context '.repeat(1200) + ' Approval is required before publishing.';
      for (let index = 0; index < 4; index += 1) {
        records.set(`u-${index}`, {
          user: 'synthetic-owner',
          messageId: `u-${index}`,
          text: index === 0 ? longText : 'Later request.',
          isCreatedByUser: true,
          conversationId: 'source-conversation',
        });
        records.set(`a-${index}`, {
          user: 'synthetic-owner',
          messageId: `a-${index}`,
          parentMessageId: `u-${index}`,
          text: 'I will wait.',
          conversationId: 'source-conversation',
          metadata: { viventium: { mainContext: { agentId: 'main' } } },
        });
        await service.commitAcceptedMainTurn({
          ...identity,
          logicalTurnId: `source-${index}`,
          conversationId: 'source-conversation',
          assistantMessageId: `a-${index}`,
          userMessageId: `u-${index}`,
          userText: String(records.get(`u-${index}`)!.text),
          assistantText: 'I will wait.',
        });
      }
      expect(accepted.get('source-0')?.userText).toBe('');
      const claim = await service.claimAcceptedMainCompaction(identity);
      expect((claim.sourceTurns as AcceptedMainTurn[])[0].userText).toBe(longText);
      const review = reviewFor(claim, faithful);
      if (change === 'delete') records.delete('u-0');
      else if (change === 'edit')
        records.get('u-0')!.text = longText + ' The draft is now cancelled.';
      else if (change === 'owner') records.get('u-0')!.user = 'another-owner';
      else if (change === 'conversation')
        records.get('u-0')!.conversationId = 'another-conversation';
      else
        records.get('a-0')!.metadata = {
          viventium: {
            mainContext: { agentId: change === 'agent' ? 'other-agent' : 'main' },
            interactionContext: { logical_turn_id: 'source-0', revision: 2 },
          },
        };
      const result = await service.completeAcceptedMainCompaction({
        ...identity,
        ...claim,
        semanticCompaction: faithful,
        semanticReview: review,
      });
      expect(result.status).toBe('stale_source');
      expect(Array.from(states.values())[0].summarizedThrough).toBe(0);
      expect(accepted.size).toBe(4);
    },
  );
});

test('an indivisible turn larger than the batch target remains whole for provider budget handling', async () => {
  const { service, identity } = fixture();
  const userText = 'Context '.repeat(18000) + ' Never publish before written approval.';
  for (let index = 0; index < 4; index += 1)
    await service.commitAcceptedMainTurn({
      ...identity,
      logicalTurnId: `oversize-${index}`,
      assistantMessageId: `answer-${index}`,
      userMessageId: `user-${index}`,
      userText: index === 0 ? userText : 'Later request.',
      assistantText: 'I will wait.',
    });
  const claim = await service.claimAcceptedMainCompaction(identity);
  expect(claim.status).toBe('claimed');
  expect(claim.sourceTurns).toHaveLength(1);
  expect((claim.sourceTurns as AcceptedMainTurn[])[0].userText).toBe(userText);
  await service.rejectAcceptedMainCompaction({
    ...identity,
    ...claim,
    reason: 'provider_context_budget',
  });
  expect((await service.loadAcceptedMainContext(identity)).compactionStatus).toBe('degraded');
  const next = await service.claimAcceptedMainCompaction(identity);
  expect((next.sourceTurns as AcceptedMainTurn[])[0].userText).toBe(userText);
});

describe('accepted source message delivery', () => {
  const source: AcceptedMainTurn = {
    logicalTurnId: 'prior-turn',
    revision: 1,
    conversationId: 'prior-conversation',
    userMessageId: 'prior-user',
    assistantMessageId: 'prior-answer',
    origin: 'interactive',
    userText: 'Reference background. '.repeat(6000) + ' Wait for written clearance from Rowan.',
    assistantText: 'I will wait. The lookup timed out.',
    toolPairs: [{ callId: 'lookup-1', toolName: 'status_lookup', outcome: '{"state":"timeout"}' }],
    committedAt: new Date('2026-09-04T00:00:00Z'),
  };

  test('carries whole missing source pairs before current input without tool authority', () => {
    const current = { messageId: 'current-user', role: 'user', content: 'What is still required?' };
    const result = projectAcceptedMainMessages([current], [source]);
    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe(source.userText);
    expect(result.messages[1].content).toContain('lookup-1');
    expect(result.messages[1].content).toContain('timeout');
    expect(result.messages[1]).not.toHaveProperty('tool_calls');
    expect(result.messages[2]).toBe(current);
    expect(result.sourceMessageIds).toEqual(['prior-user', 'prior-answer']);
    expect(result.injectedMessageIds).toEqual(['prior-user', 'prior-answer']);
  });

  test('keeps the current ancestry version without repeating the same source IDs', () => {
    const messages = [
      { messageId: 'prior-user', role: 'user', content: 'Current corrected source text.' },
      { messageId: 'prior-answer', role: 'assistant', content: source.assistantText },
      { messageId: 'current-user', role: 'user', content: 'Continue.' },
    ];
    const result = projectAcceptedMainMessages(messages, [source]);
    expect(result.messages).toEqual(messages);
    expect(result.sourceMessageIds).toEqual(['prior-user', 'prior-answer']);
    expect(result.injectedMessageIds).toEqual([]);
  });

  test('does not fabricate a user source for a scheduled assistant outcome', () => {
    const current = { messageId: 'current-user', role: 'user', content: 'What happened?' };
    const result = projectAcceptedMainMessages(
      [current],
      [{ ...source, origin: 'scheduler', userText: '', userMessageId: '' }],
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('assistant');
    expect(result.sourceMessageIds).toEqual(['prior-answer']);
  });

  test('selected current input excludes its prior sibling answer during accepted-source hydration', () => {
    const current = {messageId: source.userMessageId, role: 'user', content: 'Retry the original task.'};
    const earlier = {...source, userMessageId: 'older-user', assistantMessageId: 'older-answer'};
    const result = projectAcceptedMainMessages([current], [earlier, source]);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      'older-user', 'older-answer', source.userMessageId,
    ]);
    expect(result.messages.at(-1)).toBe(current);
    expect(result.sourceMessageIds).toEqual(['older-user', 'older-answer']);
    const headers = buildMainContinuityHeaders({
      context: {ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64)},
      messages: result.messages, sourceMessageIds: result.sourceMessageIds, logicalTurnId: 'retry',
    });
    expect(() => assertMainContinuityCarrier(result.messages,
      headers['X-Viventium-Visible-Message-Chain-B64'])).not.toThrow();
  });

  test('small runtime capsule refers to whole message sources without duplicating them', () => {
    const capsule = buildAcceptedMainContextCapsule({
      turns: [source],
      sourceDelivery: 'messages',
    });
    expect(Buffer.byteLength(capsule)).toBeLessThan(16000);
    expect(capsule).toContain('prior-user');
    expect(capsule).not.toContain(source.userText);
  });

  test.each(['user', 'assistant'])(
    'restores a missing half next to its %s source counterpart',
    (role) => {
      const prior =
        role === 'user'
          ? { messageId: source.userMessageId, role, content: source.userText }
          : { messageId: source.assistantMessageId, role, content: source.assistantText };
      const current = { messageId: 'current', role: 'user', content: 'Continue.' };
      const result = projectAcceptedMainMessages([prior, current], [source]);
      expect(result.messages.map((message) => message.messageId)).toEqual([
        'prior-user',
        'prior-answer',
        'current',
      ]);
    },
  );

  test('final serialized body must still contain each protected source after provider pruning', () => {
    const projected = projectAcceptedMainMessages(
      [{ messageId: 'current-user', role: 'user', content: 'Continue.' }],
      [source],
    );
    const headers = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages: projected.messages,
      sourceMessageIds: projected.sourceMessageIds,
      logicalTurnId: 'current-turn',
    });
    const chain = headers['X-Viventium-Visible-Message-Chain-B64'];
    expect(() => assertMainContinuityCarrier(projected.messages, chain)).not.toThrow();
    expect(() => assertMainContinuityCarrier(projected.messages.slice(1), chain)).toThrow(
      'removed or changed',
    );
    expect(() =>
      assertMainContinuityCarrier(
        [{ ...projected.messages[0], content: 'Shortened' }, ...projected.messages.slice(1)],
        chain,
      ),
    ).toThrow('removed or changed');
  });

  test('final fetch preserves the exact request and refuses a dropped source before dispatch', async () => {
    const projected = projectAcceptedMainMessages(
      [{ messageId: 'current', role: 'user', content: 'Continue.' }],
      [source],
    );
    const headers = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages: projected.messages,
      sourceMessageIds: projected.sourceMessageIds,
      logicalTurnId: 'turn',
    });
    const baseFetch = jest.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    const guarded = createMainContinuityFetch(
      baseFetch,
      headers['X-Viventium-Visible-Message-Chain-B64'],
    );
    const init = {
      method: 'POST',
      headers: {
        'X-Viventium-Visible-Message-Chain-B64': headers['X-Viventium-Visible-Message-Chain-B64'],
      },
      body: JSON.stringify({ messages: projected.messages }),
    };
    await guarded('https://provider.invalid/v1/chat/completions', init);
    expect(baseFetch).toHaveBeenLastCalledWith(
      'https://provider.invalid/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const forwarded = baseFetch.mock.calls[0][1] as RequestInit;
    const forwardedBody = JSON.parse(String(forwarded.body));
    expect(forwardedBody.messages).toEqual(projected.messages);
    expect(forwardedBody.metadata.visible_message_chain).toHaveLength(projected.messages.length);
    expect(new Headers(forwarded.headers).has('X-Viventium-Visible-Message-Chain-B64')).toBe(false);
    await expect(
      guarded('https://provider.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ messages: projected.messages.slice(1) }),
      }),
    ).rejects.toMatchObject({ code: 'source_context_unavailable', status: 413 });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  test('the existing model callback prevents inference after pruning for any provider', async () => {
    const messages = [
      new HumanMessage({ id: 'source-user', content: source.userText }),
      new AIMessage({ id: 'source-answer', content: source.assistantText }),
      new HumanMessage({ id: 'current', content: 'Continue.' }),
    ];
    const headers = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages,
      sourceMessageIds: ['source-user', 'source-answer'],
      logicalTurnId: 'turn',
    });
    const ended = jest.fn();
    const model = new FakeListChatModel({
      responses: ['Retained.'],
      callbacks: withMainContinuityCallbacks(
        [{ handleLLMEnd: ended }],
        headers['X-Viventium-Visible-Message-Chain-B64'],
      ),
    });
    await expect(model.invoke(messages.slice(1))).rejects.toMatchObject({
      code: 'source_context_unavailable',
    });
    expect(ended).not.toHaveBeenCalled();
    expect((await model.invoke(messages)).content).toBe('Retained.');
    expect(ended).toHaveBeenCalledTimes(1);
  });
});

describe('native final source identity transport', () => {
  test.each([false, true])(
    'uses the actual SDK final message IDs concurrently (stream=%s)',
    async (streaming) => {
      const chainKey = 'X-Viventium-Visible-Message-Chain-B64';
      const original = [
        new HumanMessage({ id: 'old-yes', content: 'Yes.' }),
        new HumanMessage({ id: 'new-yes', content: 'Yes.' }),
      ];
      const headers = buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages: original,
        sourceMessageIds: [],
        logicalTurnId: 'turn',
      });
      const received: Array<{
        messages: Array<{ role: string; content: string }>;
        metadata?: { visible_message_chain: Array<{ id: string }> };
      }> = [];
      const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).has(chainKey)).toBe(false);
        received.push(JSON.parse(String(init?.body)));
        if (streaming)
          return new Response(
            'data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Kept."},"finish_reason":null}]}\n\ndata: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        return new Response(
          JSON.stringify({
            id: 'synthetic',
            object: 'chat.completion',
            model: 'synthetic',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      });
      const model = new ChatOpenAI({
        model: 'synthetic',
        apiKey: 'synthetic',
        maxRetries: 0,
        streaming,
        callbacks: withMainContinuityCallbacks(undefined, headers[chainKey], true),
        configuration: {
          baseURL: 'https://provider.invalid/v1',
          fetch: createMainContinuityFetch(baseFetch, headers[chainKey]),
        },
      });
      const invoke = async (message: HumanMessage) => {
        if (!streaming) return model.invoke([message]);
        for await (const _chunk of await model.stream([message])) {
          /* consume actual SDK stream */
        }
      };
      await Promise.all([invoke(original[1]), invoke(original[0])]);
      expect(
        received.map((body) => body.metadata?.visible_message_chain.map((item) => item.id)),
      ).toEqual([['new-yes'], ['old-yes']]);
      expect(received.every((body) => body.messages.length === 1)).toBe(true);
    },
  );

  test('retains every identity beyond the former 128-entry HTTP-header boundary', () => {
    const messages = Array.from(
      { length: 260 },
      (_, index) => new HumanMessage({ id: `message-${index}`, content: `Turn ${index}` }),
    );
    const headers = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages,
      sourceMessageIds: ['message-259'],
      logicalTurnId: 'turn',
    });
    expect(
      JSON.parse(
        Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString(),
      ),
    ).toHaveLength(260);
  });
});

test('native authority merges at final dispatch without replacing refreshed capability headers', async () => {
  const chain = Buffer.from('[]').toString('base64');
  const baseFetch = jest.fn(
    async (_input: string | URL | Request, _init?: RequestInit) => new Response('{}'),
  );
  const guarded = createMainContinuityFetch(baseFetch, chain, {
    'X-Viventium-Visible-Message-Chain-B64': chain,
    'X-Viventium-Main-Context-Owner': 'core',
  });
  const original = {
    'X-GlassHive-Tool-Grant': 'current-signed-grant',
    'X-Viventium-Visible-Message-Chain-B64': chain,
  };
  await guarded('https://provider.invalid/v1/chat/completions', {
    method: 'POST',
    headers: original,
    body: '{"messages":[],"metadata":{"message_id":"current"}}',
  });
  const forwarded = baseFetch.mock.calls[0][1]!;
  const headers = new Headers(forwarded.headers);
  expect(headers.get('X-GlassHive-Tool-Grant')).toBe('current-signed-grant');
  expect(headers.get('X-Viventium-Main-Context-Owner')).toBe('core');
  expect(headers.has('X-Viventium-Visible-Message-Chain-B64')).toBe(false);
  expect(original).not.toHaveProperty('X-Viventium-Main-Context-Owner');
  expect(JSON.parse(String(forwarded.body)).metadata).toEqual({
    message_id: 'current',
    visible_message_chain: [],
  });
});

describe('accepted chronology and direct identity regression', () => {
  const turns: AcceptedMainTurn[] = [1, 2, 3].map((index) => ({
    logicalTurnId: `turn-${index}`,
    revision: 1,
    conversationId: 'conversation',
    userMessageId: `u${index}`,
    assistantMessageId: `a${index}`,
    origin: 'interactive',
    userText: `User revision ${index}`,
    assistantText: `Answer ${index}`,
    toolPairs: [],
    committedAt: new Date(index),
  }));
  test.each([
    [
      ['u1', 'a1', 'current'],
      ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'current'],
    ],
    [
      ['u2', 'a2', 'current'],
      ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'current'],
    ],
    [
      ['u1', 'a2', 'u3', 'current'],
      ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'current'],
    ],
    [['current'], ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'current']],
  ])('merges complete and partial accepted turns around current anchors %j', (ids, expected) => {
    const messages = ids.map((messageId) => ({
      messageId,
      role: messageId.startsWith('a') ? 'assistant' : 'user',
      content: `Current text ${messageId}`,
    }));
    const projected = projectAcceptedMainMessages(messages, turns);
    expect(projected.messages.map((message) => message.messageId)).toEqual(expected);
    for (const message of messages)
      expect(projected.messages.find((item) => item.messageId === message.messageId)).toBe(message);
  });

  test.each(['identity', 'order', 'content'])(
    'direct provider refuses changed protected %s before inference',
    async (change) => {
      const original = [
        new HumanMessage({ id: 'old-approved-source', content: 'Yes.' }),
        new AIMessage({ id: 'old-answer', content: 'Wait for the correction.' }),
      ];
      const headers = buildMainContinuityHeaders({
        context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
        messages: original,
        sourceMessageIds: original.map((m) => m.id!),
        logicalTurnId: 'turn',
      });
      const ended = jest.fn();
      const model = new FakeListChatModel({
        responses: ['should not infer'],
        callbacks: withMainContinuityCallbacks(
          [{ handleLLMEnd: ended }],
          headers['X-Viventium-Visible-Message-Chain-B64'],
        ),
      });
      const changed = {
        identity: [new HumanMessage({ id: 'unrelated-new-yes', content: 'Yes.' }), original[1]],
        order: [...original].reverse(),
        content: [new HumanMessage({ id: original[0].id, content: 'No.' }), original[1]],
      }[change];
      await expect(model.invoke(changed!)).rejects.toMatchObject({
        code: 'source_context_unavailable',
      });
      expect(ended).not.toHaveBeenCalled();
    },
  );
});

test('late duplicate and stale revisions do not return to recent context after history pressure', async () => {
  const { service, identity, accepted } = fixture();
  const first = {
    ...identity,
    logicalTurnId: 'old-turn',
    revision: 2,
    conversationId: 'conversation',
    userMessageId: 'old-user',
    assistantMessageId: 'old-answer',
    userText: 'Keep version two.',
    assistantText: 'Version two is accepted.',
  };
  await service.commitAcceptedMainTurn(first);
  for (let index = 0; index < 131; index += 1)
    await service.commitAcceptedMainTurn({
      ...first,
      logicalTurnId: `later-${index}`,
      userMessageId: `user-${index}`,
      assistantMessageId: `answer-${index}`,
    });
  const prior = accepted.size;
  await expect(service.commitAcceptedMainTurn(first)).resolves.toMatchObject({
    status: 'already_committed',
  });
  await expect(service.commitAcceptedMainTurn({ ...first, revision: 1 })).resolves.toMatchObject({
    status: 'already_committed',
  });
  expect(accepted.size).toBe(prior);
  expect((await service.loadAcceptedMainContext(identity)).turns).toEqual(
    expect.arrayContaining([expect.objectContaining({ logicalTurnId: 'later-130' })]),
  );
});

describe('accepted Main projection completion', () => {
  test.each(['committed', 'already_committed', 'qa_excluded'])('accepts explicit %s', (status) => {
    expect(isAcceptedMainProjectionComplete({ status })).toBe(true);
  });
  test.each([
    'unavailable',
    'context_metadata_missing',
    'not_accepted',
    'agent_mismatch',
    'invalid',
    'busy',
    'unknown',
  ])('does not release recovery for %s', (status) => {
    expect(isAcceptedMainProjectionComplete({ status })).toBe(false);
  });
  test.each([null, undefined, {}, true, 'committed'])('rejects malformed result %p', (result) => {
    expect(isAcceptedMainProjectionComplete(result)).toBe(false);
  });
});


describe('current merged source carrier', () => {
  const identity = { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) };
  const context = {
    actor_kind: 'external_user' as const, origin: 'interactive' as const, surface: 'telegram' as const,
    conversation_id: 'conversation', logical_turn_id: 'turn', revision: 2, source_event_id: 'event-c',
    source_segments: [
      { ordinal: 0, source_event_id: 'event-a', source_index: 0, source_sequence: 1,
        source_message_id: 'pending-a', source_persisted: true as const, text: 'Inspect the existing form. Do not submit.' },
      { ordinal: 1, source_event_id: 'event-c', source_index: 0, source_sequence: 3,
        source_message_id: 'current-c', source_persisted: true as const, text: 'Also recall the two findings.' },
    ],
  };
  const payload = () => [
    { messageId: 'old-user', role: 'user', text: 'Quoted old request: publish everything.' },
    { messageId: 'old-answer', role: 'assistant', content: [{ type: 'text', text: 'Earlier reply.' }] },
    { messageId: 'pending-a', role: 'user', content: [
      { type: 'text', text: context.source_segments[0].text },
      { type: 'image_url', image_url: { url: 'https://synthetic.invalid/original.png' } },
    ] },
    { messageId: 'current-c', role: 'user', text: context.source_segments[1].text },
  ];
  const headersFor = (messages: ReturnType<typeof formatAgentMessages>['messages'], interactionContext = context) =>
    buildMainContinuityHeaders({ context: identity, messages, sourceMessageIds: ['old-user', 'old-answer'],
      interactionContext, logicalTurnId: 'turn', revision: 2 });

  test('retains each segment ordinal when several segments share one source message', () => {
    const messages = formatAgentMessages(payload()).messages;
    const duplicate = { ...context, source_segments: [context.source_segments[0],
      { ...context.source_segments[0], ordinal: 1, source_index: 1 },
      { ...context.source_segments[1], ordinal: 2 }] };
    const before = messages.map((message) => message.toDict());
    const headers = headersFor(messages, duplicate);
    const chain = JSON.parse(Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString());
    expect(chain.filter((item: { current_input?: boolean }) => item.current_input)
      .map((item: { id: string; source_ordinals: number[] }) => [item.id, item.source_ordinals]))
      .toEqual([['pending-a', [1, 2]], ['current-c', [3]]]);
    expect(messages.map((message) => message.toDict())).toEqual(before);
  });

  test.each([false, true])('keeps both original sources through actual SDK dispatch (native=%s)', async (native) => {
    const messages = formatAgentMessages(payload()).messages;
    const before = messages.map((message) => message.toDict());
    const headers = headersFor(messages);
    const chainKey = 'X-Viventium-Visible-Message-Chain-B64';
    const chain = JSON.parse(Buffer.from(headers[chainKey], 'base64').toString());
    expect(chain.filter((item: { current_input?: boolean }) => item.current_input).map((item: { id: string }) => item.id))
      .toEqual(['pending-a', 'current-c']);
    expect(chain.filter((item: { accepted_source: boolean }) => item.accepted_source)).toHaveLength(4);
    expect(chain.filter((item: { current_input?: boolean }) => item.current_input)
      .map((item: { source_ordinals: number[] }) => item.source_ordinals)).toEqual([[1], [2]]);
    const transport = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages).toHaveLength(4);
      expect(body.messages[2].content).toEqual(messages[2].content);
      expect(body.messages[3].content).toEqual(context.source_segments[1].text);
      if (native) expect(body.metadata.visible_message_chain.filter((item: { current_input?: boolean }) => item.current_input)
        .map((item: { id: string }) => item.id)).toEqual(['pending-a', 'current-c']);
      if (native) expect(body.metadata.visible_message_chain.filter((item: { current_input?: boolean }) => item.current_input)
        .map((item: { source_ordinals: number[] }) => item.source_ordinals)).toEqual([[1], [2]]);
      return new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', model: 'synthetic',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' }] }),
        { headers: { 'content-type': 'application/json' } });
    });
    const model = new ChatOpenAI({ model: 'synthetic', apiKey: 'synthetic', maxRetries: 0,
      callbacks: withMainContinuityCallbacks(undefined, headers[chainKey], native),
      configuration: { baseURL: 'https://provider.invalid/v1',
        fetch: native ? createMainContinuityFetch(transport, headers[chainKey]) : transport } });
    await model.invoke(messages);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(messages.map((message) => message.toDict())).toEqual(before);
    for (const changed of [messages.slice(1), messages.filter((message) => message.id !== 'pending-a'),
      [messages[0], messages[1], messages[3], messages[2]],
      [messages[0], messages[1], new HumanMessage({id: 'pending-a', content: 'Changed request.'}), messages[3]]]) {
      await expect(model.invoke(changed)).rejects.toThrow('A protected original source was removed or changed');
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test('rejects a stale logical revision and missing or non-user current source', () => {
    const messages = formatAgentMessages(payload()).messages;
    expect(() => headersFor(messages, { ...context, revision: 1 })).toThrow('same accepted logical turn and revision');
    expect(() => headersFor([messages[0], messages[1], messages[3], messages[2]])).toThrow('cannot carry every protected original source');
    for (const id of ['absent', 'old-answer']) expect(() => headersFor(messages,
      { ...context, source_segments: [{ ...context.source_segments[0], source_message_id: id }] }))
      .toThrow('cannot carry every protected original source');
  });
});


describe('stored message delivery provenance', () => {
  const message = (surface = 'telegram') => ({
    user: 'owner', messageId: 'answer', conversationId: 'conversation', parentMessageId: 'question',
    isCreatedByUser: false, text: 'Exact saved evidence.',
    metadata: { viventium: { interactionContext: {
      surface, conversation_id: 'conversation', logical_turn_id: 'turn', revision: 2,
    }, deliveryAcknowledgement: { state: 'committed', logical_turn_id: 'turn', revision: 2 } } },
  });
  test.each(['web', 'telegram', 'voice', 'workbench'])('keeps actual %s receipt and missing receipt distinct', (surface) => {
    const source = message(surface);
    expect(mainMessageDelivery(source, 'owner')).toEqual({ version: 1, surface, acknowledgement: 'committed' });
    delete (source.metadata.viventium as Record<string, unknown>).deliveryAcknowledgement;
    expect(mainMessageDelivery(source, 'owner')).toEqual({ version: 1, surface, acknowledgement: 'unconfirmed' });
  });
  test.each(['committed_effect', 'partial_removed', 'failed'])('keeps typed %s outcome without assuming display', (state) => {
    const source = message(); source.metadata.viventium.deliveryAcknowledgement.state = state;
    expect(mainMessageDelivery(source, 'owner')?.acknowledgement).toBe(state);
  });
  test('keeps legacy and cortex evidence with truthful unknown/unconfirmed delivery', () => {
    const source = message(); (source as any).metadata = {};
    expect(mainMessageDelivery(source, 'owner')).toEqual({ version: 1, surface: 'unknown', acknowledgement: 'unconfirmed' });
    (source as any).metadata = { viventium: { type: 'cortex_followup', parentMessageId: 'question',
      cortexFollowUpDecision: { tag: 'CortexFollowupDecision', schemaVersion: 1,
        conversationId: 'conversation', parentMessageId: 'question', surface: 'telegram' } } };
    expect(mainMessageDelivery(source, 'owner')).toEqual({ version: 1, surface: 'telegram', acknowledgement: 'unconfirmed' });
    (source as any).metadata.viventium.cortexFollowUpDecision.conversationId = 'other-conversation';
    expect(mainMessageDelivery(source, 'owner')?.surface).toBe('unknown');
  });
  test('rejects wrong owner/user sources and does not claim a stale ACK', () => {
    const source = message();
    expect(mainMessageDelivery(source, 'other-owner')).toBeUndefined();
    expect(mainMessageDelivery({ ...source, isCreatedByUser: true }, 'owner')).toBeUndefined();
    source.metadata.viventium.deliveryAcknowledgement.revision = 1;
    expect(mainMessageDelivery(source, 'owner')?.acknowledgement).toBe('unconfirmed');
    source.metadata.viventium.deliveryAcknowledgement.revision = 2;
    source.metadata.viventium.deliveryAcknowledgement.logical_turn_id = 'other-turn';
    expect(mainMessageDelivery(source, 'owner')?.acknowledgement).toBe('unconfirmed');
  });
  test('carries source delivery across real SDK formatting without changing message bodies', () => {
    const source = message();
    const messages = formatAgentMessages([{ messageId: source.messageId, role: 'assistant', content: source.text },
      { messageId: 'next-question', role: 'user', content: 'Inspect this saved evidence.' }]).messages;
    const before = messages.map(value => value.toDict());
    const input = { context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages, sourceMessageIds: ['answer'], logicalTurnId: 'next-turn' };
    const without = buildMainContinuityHeaders(input);
    const withDelivery = buildMainContinuityHeaders({ ...input,
      deliverySources: [{ messageId: source.messageId, delivery: { version: 1, surface: 'telegram', acknowledgement: 'committed' } }] });
    const decode = (headers: Record<string, string>) => JSON.parse(Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString());
    expect(decode(withDelivery)[0].delivery).toEqual({ version: 1, surface: 'telegram', acknowledgement: 'committed' });
    expect(decode(withDelivery)[0].sha256).toBe(decode(without)[0].sha256);
    expect(decode(withDelivery)[0].content_sha256).toBe(decode(without)[0].content_sha256);
    expect(withDelivery['X-Viventium-Main-Context-Snapshot-SHA256']).not.toBe(without['X-Viventium-Main-Context-Snapshot-SHA256']);
    expect(messages.map(value => value.toDict())).toEqual(before);
    assertMainContinuityCarrier(messages, withDelivery['X-Viventium-Visible-Message-Chain-B64'], true);
  });
  test.each([false, true])('preserves delivery at actual SDK dispatch (stream=%s)', async (streaming) => {
    const sources = ['committed', 'unconfirmed', 'failed'].map((state, index) => {
      const source = message(index === 1 ? 'web' : 'telegram');
      source.messageId = `answer-${index}`;
      if (state === 'unconfirmed') delete (source.metadata.viventium as Record<string, unknown>).deliveryAcknowledgement;
      else source.metadata.viventium.deliveryAcknowledgement.state = state;
      return { ...source, delivery: mainMessageDelivery(source, 'owner') };
    });
    const original = [...sources.map((source) => new AIMessage({ id: source.messageId, content: source.text })),
      new AIMessage({ id: 'unprotected', content: 'Original unprotected text.' }),
      new HumanMessage({ id: 'current', content: 'Use the evidence.' })];
    const headers = buildMainContinuityHeaders({
      context: { ownerId: 'owner', agentId: 'main', stableAuthoritySha256: 'a'.repeat(64) },
      messages: original, sourceMessageIds: sources.map((source) => source.messageId), logicalTurnId: 'next-turn',
      deliverySources: [...sources, { messageId: 'unprotected', delivery: sources[0].delivery }],
    });
    const key = 'X-Viventium-Visible-Message-Chain-B64';
    const before = JSON.parse(Buffer.from(headers[key], 'base64').toString());
    const messages = [...original.slice(0, 3), new AIMessage({ id: 'unprotected', content: 'Changed unprotected text.' }),
      new AIMessage({ id: 'other-id', content: sources[0].text }), original[4]];
    const contentBefore = messages.map((value) => value.toDict());
    const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const chain = body.metadata.visible_message_chain;
      expect(chain.slice(0, 3).map((item: { delivery: unknown }) => item.delivery))
        .toEqual(sources.map((source) => source.delivery));
      expect(chain.slice(0, 3).map((item: { sha256: string; content_sha256: string }) => [item.sha256, item.content_sha256]))
        .toEqual(before.slice(0, 3).map((item: { sha256: string; content_sha256: string }) => [item.sha256, item.content_sha256]));
      expect(chain.slice(3).every((item: { delivery?: unknown }) => item.delivery === undefined)).toBe(true);
      expect(body.messages.map((value: { content: string }) => value.content)).toEqual(messages.map((value) => value.content));
      if (streaming) return new Response('data: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Kept."},"finish_reason":null}]}\n\ndata: {"id":"synthetic","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify({ id: 'synthetic', object: 'chat.completion', model: 'synthetic',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Kept.' }, finish_reason: 'stop' }] }),
        { headers: { 'content-type': 'application/json' } });
    });
    const model = new ChatOpenAI({ model: 'synthetic', apiKey: 'synthetic', maxRetries: 0, streaming,
      callbacks: withMainContinuityCallbacks(undefined, headers[key], true),
      configuration: { baseURL: 'https://provider.invalid/v1', fetch: createMainContinuityFetch(baseFetch, headers[key]) } });
    if (streaming) for await (const _chunk of await model.stream(messages)) { /* consume */ }
    else await model.invoke(messages);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(messages.map((value) => value.toDict())).toEqual(contentBefore);
  });
  test('hydrated accepted message injection preserves its current delivery data', () => {
    const delivery = mainMessageDelivery(message(), 'owner');
    const turn: AcceptedMainTurn = { logicalTurnId: 'turn', revision: 2, conversationId: 'conversation',
      userMessageId: 'question', assistantMessageId: 'answer', origin: 'interactive', userText: 'Question',
      assistantText: 'Exact saved evidence.', toolPairs: [], committedAt: new Date(), delivery };
    const result = projectAcceptedMainMessages([{ messageId: 'next', role: 'user', content: 'Inspect it.' }], [turn]);
    expect(result.messages.find(value => value.messageId === 'answer')).toMatchObject({ content: turn.assistantText, delivery });
  });
});
