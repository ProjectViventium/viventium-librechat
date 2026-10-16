/* === VIVENTIUM START ===
 * Feature: Phase B follow-up formatting parity tests
 *
 * Purpose:
 * - Keep web follow-ups aligned with the main web reply formatting contract.
 * - Prevent follow-up prompt regressions that flatten structured web text into dense prose.
 *
 * Added: 2026-03-06
 * === VIVENTIUM END === */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildPromptBundleFixture,
} = require('../../../../../scripts/test-support/promptBundle.cjs');
const previousPromptBundlePath = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
let promptFixtureDirectory;
beforeAll(() => {
  promptFixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-test-prompts-'));
  const bundlePath = path.join(promptFixtureDirectory, 'bundle.json');
  fs.writeFileSync(
    bundlePath,
    JSON.stringify(
      buildPromptBundleFixture(
        path.resolve(__dirname, '../../../../../viventium/source_of_truth/prompts'),
      ),
    ),
  );
  process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundlePath;
});
afterAll(() => {
  if (previousPromptBundlePath === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previousPromptBundlePath;
  fs.rmSync(promptFixtureDirectory, { recursive: true, force: true });
});

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
  resolveDurableMissionUserSources,
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
    const getRequiredPromptText = jest.fn(() => 'Registered follow-up');
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({
      ...jest.requireActual('~/server/services/viventium/promptRegistry'),
      getRequiredPromptText,
    }));
    const {
      formatFollowUpPrompt: registryFormatFollowUpPrompt,
    } = require('../BackgroundCortexFollowUpService');

    registryFormatFollowUpPrompt({
      insights: [{ cortexName: 'worker', insight: 'The worker found a result.' }],
      recentResponse: 'I am checking.',
      voiceMode: false,
      surface: '',
    });

    expect(getRequiredPromptText).toHaveBeenCalledWith(
      'cortex.follow_up_phase_b.user_message',
      expect.objectContaining({
        background_insights: expect.stringContaining('The worker found a result.'),
        recent_response_context: expect.stringContaining('Here is the response you JUST sent'),
      }),
    );
  });

  test('routes Phase B system prompts through the prompt registry', () => {
    jest.resetModules();
    const getPromptText = jest.fn((_promptId, fallback) => fallback);
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({
      ...jest.requireActual('~/server/services/viventium/promptRegistry'),
      getPromptText,
    }));
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

  test.each(['user_message', 'system'])(
    'fails visibly when required ordinary %s is unavailable',
    (entry) => {
      jest.resetModules();
      const error = Object.assign(new Error('required_prompt_invalid'), {
        code: 'required_prompt_invalid',
      });
      const getRequiredPromptText = jest.fn(() => {
        throw error;
      });
      const getPromptText = jest.fn(() => '{NTA}');
      jest.doMock('~/server/services/viventium/promptRegistry', () => ({
        ...jest.requireActual('~/server/services/viventium/promptRegistry'),
        getRequiredPromptText,
        getPromptText,
      }));
      const service = require('../BackgroundCortexFollowUpService');
      const call =
        entry === 'system'
          ? () => service.buildFollowUpSystemPrompt({})
          : () =>
              service.formatFollowUpPrompt({
                insights: [{ cortexName: 'Mission evidence', insight: 'Actual necessary input.' }],
                recentResponse: 'Accepted.',
                userRequest: 'Prepare the artifact.',
              });
      expect(call).toThrow(error);
      expect(getRequiredPromptText).toHaveBeenCalledWith(
        `cortex.follow_up_phase_b.${entry}`,
        expect.any(Object),
      );
      expect(
        getPromptText.mock.calls.some(([id]) => id.startsWith('cortex.follow_up_phase_b.')),
      ).toBe(false);
    },
  );

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
    jest.doMock('~/server/services/viventium/promptRegistry', () => ({
      ...jest.requireActual('~/server/services/viventium/promptRegistry'),
      getPromptText,
    }));
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

  test('a native session capability does not suppress the distinct follow-up state', () => {
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
    ).toEqual({ capsule, reason: 'conscious_synthesis' });
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
  test.each([false, true])(
    'retains native public ranges through saved Phase B and callback metadata, invalid=%s',
    async (invalid) => {
      const source = 'Read-first 🧠.\nUseful spoken result.';
      const common = { version: 1, required: true, valid: true, source: 'model' };
      const ranges = [
        { start: 0, end: 'Read-first 🧠.\n'.length, disposition: { ...common, audio: 'skip' } },
        {
          start: 'Read-first 🧠.\n'.length,
          end: source.length,
          disposition: { ...common, audio: 'eligible' },
        },
      ];
      if (invalid) ranges[1].end -= 1;
      const output = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: source,
              provider_specific_fields: {
                viventium: {
                  deliveryDispositionRanges: ranges,
                  delivery_disposition: { ...common, audio: 'eligible' },
                },
              },
            },
          },
        ],
      };
      const createRun = jest.spyOn(Run, 'create').mockImplementation(async (options) => ({
        processStream: async () => {
          options.customHandlers.on_chat_model_start.handle();
          options.customHandlers.on_chat_model_end.handle('on_chat_model_end', { output });
          return source;
        },
      }));
      const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
      const previous = process.env.XAI_API_KEY;
      try {
        process.env.XAI_API_KEY = 'synthetic-xai-key';
        const input = {
          req: {
            id: 'synthetic-ranges-request',
            _viventiumTelegram: true,
            body: { telegramAudioRequested: true, viventiumSurface: 'telegram' },
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    xai: {
                      messaging_delivery_disposition: true,
                      messaging_delivery_disposition_version: 1,
                    },
                  },
                },
              },
            },
          },
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
          runId: 'synthetic-run',
          agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
          insightsData: {
            cortexCount: 1,
            insights: [{ cortexName: 'Synthetic specialist', insight: 'A new fact.' }],
          },
          recentResponse: 'The initial answer is visible.',
        };
        const prepared = await prepareCortexFollowUpMessage(input);
        expect(prepared.text).toBe(source);
        expect(prepared.nativeDeliveryContent[0].text).toBe(source);
        expect(prepared.nativeDeliveryContent[0].deliveryDispositionRanges).toHaveLength(
          invalid ? 0 : 2,
        );
        expect(prepared.deliveryDisposition.audio).toBe(invalid ? 'skip' : 'eligible');
        expect(prepared.telegramDeliveryControls.audioContent).toEqual(
          prepared.nativeDeliveryContent,
        );
        expect(prepared.telegramDeliveryControls.sourceTextSha256).toBe(
          require('node:crypto').createHash('sha256').update(source).digest('hex'),
        );
        const persisted = await persistPreparedCortexFollowUpMessage(input, prepared);
        expect(persisted.text).toBe(source);
        expect(persisted.content).toEqual(prepared.nativeDeliveryContent);
        expect(persisted.metadata.viventium.telegramDeliveryControls).toEqual(
          prepared.telegramDeliveryControls,
        );
        expect(createRun).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = previous;
        createRun.mockRestore();
        saveMessage.mockRestore();
      }
    },
  );

  test.each([
    ['eligible', false, undefined, undefined, undefined, undefined],
    ['skip', false, undefined, undefined, undefined, undefined],
    ['eligible', true, undefined, undefined, undefined, undefined],
    ['eligible', false, '[laugh] Spoken result.', 'Spoken result.', undefined, undefined],
    ['eligible', false, 'Written only. [laugh] Spoken.', 'Written only. Spoken.', 14, 13],
    ['eligible', false, 'Written only.[laugh] Spoken.', 'Written only. Spoken.', 20, 13],
    ['eligible', false, '  [laugh] Spoken result.  ', 'Spoken result.', undefined, undefined],
  ])(
    'projects voice display tags without losing native audio=%s, invalid=%s',
    async (audio, invalid, customSource, visible, split, publicSplit) => {
      const source =
        customSource ||
        'The page is ready. [laugh] https://www.example.org/; demo@example.org.\n\n![Page](https://files.example.org/image.jpg)';
      const disposition = { version: 1, required: true, valid: true, source: 'model', audio };
      const ranges = split
        ? [
            { start: 0, end: split, disposition: { ...disposition, audio: 'skip' } },
            { start: split, end: source.length, disposition },
          ]
        : [{ start: 0, end: source.length - (invalid ? 1 : 0), disposition }];
      const output = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: source,
              provider_specific_fields: {
                viventium: {
                  deliveryDispositionRanges: ranges,
                  delivery_disposition: disposition,
                },
              },
            },
          },
        ],
      };
      const createRun = jest.spyOn(Run, 'create').mockImplementation(async (options) => ({
        processStream: async () => {
          options.customHandlers.on_chat_model_start.handle();
          options.customHandlers.on_chat_model_end.handle('on_chat_model_end', { output });
          return source;
        },
      }));
      const previous = process.env.XAI_API_KEY;
      try {
        process.env.XAI_API_KEY = 'synthetic-xai-key';
        const prepared = await prepareCortexFollowUpMessage({
          req: {
            id: 'synthetic-voice-ranges',
            viventiumCallSession: { callSessionId: 'synthetic-owned-call' },
            body: { voiceMode: true, viventiumSurface: 'voice' },
            config: {
              endpoints: {
                agents: {
                  providerCapabilities: {
                    xai: {
                      messaging_delivery_disposition: true,
                      messaging_delivery_disposition_version: 1,
                    },
                  },
                },
              },
            },
          },
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
          runId: 'synthetic-run',
          agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
          insightsData: {
            cortexCount: 1,
            insights: [{ cortexName: 'Synthetic specialist', insight: 'A useful result.' }],
          },
          recentResponse: 'The initial answer is visible.',
        });
        expect(prepared.text).toBe(visible || source.replace('[laugh] ', ''));
        expect(prepared.nativeDeliveryContent[0].text).toBe(prepared.text);
        expect(prepared.deliveryDisposition).toEqual({
          ...disposition,
          audio: invalid ? 'skip' : audio,
          valid: !invalid,
          source: invalid ? 'required_malformed' : 'model',
        });
        expect(prepared.nativeDeliveryContent[0].deliveryDispositionRanges).toEqual(
          invalid
            ? []
            : split
              ? [
                  { start: 0, end: publicSplit, disposition: { ...disposition, audio: 'skip' } },
                  { start: publicSplit, end: prepared.text.length, disposition },
                ]
              : [{ start: 0, end: prepared.text.length, disposition }],
        );
        expect(createRun).toHaveBeenCalledTimes(1);
      } finally {
        if (previous === undefined) delete process.env.XAI_API_KEY;
        else process.env.XAI_API_KEY = previous;
        createRun.mockRestore();
      }
    },
  );

  test.each([false, true])(
    'prepares before persistence and retains declared audio=%s without calling the provider again',
    async (audioEligible) => {
      const processStream = jest.fn().mockResolvedValue('A grounded follow-up.');
      const disposition = {
        version: 1,
        audio: 'eligible',
        required: true,
        valid: true,
        source: 'model',
      };
      const createRun = jest.spyOn(Run, 'create').mockImplementation(async (options) => ({
        processStream: async (...args) => {
          await options.customHandlers?.on_chat_model_end?.handle('on_chat_model_end', {
            output: {
              provider_specific_fields: { viventium: { delivery_disposition: disposition } },
            },
          });
          return processStream(...args);
        },
      }));
      const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
      const originalXaiApiKey = process.env.XAI_API_KEY;
      const input = {
        req: {
          id: 'synthetic-split-request',
          body: { voiceMode: audioEligible },
          ...(audioEligible
            ? { viventiumCallSession: { callSessionId: 'synthetic-owned-call' } }
            : {}),
          config: {
            endpoints: {
              agents: {
                providerCapabilities: {
                  xai: {
                    messaging_delivery_disposition: true,
                    messaging_delivery_disposition_version: 1,
                  },
                },
              },
            },
          },
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
        expect(prepared.deliveryDisposition).toEqual(audioEligible ? disposition : null);
        expect(prepared).toEqual(
          expect.objectContaining({
            suppressed: false,
            text: 'A grounded follow-up.',
          }),
        );

        const persisted = await persistPreparedCortexFollowUpMessage(input, prepared);

        expect(processStream).toHaveBeenCalledTimes(1);
        expect(saveMessage).toHaveBeenCalledTimes(1);
        expect(persisted.metadata.viventium.deliveryDisposition).toEqual(
          audioEligible ? disposition : undefined,
        );
        expect(saveMessage).toHaveBeenCalledWith(
          input.req,
          expect.objectContaining({
            conversationId: input.conversationId,
            parentMessageId: input.parentMessageId,
            text: 'A grounded follow-up.',
          }),
          expect.objectContaining({
            operationKind: 'system',
            context:
              'viventium/services/BackgroundCortexFollowUpService.createCortexFollowUpMessage',
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
    },
  );
});

describe('forced follow-up onto an empty primary answer', () => {
  const parent = (acknowledgement) => ({
    messageId: 'synthetic-answer',
    parentMessageId: 'synthetic-source',
    conversationId: 'synthetic-conversation',
    isCreatedByUser: false,
    text: '',
    unfinished: true,
    content: [
      { type: 'cortex_insight', cortex_id: 'synthetic', status: 'complete', insight: 'Fact.' },
      { type: 'error', error_class: 'source_context_unavailable', error: 'Unavailable.' },
    ],
    metadata: { viventium: acknowledgement ? { deliveryAcknowledgement: acknowledgement } : {} },
  });

  test.each([
    ['promotes the insight onto an empty primary answer', null, true],
    ['keeps an answer acknowledged failed and gives the insight its own message', 'failed', false],
  ])('%s', async (_label, acknowledgementState, promoted) => {
    const nativeDeliveryContent = [
      {
        type: 'text',
        text: 'The recovered answer.',
        deliveryDispositionRanges: [
          {
            start: 0,
            end: 'The recovered answer.'.length,
            disposition: {
              version: 1,
              audio: 'skip',
              required: true,
              valid: true,
              source: 'model',
            },
          },
        ],
      },
    ];
    const getMessage = jest
      .spyOn(db, 'getMessage')
      .mockResolvedValue(
        parent(acknowledgementState ? { state: acknowledgementState, revision: 1 } : null),
      );
    const getMessages = jest.spyOn(db, 'getMessages').mockResolvedValue([]);
    const updateMessage = jest.spyOn(db, 'updateMessage').mockResolvedValue({});
    const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
    try {
      await persistPreparedCortexFollowUpMessage(
        {
          req: { user: { id: 'owner' }, body: {} },
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-answer',
          agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
          insightsData: {
            cortexCount: 1,
            insights: [{ cortexName: 'Synthetic', insight: 'Fact.' }],
          },
          dependencies: {
            prepareAttachments: async (message) => {
              if (Array.isArray(message.content))
                expect(
                  message.content.some(
                    (part) => part.type === 'text' && part.text === message.text,
                  ),
                ).toBe(true);
              return [{ file_id: 'owned-file', filename: 'result.md' }];
            },
          },
        },
        {
          text: 'The recovered answer.',
          shouldForceVisibleFollowUp: true,
          nativeDeliveryContent,
          deliveryDisposition: {
            version: 1,
            audio: 'skip',
            required: true,
            valid: true,
            source: 'model',
          },
        },
      );
      const promotion = updateMessage.mock.calls.find(
        ([, update]) => update?.metadata?.viventium?.promotedToEmptyParent === true,
      );
      if (promoted) {
        expect(promotion).toBeDefined();
        expect(promotion[1]).toMatchObject({
          text: 'The recovered answer.',
          content: expect.arrayContaining(nativeDeliveryContent),
          attachments: [{ file_id: 'owned-file', filename: 'result.md' }],
          metadata: {
            viventium: {
              deliveryDisposition: {
                version: 1,
                audio: 'skip',
                required: true,
                valid: true,
                source: 'model',
              },
            },
          },
        });
        expect(saveMessage).not.toHaveBeenCalled();
      } else {
        expect(promotion).toBeUndefined();
        expect(saveMessage).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            text: 'The recovered answer.',
            metadata: expect.objectContaining({
              viventium: expect.objectContaining({
                deliveryDisposition: {
                  version: 1,
                  audio: 'skip',
                  required: true,
                  valid: true,
                  source: 'model',
                },
              }),
            }),
            attachments: [{ file_id: 'owned-file', filename: 'result.md' }],
          }),
          expect.anything(),
        );
      }
    } finally {
      getMessage.mockRestore();
      getMessages.mockRestore();
      updateMessage.mockRestore();
      saveMessage.mockRestore();
    }
  });
});

