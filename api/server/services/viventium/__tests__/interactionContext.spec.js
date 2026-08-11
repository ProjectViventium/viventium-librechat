const {
  attachInteractionContextMetadata,
  bindCanonicalInteractionConversation,
  bindLogicalTurnContext,
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
      { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
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

  test('persists only the bounded provenance needed by recall and lifecycle policy', () => {
    const req = {};
    setTrustedInteractionContext(req, {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'scheduled-conversation-8',
      source_event_id: 'scheduled-run-8',
      segment_stability: 'immediate',
      supersede_scope: 'response_only',
    });

    const message = attachInteractionContextMetadata(req, {
      messageId: 'message-1',
      metadata: { existing: true, viventium: { qaRun: true } },
    });

    expect(message.metadata).toEqual({
      existing: true,
      viventium: {
        qaRun: true,
        memoryEligible: false,
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
