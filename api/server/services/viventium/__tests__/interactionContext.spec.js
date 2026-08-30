const {
  attachInteractionContextMetadata,
  attachLogicalTurnMetadata,
  bindCanonicalInteractionConversation,
  bindInteractionSourceSegments,
  bindLogicalTurnContext,
  buildTelegramSourceEventId,
  buildTelegramSourceOrderScope,
  createSchedulerInteractionContext,
  createTelegramInteractionContext,
  createVoiceInteractionContext,
  createWebInteractionContext,
  getTrustedAdapterCapabilities,
  getTrustedInteractionContext,
  isInternalOrigin,
  setTrustedInteractionContext,
  shouldSkipAutomaticMemoryWriter,
  shouldSkipEmotionalReaction,
} = require('../interactionContext');
const { getMcpOAuthWaitDecision, shouldSuppressMcpOAuthFlow } = require('../mcpOAuthPolicy');
const { resolveViventiumSurface } = require('../surfacePrompts');

describe('trusted InteractionContext', () => {
  test.each([
    [
      'telegram',
      createTelegramInteractionContext,
      { segment_stability: 'immediate', supersede_scope: 'response_only' },
    ],
    [
      'voice',
      createVoiceInteractionContext,
      { segment_stability: 'provisional', supersede_scope: 'response_only' },
    ],
  ])(
    'authors exact %s provenance and keeps capabilities outside the base contract',
    (surface, createContext, capabilities) => {
      const req = {};
      const context = setTrustedInteractionContext(
        req,
        createContext({ conversation_id: 'conversation-1', source_event_id: 'opaque:event:1' }),
        capabilities,
      );

      expect(context).toEqual({
        actor_kind: 'external_user',
        origin: 'interactive',
        surface,
        conversation_id: 'conversation-1',
        revision: 1,
        source_event_id: 'opaque:event:1',
      });
      expect(context).not.toHaveProperty('segment_stability');
      expect(context).not.toHaveProperty('supersede_scope');
      expect(getTrustedAdapterCapabilities(req)).toEqual(capabilities);
    },
  );

  test('ignores client-supplied privileged interaction fields for a web turn', () => {
    const req = {
      body: {
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          surface: 'workbench',
        },
        source_event_id: 'client-event-1',
      },
    };

    const context = setTrustedInteractionContext(
      req,
      createWebInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'server-event-1',
      }),
    );

    expect(context).toMatchObject({
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'conversation-1',
      source_event_id: 'server-event-1',
      revision: 1,
    });
    expect(context).not.toEqual(expect.objectContaining(req.body.interactionContext));
    expect(getTrustedInteractionContext(req)).toBe(context);
    expect(Object.isFrozen(context)).toBe(true);
  });

  test('keeps trusted numeric source order separate from opaque source event identity', () => {
    const context = createTelegramInteractionContext({
      conversation_id: 'conversation-1',
      source_event_id: 'opaque:not:parsed:99999',
      source_order_scope: 'a'.repeat(64),
      source_sequence: 12346,
    });

    expect(context).toMatchObject({
      source_event_id: 'opaque:not:parsed:99999',
      source_order_scope: 'a'.repeat(64),
      source_sequence: 12346,
    });
  });

  test('hashes authenticated owner, Telegram sender, chat, topic, and server domain into one scope', () => {
    const input = {
      librechat_owner_id: 'owner-1',
      telegram_user_id: 'telegram-user-1',
      telegram_chat_id: '-100123',
      message_thread_id: '77',
      source_domain: 'telegram-interactive-v1',
    };
    const scope = buildTelegramSourceOrderScope(input);

    expect(scope).toMatch(/^[a-f0-9]{64}$/);
    expect(buildTelegramSourceOrderScope(input)).toBe(scope);
    expect(buildTelegramSourceOrderScope({ ...input, librechat_owner_id: 'owner-2' })).not.toBe(
      scope,
    );
    expect(
      buildTelegramSourceOrderScope({ ...input, telegram_user_id: 'telegram-user-2' }),
    ).not.toBe(scope);
    expect(buildTelegramSourceOrderScope({ ...input, message_thread_id: '78' })).not.toBe(scope);
    expect(
      buildTelegramSourceOrderScope({ ...input, source_domain: 'telegram-callback-v1' }),
    ).not.toBe(scope);
    expect(scope).not.toContain('owner-1');
    expect(scope).not.toContain('telegram-user-1');
    expect(scope).not.toContain('-100123');
  });

  test('derives opaque Telegram source event identity from trusted scope and positive sequence', () => {
    const scope = 'a'.repeat(64);
    const eventId = buildTelegramSourceEventId({
      source_order_scope: scope,
      source_sequence: 12346,
    });

    expect(eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(buildTelegramSourceEventId({ source_order_scope: scope, source_sequence: 12346 })).toBe(
      eventId,
    );
    expect(
      buildTelegramSourceEventId({ source_order_scope: 'opaque', source_sequence: 12346 }),
    ).toBe('');
    expect(buildTelegramSourceEventId({ source_order_scope: scope, source_sequence: 0 })).toBe('');
  });

  test('keeps a server-resolved Telegram reply descriptor typed and separate from source text', () => {
    const req = {};
    const context = setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'telegram:message:2',
        reply_context: {
          provenanceStatus: 'verified',
          senderRole: 'assistant_self',
          repliedTelegramMessageId: '91',
          logicalMessageId: 'assistant-1',
          sourceKind: 'schedule_result',
          quoteText: 'Who signs first?',
          attachments: [
            {
              kind: 'document',
              fileId: 'doc-1',
              filename: 'source.pdf',
              extractedText: 'Quoted document evidence',
            },
          ],
        },
      }),
    );

    expect(context.reply_context).toEqual({
      version: 1,
      provenanceStatus: 'verified',
      senderRole: 'assistant_self',
      repliedTelegramMessageId: '91',
      logicalMessageId: 'assistant-1',
      sourceKind: 'schedule_result',
      quoteText: 'Who signs first?',
      attachments: [
        {
          kind: 'document',
          fileId: 'doc-1',
          filename: 'source.pdf',
          extractedText: 'Quoted document evidence',
        },
      ],
    });
    const bound = bindLogicalTurnContext(req, {
      ...context,
      reply_context: undefined,
      logical_turn_id: 'turn-1',
      revision: 1,
    });
    expect(bound.reply_context).toEqual(context.reply_context);
    expect(attachInteractionContextMetadata(req, { messageId: 'message-1' })).toHaveProperty(
      'metadata.viventium.interactionContext.reply_context',
      context.reply_context,
    );
  });

  test('preserves platform-verified owner reply provenance through typed normalization', () => {
    const context = createTelegramInteractionContext({
      conversation_id: 'conversation-1',
      source_event_id: 'telegram:message:3',
      reply_context: {
        provenanceStatus: 'platform_verified',
        senderRole: 'owner_self',
        repliedTelegramMessageId: '94',
        quoteText: 'My earlier note.',
      },
    });

    expect(context.reply_context).toMatchObject({
      provenanceStatus: 'platform_verified',
      senderRole: 'owner_self',
      repliedTelegramMessageId: '94',
    });
  });

  test('stores a scheduler context only through the server-owned request slot', () => {
    const req = { body: {} };
    const context = setTrustedInteractionContext(req, {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'scheduled-conversation-7',
      source_event_id: 'scheduled-run-7',
      segment_stability: 'immediate',
      supersede_scope: 'response_only',
    });

    expect(isInternalOrigin(req)).toBe(true);
    expect(shouldSkipAutomaticMemoryWriter(req)).toBe(true);
    expect(shouldSkipEmotionalReaction(req)).toBe(true);
    expect(context.source_event_id).toBe('scheduled-run-7');
    expect(Object.keys(req)).not.toContain('_viventiumInteractionContext');
  });

  test('separates scheduler result recall eligibility from automatic saved-memory eligibility', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'scheduled-conversation-9',
        source_event_id: 'scheduled-run-9',
      }),
    );

    const envelope = attachInteractionContextMetadata(req, {
      messageId: 'scheduler-envelope',
      isCreatedByUser: true,
      text: 'Private scheduler execution envelope.',
    });
    const result = attachInteractionContextMetadata(req, {
      messageId: 'scheduler-result',
      isCreatedByUser: false,
      text: 'One useful visible scheduled result.',
    });

    expect(envelope.metadata.viventium).toMatchObject({
      visibility: 'internal',
      memoryEligible: false,
      recallEligible: false,
    });
    expect(result.metadata.viventium).toMatchObject({
      memoryEligible: false,
      recallEligible: true,
    });
    expect(result.metadata.viventium).not.toHaveProperty('visibility');
  });

  test('keeps the exported scheduler factory limited to the base InteractionContext contract', () => {
    expect(
      createSchedulerInteractionContext({
        conversation_id: 'scheduled-conversation-8',
        source_event_id: 'scheduled-run-8',
      }),
    ).toEqual({
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'scheduled-conversation-8',
      revision: 1,
      source_event_id: 'scheduled-run-8',
    });
  });

  test('cannot replace a trusted context after the boundary captures it', () => {
    const req = {};
    const first = setTrustedInteractionContext(
      req,
      createWebInteractionContext({ conversation_id: 'conversation-1', source_event_id: 'first' }),
    );
    const second = setTrustedInteractionContext(req, {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'conversation-2',
      source_event_id: 'forged-late-replacement',
    });

    expect(second).toBe(first);
    expect(getTrustedInteractionContext(req)).toBe(first);
  });

  test('only binds manager-authored logical turn fields without changing trusted provenance', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createWebInteractionContext({ conversation_id: 'conversation-1', source_event_id: 'first' }),
    );

    const bound = bindLogicalTurnContext(req, {
      ...getTrustedInteractionContext(req),
      logical_turn_id: 'logical-1',
      revision: 2,
    });
    expect(bound).toMatchObject({
      logical_turn_id: 'logical-1',
      revision: 2,
      origin: 'interactive',
    });

    const forged = bindLogicalTurnContext(req, {
      ...bound,
      origin: 'scheduler',
      logical_turn_id: 'forged',
    });
    expect(forged).toBe(bound);
    expect(getTrustedInteractionContext(req)).toBe(bound);
  });

  test('binds exact bounded source text internally but omits it from ordinary message metadata', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'event-a',
      }),
    );
    bindInteractionSourceSegments(req, ['  exact first\n', 'exact second  ']);
    const current = getTrustedInteractionContext(req);
    expect(current.source_segments).toEqual([
      {
        ordinal: 0,
        source_event_id: 'event-a',
        source_index: 0,
        text: '  exact first\n',
      },
      {
        ordinal: 1,
        source_event_id: 'event-a',
        source_index: 1,
        text: 'exact second  ',
      },
    ]);

    const claimed = bindLogicalTurnContext(req, {
      ...current,
      logical_turn_id: 'logical-1',
      revision: 2,
      source_event_id: 'event-a',
      source_segments: [
        { ordinal: 0, source_event_id: 'event-prior', source_index: 0, text: 'prior unresolved' },
        ...current.source_segments,
      ],
    });
    expect(claimed.source_segments.map(({ source_event_id }) => source_event_id)).toEqual([
      'event-prior',
      'event-a',
      'event-a',
    ]);

    const persisted = attachInteractionContextMetadata(req, { messageId: 'message-1' });
    const delivery = attachLogicalTurnMetadata({ final: true }, claimed);
    expect(JSON.stringify(persisted.metadata)).not.toContain('exact first');
    expect(JSON.stringify(persisted.metadata)).not.toContain('prior unresolved');
    expect(JSON.stringify(delivery.metadata)).not.toContain('exact first');
    expect(JSON.stringify(delivery.metadata)).not.toContain('prior unresolved');
    expect(delivery.metadata.viventium.interactionContext).not.toHaveProperty('source_segments');
  });

  test('bounds source segments by UTF-8 bytes without splitting a surrogate pair', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createWebInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'event-1',
      }),
    );
    bindInteractionSourceSegments(req, '🙂'.repeat(20_000));
    const [segment] = getTrustedInteractionContext(req).source_segments;
    expect(Buffer.byteLength(segment.text, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(segment.text.endsWith('🙂')).toBe(true);
    expect(segment).toMatchObject({
      truncated: true,
      original_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('accepts a claimed logical turn that evicts only older large source segments', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createWebInteractionContext({
        conversation_id: 'conversation-large',
        source_event_id: 'event-c',
      }),
    );
    bindInteractionSourceSegments(req, 'c'.repeat(30 * 1024));
    const current = getTrustedInteractionContext(req);
    const claimed = bindLogicalTurnContext(req, {
      ...current,
      logical_turn_id: 'logical-large',
      revision: 3,
      source_segments_overflow_count: 1,
      source_segments: [
        {
          ordinal: 0,
          source_event_id: 'event-b',
          source_index: 0,
          text: 'b'.repeat(30 * 1024),
        },
        {
          ordinal: 1,
          source_event_id: 'event-c',
          source_index: 0,
          text: current.source_segments[0].text,
        },
      ],
    });

    expect(claimed).toMatchObject({
      logical_turn_id: 'logical-large',
      revision: 3,
      source_segments_overflow_count: 1,
    });
    expect(claimed.source_segments.map((segment) => segment.source_event_id)).toEqual([
      'event-b',
      'event-c',
    ]);
  });

  test('persists only the bounded provenance needed by recall and lifecycle policy', () => {
    const req = {};
    setTrustedInteractionContext(req, {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'scheduled-conversation-8',
      source_event_id: 'scheduled-run-8',
      schedule_id: 'schedule-8',
      schedule_run_id: 'scheduled-run-8',
      qa_run: true,
      qa_run_id: 'qa-run-8',
      segment_stability: 'immediate',
      supersede_scope: 'response_only',
    });

    const message = attachInteractionContextMetadata(req, {
      messageId: 'message-1',
      metadata: { existing: true },
    });

    expect(message.metadata).toEqual({
      existing: true,
      viventium: {
        qaRun: true,
        qaRunId: 'qa-run-8',
        memoryEligible: false,
        recallEligible: true,
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: { commit_authority: 'server' },
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          surface: 'workbench',
          conversation_id: 'scheduled-conversation-8',
          revision: 1,
          source_event_id: 'scheduled-run-8',
          schedule_id: 'schedule-8',
          schedule_run_id: 'scheduled-run-8',
          qa_run: true,
          qa_run_id: 'qa-run-8',
        },
      },
    });
  });

  test('hides only trusted scheduler control/NTA rows, not an interactive user literal', () => {
    const scheduledReq = {};
    setTrustedInteractionContext(
      scheduledReq,
      createSchedulerInteractionContext({ conversation_id: 'c-1', source_event_id: 's-1' }),
    );
    expect(
      attachInteractionContextMetadata(scheduledReq, {
        text: '{NTA}',
        isCreatedByUser: false,
      }).metadata.viventium.visibility,
    ).toBe('internal');

    const webReq = {};
    setTrustedInteractionContext(
      webReq,
      createWebInteractionContext({ conversation_id: 'c-1', source_event_id: 'u-1' }),
    );
    expect(
      attachInteractionContextMetadata(webReq, { text: '{NTA}', isCreatedByUser: true }).metadata
        .viventium.visibility,
    ).toBeUndefined();
  });

  test('makes scheduler workbench provenance authoritative and noninteractive for OAuth', () => {
    const previous = process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY;
    process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = 'always';
    const req = { body: { viventiumSurface: 'voice' } };
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({ conversation_id: 'c-1', source_event_id: 's-1' }),
    );

    expect(resolveViventiumSurface(req)).toBe('workbench');
    expect(getMcpOAuthWaitDecision(req, new Set(['calendar'])).waitForOAuth).toBe(false);
    expect(shouldSuppressMcpOAuthFlow(req)).toBe(true);

    if (previous === undefined) delete process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY;
    else process.env.VIVENTIUM_MCP_OAUTH_WAIT_POLICY = previous;
  });

  test('keeps OAuth flow initiation available for an ordinary interactive web request', () => {
    expect(shouldSuppressMcpOAuthFlow({})).toBe(false);
  });

  test('binds a server-generated canonical conversation before a logical turn is claimed', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'new',
        source_event_id: 'event-1',
      }),
    );

    const rebound = bindCanonicalInteractionConversation(req, 'conversation-canonical');

    expect(rebound).toEqual(
      expect.objectContaining({
        surface: 'telegram',
        conversation_id: 'conversation-canonical',
        source_event_id: 'event-1',
      }),
    );
    expect(getTrustedInteractionContext(req)).toBe(rebound);
  });

  test('does not rewrite conversation authority after a logical turn is claimed', () => {
    const req = {};
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-one',
        source_event_id: 'event-1',
      }),
    );
    bindLogicalTurnContext(req, {
      ...getTrustedInteractionContext(req),
      logical_turn_id: 'turn-1',
      revision: 1,
    });

    expect(bindCanonicalInteractionConversation(req, 'conversation-two').conversation_id).toBe(
      'conversation-one',
    );
  });
});
