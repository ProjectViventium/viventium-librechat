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
const db = require('~/models');
const {
  formatFollowUpPrompt,
  deduplicateInsights,
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
  buildFollowUpSystemPrompt,
  resolvePhaseBFeelingContext,
  resolvePhaseBFeelingInjection,
  prepareCortexFollowUpMessage,
  persistPreparedCortexFollowUpMessage,
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

  test('preserves graph-authored text parts when top-level text is their concatenated transcript', () => {
    const existing = [
      {
        type: 'text',
        agentId: 'agent-consultant',
        text: 'Verified evidence.',
      },
      {
        type: 'text',
        agentId: 'agent-author',
        text: ' Final synthesis.',
      },
    ];

    const merged = upsertCortexParts(
      existing,
      [
        {
          type: 'cortex_insight',
          cortex_id: 'background-review',
          status: 'complete',
          insight: 'No additional correction.',
        },
      ],
      { visibleText: 'Verified evidence. Final synthesis.' },
    );

    expect(merged).toEqual([
      existing[0],
      existing[1],
      expect.objectContaining({
        type: 'cortex_insight',
        cortex_id: 'background-review',
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
    const originalXaiApiKey = process.env.XAI_API_KEY;

    try {
      process.env.XAI_API_KEY = 'synthetic-xai-key';
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
      if (originalXaiApiKey == null) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
      createRun.mockRestore();
      infoLog.mockRestore();
      warnLog.mockRestore();
    }
  });
});

describe('Phase B session-backed Feelings', () => {
  const capsule = '<viventium_feeling_state>synthetic state</viventium_feeling_state>';

  test('pins one capsule at the final system layer for a direct-provider follow-up', () => {
    const prompt = buildFollowUpSystemPrompt({
      noResponseInstructions: 'Use {NTA} when no reply is needed.',
      feelingCapsule: capsule,
    });
    expect(prompt.endsWith(capsule)).toBe(true);
    expect(prompt.match(/<viventium_feeling_state>/g)).toHaveLength(1);
  });

  test('does not inject a second capsule into a same-session continuation', () => {
    const feelingContext = resolvePhaseBFeelingContext({
      enabled: true,
      agentScope: 'conscious_agent',
      snapshotHash: 'synthetic-hash',
      capsule,
    });
    expect(
      resolvePhaseBFeelingInjection({
        feelingContext,
        providerCapability: { conversation_session: true },
        primaryResponseMode: false,
      }),
    ).toEqual({ capsule: '', reason: 'preserved_in_conversation_session' });
  });

  test('keeps the capsule for direct providers and a forced primary follow-up', () => {
    const feelingContext = { capsule, reason: 'conscious_synthesis' };
    expect(
      resolvePhaseBFeelingInjection({
        feelingContext,
        providerCapability: { conversation_session: false },
      }).capsule,
    ).toBe(capsule);
    expect(
      resolvePhaseBFeelingInjection({
        feelingContext,
        providerCapability: { conversation_session: true },
        primaryResponseMode: true,
      }).capsule,
    ).toBe(capsule);
  });
});

describe('Phase B prepare/persist boundary', () => {
  test('prepares with the provider before persistence and persists without calling it again', async () => {
    const processStream = jest.fn().mockResolvedValue('A grounded follow-up.');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
    const originalXaiApiKey = process.env.XAI_API_KEY;
    const input = {
      req: {
        id: 'synthetic-split-request',
        body: {},
      },
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
      runId: 'synthetic-run',
      agent: {
        provider: 'xai',
        model: 'synthetic-model',
        model_parameters: {},
      },
      insightsData: {
        cortexCount: 1,
        insights: [{ cortexName: 'Synthetic specialist', insight: 'A new grounded fact.' }],
      },
      recentResponse: 'The initial answer is already visible.',
    };

    try {
      process.env.XAI_API_KEY = 'synthetic-xai-key';

      const prepared = await prepareCortexFollowUpMessage(input);

      expect(processStream).toHaveBeenCalledTimes(1);
      expect(saveMessage).not.toHaveBeenCalled();
      expect(prepared).toEqual(
        expect.objectContaining({
          suppressed: false,
          text: 'A grounded follow-up.',
        }),
      );

      const persisted = await persistPreparedCortexFollowUpMessage(input, prepared);

      expect(processStream).toHaveBeenCalledTimes(1);
      expect(saveMessage).toHaveBeenCalledTimes(1);
      expect(saveMessage).toHaveBeenCalledWith(
        input.req,
        expect.objectContaining({
          conversationId: input.conversationId,
          parentMessageId: input.parentMessageId,
          text: 'A grounded follow-up.',
        }),
        expect.objectContaining({
          operationKind: 'system',
          context: 'viventium/services/BackgroundCortexFollowUpService.createCortexFollowUpMessage',
        }),
      );
      expect(persisted).toEqual(
        expect.objectContaining({
          conversationId: input.conversationId,
          parentMessageId: input.parentMessageId,
          text: 'A grounded follow-up.',
        }),
      );
    } finally {
      if (originalXaiApiKey == null) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
      createRun.mockRestore();
      saveMessage.mockRestore();
    }
  });
});

describe('formatFollowUpPrompt', () => {
  const missionInsight = (runId, instruction, insight) => ({
    cortexName: 'Mission evidence', insight,
    runInput: { version: 1, run_id: runId, instruction },
    authority: { kind: 'durable_terminal_callback', runId, event: 'run.completed', workState: 'completed' },
  });

  test('restores exact accepted mission input instead of an unrelated quick request', () => {
    const instruction = '  Compare two storage designs.\n Keep the source links.  ';
    const evidence = missionInsight('run-a', instruction, '  Full result\nwith sources.  ');
    const prompt = formatFollowUpPrompt({ insights: [evidence], userRequest: 'What is 17 times 23?',
      recentResponse: '391. The comparison was accepted separately.', surface: 'web' });
    expect(prompt).toContain(JSON.stringify(evidence.runInput));
    expect(prompt).toContain(JSON.stringify(evidence.authority));
    expect(prompt).toContain(evidence.insight);
    expect(prompt).not.toContain('What is 17 times 23?');
    expect(prompt).toContain('391. The comparison was accepted separately.');
  });

  test('preserves distinct grouped mission inputs and complete evidence without prefix clipping', () => {
    const a = missionInsight('run-a', 'First objective\n' + 'x'.repeat(4300) + '  END A', 'a'.repeat(12500) + ' END RESULT A');
    const b = missionInsight('run-b', '\tSecond objective  ', 'END RESULT B');
    const prompt = formatFollowUpPrompt({ insights: [a, b], userRequest: 'Unrelated question', surface: 'web' });
    expect(prompt).toContain(JSON.stringify(a.runInput));
    expect(prompt).toContain(JSON.stringify(b.runInput));
    expect(prompt).toContain(a.insight);
    expect(prompt).toContain(b.insight);
    expect(prompt.indexOf(JSON.stringify(a.runInput))).toBeLessThan(prompt.indexOf(JSON.stringify(b.runInput)));
  });

  test('distinct accepted missions retain both inputs even when their result text overlaps', () => {
    const a = missionInsight('run-a', 'First accepted goal', 'Identical factual result with shared source material.');
    const b = missionInsight('run-b', 'Second accepted goal', a.insight);
    expect(deduplicateInsights([a, b])).toEqual([a, b]);
  });

  test.each([false, true])('retains terminal evidence with missing input without borrowing the quick question (mixed=%s)', (mixed) => {
    const missing = { cortexName: 'Mission evidence', insight: 'legacy result '.repeat(1500) + ' END LEGACY',
      authority: { kind: 'durable_terminal_callback', runId: 'run-legacy', event: 'run.completed', workState: 'completed' } };
    const known = missionInsight('run-known', '  Exact known objective\n', missing.insight);
    const insights = mixed ? [known, missing] : [missing];
    expect(deduplicateInsights(insights)).toEqual(insights);
    const prompt = formatFollowUpPrompt({ insights, userRequest: 'Unrelated quick question', surface: 'web' });
    expect(prompt).not.toContain('Unrelated quick question');
    expect(prompt).toContain(missing.insight);
    expect(prompt).toContain(JSON.stringify(missing.authority));
    expect(prompt).toContain('"runInput":null');
    if (mixed) expect(prompt).toContain(JSON.stringify(known.runInput));
  });

  test('ordinary insights cannot substitute an unbound run input for the current request', () => {
    const ordinary = { cortexName: 'planner', insight: 'A useful fact.', runInput: { version: 1, run_id: 'run-a', instruction: 'Wrong objective' } };
    const input = { insights: [ordinary], userRequest: 'Current request', surface: 'web' };
    const withoutInput = { ...ordinary }; delete withoutInput.runInput;
    expect(formatFollowUpPrompt(input)).toBe(formatFollowUpPrompt({ ...input, insights: [withoutInput] }));
    expect(formatFollowUpPrompt(input)).toContain('Current request');
  });

  test.each(['web', 'telegram', 'playground'])(
    'preserves the complete delivered answer for %s follow-up judgment',
    (surface) => {
      const recentResponse = `${'The detailed comparison explains the options. '.repeat(80)}\nDecision: retain the current service and verify the restore before launch.`;
      const prompt = formatFollowUpPrompt({
        insights: [{ cortexName: 'planner', insight: 'Retain the current service and verify restore.' }],
        recentResponse,
        surface,
      });

      expect(prompt).toContain(recentResponse);
    },
  );

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

  test('teaches smart optional audio only to Telegram follow-ups that can attach audio', () => {
    const base = {
      insights: [{ cortexName: 'planner', insight: 'The synthetic draft is ready.' }],
      recentResponse: 'I started checking it.',
      voiceMode: false,
      surface: 'telegram',
    };

    const textOnlyPrompt = formatFollowUpPrompt(base);
    const audioEligiblePrompt = formatFollowUpPrompt({
      ...base,
      telegramAudioRequested: true,
      voiceProvider: 'xai',
    });

    expect(textOnlyPrompt).toContain('{MSG_BREAK}');
    expect(textOnlyPrompt).not.toContain('{SKIP_VOICE}');
    expect(audioEligiblePrompt).toContain('{MSG_BREAK}');
    expect(audioEligiblePrompt).toContain('{SKIP_VOICE}');
    expect(audioEligiblePrompt).toContain('explicitly asks to hear, read aloud, speak');
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

  test('keeps bounded mission evidence links intact and applies newer user instructions', () => {
    const artifactUrl = 'https://glasshive.example.test/v1/link-refs/ghr_1234567890abcdef';
    const prompt = formatFollowUpPrompt({
      insights: [
        {
          cortexName: 'Mission evidence',
          insight: `${'Verified detail. '.repeat(60)}\nFile: [Download file](${artifactUrl})`,
          maxPromptChars: 12_000,
        },
      ],
      recentResponse: 'The worker is running.',
      userRequest: 'Keep the marker ALPHA-ORIGINAL.',
      continuationContext: 'User: Change the marker to ALPHA-STEERED.',
      voiceMode: false,
      surface: 'telegram',
      primaryResponseMode: true,
    });

    expect(prompt).toContain(artifactUrl);
    expect(prompt).toContain('User: Change the marker to ALPHA-STEERED.');
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
  test.each(['web', 'telegram'])(
    'does not publish raw optional insights when %s follow-up generation fails',
    (surface) => {
      const result = resolveFollowUpPersistenceText({
        generatedText: '',
        insightsData: { insights: [{ cortexName: 'Analysis', insight: 'The earlier answer is correct.' }] },
        surface,
        generationFailed: true,
      });
      expect(result.text).toBe('');
      expect(result.decision.selectedStrategy).toBe('failed_optional_followup_suppressed');
      expect(result.decision.suppressionReason).toBe('followup_generation_failed');
      expect(result.decision.generationFailed).toBe(true);
    },
  );

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

  test('retains assistant-only result context without marking a new user turn', () => {
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
    expect(result.contextText).toContain('Assistant: Background card updated.');
  });

  test('keeps the correction and prior result after follow-up metadata updates the anchor', () => {
    const result = resolveFollowUpContinuationContext(
      [
        {
          messageId: 'anchor', parentMessageId: 'request', sender: 'AI', text: 'Both checks are running.',
          createdAt: '2026-05-03T03:00:00.000Z', updatedAt: '2026-05-03T03:05:00.000Z',
        },
        {
          messageId: 'correction', parentMessageId: 'anchor', sender: 'User', isCreatedByUser: true,
          text: 'Narrow the first check. Leave the other one unchanged.', createdAt: '2026-05-03T03:01:00.000Z',
        },
        {
          messageId: 'first-result', parentMessageId: 'correction', sender: 'AI',
          text: 'The first check found an undocumented sign-in requirement.', createdAt: '2026-05-03T03:04:00.000Z',
        },
        {
          messageId: 'second-status', parentMessageId: 'first-result', sender: 'AI',
          text: 'Second check completed.', createdAt: '2026-05-03T03:06:00.000Z',
        },
      ],
      'anchor',
    );
    expect(result.hasMovedOn).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(result.contextText).toContain('Narrow the first check. Leave the other one unchanged.');
    expect(result.contextText).toContain('The first check found an undocumented sign-in requirement.');
    expect(result.currentLeafMessageId).toBe('second-status');
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
      model: 'claude-opus-5',
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

  test('keeps adaptive-era safety for date-stamped models with an explicit adaptive revision', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-opus-4-7-20250929',
      temperature: 0.3,
      thinking: false,
    });

    expect(result.temperature).toBeUndefined();
  });

  test('preserves temperature for legacy Anthropic models when thinking is explicitly disabled', () => {
    const result = sanitizeAnthropicFollowUpLLMConfig({
      model: 'claude-opus-5-20250929',
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

  test('preserves a custom endpoint as the Phase B route after OpenAI transport adaptation', () => {
    const result = resolveFollowUpRuntimeAssignment(
      {
        id: 'agent-glasshive-main',
        endpoint: 'glasshive-harness',
        provider: 'openAI',
        model: 'codex-cli:gpt-5.6-sol',
        model_parameters: {
          model: 'codex-cli:gpt-5.6-sol',
          reasoning_effort: 'medium',
        },
        glasshive_options: {
          workspace: { mode: 'life' },
          access: 'workspace',
        },
      },
      { useVoiceModel: false },
    );

    expect(result.effectiveProvider).toBe('glasshive-harness');
    expect(result.effectiveModel).toBe('codex-cli:gpt-5.6-sol');
    expect(result.runtimeAgent.endpoint).toBe('glasshive-harness');
  });

  test('preserves a capability-required canonical Main across stale upgrade runtime defaults', () => {
    const result = resolveFollowUpRuntimeAssignment(
      {
        id: 'agent_viventium_main_95aeb3',
        provider: 'glasshive-harness',
        model: 'codex-cli:gpt-5.6-sol',
        model_parameters: {
          model: 'codex-cli:gpt-5.6-sol',
          reasoning_effort: 'medium',
        },
      },
      {
        useVoiceModel: false,
        capabilityRequiredProviders: ['glasshive-harness'],
      },
    );

    expect(result.effectiveProvider).toBe('glasshive-harness');
    expect(result.effectiveModel).toBe('codex-cli:gpt-5.6-sol');
    expect(result.runtimeAgent.model_parameters).toMatchObject({
      model: 'codex-cli:gpt-5.6-sol',
      reasoning_effort: 'medium',
    });
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


describe('typed terminal-result follow-up mode', () => {
  test.each([
    ['durable_terminal_callback', 'The requested check is running.', false],
    ['durable_terminal_callback', '', false],
    ['scheduled_evidence', 'The requested check is running.', true],
  ])('selects mode from authority while preserving empty-primary recovery: %s / %s', async (kind, recentResponse, forced) => {
    const processStream = jest.fn().mockResolvedValue('{NTA}');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const priorKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'synthetic-xai-key';
    try {
      const prepared = await prepareCortexFollowUpMessage({
        req: { body: {} },
        conversationId: 'synthetic-conversation', parentMessageId: 'synthetic-parent',
        agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
        forceVisibleFollowUp: true, recentResponse,
        insightsData: { cortexCount: 1, insights: [{
          cortexName: 'Synthetic evidence', insight: 'A verified finding.',
          authority: { kind },
        }] },
      });
      expect(prepared.shouldForceVisibleFollowUp).toBe(forced);
      expect(prepared.followUpDecisionRecord.forceVisibleFollowUp).toBe(forced);
      expect(Boolean(prepared.text)).toBe(forced);
      expect(prepared.followUpDecisionRecord.generationFailed).toBe(false);
      expect(processStream).toHaveBeenCalledTimes(1);
    } finally {
      if (priorKey == null) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = priorKey;
      createRun.mockRestore();
    }
  });
});

test('Phase B receives verified parent graph records beside the limited parallel insight', async () => {
  const native = require('../nativeResponseService');
  const evidence = [{ type: 'text', text: JSON.stringify({ native_tool_evidence: {
    requests: [{ run_id: 'before', record: 'Primary archive result' },
      { run_id: 'after', record: 'Later graph verification' }],
  } }) }];
  const readToolEvidence = jest.fn().mockResolvedValue(evidence);
  const service = jest.spyOn(native, 'getService').mockReturnValue({ readToolEvidence });
  const processStream = jest.fn().mockResolvedValue('Useful synthesis.');
  const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
  const oldKey = process.env.XAI_API_KEY;
  try {
    process.env.XAI_API_KEY = 'synthetic-key';
    await generateFollowUpText({ req: { user: { id: 'owner' }, body: {} },
      agent: { provider: 'xai', model: 'synthetic', model_parameters: {} },
      conversationId: 'conversation', parentMessageId: 'answer', runId: 'run',
      insightsData: { insights: [{ cortexName: 'Parallel search', insight: 'The prior conversation search found no record.' }] },
      recentResponse: 'The primary archive read found a record.',
    });
    expect(readToolEvidence).toHaveBeenCalledWith('owner', 'conversation', 'answer');
    const transmitted = JSON.stringify(processStream.mock.calls[0][0]);
    expect(transmitted).toContain('Primary archive result');
    expect(transmitted).toContain('Later graph verification');
    expect(transmitted).toContain('prior conversation search found no record');
    expect(createRun.mock.calls[0][0].graphConfig.tools).toEqual([]);
  } finally {
    if (oldKey == null) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldKey;
    service.mockRestore(); createRun.mockRestore();
  }
});


test.each([
  ['durable_terminal_callback', 'native_graph_tool_evidence_parent_unfinished', true],
  ['ordinary_cortex', 'native_graph_tool_evidence_parent_unfinished', false],
  ['durable_terminal_callback', 'native_graph_tool_evidence_identity_mismatch', false],
  ['durable_terminal_callback', 'native_graph_tool_evidence_source_changed', false],
])('Phase B handles %s parent evidence error %s without weakening its guard', async (kind, code, allowed) => {
  const native = require('../nativeResponseService');
  const readToolEvidence = jest.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
  const service = jest.spyOn(native, 'getService').mockReturnValue({ readToolEvidence });
  const processStream = jest.fn().mockResolvedValue('The completed worker result.');
  const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
  const oldKey = process.env.XAI_API_KEY;
  try {
    process.env.XAI_API_KEY = 'synthetic-key';
    const result = generateFollowUpText({
      req: { user: { id: 'owner' }, body: {} },
      agent: { provider: 'xai', model: 'synthetic', model_parameters: {} },
      conversationId: 'conversation', parentMessageId: 'answer', runId: 'run',
      insightsData: { insights: [{ cortexName: 'Completed worker', insight: 'Verified retained result.',
        authority: { kind, runId: 'worker-run', event: 'run.completed', workState: 'completed' } }] },
    });
    if (allowed) {
      await expect(result).resolves.toBe('The completed worker result.');
      expect(JSON.stringify(processStream.mock.calls[0][0])).toContain('Verified retained result.');
    } else {
      await expect(result).rejects.toMatchObject({ code });
      expect(processStream).not.toHaveBeenCalled();
    }
  } finally {
    if (oldKey == null) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldKey;
    service.mockRestore(); createRun.mockRestore();
  }
});
