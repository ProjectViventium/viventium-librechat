/* === VIVENTIUM START ===
 * Feature: Phase B follow-up formatting parity tests
 *
 * Purpose:
 * - Keep web follow-ups aligned with the main web reply formatting contract.
 * - Prevent follow-up prompt regressions that flatten structured web text into dense prose.
 *
 * Added: 2026-03-06
 * === VIVENTIUM END === */

const { logger } = require('@librechat/data-schemas');
const { Run } = require('@librechat/agents');
const {
  formatFollowUpPrompt,
  resolveFollowUpContinuationContext,
  resolveFollowUpRuntimeAssignment,
  resolveFollowUpPersistenceText,
  sanitizeAnthropicFollowUpLLMConfig,
  buildFollowUpModelKwargsForProvider,
  shouldForceVisibleFollowUpForEmptyPrimary,
  extractRecentResponseTextFromMessage,
  resolveUserRequestTextFromMessages,
  isPlaceholderRecentResponseText,
  mergeVisibleTextIntoMessageContent,
  upsertCortexParts,
  buildFollowUpDecisionRecord,
  compactDecisionRecordForMetadata,
  generateFollowUpText,
  resolvePhaseBFeelingContext,
} = require('../BackgroundCortexFollowUpService');

describe('upsertCortexParts', () => {
  test('preserves the parent Phase A text when adding cortex parts', () => {
    const merged = upsertCortexParts(
      [],
      [
        {
          type: 'cortex_insight',
          cortex_id: 'confirmation_bias',
          cortex_name: 'Confirmation Bias',
          status: 'complete',
          insight: 'Check assumptions.',
        },
      ],
      { visibleText: 'TEST_OK' },
    );

    expect(merged).toEqual([
      expect.objectContaining({ type: 'text', text: 'TEST_OK' }),
      expect.objectContaining({
        type: 'cortex_insight',
        cortex_id: 'confirmation_bias',
      }),
    ]);
  });

  test('does not turn an internal no-response marker into visible parent text', () => {
    const merged = upsertCortexParts(
      [],
      [
        {
          type: 'cortex_insight',
          cortex_id: 'red_team',
          cortex_name: 'Red Team',
          status: 'complete',
          insight: 'No issue.',
        },
      ],
      { visibleText: '{NTA}' },
    );

    expect(merged).toEqual([
      expect.objectContaining({
        type: 'cortex_insight',
        cortex_id: 'red_team',
      }),
    ]);
  });
});

describe('mergeVisibleTextIntoMessageContent', () => {
  test('drops stale provider error parts when recovered visible text replaces an empty primary', () => {
    const merged = mergeVisibleTextIntoMessageContent(
      [
        {
          type: 'cortex_insight',
          cortex_id: 'emotional_resonance',
          status: 'complete',
          insight: 'A useful recovered observation.',
        },
        {
          type: 'error',
          error: 'The model provider is temporarily overloaded. Please try again shortly.',
          error_class: 'provider_temporarily_unavailable',
        },
      ],
      'Recovered visible answer.',
      { dropErrorParts: true },
    );

    expect(merged).toEqual([
      expect.objectContaining({
        type: 'cortex_insight',
        cortex_id: 'emotional_resonance',
      }),
      { type: 'text', text: 'Recovered visible answer.' },
    ]);
  });

  test('preserves error parts when callers are only merging ordinary visible text', () => {
    const merged = mergeVisibleTextIntoMessageContent(
      [
        {
          type: 'error',
          error: 'The model provider is temporarily overloaded. Please try again shortly.',
          error_class: 'provider_temporarily_unavailable',
        },
      ],
      'Visible answer.',
    );

    expect(merged).toEqual([
      expect.objectContaining({
        type: 'error',
        error_class: 'provider_temporarily_unavailable',
      }),
      { type: 'text', text: 'Visible answer.' },
    ]);
  });
});