describe('formatFollowUpPrompt', () => {
  const missionReports = (prompt) =>
    prompt
      .split('\n')
      .filter((line) => line.startsWith('- Mission evidence: {'))
      .map((line) => JSON.parse(line.slice('- Mission evidence: '.length)));
  const missionInsight = (runId, instruction, insight) => ({
    cortexName: 'Mission evidence',
    insight,
    runInput: { version: 1, run_id: runId, instruction },
    authority: {
      kind: 'durable_terminal_callback',
      runId,
      event: 'run.completed',
      workState: 'completed',
    },
  });

  test.each(['17', '  Exact result\nwith "quoted" source.  '])(
    'binds a complete report to its accepted goal and authority without an ambiguous bare value (%s)',
    (report) => {
      const evidence = missionInsight('run-report', 'Return the requested result.', report);
      const prompt = formatFollowUpPrompt({
        insights: [evidence],
        userRequest: 'Do the accepted task, and answer a separate quick question.',
        recentResponse: '42. The task was accepted.',
        surface: 'voice',
      });
      expect(missionReports(prompt)).toEqual([
        { report, runInput: evidence.runInput, authority: evidence.authority },
      ]);
      expect(prompt).not.toContain('- Mission evidence: ' + report + '\n');
      expect(prompt.split(JSON.stringify(report))).toHaveLength(2);
    },
  );

  test('keeps the public user request separate from worker execution instructions', () => {
    const instruction = '  Compare two storage designs.\n Keep the source links.  ';
    const evidence = missionInsight('run-a', instruction, '  Full result\nwith sources.  ');
    const prompt = formatFollowUpPrompt({
      insights: [evidence],
      userRequest: 'What is 17 times 23?',
      recentResponse: '391. The comparison was accepted separately.',
      surface: 'web',
    });
    expect(prompt).toContain(JSON.stringify(evidence.runInput));
    expect(prompt).toContain(JSON.stringify(evidence.authority));
    expect(missionReports(prompt).map((item) => item.report)).toContain(evidence.insight);
    expect(prompt).toContain('What is 17 times 23?');
    const publicRequest = prompt.split('Original user request for interpreting')[1].split('---')[1];
    expect(publicRequest).toContain('What is 17 times 23?');
    expect(publicRequest).not.toContain(instruction);
    expect(prompt.split(JSON.stringify(evidence.runInput))).toHaveLength(2);
    expect(prompt).toContain('391. The comparison was accepted separately.');
  });

  test('preserves distinct grouped mission inputs and complete evidence without prefix clipping', () => {
    const a = missionInsight(
      'run-a',
      'First objective\n' + 'x'.repeat(4300) + '  END A',
      'a'.repeat(12500) + ' END RESULT A',
    );
    const b = missionInsight('run-b', '\tSecond objective  ', 'END RESULT B');
    const prompt = formatFollowUpPrompt({
      insights: [a, b],
      userRequest: 'Unrelated question',
      surface: 'web',
    });
    expect(prompt).toContain(JSON.stringify(a.runInput));
    expect(prompt).toContain(JSON.stringify(b.runInput));
    expect(missionReports(prompt).map((item) => item.report)).toContain(a.insight);
    expect(missionReports(prompt).map((item) => item.report)).toContain(b.insight);
    expect(prompt.indexOf(JSON.stringify(a.runInput))).toBeLessThan(
      prompt.indexOf(JSON.stringify(b.runInput)),
    );
  });

  test('distinct accepted missions retain both inputs even when their result text overlaps', () => {
    const a = missionInsight(
      'run-a',
      'First accepted goal',
      'Identical factual result with shared source material.',
    );
    const b = missionInsight('run-b', 'Second accepted goal', a.insight);
    expect(deduplicateInsights([a, b])).toEqual([a, b]);
  });

  test.each([false, true])(
    'retains terminal evidence with missing worker input without replacing the public user request (mixed=%s)',
    (mixed) => {
      const missing = {
        cortexName: 'Mission evidence',
        insight: 'legacy result '.repeat(1500) + ' END LEGACY',
        authority: {
          kind: 'durable_terminal_callback',
          runId: 'run-legacy',
          event: 'run.completed',
          workState: 'completed',
        },
      };
      const known = missionInsight('run-known', '  Exact known objective\n', missing.insight);
      const insights = mixed ? [known, missing] : [missing];
      expect(deduplicateInsights(insights)).toEqual(insights);
      const prompt = formatFollowUpPrompt({
        insights,
        userRequest: 'Unrelated quick question',
        surface: 'web',
      });
      expect(prompt).toContain('Unrelated quick question');
      expect(missionReports(prompt).map((item) => item.report)).toContain(missing.insight);
      expect(prompt).toContain(JSON.stringify(missing.authority));
      expect(prompt).toContain('"runInput":null');
      if (mixed) expect(prompt).toContain(JSON.stringify(known.runInput));
    },
  );

  test('retains complete durable user constraints without a worker return-format substitution', () => {
    const ownerRequest = 'Keep the public answer natural. ' + 'x'.repeat(5000) + ' END OWNER';
    const workerInstruction = 'Inspect the result and return only an internal JSON field.';
    const evidence = missionInsight('run-a', workerInstruction, 'Verified outcome.');
    const prompt = formatFollowUpPrompt({
      insights: [evidence],
      userRequest: ownerRequest,
      surface: 'voice',
    });
    const publicRequest = prompt.split('Original user request for interpreting')[1].split('---')[1];
    expect(publicRequest.trim()).toBe(ownerRequest);
    expect(publicRequest).not.toContain(workerInstruction);
    expect(prompt).toContain(JSON.stringify(evidence.runInput));
  });

  test('keeps missing public source explicit while retaining the accepted worker goal', () => {
    const instruction = 'Return only the internal result field.';
    const evidence = missionInsight('run-a', instruction, 'Verified outcome.');
    const prompt = formatFollowUpPrompt({ insights: [evidence], userRequest: '', surface: 'web' });
    const publicRequest = prompt.split('Original user request for interpreting')[1].split('---')[1];
    expect(publicRequest).toContain('user request unavailable');
    expect(publicRequest).not.toContain(instruction);
    expect(prompt).toContain(JSON.stringify(evidence.runInput));
  });

  test('ordinary insights cannot substitute an unbound run input for the current request', () => {
    const ordinary = {
      cortexName: 'planner',
      insight: 'A useful fact.',
      runInput: { version: 1, run_id: 'run-a', instruction: 'Wrong objective' },
    };
    const input = { insights: [ordinary], userRequest: 'Current request', surface: 'web' };
    const withoutInput = { ...ordinary };
    delete withoutInput.runInput;
    expect(formatFollowUpPrompt(input)).toBe(
      formatFollowUpPrompt({ ...input, insights: [withoutInput] }),
    );
    expect(formatFollowUpPrompt(input)).toContain('Current request');
  });

  test.each(['web', 'telegram', 'playground'])(
    'preserves the complete delivered answer for %s follow-up judgment',
    (surface) => {
      const recentResponse = `${'The detailed comparison explains the options. '.repeat(80)}\nDecision: retain the current service and verify the restore before launch.`;
      const prompt = formatFollowUpPrompt({
        insights: [
          { cortexName: 'planner', insight: 'Retain the current service and verify restore.' },
        ],
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
      'If an insight contains new factual/contextual material followed by an optional generic question, keep the new material and drop that question.',
    );
    expect(prompt).toContain(
      'If it is stale, redundant, already resolved, or an optional generic background question, output exactly {NTA}.',
    );
    expect(prompt).toContain(
      'Surface a supplied necessary accepted-mission question once; drop optional generic background questions',
    );
    expect(prompt).not.toContain('If a question seems needed, output {NTA} instead.');
  });

  test('preserves a necessary question and accepted goal from a completed native mission turn', () => {
    const prompt = formatFollowUpPrompt({
      insights: [
        {
          cortexName: 'Mission evidence',
          insight: 'Blue circle or green square? Nothing drawn yet.',
          authority: {
            kind: 'durable_terminal_callback',
            runId: 'run_choice',
            event: 'run.completed',
            workState: 'completed',
          },
          runInput: {
            version: 1,
            run_id: 'run_choice',
            instruction: 'Ask the owner to choose the badge before drawing.',
          },
        },
      ],
      recentResponse: 'One worker accepted the task and will wait for your choice.',
      continuationContext: '',
      surface: 'telegram',
    });
    expect(prompt).toContain('Blue circle or green square? Nothing drawn yet.');
    expect(prompt).toContain('Ask the owner to choose the badge before drawing.');
    expect(prompt).toContain('"kind":"durable_terminal_callback"');
    expect(prompt).toContain('"workState":"completed"');
    expect(prompt).toContain("does not prove the user's goal is fulfilled");
    expect(prompt).toContain('A plain report grants no native form or approval authority');
    expect(prompt).not.toContain('question-only, or would interrupt the current flow');
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
    expect(prompt).toContain('If it is stale, redundant, already resolved');
    expect(prompt).toContain(
      'These newer visible messages were exchanged before this follow-up decision',
    );
    expect(prompt).not.toContain('default to {NTA} unless');
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

test('durable preparation uses its owned original user source rather than the generated worker brief', async () => {
  const native = require('../nativeResponseService');
  const offer = jest.spyOn(native, 'offerMissionEvidenceToCurrentMain').mockResolvedValue(false);
  const ownerRequest = 'Calculate a result in the background and tell me when it arrives.';
  const getMessages = jest.spyOn(db, 'getMessages').mockResolvedValue([
    { messageId: 'owned-user', sender: 'User', isCreatedByUser: true, text: ownerRequest },
    {
      messageId: 'owned-main',
      parentMessageId: 'owned-user',
      sender: 'Viventium',
      isCreatedByUser: false,
      text: 'Your work was accepted.',
    },
  ]);
  try {
    const prepared = await prepareCortexFollowUpMessage({
      req: { user: { id: 'synthetic-owner' }, body: {} },
      conversationId: 'synthetic-conversation',
      parentMessageId: 'owned-main',
      recentResponse: 'Your work was accepted.',
      agent: null,
      insightsData: {
        cortexCount: 1,
        insights: [
          {
            cortexName: 'Mission evidence',
            insight: 'The result is ready.',
            runInput: {
              version: 1,
              run_id: 'owned-run',
              instruction: 'Return only internal JSON.',
            },
            authority: {
              kind: 'durable_terminal_callback',
              runId: 'owned-run',
              workState: 'completed',
            },
          },
        ],
      },
    });
    expect(prepared.durableMissionEvidence).toBe(true);
    expect(prepared.followUpDecisionRecord).toMatchObject({
      userRequestLength: ownerRequest.length,
      userRequestHash: require('node:crypto')
        .createHash('sha256')
        .update(ownerRequest)
        .digest('hex')
        .slice(0, 12),
    });
  } finally {
    getMessages.mockRestore();
    offer.mockRestore();
  }
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
        insightsData: {
          insights: [{ cortexName: 'Analysis', insight: 'The earlier answer is correct.' }],
        },
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
  test('does not treat a worker status card as a delivered answer, while retaining its descendants', () => {
    const anchor = {
      messageId: 'anchor',
      parentMessageId: 'request',
      sender: 'AI',
      text: 'Working.',
    };
    const status = {
      messageId: 'status',
      parentMessageId: 'anchor',
      sender: 'AI',
      text: 'Mission completed.',
      isCreatedByUser: false,
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          event: 'run.completed',
          visibility: 'internal',
        },
      },
    };
    const statusOnly = resolveFollowUpContinuationContext([anchor, status], 'anchor');
    expect(statusOnly).toMatchObject({
      hasMovedOn: false,
      contextText: '',
      messageCount: 0,
      currentLeafMessageId: 'status',
    });
    const continued = resolveFollowUpContinuationContext(
      [
        anchor,
        status,
        {
          messageId: 'user',
          parentMessageId: 'status',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Use the other offer.',
        },
        { messageId: 'answer', parentMessageId: 'user', sender: 'AI', text: 'Mission completed.' },
      ],
      'anchor',
    );
    expect(continued).toMatchObject({
      hasMovedOn: true,
      messageCount: 2,
      currentLeafMessageId: 'answer',
    });
    expect(continued.contextText).toBe('User: Use the other offer.\nAssistant: Mission completed.');
  });

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
          messageId: 'anchor',
          parentMessageId: 'request',
          sender: 'AI',
          text: 'Both checks are running.',
          createdAt: '2026-05-03T03:00:00.000Z',
          updatedAt: '2026-05-03T03:05:00.000Z',
        },
        {
          messageId: 'correction',
          parentMessageId: 'anchor',
          sender: 'User',
          isCreatedByUser: true,
          text: 'Narrow the first check. Leave the other one unchanged.',
          createdAt: '2026-05-03T03:01:00.000Z',
        },
        {
          messageId: 'first-result',
          parentMessageId: 'correction',
          sender: 'AI',
          text: 'The first check found an undocumented sign-in requirement.',
          createdAt: '2026-05-03T03:04:00.000Z',
        },
        {
          messageId: 'second-status',
          parentMessageId: 'first-result',
          sender: 'AI',
          text: 'Second check completed.',
          createdAt: '2026-05-03T03:06:00.000Z',
        },
      ],
      'anchor',
    );
    expect(result.hasMovedOn).toBe(true);
    expect(result.messageCount).toBe(3);
    expect(result.contextText).toContain('Narrow the first check. Leave the other one unchanged.');
    expect(result.contextText).toContain(
      'The first check found an undocumented sign-in requirement.',
    );
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
  ])(
    'selects mode from authority while preserving empty-primary recovery: %s / %s',
    async (kind, recentResponse, forced) => {
      const processStream = jest.fn().mockResolvedValue('{NTA}');
      const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
      const priorKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = 'synthetic-xai-key';
      try {
        const prepared = await prepareCortexFollowUpMessage({
          req: { body: {} },
          conversationId: 'synthetic-conversation',
          parentMessageId: 'synthetic-parent',
          agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
          forceVisibleFollowUp: true,
          recentResponse,
          insightsData: {
            cortexCount: 1,
            insights: [
              {
                cortexName: 'Synthetic evidence',
                insight: 'A verified finding.',
                authority: { kind },
              },
            ],
          },
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
    },
  );
});

test('Phase B receives verified parent graph records beside the limited parallel insight', async () => {
  const native = require('../nativeResponseService');
  const evidence = [
    {
      type: 'text',
      text: JSON.stringify({
        native_tool_evidence: {
          requests: [
            { run_id: 'before', record: 'Primary archive result' },
            { run_id: 'after', record: 'Later graph verification' },
          ],
        },
      }),
    },
  ];
  const readToolEvidenceForPresentation = jest.fn().mockResolvedValue(evidence);
  const service = jest
    .spyOn(native, 'getService')
    .mockReturnValue({ readToolEvidenceForPresentation });
  const processStream = jest.fn().mockResolvedValue('Useful synthesis.');
  const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
  const oldKey = process.env.XAI_API_KEY;
  try {
    process.env.XAI_API_KEY = 'synthetic-key';
    await generateFollowUpText({
      req: { user: { id: 'owner' }, body: {} },
      agent: { provider: 'xai', model: 'synthetic', model_parameters: {} },
      conversationId: 'conversation',
      parentMessageId: 'answer',
      runId: 'run',
      insightsData: {
        insights: [
          {
            cortexName: 'Parallel search',
            insight: 'The prior conversation search found no record.',
          },
        ],
      },
      recentResponse: 'The primary archive read found a record.',
    });
    expect(readToolEvidenceForPresentation).toHaveBeenCalledWith(
      'owner',
      'conversation',
      'answer',
      expect.any(Number),
    );
    const transmitted = JSON.stringify(processStream.mock.calls[0][0]);
    expect(transmitted).toContain('Primary archive result');
    expect(transmitted).toContain('Later graph verification');
    expect(transmitted).toContain('prior conversation search found no record');
    expect(createRun.mock.calls[0][0].graphConfig.tools).toEqual([]);
  } finally {
    if (oldKey == null) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = oldKey;
    service.mockRestore();
    createRun.mockRestore();
  }
});

test.each([
  ['durable_terminal_callback', 'native_graph_tool_evidence_parent_unfinished', true],
  ['ordinary_cortex', 'native_graph_tool_evidence_parent_unfinished', false],
  ['durable_terminal_callback', 'native_graph_tool_evidence_identity_mismatch', false],
  ['durable_terminal_callback', 'native_graph_tool_evidence_source_changed', false],
])(
  'Phase B handles %s parent evidence error %s without weakening its guard',
  async (kind, code, allowed) => {
    const native = require('../nativeResponseService');
    const readToolEvidenceForPresentation = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error(code), { code }));
    const service = jest
      .spyOn(native, 'getService')
      .mockReturnValue({ readToolEvidenceForPresentation });
    const processStream = jest.fn().mockResolvedValue('The completed worker result.');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const oldKey = process.env.XAI_API_KEY;
    try {
      process.env.XAI_API_KEY = 'synthetic-key';
      const result = generateFollowUpText({
        req: { user: { id: 'owner' }, body: {} },
        agent: { provider: 'xai', model: 'synthetic', model_parameters: {} },
        conversationId: 'conversation',
        parentMessageId: 'answer',
        runId: 'run',
        insightsData: {
          insights: [
            {
              cortexName: 'Completed worker',
              insight: 'Verified retained result.',
              authority: {
                kind,
                runId: 'worker-run',
                event: 'run.completed',
                workState: 'completed',
              },
            },
          ],
        },
      });
      if (allowed) {
        await expect(result).resolves.toBe('The completed worker result.');
        expect(JSON.stringify(processStream.mock.calls[0][0])).toContain(
          'Verified retained result.',
        );
      } else {
        await expect(result).rejects.toMatchObject({ code });
        expect(processStream).not.toHaveBeenCalled();
      }
    } finally {
      if (oldKey == null) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = oldKey;
      service.mockRestore();
      createRun.mockRestore();
    }
  },
);

