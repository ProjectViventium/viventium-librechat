const {
  applyMainContextAttempt,
  attachMainContextSnapshotMetadata,
  bindMainContextSnapshot,
  buildMainAttemptFactsForAgent,
  captureMainContextSnapshot,
  createMainAttemptFacts,
  hasUnreconciledMainHistory,
  renderMainAttemptFactsAuthorityBlock,
} = require('../ViventiumMainContextService');
const { applyTimeContextDelivery } = require('../surfacePrompts');
const {
  bindLogicalTurnContext,
  createSchedulerInteractionContext,
  createTelegramInteractionContext,
  createVoiceInteractionContext,
  createWebInteractionContext,
  setTrustedInteractionContext,
} = require('../interactionContext');

describe('ViventiumMainContextService', () => {
  function agent(instructions = 'Stable Main policy.') {
    return {
      id: 'main-agent',
      instructions,
      tools: [{ name: 'search' }],
      mcp: ['calendar'],
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Agent-Id': 'main-agent',
            'X-GlassHive-Stable-Authority-SHA256': 'a'.repeat(64),
          },
        },
      },
    };
  }

  test('pins one immutable snapshot when dynamic inputs change later in the attempt chain', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'conversation-1' } };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    bindLogicalTurnContext(req, {
      ...createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
      logical_turn_id: 'logical-turn-1',
      revision: 2,
    });
    const first = captureMainContextSnapshot(req, {
      agent: agent(),
      messages: [{ role: 'user', content: 'Current ask.' }],
      sections: { feelings: 'fresh-state-1', memory: 'bounded-memory' },
    });
    const fallback = captureMainContextSnapshot(req, {
      agent: agent('Different fallback assembly.'),
      messages: [{ role: 'user', content: 'Changed later.' }],
      sections: { feelings: 'fresh-state-2' },
    });

    expect(fallback).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).toMatchObject({
      version: 1,
      ownerId: 'owner-1',
      conversationId: 'conversation-1',
      contextEpoch: 'a'.repeat(64),
      stableAuthoritySha256: 'a'.repeat(64),
    });
    expect(first.sections.feelings).toEqual({
      bytes: Buffer.byteLength('fresh-state-1'),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('pins trusted route facts and renders separate model-visible facts for each attempt', () => {
    const req = {
      user: { id: 'owner-1' },
      body: {
        conversationId: 'conversation-1',
        surface: 'web',
        mainAttemptFacts: {
          provider: 'forged-provider',
          model: 'forged-model',
          effort: 'forged-effort',
        },
      },
    };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    const configuredPath = ['telegram', 'librechat', 'glasshive'];
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      messages: [{ role: 'user', content: 'Which route is active?' }],
      routeFacts: {
        configuredPath,
        primary: { provider: 'codex-cli', model: 'gpt-5.6', effort: 'xhigh' },
        fallback: { provider: 'claude-code', model: 'opus', effort: 'high' },
      },
      feelingsReceipt: {
        status: 'available',
        enabled: true,
        scope: 'all_agents',
        version: 220,
        snapshotSha256: 'f'.repeat(64),
      },
    });
    configuredPath.push('forged-hop');

    expect(snapshot.routeFacts).toEqual({
      surface: 'telegram',
      configuredPath: ['telegram', 'librechat', 'glasshive'],
      primary: { provider: 'codex-cli', model: 'gpt-5.6', effort: 'xhigh' },
      fallback: { provider: 'claude-code', model: 'opus', effort: 'high' },
    });
    expect(Object.isFrozen(snapshot.routeFacts)).toBe(true);
    expect(Object.isFrozen(snapshot.routeFacts.fallback)).toBe(true);

    const primaryFacts = createMainAttemptFacts({
      snapshot,
      attemptNumber: 1,
      executionPath: ['telegram', 'librechat', 'glasshive', 'codex'],
      provider: 'codex-cli',
      model: 'gpt-5.6',
      effort: 'xhigh',
    });
    const fallbackFacts = createMainAttemptFacts({
      snapshot,
      attemptNumber: 2,
      executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
      provider: 'claude-code',
      model: 'opus',
      effort: 'high',
      fallbackReason: 'provider_quota_exhausted',
    });

    expect(primaryFacts).toMatchObject({
      version: 1,
      snapshotSha256: snapshot.snapshotSha256,
      surface: 'telegram',
      attemptNumber: 1,
      isFallback: false,
      feelingsReceipt: {
        status: 'available',
        enabled: true,
        scope: 'all_agents',
        version: 220,
        snapshotSha256: 'f'.repeat(64),
      },
    });
    expect(fallbackFacts).toEqual({
      version: 1,
      snapshotSha256: snapshot.snapshotSha256,
      logicalTurnId: snapshot.logicalTurnId,
      revision: snapshot.revision,
      surface: 'telegram',
      attemptNumber: 2,
      executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
      provider: 'claude-code',
      model: 'opus',
      effort: 'high',
      configuredPrimary: {
        provider: 'codex-cli',
        model: 'gpt-5.6',
        effort: 'xhigh',
      },
      configuredFallback: {
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
      attemptedRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
      winningRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
      isFallback: true,
      feelingsReceipt: {
        status: 'available',
        enabled: true,
        scope: 'all_agents',
        version: 220,
        snapshotSha256: 'f'.repeat(64),
      },
      fallbackReason: 'provider_quota_exhausted',
    });
    expect(Object.isFrozen(fallbackFacts)).toBe(true);
    expect(Object.isFrozen(fallbackFacts.executionPath)).toBe(true);

    const authority = renderMainAttemptFactsAuthorityBlock(fallbackFacts);
    expect(authority).toContain('<viventium_main_attempt_facts_v1>');
    expect(authority).toContain('Trusted current-attempt execution facts');
    expect(authority).toContain('"surface":"telegram"');
    expect(authority).toContain('"fallbackReason":"provider_quota_exhausted"');
    expect(authority).toContain('"feelingsReceipt":{"enabled":true');
    expect(authority).not.toContain('forged-provider');
    expect(authority).not.toContain('forged-model');
    expect(
      renderMainAttemptFactsAuthorityBlock({
        ...fallbackFacts,
        provider: 'body-forged-provider',
      }),
    ).toBe('');
  });

  test('renders a fail-closed Feelings receipt when the turn-pinned read is unavailable', () => {
    const req = { user: { id: 'owner-1' }, body: {} };
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      feelingsReceipt: { status: 'unavailable', reason: 'state_read_timeout' },
    });
    const facts = buildMainAttemptFactsForAgent({ snapshot, agent: agent() });
    const authority = renderMainAttemptFactsAuthorityBlock(facts);

    expect(facts.feelingsReceipt).toEqual({
      status: 'unavailable',
      reason: 'state_read_timeout',
    });
    expect(authority).toContain('"feelingsReceipt":{"reason":"state_read_timeout"');
    expect(authority).toContain('do not invent one');
  });

  test('derives native GlassHive attempt facts from typed provider configuration', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'conversation-1' } };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    bindLogicalTurnContext(req, {
      ...createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
      logical_turn_id: 'logical-turn-1',
      revision: 2,
    });
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      routeFacts: {
        configuredPath: ['telegram', 'librechat'],
        primary: {
          provider: 'glasshive-harness',
          model: 'codex-cli:gpt-5.6-sol',
          effort: 'medium',
        },
        fallback: {
          provider: 'glasshive-harness',
          model: 'claude-code:opus',
          effort: 'high',
        },
      },
    });

    const facts = buildMainAttemptFactsForAgent({
      snapshot,
      agent: {
        provider: 'glasshive-harness',
        model: 'claude-code:opus',
        model_parameters: { reasoning_effort: 'high' },
      },
      isFallback: true,
      fallbackReason: 'provider_quota_exhausted',
    });

    expect(facts).toEqual({
      version: 1,
      snapshotSha256: snapshot.snapshotSha256,
      logicalTurnId: 'logical-turn-1',
      revision: 2,
      surface: 'telegram',
      attemptNumber: 2,
      executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
      provider: 'claude-code',
      model: 'opus',
      effort: 'high',
      configuredPrimary: {
        provider: 'glasshive-harness',
        model: 'codex-cli:gpt-5.6-sol',
        effort: 'medium',
      },
      configuredFallback: {
        provider: 'glasshive-harness',
        model: 'claude-code:opus',
        effort: 'high',
      },
      attemptedRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
      winningRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        effort: 'high',
      },
      isFallback: true,
      fallbackReason: 'provider_quota_exhausted',
    });
  });

  test('renders configured, attempted, and winning routes with typed user-readable model labels', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'conversation-1' } };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    const configuredPrimary = {
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
      modelLabel: 'GPT-5.6 Sol',
      effort: 'xhigh',
    };
    const configuredFallback = {
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      modelLabel: 'Claude Opus 5',
      effort: 'high',
    };
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      routeFacts: {
        configuredPath: ['telegram', 'librechat'],
        primary: configuredPrimary,
        fallback: configuredFallback,
      },
    });

    const facts = buildMainAttemptFactsForAgent({
      snapshot,
      agent: {
        provider: 'glasshive-harness',
        model: 'claude-code:opus',
        model_parameters: {
          model: 'claude-code:opus',
          modelLabel: 'Claude Opus 5',
          reasoning_effort: 'high',
        },
      },
      isFallback: true,
      fallbackReason: 'provider_quota_exhausted',
    });

    expect(facts).toMatchObject({
      selectedModelLabel: 'Claude Opus 5',
      configuredPrimary,
      configuredFallback,
      attemptedRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        modelLabel: 'Claude Opus 5',
        effort: 'high',
      },
      winningRoute: {
        executionPath: ['telegram', 'librechat', 'glasshive', 'claude'],
        provider: 'claude-code',
        model: 'opus',
        modelLabel: 'Claude Opus 5',
        effort: 'high',
      },
    });
    const authority = renderMainAttemptFactsAuthorityBlock(facts);
    expect(authority).toContain('"selectedModelLabel":"Claude Opus 5"');
    expect(authority).toContain('"configuredPrimary"');
    expect(authority).toContain('"configuredFallback"');
    expect(authority).toContain('"attemptedRoute"');
    expect(authority).toContain('"winningRoute"');
  });

  test.each([
    {
      surface: 'web',
      context: createWebInteractionContext,
      route: {
        provider: 'openAI',
        model: 'gpt-5.6-sol',
        modelLabel: 'GPT-5.6 Sol',
        effort: 'xhigh',
      },
      path: ['web', 'librechat', 'openAI'],
    },
    {
      surface: 'voice',
      context: createVoiceInteractionContext,
      route: {
        provider: 'xai',
        model: 'grok-4.5',
        modelLabel: 'Grok 4.5',
        effort: 'low',
      },
      path: ['voice', 'librechat', 'xai'],
    },
  ])('keeps $surface nonfallback route facts correct', ({ surface, context, route, path }) => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: `${surface}-conversation` } };
    setTrustedInteractionContext(
      req,
      context({ conversation_id: `${surface}-conversation`, source_event_id: `${surface}-event` }),
    );
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      routeFacts: { primary: route },
    });

    const facts = buildMainAttemptFactsForAgent({
      snapshot,
      agent: {
        provider: route.provider,
        model: route.model,
        model_parameters: {
          model: route.model,
          modelLabel: route.modelLabel,
          reasoning_effort: route.effort,
        },
      },
    });

    expect(facts).toMatchObject({
      surface,
      attemptNumber: 1,
      executionPath: path,
      selectedModelLabel: route.modelLabel,
      configuredPrimary: route,
      attemptedRoute: { executionPath: path, ...route },
      winningRoute: { executionPath: path, ...route },
      isFallback: false,
    });
    expect(facts.configuredFallback).toBeUndefined();
  });

  test('binds digest-only protocol headers and never copies raw context into transport headers', () => {
    const req = { user: { id: 'owner-1' }, body: {} };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    bindLogicalTurnContext(req, {
      ...createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
      logical_turn_id: 'logical-turn-1',
      revision: 2,
    });
    const target = agent();
    const snapshot = captureMainContextSnapshot(req, {
      agent: target,
      messages: [{ role: 'user', content: 'private-content' }],
      visibleMessages: [
        {
          messageId: 'user-message-1',
          parentMessageId: '',
          isCreatedByUser: true,
          text: 'private-content',
        },
      ],
      sections: { memory: 'private-memory' },
    });

    expect(bindMainContextSnapshot(target, snapshot)).toBe(true);
    const headers = target.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Viventium-Main-Context-Protocol']).toBe('main_context_v1');
    expect(headers['X-Viventium-Main-Context-Owner']).toBe('core');
    expect(headers['X-GlassHive-Stable-Authority-SHA256']).toBe(snapshot.stableAuthoritySha256);
    expect(headers['X-Viventium-Main-Context-Snapshot-SHA256']).toBe(snapshot.snapshotSha256);
    expect(headers['X-Viventium-Continuity-Domain-Id']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['X-Viventium-Continuity-Agent-Id']).toBe('main-agent');
    expect(headers['X-Viventium-Logical-Turn-Id']).toBe(snapshot.logicalTurnId);
    expect(headers['X-Viventium-Logical-Turn-Revision']).toBe(String(snapshot.revision));
    expect(headers['X-Viventium-Memory-Eligible']).toBe('true');
    const visibleChain = JSON.parse(
      Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString('utf8'),
    );
    expect(visibleChain).toEqual([
      expect.objectContaining({
        id: 'user-message-1',
        parentId: '',
        role: 'user',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(JSON.stringify(headers)).not.toContain('private-content');
    expect(JSON.stringify(headers)).not.toContain('private-memory');
  });

  test('bounds a long visible message chain by encoded transport bytes and keeps the newest turns', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'long-schedule' } };
    const target = agent();
    const visibleMessages = Array.from({ length: 320 }, (_, index) => ({
      messageId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      parentMessageId:
        index === 0 ? '' : `00000000-0000-4000-8000-${String(index - 1).padStart(12, '0')}`,
      isCreatedByUser: index % 2 === 0,
      text: `Synthetic visible turn ${index}`,
    }));
    const snapshot = captureMainContextSnapshot(req, {
      agent: target,
      messages: [{ role: 'user', content: 'Current scheduled ask.' }],
      visibleMessages,
    });

    expect(bindMainContextSnapshot(target, snapshot)).toBe(true);
    const encoded =
      target.model_parameters.configuration.defaultHeaders['X-Viventium-Visible-Message-Chain-B64'];
    const chain = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(chain.length).toBeLessThan(128);
    expect(chain.at(-1).id).toBe(visibleMessages.at(-1).messageId);
    expect(chain.slice(-6).map((entry) => entry.id)).toEqual(
      visibleMessages.slice(-6).map((message) => message.messageId),
    );
  });

  test('persists only the digest identity required for an accepted-turn commit', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'conversation-1' } };
    setTrustedInteractionContext(
      req,
      createTelegramInteractionContext({
        conversation_id: 'conversation-1',
        source_event_id: 'message-1',
      }),
    );
    const snapshot = captureMainContextSnapshot(req, {
      agent: agent(),
      messages: [{ role: 'user', content: 'private-content' }],
      sections: { memory: 'private-memory' },
      attemptState: { turnContextText: 'private-turn-context' },
    });
    const persisted = attachMainContextSnapshotMetadata(req, {
      messageId: 'assistant-1',
      metadata: { existing: true },
    });

    expect(persisted.metadata.viventium.mainContext).toEqual({
      version: 1,
      continuityDomainId: snapshot.continuityDomainId,
      agentId: 'main-agent',
      contextEpoch: 'a'.repeat(64),
      stableAuthoritySha256: 'a'.repeat(64),
      snapshotSha256: snapshot.snapshotSha256,
    });
    expect(JSON.stringify(persisted)).not.toContain('private-content');
    expect(JSON.stringify(persisted)).not.toContain('private-memory');
    expect(JSON.stringify(persisted)).not.toContain('private-turn-context');
  });

  test('keeps scheduler turns in the owner Main domain but marks them memory-ineligible', () => {
    const req = { user: { id: 'owner-1' }, body: { conversationId: 'schedule-thread' } };
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'schedule-thread',
        source_event_id: 'occurrence-1',
      }),
    );
    const target = agent();
    const snapshot = captureMainContextSnapshot(req, {
      agent: target,
      messages: [{ role: 'user', content: 'Internal schedule envelope.' }],
    });

    bindMainContextSnapshot(target, snapshot);

    expect(snapshot.memoryEligible).toBe(false);
    expect(target.model_parameters.configuration.defaultHeaders).toMatchObject({
      'X-Viventium-Actor-Kind': 'system',
      'X-Viventium-Origin': 'scheduler',
      'X-Viventium-Memory-Eligible': 'false',
    });
  });

  test('restores exact admitted instructions and turn context for fallback without exposing raw state', () => {
    const req = { user: { id: 'owner-1' }, body: {} };
    const primary = agent('Primary plus exact admitted memory.');
    const snapshot = captureMainContextSnapshot(req, {
      agent: primary,
      messages: [{ role: 'user', content: 'Current ask.' }],
      sections: { finalPrimaryInstructions: primary.instructions },
      attemptState: {
        instructionsByAgentId: { 'main-agent': primary.instructions },
        turnContextHeaderPresent: true,
        turnContextHeaderB64: 'cGlubmVkLXR1cm4tY29udGV4dA==',
        turnContextText: 'pinned-turn-context',
      },
    });
    const fallback = agent('Fresh fallback assembly that must not author.');
    const requestBody = { viventiumGlassHiveTurnContextB64: 'bmV3ZXItbXV0YWJsZS1zdGF0ZQ==' };

    expect(
      applyMainContextAttempt({
        agents: [fallback],
        requestBody,
        snapshot,
        turnContextDeliveryByAgentId: { 'main-agent': 'per_turn_header' },
        attemptAuthorityBlock:
          '<viventium_main_attempt_facts_v1>fallback</viventium_main_attempt_facts_v1>',
      }),
    ).toBe(true);
    expect(fallback.instructions).toBe(primary.instructions);
    expect(
      Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString('utf8'),
    ).toBe(
      'pinned-turn-context\n\n<viventium_main_attempt_facts_v1>fallback</viventium_main_attempt_facts_v1>',
    );
    expect(fallback.model_parameters.configuration.defaultHeaders).toMatchObject({
      'X-Viventium-Main-Context-Snapshot-SHA256': snapshot.snapshotSha256,
    });
    expect(JSON.stringify(snapshot)).not.toContain('cGlubmVkLXR1cm4tY29udGV4dA==');
    expect(JSON.stringify(snapshot)).not.toContain('Primary plus exact admitted memory');
  });

  test('moves the exact admitted turn context into instructions for a direct fallback carrier', () => {
    const req = { user: { id: 'owner-1' }, body: {} };
    const primary = agent('Primary stable instructions.');
    const snapshot = captureMainContextSnapshot(req, {
      agent: primary,
      messages: [{ role: 'user', content: 'Current ask.' }],
      attemptState: {
        instructionsByAgentId: { 'main-agent': primary.instructions },
        turnContextHeaderPresent: true,
        turnContextHeaderB64: 'cGlubmVkLXR1cm4tY29udGV4dA==',
        turnContextText: '<viventium_reply_context_v1>exact referent</viventium_reply_context_v1>',
      },
    });
    const fallback = agent('Mutable fallback assembly.');
    const requestBody = { viventiumGlassHiveTurnContextB64: 'mutable' };

    expect(
      applyMainContextAttempt({
        agents: [fallback],
        requestBody,
        snapshot,
        turnContextDeliveryByAgentId: { 'main-agent': 'developer' },
        attemptAuthorityBlock:
          '<viventium_main_attempt_facts_v1>fallback</viventium_main_attempt_facts_v1>',
      }),
    ).toBe(true);
    expect(fallback.instructions).toBe(
      'Primary stable instructions.\n\n<viventium_reply_context_v1>exact referent</viventium_reply_context_v1>\n\n<viventium_main_attempt_facts_v1>fallback</viventium_main_attempt_facts_v1>',
    );
    expect(requestBody).not.toHaveProperty('viventiumGlassHiveTurnContextB64');
  });

  test('adds only fallback authority when the real direct primary carrier already contains pinned turn context', () => {
    const req = { user: { id: 'owner-1' }, body: {} };
    const pinnedTurnContext = [
      '<viventium_reply_context_v1>exact route and surface facts</viventium_reply_context_v1>',
      '<viventium_feelings_context_v1>one request-pinned capsule</viventium_feelings_context_v1>',
    ].join('\n\n');
    const primary = agent(
      applyTimeContextDelivery({
        req,
        requestBody: req.body,
        instructions: 'Primary stable instructions.',
        timeContextInstructions: pinnedTurnContext,
        providerCapability: { workspace_binding: false, conversation_session: false },
      }),
    );
    const snapshot = captureMainContextSnapshot(req, {
      agent: primary,
      messages: [{ role: 'user', content: 'Current ask.' }],
      sections: {
        finalPrimaryInstructions: primary.instructions,
        feelings:
          '<viventium_feelings_context_v1>one request-pinned capsule</viventium_feelings_context_v1>',
      },
      attemptState: {
        instructionsByAgentId: { 'main-agent': primary.instructions },
        turnContextHeaderPresent: false,
        turnContextText: pinnedTurnContext,
      },
    });
    const fallback = agent('Mutable fallback assembly.');
    const requestBody = { viventiumGlassHiveTurnContextB64: 'mutable-new-context' };
    const fallbackAuthority =
      '<viventium_main_attempt_facts_v1>fallback</viventium_main_attempt_facts_v1>';

    expect(
      applyMainContextAttempt({
        agents: [fallback],
        requestBody,
        snapshot,
        turnContextDeliveryByAgentId: { 'main-agent': 'developer' },
        attemptAuthorityBlock: fallbackAuthority,
      }),
    ).toBe(true);
    expect(fallback.instructions).toBe(`${primary.instructions}\n\n${fallbackAuthority}`);
    expect(fallback.instructions.split(pinnedTurnContext)).toHaveLength(2);
    expect(fallback.instructions.match(/<viventium_feelings_context_v1>/g)).toHaveLength(1);
    expect(requestBody).not.toHaveProperty('viventiumGlassHiveTurnContextB64');
    expect(snapshot.sections.finalPrimaryInstructions.sha256).toBe(
      captureMainContextSnapshot(req, {
        agent: agent('Changed mutable instructions.'),
        sections: { finalPrimaryInstructions: 'Changed mutable instructions.' },
      }).sections.finalPrimaryInstructions.sha256,
    );
  });

  test('reserves the shared provider budget for exact scheduler, Feelings, and attempt authority', () => {
    const maximumDecodedBytes = 16 * 1024;
    const feelingsCapsule =
      '<viventium_feelings_context_v1>one exact request-pinned state</viventium_feelings_context_v1>';
    const replyContext =
      '<viventium_reply_context_v1>verified scheduled referent</viventium_reply_context_v1>';
    const continuityContext =
      '<viventium_main_continuity_v1>accepted owner continuity</viventium_main_continuity_v1>';
    const recurrenceContext =
      '<viventium_recurrence_state_v1>current schedule occurrence</viventium_recurrence_state_v1>';
    const currentTime = 'Current time: Tuesday, August 25, 2026, 2:15 PM (America/Toronto).';
    const schedulerFacts =
      'Scheduled run context:\n- Anchor date tag: scheduled_due_local_date_iso=2026-08-25';
    const rosterOpen = '<viventium_untrusted_active_work_data encoding="base64url-json-v1">\n';
    const rosterClose = '\n</viventium_untrusted_active_work_data>';
    const fixedContext = [
      replyContext,
      continuityContext,
      recurrenceContext,
      currentTime,
      schedulerFacts,
      `${rosterOpen}${rosterClose}`,
    ].join('\n\n');
    const rosterPadding = 'x'.repeat(
      maximumDecodedBytes - Buffer.byteLength(fixedContext, 'utf8') - 7,
    );
    const turnContext = [
      replyContext,
      continuityContext,
      recurrenceContext,
      currentTime,
      schedulerFacts,
      `${rosterOpen}${rosterPadding}${rosterClose}`,
    ].join('\n\n');
    const req = { user: { id: 'owner-scheduler' }, body: { conversationId: 'schedule-thread' } };
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'schedule-thread',
        source_event_id: 'scheduled-occurrence-1',
      }),
    );
    const primary = {
      ...agent(`Stable Main authority.\n\n${feelingsCapsule}`),
      endpoint: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
    };
    const snapshot = captureMainContextSnapshot(req, {
      agent: primary,
      sections: {
        finalPrimaryInstructions: primary.instructions,
        telegramReplyContext: replyContext,
        feelings: feelingsCapsule,
        mainContinuity: continuityContext,
        recurrenceState: recurrenceContext,
      },
      routeFacts: {
        primary: { provider: 'glasshive-harness', model: 'codex-cli:gpt-5.6-sol' },
        fallback: { provider: 'glasshive-harness', model: 'claude-code:opus' },
      },
      feelingsReceipt: {
        status: 'available',
        enabled: true,
        scope: 'all_agents',
        version: 220,
        snapshotSha256: 'f'.repeat(64),
      },
      attemptState: {
        instructionsByAgentId: { 'main-agent': primary.instructions },
        turnContextHeaderPresent: true,
        turnContextText: turnContext,
      },
    });
    const primaryAuthority = renderMainAttemptFactsAuthorityBlock(
      buildMainAttemptFactsForAgent({ snapshot, agent: primary }),
    );
    const snapshotDigest = snapshot.snapshotSha256;
    const primaryBody = {};

    expect(Buffer.byteLength(turnContext, 'utf8')).toBeLessThan(maximumDecodedBytes);
    expect(Buffer.byteLength(`${turnContext}\n\n${primaryAuthority}`, 'utf8')).toBeGreaterThan(
      maximumDecodedBytes,
    );
    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody: primaryBody,
        snapshot,
        attemptAuthorityBlock: primaryAuthority,
        turnContextDeliveryByAgentId: { 'main-agent': 'per_turn_header' },
      }),
    ).toBe(true);

    const primaryContext = Buffer.from(
      primaryBody.viventiumGlassHiveTurnContextB64,
      'base64',
    ).toString('utf8');
    expect(Buffer.byteLength(primaryContext, 'utf8')).toBeLessThanOrEqual(maximumDecodedBytes);
    expect(
      Buffer.byteLength(primaryBody.viventiumGlassHiveTurnContextB64, 'utf8'),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(primaryContext).toContain(replyContext);
    expect(primaryContext).toContain(continuityContext);
    expect(primaryContext).toContain(recurrenceContext);
    expect(primaryContext).toContain(currentTime);
    expect(primaryContext).toContain(schedulerFacts);
    expect(primaryContext).toContain(primaryAuthority);
    expect(primaryContext).not.toContain(rosterOpen);
    expect(primaryContext).not.toContain(rosterClose);
    expect(primaryContext).toContain(`"snapshotSha256":"${'f'.repeat(64)}"`);
    expect(primary.instructions.split(feelingsCapsule)).toHaveLength(2);
    expect(primary.model_parameters.configuration.defaultHeaders).toMatchObject({
      'X-Viventium-Origin': 'scheduler',
      'X-Viventium-Memory-Eligible': 'false',
      'X-Viventium-Main-Context-Snapshot-SHA256': snapshotDigest,
    });

    const fallback = {
      ...agent('Mutable fallback instructions must not become authority.'),
      endpoint: 'glasshive-harness',
      model: 'claude-code:opus',
    };
    const fallbackAuthority = renderMainAttemptFactsAuthorityBlock(
      buildMainAttemptFactsForAgent({
        snapshot,
        agent: fallback,
        isFallback: true,
        fallbackReason: 'provider_quota_exhausted',
      }),
    );
    const fallbackBody = {};
    expect(
      applyMainContextAttempt({
        agents: [fallback],
        requestBody: fallbackBody,
        snapshot,
        attemptAuthorityBlock: fallbackAuthority,
        turnContextDeliveryByAgentId: { 'main-agent': 'per_turn_header' },
      }),
    ).toBe(true);

    const fallbackContext = Buffer.from(
      fallbackBody.viventiumGlassHiveTurnContextB64,
      'base64',
    ).toString('utf8');
    expect(Buffer.byteLength(fallbackContext, 'utf8')).toBeLessThanOrEqual(maximumDecodedBytes);
    expect(fallbackContext).toContain(fallbackAuthority);
    expect(fallbackContext).toContain('"provider":"claude-code"');
    expect(fallbackContext).toContain('"fallbackReason":"provider_quota_exhausted"');
    expect(fallbackContext.match(/<viventium_main_attempt_facts_v1>/g)).toHaveLength(1);
    expect(fallback.instructions).toBe(primary.instructions);
    expect(fallback.instructions.split(feelingsCapsule)).toHaveLength(2);
    expect(snapshot.snapshotSha256).toBe(snapshotDigest);
    expect(Object.isFrozen(snapshot)).toBe(true);

    const encodedFallback = fallbackBody.viventiumGlassHiveTurnContextB64;
    expect(
      applyMainContextAttempt({
        agents: [fallback],
        requestBody: fallbackBody,
        snapshot,
        attemptAuthorityBlock: fallbackAuthority,
        turnContextDeliveryByAgentId: { 'main-agent': 'per_turn_header' },
      }),
    ).toBe(true);
    expect(fallbackBody.viventiumGlassHiveTurnContextB64).toBe(encodedFallback);
    expect(fallback.instructions).toBe(primary.instructions);
  });

  test('admits the exact 16-KiB decoded boundary without changing context or authority', () => {
    const maximumDecodedBytes = 16 * 1024;
    const authority =
      '<viventium_main_attempt_facts_v1>exact boundary</viventium_main_attempt_facts_v1>';
    const turnContext = 'x'.repeat(
      maximumDecodedBytes -
        Buffer.byteLength(authority, 'utf8') -
        Buffer.byteLength('\n\n', 'utf8'),
    );
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-boundary' } },
      {
        agent: primary,
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: turnContext,
        },
      },
    );
    const requestBody = {};

    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
      }),
    ).toBe(true);

    const decoded = Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString(
      'utf8',
    );
    expect(decoded).toBe(`${turnContext}\n\n${authority}`);
    expect(Buffer.byteLength(decoded, 'utf8')).toBe(maximumDecodedBytes);
    expect(Buffer.byteLength(requestBody.viventiumGlassHiveTurnContextB64, 'utf8')).toBe(21_848);
  });

  test('compacts multibyte turn context without splitting Unicode or changing exact authority', () => {
    const maximumDecodedBytes = 16 * 1024;
    const authority =
      '<viventium_main_attempt_facts_v1>🧠 exact Unicode authority</viventium_main_attempt_facts_v1>';
    const turnContext = '🧠'.repeat(4096);
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-unicode' } },
      {
        agent: primary,
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: turnContext,
        },
      },
    );
    const requestBody = {};

    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
      }),
    ).toBe(true);

    const decoded = Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString(
      'utf8',
    );
    const preservedContext = decoded.slice(0, -authority.length - 2);
    expect(Buffer.byteLength(decoded, 'utf8')).toBeLessThanOrEqual(maximumDecodedBytes);
    expect(preservedContext.length).toBeGreaterThan(0);
    expect(preservedContext.split('🧠').join('')).toBe('');
    expect(decoded).not.toContain('\uFFFD');
    expect(decoded.endsWith(`\n\n${authority}`)).toBe(true);
  });

  test('never clips or separates an atomic trusted envelope that contains blank lines', () => {
    const replyContext = [
      '<viventium_reply_context_v1>',
      'First verified paragraph.',
      '',
      'Second verified paragraph.',
      '</viventium_reply_context_v1>',
    ].join('\n');
    const authority =
      '<viventium_main_attempt_facts_v1>keep the entire reply</viventium_main_attempt_facts_v1>';
    const turnContext = `${replyContext}\n\n${'🧠'.repeat(4090)}`;
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-envelope' } },
      {
        agent: primary,
        sections: { telegramReplyContext: replyContext },
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: turnContext,
        },
      },
    );
    const requestBody = {};

    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
      }),
    ).toBe(true);

    const decoded = Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString(
      'utf8',
    );
    expect(Buffer.byteLength(decoded, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(decoded).toContain(replyContext);
    expect(decoded.match(/<viventium_reply_context_v1>/g)).toHaveLength(1);
    expect(decoded.match(/<\/viventium_reply_context_v1>/g)).toHaveLength(1);
    expect(decoded).toContain(authority);
    expect(decoded).not.toContain('\uFFFD');
  });

  test('fails closed before mutating agents or request headers when trusted authority cannot fit', () => {
    const primary = agent('Existing private instructions must remain unchanged.');
    const existingHeaders = { ...primary.model_parameters.configuration.defaultHeaders };
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-oversized' } },
      {
        agent: primary,
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: 'Current exact schedule facts.',
        },
      },
    );
    const requestBody = { viventiumGlassHiveTurnContextB64: 'existing-pinned-header' };
    let failure;

    try {
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: '🧠'.repeat(4097),
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 'main_context_turn_context_authority_too_large' });
    expect(primary.instructions).toBe('Existing private instructions must remain unchanged.');
    expect(primary.model_parameters.configuration.defaultHeaders).toEqual(existingHeaders);
    expect(requestBody).toEqual({ viventiumGlassHiveTurnContextB64: 'existing-pinned-header' });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('never removes or duplicates an exact request-pinned Feeling capsule during compaction', () => {
    const feelingsCapsule =
      '<viventium_feelings_context_v1>exact private request-pinned state</viventium_feelings_context_v1>';
    const authority =
      '<viventium_main_attempt_facts_v1>exact pinned Feelings receipt</viventium_main_attempt_facts_v1>';
    const turnContext = `${feelingsCapsule}\n\n${'🧠'.repeat(4096)}`;
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-pinned-feelings' } },
      {
        agent: primary,
        sections: { feelings: feelingsCapsule },
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: turnContext,
        },
      },
    );
    const requestBody = {};

    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
      }),
    ).toBe(true);

    const decoded = Buffer.from(requestBody.viventiumGlassHiveTurnContextB64, 'base64').toString(
      'utf8',
    );
    expect(Buffer.byteLength(decoded, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    expect(decoded.split(feelingsCapsule)).toHaveLength(2);
    expect(decoded).toContain(authority);
  });

  test('rejects an atomic pinned referent that cannot fit beside complete trusted authority', () => {
    const replyContext = `<viventium_reply_context_v1>${'x'.repeat(
      16 * 1024 - 100,
    )}</viventium_reply_context_v1>`;
    const authority =
      '<viventium_main_attempt_facts_v1>complete trusted execution facts that cannot be removed</viventium_main_attempt_facts_v1>';
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-atomic-referent' } },
      {
        agent: primary,
        sections: { telegramReplyContext: replyContext },
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: true,
          turnContextText: replyContext,
        },
      },
    );
    const requestBody = { viventiumGlassHiveTurnContextB64: 'existing-pinned-header' };
    let failure;

    try {
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'main_context_turn_context_required_section_too_large',
    });
    expect(primary.instructions).toBe('Stable Main policy.');
    expect(requestBody).toEqual({ viventiumGlassHiveTurnContextB64: 'existing-pinned-header' });
  });

  test('does not apply GlassHive header limits to an unchanged direct developer carrier', () => {
    const turnContext = '🧠'.repeat(4097);
    const authority = 'x'.repeat(16 * 1024 + 1);
    const primary = agent();
    const snapshot = captureMainContextSnapshot(
      { user: { id: 'owner-direct' } },
      {
        agent: primary,
        attemptState: {
          instructionsByAgentId: { 'main-agent': primary.instructions },
          turnContextHeaderPresent: false,
          turnContextText: turnContext,
        },
      },
    );
    const requestBody = { viventiumGlassHiveTurnContextB64: 'stale-header' };

    expect(
      applyMainContextAttempt({
        agents: [primary],
        requestBody,
        snapshot,
        attemptAuthorityBlock: authority,
        turnContextDeliveryByAgentId: { 'main-agent': 'developer' },
      }),
    ).toBe(true);
    expect(primary.instructions).toBe(`Stable Main policy.\n\n${turnContext}\n\n${authority}`);
    expect(requestBody).not.toHaveProperty('viventiumGlassHiveTurnContextB64');
  });

  test('protects an unstamped accepted Mongo branch on its first Core-owned V1 turn', () => {
    const req = { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } };
    const primary = agent();
    primary.provider = 'glasshive-harness';
    primary.model = 'codex-cli:gpt-5.6-sol';
    const history = [
      {
        messageId: 'old-user',
        parentMessageId: '',
        role: 'user',
        isCreatedByUser: true,
        content: 'Retain this prior decision.',
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
      },
      {
        messageId: 'old-answer',
        parentMessageId: 'old-user',
        role: 'assistant',
        isCreatedByUser: false,
        content: 'Wait for approval.',
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
      },
      { messageId: 'new-user', parentMessageId: 'old-answer', role: 'user', content: 'What next?' },
    ];
    const snapshot = captureMainContextSnapshot(req, {
      agent: primary,
      messages: history,
      visibleMessages: history,
      routeFacts: { primary: { provider: primary.provider, model: primary.model } },
      protectUnreconciledHistory: true,
    });
    expect(snapshot.routeFacts.primary).toMatchObject({
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-5.6-sol',
    });
    expect(bindMainContextSnapshot(primary, snapshot)).toBe(true);
    const headers = primary.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Viventium-Main-Context-Owner']).toBe('core');
    const chain = JSON.parse(
      Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64'),
    );
    expect(chain.map(({ id, accepted_source }) => [id, accepted_source === true])).toEqual([
      ['old-user', true],
      ['old-answer', true],
      ['new-user', false],
    ]);
  });

  test('keeps protecting old history after a new Core-stamped turn and reload', () => {
    const stamped = {
      version: 1,
      agentId: 'main-agent',
      continuityDomainId: 'a'.repeat(64),
      contextEpoch: 'a'.repeat(64),
      stableAuthoritySha256: 'a'.repeat(64),
      snapshotSha256: 'b'.repeat(64),
    };
    const branch = [
      { messageId: 'old-user', isCreatedByUser: true },
      { messageId: 'old-answer', isCreatedByUser: false },
      {
        messageId: 'new-user-1',
        isCreatedByUser: true,
        metadata: { viventium: { mainContext: stamped } },
      },
      {
        messageId: 'new-answer-1',
        isCreatedByUser: false,
        metadata: { viventium: { mainContext: stamped } },
      },
      { messageId: 'new-user-2', isCreatedByUser: true },
    ];
    expect(hasUnreconciledMainHistory(branch)).toBe(true);
    expect(hasUnreconciledMainHistory(branch.slice(2))).toBe(false);
    expect(hasUnreconciledMainHistory(branch.slice(-1))).toBe(false);
  });

  test('rejects a pruned unstamped prior turn before claiming Core-owned V1', () => {
    const history = [
      {
        messageId: 'old-user',
        role: 'user',
        isCreatedByUser: true,
        content: 'Material prior fact.',
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
      },
      {
        messageId: 'old-answer',
        role: 'assistant',
        isCreatedByUser: false,
        content: 'Approved only after review.',
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
      },
      { messageId: 'new-user', role: 'user', content: 'Continue.' },
    ];
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history.slice(1),
          protectUnreconciledHistory: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test('rejects a protected old branch when no visible source reaches the snapshot', () => {
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        { agent: agent(), visibleMessages: [], messages: [], protectUnreconciledHistory: true },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test('does not let repeated current text impersonate a missing old source', () => {
    const history = [
      {
        messageId: 'old-user',
        role: 'user',
        isCreatedByUser: true,
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
        content: 'Repeat.',
      },
      { messageId: 'new-user', role: 'user', isCreatedByUser: true, content: 'Repeat.' },
    ];
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history.slice(1),
          protectUnreconciledHistory: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test('rejects an unstamped branch beyond the bounded identity carrier', () => {
    const history = Array.from({ length: 129 }, (_, index) => ({
      messageId: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      isCreatedByUser: index % 2 === 0,
      user: 'owner-legacy',
      conversationId: 'conversation-legacy',
      content: `Synthetic accepted message ${index}`,
    }));
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history,
          protectUnreconciledHistory: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test('rejects ambiguous old message identity before publishing protected sources', () => {
    const history = [
      {
        messageId: 'same',
        role: 'user',
        isCreatedByUser: true,
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
        content: 'First.',
      },
      {
        messageId: 'same',
        role: 'assistant',
        isCreatedByUser: false,
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
        content: 'Second.',
      },
      { messageId: 'current', role: 'user', content: 'Continue.' },
    ];
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history,
          protectUnreconciledHistory: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test.each([
    ['foreign owner', { user: 'other-owner' }],
    ['foreign conversation', { conversationId: 'other-conversation' }],
    ['unfinished answer', { unfinished: true }],
    ['internal answer', { metadata: { viventium: { visibility: 'internal' } } }],
    ['visible text missing from content', { text: 'Prior answer.', content: [] }],
  ])('refuses %s as old accepted Main evidence', (_case, altered) => {
    const prior = {
      user: 'owner-legacy',
      conversationId: 'conversation-legacy',
      messageId: 'old-answer',
      role: 'assistant',
      isCreatedByUser: false,
      content: 'Prior answer.',
      ...altered,
    };
    const history = [prior, { messageId: 'new-user', role: 'user', content: 'Continue.' }];
    expect(() =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history,
          protectUnreconciledHistory: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'source_context_unavailable', status: 413 }));
  });

  test('reloaded Core snapshot preserves the same exact old branch and route', () => {
    const history = [
      {
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
        messageId: 'old-user',
        role: 'user',
        isCreatedByUser: true,
        content: 'Keep the option open.',
      },
      {
        user: 'owner-legacy',
        conversationId: 'conversation-legacy',
        messageId: 'old-answer',
        role: 'assistant',
        isCreatedByUser: false,
        content: 'Approval remains pending.',
      },
      { messageId: 'new-user', role: 'user', content: 'Continue.' },
    ];
    const capture = () =>
      captureMainContextSnapshot(
        { user: { id: 'owner-legacy' }, body: { conversationId: 'conversation-legacy' } },
        {
          agent: agent(),
          visibleMessages: history,
          messages: history,
          routeFacts: {
            primary: { provider: 'glasshive-harness', model: 'codex-cli:gpt-5.6-sol' },
          },
          protectUnreconciledHistory: true,
        },
      );
    const before = capture();
    const after = capture();
    expect(after.snapshotSha256).toBe(before.snapshotSha256);
    expect(after.visibleMessageChain).toEqual(before.visibleMessageChain);
    expect(after.routeFacts.primary).toEqual(before.routeFacts.primary);
  });
});