describe('Phase B prompt registry ownership', () => {
  afterEach(() => {
    jest.dontMock('~/server/services/viventium/promptRegistry');
    jest.resetModules();
  });

  test('routes ordinary follow-up user prompts through the prompt registry', () => {
    jest.resetModules();
    const getPromptText = jest.fn((_promptId, fallback) => fallback);
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({ getPromptText }));
    const {
      formatFollowUpPrompt: registryFormatFollowUpPrompt,
    } = require('../BackgroundCortexFollowUpService');

    registryFormatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The worker found a result.' }],
      recentResponse: 'I am checking.',
      voiceMode: false,
      surface: '',
    });

    expect(getPromptText).toHaveBeenCalledWith(
      'cortex.follow_up_phase_b.user_message',
      expect.any(String),
      expect.objectContaining({
        background_insights: expect.stringContaining('The worker found a result.'),
        recent_response_context: expect.stringContaining('Here is the response you JUST sent'),
      }),
    );
  });

  test('routes Phase B system prompts through the prompt registry', () => {
    jest.resetModules();
    const getPromptText = jest.fn((_promptId, fallback) => fallback);
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({ getPromptText }));
    const {
      buildFollowUpSystemPrompt: registryBuildFollowUpSystemPrompt,
    } = require('../BackgroundCortexFollowUpService');

    registryBuildFollowUpSystemPrompt({
      primaryResponseMode: true,
      noResponseInstructions: 'Use {NTA} when no reply is needed.',
    });

    expect(getPromptText).toHaveBeenCalledWith(
      'cortex.follow_up_phase_b.primary_system',
      expect.any(String),
      expect.objectContaining({
        no_response_instructions: 'Use {NTA} when no reply is needed.',
      }),
    );
  });

  test('pins one Feeling capsule as the final system layer for a visible follow-up', () => {
    const capsule =
      '<viventium_feeling_state>\nsynthetic private cause\n</viventium_feeling_state>';
    const systemPrompt = require('../BackgroundCortexFollowUpService').buildFollowUpSystemPrompt({
      primaryResponseMode: false,
      noResponseInstructions: 'Use {NTA} when no reply is needed.',
      feelingCapsule: capsule,
    });

    expect(systemPrompt.endsWith(capsule)).toBe(true);
    expect(systemPrompt.match(/<viventium_feeling_state>/g)).toHaveLength(1);
    expect(systemPrompt.indexOf('Use {NTA}')).toBeLessThan(systemPrompt.indexOf(capsule));
  });

  test('routes forced primary follow-up prompts with the user request through the prompt registry', () => {
    jest.resetModules();
    const getPromptText = jest.fn((_promptId, fallback) => fallback);
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({ getPromptText }));
    const {
      formatFollowUpPrompt: registryFormatFollowUpPrompt,
    } = require('../BackgroundCortexFollowUpService');

    registryFormatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'Use two bullets.' }],
      recentResponse: '',
      userRequest: 'Give me one strength and one improvement.',
      voiceMode: false,
      surface: '',
      primaryResponseMode: true,
    });

    expect(getPromptText).toHaveBeenCalledWith(
      'cortex.follow_up_phase_b.primary_user_message',
      expect.any(String),
      expect.objectContaining({
        user_request: 'Give me one strength and one improvement.',
        background_insights: expect.stringContaining('Use two bullets.'),
      }),
    );
  });
});