/* === VIVENTIUM START === Worker/cortex follow-up ownership persists with the message. === */
describe('durable callback follow-up ownership', () => {
  test.each([
    ['all durable', ['durable_terminal_callback', 'durable_terminal_callback'], true],
    ['nonterminal attention', ['durable_work_callback'], true],
    ['ordinary', ['cortex_insight'], false],
    ['mixed', ['durable_terminal_callback', 'cortex_insight'], false],
  ])('persists the source only for %s evidence', async (_label, kinds, durable) => {
    const processStream = jest.fn().mockResolvedValue('A grounded result.');
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
    const priorKey = process.env.XAI_API_KEY;
    const input = {
      req: { id: 'synthetic-ownership-request', body: { voiceMode: true } },
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
      runId: 'synthetic-run',
      agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
      recentResponse: 'The initial answer is already visible.',
      insightsData: {
        cortexCount: kinds.length,
        insights: kinds.map((kind, index) => ({
          cortexName: 'Synthetic evidence',
          insight: `Verified result ${index + 1}.`,
          authority: { kind },
        })),
      },
    };
    try {
      process.env.XAI_API_KEY = 'synthetic-xai-key';
      const prepared = await prepareCortexFollowUpMessage(input);
      expect(saveMessage).not.toHaveBeenCalled();
      const persisted = await persistPreparedCortexFollowUpMessage(input, prepared);
      expect(processStream).toHaveBeenCalledTimes(1);
      expect(saveMessage).toHaveBeenCalledTimes(1);
      const saved = saveMessage.mock.calls[0][1];
      expect(saved.text).toBe('A grounded result.');
      expect(saved.metadata.viventium.type).toBe('cortex_followup');
      expect(saved.metadata.viventium.parentMessageId).toBe(input.parentMessageId);
      expect(saved.metadata.viventium.cortexCount).toBe(kinds.length);
      if (durable) {
        expect(saved.metadata.viventium.followUpSource).toBe(
          kinds.every((kind) => kind === 'durable_terminal_callback')
            ? 'durable_terminal_callback'
            : 'durable_work_callback',
        );
      } else {
        expect(saved.metadata.viventium).not.toHaveProperty('followUpSource');
      }
      expect(persisted.metadata).toEqual(saved.metadata);
    } finally {
      if (priorKey == null) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = priorKey;
      createRun.mockRestore();
      saveMessage.mockRestore();
    }
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Preserve durable decisions across foreground movement. === */
describe('durable follow-up foreground movement', () => {
  test.each([
    ['telegram', ['durable_terminal_callback'], 'The result is ready.', true],
    ['telegram', ['durable_terminal_callback'], '{NTA}', true],
    ['voice', ['durable_terminal_callback'], 'The result is ready.', true],
    ['voice', ['durable_terminal_callback'], '{NTA}', true],
    ['web', ['durable_terminal_callback'], 'The result is ready.', true],
    ['web', ['durable_terminal_callback'], '{NTA}', true],
    ['telegram', ['cortex_insight'], 'An optional observation.', false],
    ['web', ['cortex_insight'], '{NTA}', false],
    ['voice', ['durable_terminal_callback', 'cortex_insight'], 'A mixed observation.', false],
    ['telegram', ['durable_terminal_callback', 'cortex_insight'], '{NTA}', false],
  ])('preserves the typed decision on %s (%s / %s)', async (surface, kinds, generated, durable) => {
    const before = [
      {
        messageId: 'synthetic-user',
        parentMessageId: null,
        isCreatedByUser: true,
        text: 'Keep chatting while the work finishes.',
        createdAt: new Date(1000),
      },
      {
        messageId: 'synthetic-parent',
        parentMessageId: 'synthetic-user',
        isCreatedByUser: false,
        text: 'The accepted work is running.',
        createdAt: new Date(2000),
      },
    ];
    const after = [
      ...before,
      {
        messageId: 'synthetic-next',
        parentMessageId: 'synthetic-parent',
        isCreatedByUser: true,
        text: 'A current foreground question.',
        createdAt: new Date(3000),
      },
    ];
    const getMessages = jest
      .spyOn(db, 'getMessages')
      .mockResolvedValueOnce(before)
      .mockResolvedValue(after);
    const native = require('../nativeResponseService');
    const readToolEvidenceForPresentation = jest.fn().mockResolvedValue([]);
    const service = jest
      .spyOn(native, 'getService')
      .mockReturnValue({ readToolEvidenceForPresentation });
    const processStream = jest.fn().mockResolvedValue(generated);
    const createRun = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
    const saveMessage = jest.spyOn(db, 'saveMessage').mockResolvedValue({});
    const oldKey = process.env.XAI_API_KEY;
    try {
      process.env.XAI_API_KEY = 'synthetic-xai-key';
      const prepared = await prepareCortexFollowUpMessage({
        req: {
          user: { id: 'synthetic-owner' },
          body: { viventiumSurface: surface, ...(surface === 'voice' ? { voiceMode: true } : {}) },
        },
        conversationId: 'synthetic-conversation',
        parentMessageId: 'synthetic-parent',
        runId: 'synthetic-run',
        agent: { provider: 'xai', model: 'synthetic-model', model_parameters: {} },
        recentResponse: 'The accepted work is running.',
        insightsData: {
          cortexCount: kinds.length,
          insights: kinds.map((kind) => ({
            cortexName: 'Synthetic evidence',
            insight: 'A verified accepted result.',
            authority: {
              kind,
              runId: 'synthetic-worker',
              event: 'run.completed',
              workState: 'completed',
            },
          })),
        },
      });
      expect(prepared.durableMissionEvidence).toBe(durable);
      expect(prepared.followUpDecisionRecord).toMatchObject({
        generationFailed: false,
        movedOnAfterParent: true,
        forceVisibleFollowUp: false,
      });
      expect(processStream).toHaveBeenCalledTimes(1);
      expect(readToolEvidenceForPresentation).toHaveBeenCalledWith(
        'synthetic-owner',
        'synthetic-conversation',
        'synthetic-parent',
        expect.any(Number),
      );
      expect(createRun.mock.calls[0][0].graphConfig.tools).toEqual([]);
      expect(saveMessage).not.toHaveBeenCalled();
      if (durable) {
        expect(prepared.text).toBe(generated === '{NTA}' ? '' : generated);
        expect(prepared.followUpDecisionRecord).toMatchObject({
          llmResult: generated === '{NTA}' ? 'nta' : 'generated',
          selectedStrategy: generated === '{NTA}' ? 'no_response_suppressed' : 'llm_generated',
        });
      } else {
        expect(prepared.text).toBe('');
        expect(prepared.followUpDecisionRecord).toMatchObject({
          llmResult: 'empty',
          selectedStrategy: 'moved_on_empty_suppressed',
        });
      }
    } finally {
      if (oldKey == null) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = oldKey;
      getMessages.mockRestore();
      service.mockRestore();
      createRun.mockRestore();
      saveMessage.mockRestore();
    }
  });
});
/* === VIVENTIUM END === */

test('terminal mission synthesis27 defers to the current Main and keeps ordinary Cortex immediate', async () => {
  const native = require('../nativeResponseService');
  const previous = native.offerMissionEvidenceToCurrentMain;
  const offer = jest.fn().mockResolvedValue(true);
  native.offerMissionEvidenceToCurrentMain = offer;
  const service = jest.spyOn(native, 'getService').mockReturnValue({
    readToolEvidenceForPresentation: jest.fn().mockResolvedValue([]),
  });
  const processStream = jest.fn().mockResolvedValue('{NTA}');
  const create = jest.spyOn(Run, 'create').mockResolvedValue({ processStream });
  const oldKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'synthetic-key';
  const input = {
    req: { user: { id: 'owner' }, body: {} },
    conversationId: 'conversation',
    parentMessageId: 'old-anchor',
    recentResponse: 'Old holding reply.',
    agent: { id: 'main', provider: 'xai', model: 'synthetic', model_parameters: {} },
    insightsData: {
      insights: [
        {
          cortexName: 'Mission',
          insight: 'Inspection declined.',
          authority: { kind: 'durable_terminal_callback' },
        },
      ],
    },
  };
  const messages = jest.spyOn(db, 'getMessages').mockResolvedValue([]);
  try {
    expect(await prepareCortexFollowUpMessage(input)).toEqual({
      currentMainPending: true,
      currentMainReadyAfterRelease: undefined,
    });
    expect(create).not.toHaveBeenCalled();
    offer.mockResolvedValue(false);
    expect((await prepareCortexFollowUpMessage(input)).followUpDecisionRecord.llmResult).toBe(
      'nta',
    );
    expect(create).toHaveBeenCalledTimes(1);
    offer.mockClear();
    await prepareCortexFollowUpMessage({
      ...input,
      insightsData: { insights: [{ cortexName: 'Cortex', insight: 'Adjacent useful evidence.' }] },
    });
    expect(offer).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
  } finally {
    if (previous === undefined) delete native.offerMissionEvidenceToCurrentMain;
    else native.offerMissionEvidenceToCurrentMain = previous;
    create.mockRestore();
    messages.mockRestore();
    service.mockRestore();
    if (oldKey == null) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = oldKey;
  }
});

/* === VIVENTIUM START === Completed native silence preserves model judgment. === */
describe('native silence persistence decision', () => {
  test('retains a validated native empty assistant response after an unrelated turn', () => {
    const result = resolveFollowUpPersistenceText({
      generatedText: '',
      nativeSilentDecision: true,
      voiceMode: true,
      movedOnAfterParent: true,
      insightsData: { insights: [{ insight: 'Accepted blocker.' }] },
    });
    expect(result.text).toBe('');
    expect(result.decision).toMatchObject({
      nativeSilentDecision: true,
      llmResult: 'native_silent',
      selectedStrategy: 'native_silent_suppressed',
      generationFailed: false,
    });
    expect(
      buildFollowUpDecisionRecord({ generatedText: '', finalText: '', decision: result.decision }),
    ).toMatchObject({ nativeSilentDecision: true, llmResult: 'native_silent', generatedLength: 0 });
  });
  test.each([
    { nativeSilentDecision: false },
    { nativeSilentDecision: true, generationFailed: true },
    { nativeSilentDecision: true, generatedText: 'An actionable question.' },
  ])(
    'does not promote arbitrary empty, failed or useful output into native silence: %j',
    (changes) => {
      const result = resolveFollowUpPersistenceText({
        generatedText: '',
        voiceMode: true,
        ...changes,
      });
      expect(result.decision.nativeSilentDecision).toBeUndefined();
      expect(result.decision.llmResult).not.toBe('native_silent');
    },
  );
});
/* === VIVENTIUM END === */

describe('Phase B retained File publication', () => {
  test.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'normal follow-up persists only after its original File source guard, revoked=%s explicitHook=%s',
    async (revoked, explicitHook) => {
      const transaction = require('../GlassHiveTerminalCallbackTransaction');
      const session = { inTransaction: () => true };
      const order = [];
      const runTransaction = jest
        .spyOn(transaction, 'runGlassHiveTerminalCallbackTransaction')
        .mockImplementation(async (operation) => {
          order.push('transaction');
          return operation(session);
        });
      const save = jest.spyOn(db, 'saveMessage').mockImplementation(async (_req, message) => {
        order.push('save');
        return message;
      });
      const guard = jest.fn(async (currentSession) => {
        expect(currentSession).toBe(session);
        order.push('guard');
        if (revoked) throw new Error('native_output_files_retained_source_invalid');
      });
      const attachments = [
        {
          user: 'owner',
          file_id: 'native_' + 'a'.repeat(64),
          filepath: '/uploads/capture.svg',
          filename: 'capture.svg',
          type: 'image/svg+xml',
          bytes: 6,
          source: 'local',
          nativeOutputFile: {
            version: 1,
            status: 'available',
            messageId: 'new-message',
            downloadUrl: 'https://artifacts.example.test/v1/link-refs/ghr_retained1234567890',
          },
        },
      ];
      const priorBase = process.env.GLASSHIVE_ARTIFACT_BASE_URL;
      process.env.GLASSHIVE_ARTIFACT_BASE_URL = 'https://artifacts.example.test';
      const source = require('../nativeOutputFiles');
      const prepareFiles = jest
        .spyOn(source, 'prepareMissionOutputFiles')
        .mockResolvedValue({ attachments, authorizePublication: guard });
      try {
        const operation = persistPreparedCortexFollowUpMessage(
          {
            req: { user: { id: 'owner' }, body: {} },
            conversationId: 'conversation',
            parentMessageId: 'parent',
            agent: { id: 'main' },
            insightsData: { insights: [] },
            dependencies: explicitHook
              ? { prepareAttachments: async () => ({ attachments, authorizePublication: guard }) }
              : {},
          },
          {
            text: '[Original capture](https://artifacts.example.test/v1/link-refs/ghr_retained1234567890)',
            shouldForceVisibleFollowUp: false,
            finalContinuationContext: { currentLeafMessageId: 'parent' },
            followUpDecisionRecord: {},
            conversationMessages: [],
          },
        );
        if (revoked)
          await expect(operation).rejects.toThrow('native_output_files_retained_source_invalid');
        else await expect(operation).resolves.toMatchObject({ attachments });
        expect(order).toEqual(
          revoked ? ['transaction', 'guard'] : ['transaction', 'guard', 'save'],
        );
        expect(guard).toHaveBeenCalledTimes(1);
        if (!explicitHook)
          expect(prepareFiles).toHaveBeenCalledWith(
            expect.objectContaining({
              message: expect.objectContaining({
                text: '[Original capture](https://artifacts.example.test/v1/link-refs/ghr_retained1234567890)',
              }),
            }),
          );
      } finally {
        runTransaction.mockRestore();
        save.mockRestore();
        prepareFiles.mockRestore();
        if (priorBase === undefined) delete process.env.GLASSHIVE_ARTIFACT_BASE_URL;
        else process.env.GLASSHIVE_ARTIFACT_BASE_URL = priorBase;
      }
    },
  );
});

describe('durable per-result user provenance', () => {
  const req = { user: { id: 'owner-a' } };
  const insight = (runId, messageId, conversationId = 'conversation-a') => ({
    cortexName: 'Mission evidence',
    insight: `Result ${runId}`,
    runInput: { version: 1, run_id: runId, instruction: 'Worker-private execution format.' },
    authority: {
      kind: 'durable_terminal_callback',
      runId,
      userSource: { messageId, conversationId },
    },
  });
  test('keeps distinct source constraints and full text paired with their exact results without another read', async () => {
    const getMessages = jest.spyOn(db, 'getMessages').mockResolvedValue([]);
    const longText = `Original task A. ${'Full source. '.repeat(500)} Return only its count.`;
    try {
      const insights = [insight('run-a', 'source-a'), insight('run-b', 'source-b')];
      const result = await resolveDurableMissionUserSources({
        req,
        conversationId: 'conversation-a',
        insightsData: { insights },
        messages: [
          {
            user: 'owner-a',
            conversationId: 'conversation-a',
            messageId: 'source-a',
            isCreatedByUser: true,
            text: longText,
          },
          {
            user: 'owner-a',
            conversationId: 'conversation-a',
            messageId: 'source-b',
            isCreatedByUser: true,
            text: 'Task B: explain the finding.',
          },
        ],
      });
      expect(getMessages).not.toHaveBeenCalled();
      expect(result.insights[0].authority.userSource).toEqual({
        messageId: 'source-a',
        conversationId: 'conversation-a',
        status: 'available',
        text: longText,
      });
      expect(result.insights[1].authority.userSource.text).toBe('Task B: explain the finding.');
      expect(result.insights.map((item) => item.runInput)).toEqual(
        insights.map((item) => item.runInput),
      );
      const prompt = formatFollowUpPrompt({
        insights: result.insights,
        userRequest: 'Current source B.',
        recentResponse: 'The tasks continue.',
      });
      expect(prompt).toContain(JSON.stringify(result.insights[0].authority));
      expect(prompt).toContain(JSON.stringify(result.insights[1].authority));
    } finally {
      getMessages.mockRestore();
    }
  });
  test('loads absent IDs in one scoped batch and rejects foreign, assistant and deleted sources', async () => {
    const getMessages = jest.spyOn(db, 'getMessages').mockResolvedValue([
      {
        user: 'owner-a',
        conversationId: 'conversation-a',
        messageId: 'valid',
        isCreatedByUser: true,
        text: 'Actual owner limit.',
      },
      {
        user: 'other-owner',
        conversationId: 'conversation-a',
        messageId: 'foreign-owner',
        isCreatedByUser: true,
        text: 'Foreign owner.',
      },
      {
        user: 'owner-a',
        conversationId: 'other-conversation',
        messageId: 'foreign-conversation',
        isCreatedByUser: true,
        text: 'Foreign conversation.',
      },
      {
        user: 'owner-a',
        conversationId: 'conversation-a',
        messageId: 'assistant',
        isCreatedByUser: false,
        sender: 'User',
        text: 'Not an owner message.',
      },
      {
        user: 'owner-a',
        conversationId: 'conversation-a',
        messageId: 'deleted',
        isCreatedByUser: true,
        deletedAt: new Date(),
        text: 'Deleted source.',
      },
      {
        user: 'owner-a',
        conversationId: 'conversation-a',
        messageId: 'tombstoned',
        isCreatedByUser: true,
        cleanupTombstone: { tombstonedAt: new Date() },
        text: 'Removed source.',
      },
    ]);
    try {
      const ids = [
        'valid',
        'foreign-owner',
        'foreign-conversation',
        'assistant',
        'deleted',
        'tombstoned',
        'missing',
      ];
      const result = await resolveDurableMissionUserSources({
        req,
        conversationId: 'conversation-a',
        messages: [],
        insightsData: { insights: ids.map((id) => insight(`run-${id}`, id)) },
      });
      expect(getMessages).toHaveBeenCalledTimes(1);
      expect(getMessages).toHaveBeenCalledWith(
        { user: 'owner-a', conversationId: { $in: ['conversation-a'] }, messageId: { $in: ids } },
        expect.any(String),
      );
      expect(result.insights[0].authority.userSource.text).toBe('Actual owner limit.');
      for (const item of result.insights.slice(1)) {
        expect(item.authority.userSource).toMatchObject({ status: 'unavailable' });
        expect(item.authority.userSource).not.toHaveProperty('text');
      }
    } finally {
      getMessages.mockRestore();
    }
  });
  test('keeps absent or failed source explicit without substituting the worker brief', async () => {
    const getMessages = jest
      .spyOn(db, 'getMessages')
      .mockRejectedValue(new Error('source_store_unavailable'));
    try {
      const result = await resolveDurableMissionUserSources({
        req,
        conversationId: 'conversation-a',
        messages: [],
        insightsData: { insights: [insight('run-a', null), insight('run-b', 'missing')] },
      });
      expect(
        result.insights.every((item) => item.authority.userSource.status === 'unavailable'),
      ).toBe(true);
      expect(result.insights.every((item) => !('text' in item.authority.userSource))).toBe(true);
      expect(result.insights[0].runInput.instruction).toBe('Worker-private execution format.');
    } finally {
      getMessages.mockRestore();
    }
  });
});

describe('canonical written details in Voice follow-up', () => {
  const input = {
    insights: [
      {
        cortexName: 'Verified result',
        insight: 'Example reference page: https://docs.example.test/guide',
      },
    ],
    userRequest: 'Give me the verified page title and address.',
    voiceMode: true,
    surface: 'voice',
    voiceProvider: 'xai',
  };
  test('uses the same canonical Voice contract instead of offering the requested details again', () => {
    const rules = require('../surfacePrompts').buildVoiceModeInstructions('xai');
    const rendered = formatFollowUpPrompt(input);
    expect(rendered).toContain(rules);
    expect(rendered).toContain(
      'Include requested URLs and email addresses in the written reply without asking again.',
    );
    expect(rendered).not.toContain('say you can send the details');
    expect(rendered).toContain('{NTA}');
  });
  test('retains the explicit follow-up override as its sole voice rule owner', () => {
    const previous = process.env.VIVENTIUM_VOICE_FOLLOWUP_RULES;
    try {
      process.env.VIVENTIUM_VOICE_FOLLOWUP_RULES = 'EXPLICIT FOLLOW-UP RULE';
      const rendered = formatFollowUpPrompt(input);
      expect(rendered).toContain('EXPLICIT FOLLOW-UP RULE');
      expect(rendered).not.toContain('Include requested URLs and email addresses');
    } finally {
      if (previous === undefined) delete process.env.VIVENTIUM_VOICE_FOLLOWUP_RULES;
      else process.env.VIVENTIUM_VOICE_FOLLOWUP_RULES = previous;
    }
  });
});