describe('Phase B conscious Feelings context', () => {
  const capsule = '<viventium_feeling_state>\nsynthetic private cause\n</viventium_feeling_state>';

  test.each(['all_agents', 'conscious_agent'])(
    'applies the pinned capsule to conscious synthesis under %s scope',
    (agentScope) => {
      expect(
        resolvePhaseBFeelingContext({
          enabled: true,
          agentScope,
          snapshotHash: 'synthetic-hash',
          capsule,
        }),
      ).toEqual({
        capsule,
        enabled: true,
        scope: agentScope,
        snapshotHash: 'synthetic-hash',
        reason: 'conscious_synthesis',
        rangePromptOverrideCount: 0,
        activeRangePromptOverrideCount: 0,
        activeRangePromptOverrideChars: 0,
      });
    },
  );

  test('does not apply a capsule when Feelings is off', () => {
    expect(
      resolvePhaseBFeelingContext({
        enabled: false,
        agentScope: 'all_agents',
        snapshotHash: 'synthetic-off-hash',
        capsule,
      }),
    ).toEqual({
      capsule: '',
      enabled: false,
      scope: 'all_agents',
      snapshotHash: 'synthetic-off-hash',
      reason: 'feelings_disabled',
      rangePromptOverrideCount: 0,
      activeRangePromptOverrideCount: 0,
      activeRangePromptOverrideChars: 0,
    });
  });

  test('distinguishes operator unavailability from a user turning Feelings off', () => {
    expect(
      resolvePhaseBFeelingContext({
        available: false,
        enabled: false,
        agentScope: 'all_agents',
        snapshotHash: 'synthetic-unavailable-hash',
        capsule: '',
      }),
    ).toEqual({
      capsule: '',
      enabled: false,
      scope: 'all_agents',
      snapshotHash: 'synthetic-unavailable-hash',
      reason: 'operator_unavailable',
      rangePromptOverrideCount: 0,
      activeRangePromptOverrideCount: 0,
      activeRangePromptOverrideChars: 0,
    });
  });

  test.each([
    [null, 'snapshot_unavailable'],
    [
      {
        enabled: true,
        agentScope: 'all_agents',
        snapshotHash: 'synthetic-empty-hash',
        capsule: '',
      },
      'capsule_unavailable',
    ],
  ])(
    'fails open without invented affect when pinned context is unavailable',
    (snapshot, reason) => {
      expect(resolvePhaseBFeelingContext(snapshot)).toEqual(
        expect.objectContaining({
          capsule: '',
          reason,
        }),
      );
    },
  );

  test('sends the exact pinned capsule to the model and logs only structural application evidence', async () => {
    const processStream = jest.fn().mockResolvedValue('A natural synthesized continuation.');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const infoLog = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warnLog = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await generateFollowUpText({
        req: {
          id: 'synthetic-phase-b-request',
          body: {},
          _viventiumFeelingSnapshot: {
            enabled: true,
            agentScope: 'conscious_agent',
            snapshotHash: 'synthetic-hash',
            capsule,
          },
        },
        agent: {
          provider: 'xai',
          model: 'synthetic-model',
          model_parameters: {},
        },
        insightsData: {
          insights: [{ cortexName: 'Synthetic specialist', insight: 'A new grounded fact.' }],
        },
        recentResponse: 'The initial answer is already visible.',
        runId: 'synthetic-run',
      });

      const modelInstructions = createRun.mock.calls[0][0].graphConfig.instructions;
      expect(modelInstructions.endsWith(capsule)).toBe(true);
      expect(modelInstructions.match(/<viventium_feeling_state>/g)).toHaveLength(1);

      const serializedLogs = infoLog.mock.calls.map(([message]) => String(message)).join('\n');
      expect(serializedLogs).toContain('feelings.inject.final_run');
      expect(serializedLogs).toContain('phase_b_followup');
      expect(serializedLogs).toContain('conscious_synthesis');
      expect(serializedLogs).not.toContain('synthetic private cause');
    } finally {
      createRun.mockRestore();
      infoLog.mockRestore();
      warnLog.mockRestore();
    }
  });
});

describe('formatFollowUpPrompt', () => {
  test('defaults web follow-ups to markdown-friendly web text rules', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'planner', insight: 'Use bullets.\n\nKeep sections tight.' }],
      recentResponse: 'Initial reply already covered the high-level recommendation.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('WEB TEXT MODE:');
    expect(prompt).toContain('Use standard Markdown formatting');
    expect(prompt).toContain('Prefer short paragraphs and bullet lists');
    expect(prompt).toContain('preserve helpful structure');
  });

  test('keeps playground follow-ups plain text', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'planner', insight: 'Keep it simple.' }],
      recentResponse: 'Initial reply already covered the basics.',
      voiceMode: false,
      surface: 'playground',
    });

    expect(prompt).toContain('PLAYGROUND TEXT MODE:');
    expect(prompt).not.toContain('WEB TEXT MODE:');
  });

  test('keeps Wing Mode follow-ups silence-first', () => {
    const prompt = formatFollowUpPrompt({
      insights: [
        {
          cortexName: 'Emotional Resonance',
          insight: 'The user may need space to talk, but did not address the assistant directly.',
        },
      ],
      recentResponse: '{NTA}',
      voiceMode: true,
      surface: 'wing',
    });

    expect(prompt).toContain('Wing Mode follow-up rule:');
    expect(prompt).toContain('silence-first ambient voice context');
    expect(prompt).toContain('Output exactly {NTA}');
    expect(prompt).toContain(
      'Emotional resonance, general support, or “space to talk” is not enough',
    );
  });

  test('tells the follow-up model to keep new facts even when an insight ends with a question', () => {
    const prompt = formatFollowUpPrompt({
      insights: [
        {
          cortexName: 'Pattern Recognition',
          insight:
            'Earlier today you already decided the on-site visit is optional for the reporting launch. Is the deployment still blocked?',
        },
      ],
      recentResponse: "Alright, I'm listening.",
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain(
      'If an insight contains new factual/contextual material followed by a question, keep the new material and drop the question.',
    );
    expect(prompt).toContain(
      'Use {NTA} only when there is truly no new user-visible content beyond a question or repetition.',
    );
    expect(prompt).toContain(
      'If an insight includes a question, drop the question and keep any accompanying factual material.',
    );
    expect(prompt).not.toContain('If a question seems needed, output {NTA} instead.');
  });

  test('makes the main-agent continuation the adjudicator for background evidence', () => {
    const prompt = formatFollowUpPrompt({
      insights: [
        { cortexName: 'worker', insight: 'The local worker finished and found a useful result.' },
      ],
      recentResponse: 'I started the worker.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('You are the main AI continuing the same conversation.');
    expect(prompt).toContain(
      'Background agents provide evidence only. You decide whether there is anything worth surfacing.',
    );
    expect(prompt).toContain('respond with {NTA}');
  });

  test('shows the follow-up model newer conversation context when the thread moved on', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The venue doors opened at 8 PM.' }],
      recentResponse: "You're not late.",
      continuationContext: 'User: I am already getting ready now.\nAssistant: You have time.',
      voiceMode: false,
      surface: '',
    });

    expect(prompt).toContain('Here is the earlier response this follow-up belongs to');
    expect(prompt).toContain('## Current Conversation State');
    expect(prompt).toContain('User: I am already getting ready now.');
    expect(prompt).toContain('If the background insights are stale, redundant, already resolved');
    expect(prompt).toContain('Only surface information that is still useful now');
    expect(prompt).toContain('{NTA}');
  });

  test('makes primary deferred answers user-visible only through the main-agent continuation', () => {
    const prompt = formatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The task completed successfully.' }],
      recentResponse: 'I’m checking.',
      userRequest: 'Please summarize the result.',
      voiceMode: false,
      surface: '',
      primaryResponseMode: true,
    });

    expect(prompt).toContain('You are generating the primary user-visible answer for this turn.');
    expect(prompt).toContain(
      'Background agents provide evidence only. You decide what, if anything, should become visible to the user.',
    );
    expect(prompt).toContain(
      'Do not output {NTA} if the insights contain any substantive user-visible information.',
    );
    expect(prompt).toContain('User request for this turn:');
    expect(prompt).toContain('Please summarize the result.');
  });
});

describe('resolveUserRequestTextFromMessages', () => {
  test('loads the user request from the assistant parent message tree', () => {
    const text = resolveUserRequestTextFromMessages(
      [
        {
          messageId: 'user-1',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Answer in two short bullets.',
        },
        {
          messageId: 'assistant-1',
          parentMessageId: 'user-1',
          sender: 'Viventium',
          isCreatedByUser: false,
          text: '',
          content: [{ type: 'cortex_insight', insight: 'A useful result.' }],
        },
      ],
      'assistant-1',
    );

    expect(text).toBe('Answer in two short bullets.');
  });

  test('returns an empty string when the assistant parent is not a user message', () => {
    const text = resolveUserRequestTextFromMessages(
      [
        {
          messageId: 'assistant-0',
          sender: 'Viventium',
          isCreatedByUser: false,
          text: 'Earlier answer.',
        },
        {
          messageId: 'assistant-1',
          parentMessageId: 'assistant-0',
          sender: 'Viventium',
          isCreatedByUser: false,
          text: '',
        },
      ],
      'assistant-1',
    );

    expect(text).toBe('');
  });
});

describe('resolveFollowUpPersistenceText', () => {
  test('uses deterministic fallback text when LLM follow-up is empty but substantive insights exist', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          {
            cortexName: 'Pattern Recognition',
            insight:
              'Earlier today you already decided the on-site visit is optional for the reporting launch and more of a morale trip.',
          },
        ],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      scheduleId: '',
    });

    expect(result.text).toContain('Earlier today you already decided');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves snake_case deferred error classes for deterministic fallback text', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [],
        hasErrors: true,
        errors: [
          {
            error: 'public-safe provider message',
            error_class: 'provider_rate_limited',
          },
        ],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      scheduleId: '',
    });

    expect(result.text).toBe('That background check was rate-limited by the configured provider.');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
  });

  test('keeps {NTA} suppressed for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: false,
    });

    expect(result.text).toBe('');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
    expect(result.decision.suppressionReason).toBe('no_response_tag');
  });

  test('does not treat legacy replaceParentMessage input as permission to edit or force Phase B', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.replaceParentMessage).toBe(false);
    expect(result.decision.forceVisibleFollowUp).toBe(false);
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
  });

  test('keeps voice-mode {NTA} suppressed for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('no_response_suppressed');
    expect(result.decision.suppressionReason).toBe('no_response_tag');
  });

  test('preserves voice-mode generated follow-up text for ordinary follow-ups', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: 'That still works.',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('That still works.');
    expect(result.decision.selectedStrategy).toBe('llm_generated');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('suppresses generated Wing Mode follow-ups unless explicitly forced visible', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: 'You sound like you need space to talk.',
      insightsData: {
        insights: [
          {
            cortexName: 'Emotional Resonance',
            insight:
              'Ambient speech sounded vulnerable, but the user did not address the assistant.',
          },
        ],
      },
      voiceMode: true,
      surface: 'wing',
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('wing_surface_suppressed');
    expect(result.decision.suppressionReason).toBe('wing_silence_first');
  });

  test('preserves forced follow-up fallback when {NTA} has visible insight text', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      forceVisibleFollowUp: true,
    });

    expect(result.text).toBe('That choice is fine. Good call.');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('forces scheduled {NTA} parent into a new visible Phase B follow-up when multiple insights exist', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [
          {
            cortexName: 'Background Analysis',
            insight: 'I reviewed the latest context and found one open work loop that can wait.',
          },
          {
            cortexName: 'MS365',
            insight: 'I found 2 calendar items that need attention today.',
            completed_tool_calls: 2,
          },
        ],
      },
      forceVisibleFollowUp: true,
      scheduleId: 'schedule_123',
    });

    expect(result.text).toBe('I found 2 calendar items that need attention today.');
    expect(result.decision.llmResult).toBe('nta');
    expect(result.decision.selectedStrategy).toBe('best_visible_insight');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves voice-mode forced follow-up fallback when generated follow-up text is empty', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      forceVisibleFollowUp: true,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('That choice is fine. Good call.');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('uses best visible insight when an empty primary answer leaves multiple completed insights', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          {
            cortexName: 'Confirmation Bias',
            insight:
              'This plan depends on one enthusiastic prospect, so the next move is validation before building.',
          },
          {
            cortexName: 'Red Team',
            insight:
              'The strongest risk is workflow fit: generic transcription spend does not prove a PE-specific product budget.',
          },
        ],
      },
      forceVisibleFollowUp: true,
      voiceMode: false,
      surface: 'web',
      generationFailed: true,
    });

    expect(result.text).toContain('generic transcription spend');
    expect(result.decision.selectedStrategy).toBe('best_visible_insight');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('keeps voice-mode empty follow-up generation silent instead of speaking raw insights', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('voice_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('empty_voice_followup');
  });

  test('keeps moved-on empty follow-up generation silent on all surfaces', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'Old context that may be stale.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('moved_on_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('moved_on_empty_followup');
  });

  test('keeps moved-on empty Telegram follow-up generation silent', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'Old context that may be stale.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'telegram',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('moved_on_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('moved_on_empty_followup');
  });

  test('keeps moved-on generated follow-up text when the main agent finds it useful', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: 'One useful new detail: doors are already open.',
      insightsData: {
        insights: [{ cortexName: 'Deep Research', insight: 'Doors opened at 8 PM.' }],
      },
      replaceParentMessage: false,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('One useful new detail: doors are already open.');
    expect(result.decision.selectedStrategy).toBe('llm_generated');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('preserves forced follow-up fallback even when conversation moved on', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [{ cortexName: 'worker', insight: 'The task completed successfully.' }],
      },
      forceVisibleFollowUp: true,
      voiceMode: false,
      surface: 'web',
      movedOnAfterParent: true,
    });

    expect(result.text).toBe('The task completed successfully.');
    expect(result.decision.selectedStrategy).toBe('deterministic_fallback');
    expect(result.decision.suppressionReason).toBe('');
  });

  test('labels voice-mode empty suppression caused by follow-up generation failure', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      insightsData: {
        insights: [
          { cortexName: 'Pattern Recognition', insight: 'That choice is fine. Good call.' },
        ],
      },
      replaceParentMessage: false,
      voiceMode: true,
      surface: 'playground',
      generationFailed: true,
    });

    expect(result.text).toBe('');
    expect(result.decision.selectedStrategy).toBe('voice_empty_suppressed');
    expect(result.decision.suppressionReason).toBe('voice_followup_generation_failed');
    expect(result.decision.generationFailed).toBe(true);
  });
});

describe('CortexFollowupDecision observability', () => {
  test('records no-response suppression context without raw prompt text', () => {
    const persistence = resolveFollowUpPersistenceText({
      generatedText: '{NTA}',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Useful internal context.' }],
        cortexCount: 1,
      },
      voiceMode: true,
      surface: 'voice',
    });
    const record = buildFollowUpDecisionRecord({
      req: {
        body: { voiceMode: true, streamId: 'stream-1', viventiumSurface: 'voice' },
        viventiumCallSession: { callSessionId: 'call-1' },
      },
      conversationId: 'conv-1',
      parentMessageId: 'parent-1',
      insightsData: {
        insights: [{ cortexName: 'Pattern Recognition', insight: 'Useful internal context.' }],
        cortexCount: 1,
      },
      generatedText: '{NTA}',
      finalText: persistence.text,
      decision: persistence.decision,
      recentResponseResolution: { source: 'db_parent_message', text: 'I already covered this.' },
      userRequest: 'Please analyze this.',
      finalContinuationContext: {
        hasMovedOn: false,
        messageCount: 0,
        currentLeafMessageId: 'parent-1',
        lookupFailed: false,
        contextText: '',
      },
    });

    expect(record).toEqual(
      expect.objectContaining({
        tag: 'CortexFollowupDecision',
        result: 'suppressed',
        surface: 'voice',
        voiceMode: true,
        conversationId: 'conv-1',
        parentMessageId: 'parent-1',
        llmResult: 'nta',
        selectedStrategy: 'no_response_suppressed',
        suppressionReason: 'no_response_tag',
        insightCount: 1,
        generatedLength: 5,
        finalLength: 0,
      }),
    );
    expect(JSON.stringify(record)).not.toContain('I already covered this');
    expect(record.recentResponseHash).toHaveLength(12);
  });

  test('compacts decision metadata for DB endpoints by removing volatile request ids', () => {
    const compact = compactDecisionRecordForMetadata({
      tag: 'CortexFollowupDecision',
      result: 'suppressed',
      callSessionId: 'call-1',
      streamId: 'stream-1',
      requestId: 'req-1',
      parentMessageId: 'parent-1',
    });

    expect(compact).toEqual({
      tag: 'CortexFollowupDecision',
      result: 'suppressed',
      parentMessageId: 'parent-1',
    });
  });

  test('honors explicit skipped result for terminal Phase B decisions', () => {
    const record = buildFollowUpDecisionRecord({
      req: {
        body: { viventiumSurface: 'web' },
      },
      conversationId: 'conv-1',
      parentMessageId: 'parent-1',
      insightsData: {
        insights: [],
        mergedPrompt: '',
        cortexCount: 0,
      },
      decision: {
        result: 'skipped',
        selectedStrategy: 'no_usable_output',
        suppressionReason: 'no_usable_phase_b_output',
        llmResult: 'skipped',
      },
    });

    expect(record).toEqual(
      expect.objectContaining({
        result: 'skipped',
        selectedStrategy: 'no_usable_output',
        suppressionReason: 'no_usable_phase_b_output',
        llmResult: 'skipped',
        finalLength: 0,
      }),
    );
  });
});

describe('shouldForceVisibleFollowUpForEmptyPrimary', () => {
  test('forces visible Phase B when the normal text primary answer is empty and insights completed', () => {
    expect(
      shouldForceVisibleFollowUpForEmptyPrimary({
        hasInsights: true,
        recentResponse: '',
        voiceMode: false,
        surface: 'web',
      }),
    ).toBe(true);
  });

  test('treats generation placeholders as empty primary answers', () => {
    expect(isPlaceholderRecentResponseText('Generation in progress.')).toBe(true);
    expect(
      extractRecentResponseTextFromMessage({
        text: 'Generation in progress.',
        content: [{ type: 'text', text: 'Generation in progress.' }],
      }),
    ).toBe('');
    expect(
      shouldForceVisibleFollowUpForEmptyPrimary({
        hasInsights: true,
        recentResponse: 'Generation in progress.',
        voiceMode: false,
        surface: 'web',
      }),
    ).toBe(true);
  });

  test('does not force ambient voice or Wing Mode follow-ups from an empty primary answer', () => {
    expect(
      shouldForceVisibleFollowUpForEmptyPrimary({
        hasInsights: true,
        recentResponse: '',
        voiceMode: true,
        surface: 'playground',
      }),
    ).toBe(false);
    expect(
      shouldForceVisibleFollowUpForEmptyPrimary({
        hasInsights: true,
        recentResponse: '',
        voiceMode: false,
        surface: 'wing',
      }),
    ).toBe(false);
  });

  test('preserves explicit force-visible decisions even when the primary answer is non-empty', () => {
    expect(
      shouldForceVisibleFollowUpForEmptyPrimary({
        configuredForceVisibleFollowUp: true,
        hasInsights: true,
        recentResponse: 'Checking now.',
        voiceMode: false,
        surface: 'web',
      }),
    ).toBe(true);
  });
});

describe('resolveFollowUpContinuationContext', () => {
  test('builds current conversation context from newer user and assistant descendants', () => {
    const result = resolveFollowUpContinuationContext(
      [
        {
          messageId: 'assistant-a',
          parentMessageId: 'user-a',
          sender: 'AI',
          text: "You're not late.",
          createdAt: '2026-05-03T03:04:20.000Z',
        },
        {
          messageId: 'user-b',
          parentMessageId: 'assistant-a',
          sender: 'User',
          isCreatedByUser: true,
          text: 'I am already getting ready now.',
          createdAt: '2026-05-03T03:04:30.000Z',
        },
        {
          messageId: 'assistant-b',
          parentMessageId: 'user-b',
          sender: 'AI',
          text: 'You have time.',
          createdAt: '2026-05-03T03:04:35.000Z',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(true);
    expect(result.currentLeafMessageId).toBe('assistant-b');
    expect(result.contextText).toContain('User: I am already getting ready now.');
    expect(result.contextText).toContain('Assistant: You have time.');
  });

  test('does not mark assistant-only descendants as moved on', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'Checking.' },
        {
          messageId: 'assistant-child',
          parentMessageId: 'assistant-a',
          sender: 'AI',
          text: 'Background card updated.',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(false);
    expect(result.contextText).toBe('');
  });

  test('finds a user continuation through a two-hop descendant path', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'First.' },
        {
          messageId: 'assistant-child',
          parentMessageId: 'assistant-a',
          sender: 'AI',
          text: 'Interim assistant message.',
        },
        {
          messageId: 'user-c',
          parentMessageId: 'assistant-child',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Actually I already handled that.',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(true);
    expect(result.currentLeafMessageId).toBe('user-c');
    expect(result.contextText).toContain('Actually I already handled that.');
  });

  test('does not pull sibling-branch text when current leaf is not downstream of parent', () => {
    const result = resolveFollowUpContinuationContext(
      [
        { messageId: 'assistant-a', parentMessageId: 'user-a', sender: 'AI', text: 'Branch A.' },
        {
          messageId: 'user-b',
          parentMessageId: 'user-a',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Sibling branch user text.',
          createdAt: '2026-05-03T03:04:30.000Z',
        },
        {
          messageId: 'assistant-b',
          parentMessageId: 'user-b',
          sender: 'AI',
          text: 'Sibling branch answer.',
          createdAt: '2026-05-03T03:04:35.000Z',
        },
      ],
      'assistant-a',
    );

    expect(result.hasMovedOn).toBe(false);
    expect(result.contextText).toBe('');
    expect(result.currentLeafMessageId).toBe('assistant-b');
  });
});

describe('sanitizeAnthropicFollowUpLLMConfig', () => {
  test('removes temperature when Anthropic follow-up relies on default thinking', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-sonnet-4-5',
      temperature: 0.3,
    });

    expect(result.temperature).toBeUndefined();
  });

  test('removes temperature for Anthropic adaptive-capable models even when thinking is explicitly disabled', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-opus-4-7',
      temperature: 0.3,
      thinking: false,
    });

    expect(result.temperature).toBeUndefined();
  });

  test('preserves temperature for legacy Anthropic models when thinking is explicitly disabled', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0.3,
      thinking: false,
    });

    expect(result.temperature).toBe(0.3);
  });
});

describe('voice follow-up runtime assignment', () => {
  const originalXaiApiKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-xai-key';
  });

  afterEach(() => {
    if (originalXaiApiKey == null) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = originalXaiApiKey;
    }
  });

  test('preserves the live main-agent route over compiled Anthropic defaults for text follow-ups', () => {
    const originalProvider = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
    const originalModel = process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = 'anthropic';
    process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = 'claude-opus-4-7';

    try {
      const result = resolveFollowUpRuntimeAssignment(
        {
          id: 'agent_viventium_main_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.4',
          model_parameters: {
            model: 'gpt-5.4',
            reasoning_effort: 'high',
          },
        },
        { useVoiceModel: false },
      );

      expect(result.effectiveProvider).toBe('openAI');
      expect(result.effectiveModel).toBe('gpt-5.4');
      expect(result.runtimeAgent.model_parameters.model).toBe('gpt-5.4');
      expect(result.runtimeAgent.model_parameters).not.toHaveProperty('thinkingBudget');
    } finally {
      if (originalProvider == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER = originalProvider;
      }
      if (originalModel == null) {
        delete process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL;
      } else {
        process.env.VIVENTIUM_FC_CONSCIOUS_LLM_MODEL = originalModel;
      }
    }
  });

  test('normalizes xAI voice follow-up parameters to no reasoning', () => {
    const result = resolveFollowUpRuntimeAssignment(
      {
        id: 'agent-main',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        model_parameters: {
          model: 'claude-opus-4-7',
          thinking: true,
          thinkingBudget: 4096,
          temperature: 0.3,
        },
        voice_llm_provider: 'xai',
        voice_llm_model: 'grok-4.3',
        voice_llm_model_parameters: {
          thinking: false,
        },
      },
      { useVoiceModel: true },
    );

    expect(result.effectiveProvider).toBe('xai');
    expect(result.effectiveModel).toBe('grok-4.3');
    expect(result.runtimeAgent.model_parameters.reasoning_effort).toBe('none');
    expect(result.runtimeAgent.model_parameters).not.toHaveProperty('thinking');
    expect(result.runtimeAgent.model_parameters).not.toHaveProperty('thinkingBudget');
  });

  test('passes xAI no-reasoning follow-up knob through OpenAI-compatible kwargs', () => {
    expect(
      buildFollowUpModelKwargsForProvider({
        providerName: 'xai',
        modelParameters: {
          reasoning_effort: 'none',
        },
      }),
    ).toEqual({ reasoning_effort: 'none' });

    expect(
      buildFollowUpModelKwargsForProvider({
        providerName: 'anthropic',
        modelParameters: {
          reasoning_effort: 'none',
        },
      }),
    ).toBeUndefined();
  });
});
