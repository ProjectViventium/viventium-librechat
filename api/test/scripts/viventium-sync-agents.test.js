/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const {
  buildPushGuardError,
  compareBundles,
  compareBundlesByAgent,
  compareNamedFields,
  isPlaceholderOwnerEmail,
  LIBRECHAT_REVIEW_FIELDS,
  parseArgs,
  pickAgentFields,
  mergeBackgroundCorticesActivationFields,
  normalizeBundleForSourceOfTruth,
  buildUpdateData,
  resolveSafeActivationFields,
  shouldApplyRuntimeOverrides,
  shouldRepairRuntimeFieldsForPushMode,
  shouldPushStandaloneBackgroundAgent,
} = require('../../../scripts/viventium-sync-agents');

describe('viventium-sync-agents args', () => {
  test('parseArgs captures mongo uri override', () => {
    const args = parseArgs([
      'pull',
      '--mongo-uri=mongodb+srv://user:pass@cluster0.example.mongodb.net/LibreChat?appName=Cluster0',
      '--json',
    ]);
    expect(args.action).toBe('pull');
    expect(args.mongoUri).toBe(
      'mongodb+srv://user:pass@cluster0.example.mongodb.net/LibreChat?appName=Cluster0',
    );
    expect(args.format).toBe('json');
  });

  test('parseArgs does not bake a personal owner email fallback', () => {
    const args = parseArgs(['pull']);

    expect(args.email).toBe('');
  });

  test('parseArgs captures activation-config-only flags', () => {
    const args = parseArgs([
      'push',
      '--activation-config-only',
      '--activation-fields=prompt,model,provider,intent_scope',
    ]);

    expect(args.action).toBe('push');
    expect(args.activationConfigOnly).toBe(true);
    expect(args.activationFields).toEqual(['prompt', 'model', 'provider', 'intent_scope']);
  });

  test('parseArgs captures model-config-only flag', () => {
    const args = parseArgs([
      'push',
      '--model-config-only',
    ]);

    expect(args.action).toBe('push');
    expect(args.modelConfigOnly).toBe(true);
  });

  test('buildUpdateData keeps the dedicated voice parameter bag in model-config-only mode', () => {
    const update = buildUpdateData(
      {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-6',
        model_parameters: { model: 'claude-opus-4-6' },
        voice_llm_provider: 'anthropic',
        voice_llm_model: 'claude-haiku-4-5',
        voice_llm_model_parameters: { thinking: false },
      },
      { modelConfigOnly: true },
    );

    expect(update).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      model_parameters: { model: 'claude-opus-4-6' },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: { thinking: false },
    });
  });

  test('parseArgs captures help flag without inventing an action', () => {
    const args = parseArgs(['push', '--help']);

    expect(args.help).toBe(true);
    expect(args.action).toBe('push');
  });

  test('local push defaults to runtime-aware rewrites', () => {
    const args = parseArgs(['push']);

    expect(shouldApplyRuntimeOverrides(args)).toBe(true);
  });

  test('raw-source-of-truth disables runtime-aware default', () => {
    const args = parseArgs(['push', '--raw-source-of-truth']);

    expect(shouldApplyRuntimeOverrides(args)).toBe(false);
  });

  test('non-local push does not auto-apply runtime-aware rewrites', () => {
    const args = parseArgs(['push', '--env=cloud']);

    expect(shouldApplyRuntimeOverrides(args)).toBe(false);
  });

  test('runtime-aware can be requested explicitly', () => {
    const args = parseArgs(['push', '--env=cloud', '--runtime-aware']);

    expect(shouldApplyRuntimeOverrides(args)).toBe(true);
  });

  test('safe prompt pushes do not run runtime repair', () => {
    expect(
      shouldRepairRuntimeFieldsForPushMode({
        promptsOnly: true,
        runtimeAware: true,
      }),
    ).toBe(false);
  });

  test('safe activation pushes do not run runtime repair', () => {
    expect(
      shouldRepairRuntimeFieldsForPushMode({
        activationConfigOnly: true,
        runtimeAware: true,
      }),
    ).toBe(false);
  });

  test('full runtime-aware pushes still run runtime repair', () => {
    expect(
      shouldRepairRuntimeFieldsForPushMode({
        runtimeAware: true,
      }),
    ).toBe(true);
  });

  test('activation-config-only skips standalone background agent document pushes', () => {
    expect(
      shouldPushStandaloneBackgroundAgent({
        agentId: 'agent-a',
        selectedAgentIds: ['agent-a'],
        activationConfigOnly: true,
      }),
    ).toBe(false);
  });

  test('non-activation safe modes still honor selected background agent ids', () => {
    expect(
      shouldPushStandaloneBackgroundAgent({
        agentId: 'agent-a',
        selectedAgentIds: ['agent-a'],
      }),
    ).toBe(true);
    expect(
      shouldPushStandaloneBackgroundAgent({
        agentId: 'agent-b',
        selectedAgentIds: ['agent-a'],
      }),
    ).toBe(false);
  });

  test('parseArgs captures surgical agent id filters', () => {
    const args = parseArgs([
      'push',
      '--model-config-only',
      '--agent-ids=agent-a,agent-b,agent-a',
    ]);

    expect(args.selectedAgentIds).toEqual(['agent-a', 'agent-b']);
  });

  test('parseArgs captures compare-reviewed push acknowledgement', () => {
    const args = parseArgs(['push', '--compare-reviewed']);

    expect(args.compareReviewed).toBe(true);
  });

  test('parseArgs rejects multiple safe push modes together', () => {
    expect(() =>
      parseArgs([
        'push',
        '--prompts-only',
        '--model-config-only',
      ]),
    ).toThrow('Choose only one safe push mode');
  });

  test('resolveSafeActivationFields uses safe defaults for activation-config-only mode', () => {
    expect(resolveSafeActivationFields({ activationConfigOnly: true })).toEqual([
      'enabled',
      'prompt',
      'confidence_threshold',
      'model',
      'provider',
      'fallbacks',
      'cooldown_ms',
      'max_history',
      'intent_scope',
    ]);
  });

  test('resolveSafeActivationFields includes fallbacks for prompts-only mode', () => {
    expect(resolveSafeActivationFields({ promptsOnly: true })).toEqual([
      'enabled',
      'prompt',
      'confidence_threshold',
      'fallbacks',
    ]);
  });

  test('mergeBackgroundCorticesActivationFields updates only selected activation fields', () => {
    const existing = [
      {
        agent_id: 'agent-a',
        activation: {
          enabled: true,
          prompt: 'old prompt',
          confidence_threshold: 0.7,
          model: 'old-model',
          provider: 'old-provider',
          fallbacks: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }],
          cooldown_ms: 30000,
          max_history: 6,
        },
      },
    ];
    const incoming = [
      {
        agent_id: 'agent-a',
        activation: {
          prompt: 'new prompt',
          model: 'new-model',
          provider: 'new-provider',
          fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
          intent_scope: 'productivity_google_workspace',
        },
      },
    ];

    expect(
      mergeBackgroundCorticesActivationFields(existing, incoming, [
        'prompt',
        'model',
        'provider',
        'fallbacks',
        'intent_scope',
      ]),
    ).toEqual([
      {
        agent_id: 'agent-a',
        activation: {
          enabled: true,
          prompt: 'new prompt',
          confidence_threshold: 0.7,
          model: 'new-model',
          provider: 'new-provider',
          fallbacks: [{ provider: 'openai', model: 'gpt-5.4' }],
          cooldown_ms: 30000,
          max_history: 6,
          intent_scope: 'productivity_google_workspace',
        },
      },
    ]);
  });

  test('mergeBackgroundCorticesActivationFields respects selected agent filters', () => {
    const existing = [
      {
        agent_id: 'agent-a',
        activation: {
          prompt: 'old prompt a',
          intent_scope: 'productivity_ms365',
        },
      },
      {
        agent_id: 'agent-b',
        activation: {
          prompt: 'old prompt b',
          intent_scope: 'productivity_google_workspace',
        },
      },
    ];
    const incoming = [
      {
        agent_id: 'agent-a',
        activation: {
          prompt: 'new prompt a',
        },
      },
      {
        agent_id: 'agent-b',
        activation: {
          prompt: 'new prompt b',
        },
      },
    ];

    expect(
      mergeBackgroundCorticesActivationFields(existing, incoming, ['prompt'], ['agent-b']),
    ).toEqual([
      {
        agent_id: 'agent-a',
        activation: {
          prompt: 'old prompt a',
          intent_scope: 'productivity_ms365',
        },
      },
      {
        agent_id: 'agent-b',
        activation: {
          prompt: 'new prompt b',
          intent_scope: 'productivity_google_workspace',
        },
      },
    ]);
  });

  test('compareBundlesByAgent includes tool_kwargs and activation field diffs in reviewed output', () => {
    const diff = compareBundlesByAgent({
      leftBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          background_cortices: [
            {
              agent_id: 'agent-ms365',
              activation: {
                prompt: 'old prompt',
                confidence_threshold: 0.7,
              },
            },
          ],
        },
        backgroundAgents: [
          {
            id: 'agent-support',
            name: 'Support',
            tool_kwargs: [{ name: 'web_search', throttle: 1 }],
          },
        ],
      },
      rightBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          background_cortices: [
            {
              agent_id: 'agent-ms365',
              activation: {
                prompt: 'new prompt',
                confidence_threshold: 0.7,
              },
            },
          ],
        },
        backgroundAgents: [
          {
            id: 'agent-support',
            name: 'Support',
            tool_kwargs: [{ name: 'web_search', throttle: 2 }],
          },
        ],
      },
    });

    expect(diff.diffCount).toBe(2);
    expect(diff.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-support',
          changedFields: ['tool_kwargs'],
        }),
        expect.objectContaining({
          id: 'main',
          changedFields: ['background_cortices'],
          details: expect.objectContaining({
            background_cortices: expect.objectContaining({
              changedAgentIds: ['agent-ms365'],
              changedAgents: [
                expect.objectContaining({
                  agentId: 'agent-ms365',
                  activationChangedFields: ['prompt'],
                }),
              ],
            }),
          }),
        }),
      ]),
    );
  });

  test('compareBundlesByAgent ignores background cortex metadata noise when activation matches', () => {
    const diff = compareBundlesByAgent({
      leftBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          background_cortices: [
            {
              agent_id: 'agent-ms365',
              activation: {
                prompt: 'same prompt',
                confidence_threshold: 0.7,
              },
            },
          ],
        },
        backgroundAgents: [],
      },
      rightBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          background_cortices: [
            {
              agent_id: 'agent-ms365',
              activation: {
                prompt: 'same prompt',
                confidence_threshold: 0.7,
              },
              status: 'runtime-noise',
            },
          ],
        },
        backgroundAgents: [],
      },
    });

    expect(diff.diffCount).toBe(1);
    expect(diff.diffs).toEqual([
      expect.objectContaining({
        id: 'main',
        changedFields: ['background_cortices'],
        details: expect.objectContaining({
          background_cortices: expect.objectContaining({
            changedAgentIds: ['agent-ms365'],
            changedAgents: [
              expect.objectContaining({
                agentId: 'agent-ms365',
                metadataChangedFields: ['status'],
              }),
            ],
          }),
        }),
      }),
    ]);
  });

  test('compareBundlesByAgent surfaces dedicated voice parameter drift', () => {
    const diff = compareBundlesByAgent({
      leftBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          voice_llm_provider: 'anthropic',
          voice_llm_model: 'claude-haiku-4-5',
          voice_llm_model_parameters: {
            thinking: false,
          },
        },
        backgroundAgents: [],
      },
      rightBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          voice_llm_provider: 'anthropic',
          voice_llm_model: 'claude-haiku-4-5',
          voice_llm_model_parameters: {
            thinking: true,
          },
        },
        backgroundAgents: [],
      },
    });

    expect(diff.diffCount).toBe(1);
    expect(diff.diffs).toEqual([
      expect.objectContaining({
        id: 'main',
        changedFields: ['voice_llm_model_parameters'],
      }),
    ]);
  });

  test('compareBundlesByAgent ignores dedicated voice parameter key-order noise', () => {
    const diff = compareBundlesByAgent({
      leftBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          voice_llm_model_parameters: {
            thinking: false,
            model: 'claude-haiku-4-5',
          },
        },
        backgroundAgents: [],
      },
      rightBundle: {
        mainAgent: {
          id: 'main',
          name: 'Viventium',
          voice_llm_model_parameters: {
            model: 'claude-haiku-4-5',
            thinking: false,
          },
        },
        backgroundAgents: [],
      },
    });

    expect(diff.diffCount).toBe(0);
    expect(diff.diffs).toEqual([]);
  });

  test('pickAgentFields keeps the dedicated voice parameter bag in pulled bundles', () => {
    expect(
      pickAgentFields({
        id: 'agent_viventium_main_95aeb3',
        voice_llm_model: 'claude-haiku-4-5',
        voice_llm_provider: 'anthropic',
        voice_llm_model_parameters: { thinking: false },
      }),
    ).toEqual({
      id: 'agent_viventium_main_95aeb3',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_provider: 'anthropic',
      voice_llm_model_parameters: { thinking: false },
    });
  });

  test('compareNamedFields surfaces adjacent webSearch drift in librechat config review', () => {
    const diff = compareNamedFields({
      leftValue: {
        interface: {
          webSearch: true,
          fileSearch: true,
        },
        webSearch: {
          searchProvider: 'searxng',
        },
      },
      rightValue: {
        interface: {
          webSearch: false,
          fileSearch: true,
        },
      },
      fields: LIBRECHAT_REVIEW_FIELDS,
    });

    expect(diff.diffCount).toBeGreaterThanOrEqual(2);
    expect(diff.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'interface.webSearch' }),
        expect.objectContaining({ field: 'webSearch' }),
      ]),
    );
  });

  test('buildPushGuardError blocks non-dry-run pushes until compare drift is reviewed', () => {
    const error = buildPushGuardError({
      compareResult: {
        env: 'local',
        liveVsSource: { diffCount: 1 },
        adjacentLibrechat: { liveVsSource: { diffCount: 1 } },
      },
      dryRun: false,
      compareReviewed: false,
    });

    expect(error).toContain('Push blocked until drift is reviewed');
    expect(error).toContain('--compare-reviewed');
    expect(error).toContain('compare --env=local');
  });

  test('compareBundles ignores --json-style input parsing for yaml source-of-truth files', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-sync-compare-'));
    const livePath = path.join(tempDir, 'live.viventium-agents.yaml');
    const sourcePath = path.join(tempDir, 'source.viventium-agents.yaml');
    const bundleYaml = `
meta:
  user:
    email: user@viventium.local
    id: placeholder-owner
mainAgent:
  id: agent-main
  background_cortices: []
backgroundAgents: []
`;
    fs.writeFileSync(livePath, bundleYaml);
    fs.writeFileSync(sourcePath, bundleYaml);

    const result = await compareBundles({
      env: 'local',
      livePath,
      sourcePath,
      format: 'json',
    });

    expect(result.liveVsSource.diffCount).toBe(0);
  });

  test('normalizeBundleForSourceOfTruth strips owner-specific user metadata', () => {
    const normalized = normalizeBundleForSourceOfTruth({
      meta: {
        exportedAt: '2026-03-23T00:00:00.000Z',
        user: {
          email: 'real-owner@example.com',
          id: 'real-user-id',
        },
      },
    });

    expect(normalized.meta.exportedAt).toBeNull();
    expect(normalized.meta.user).toEqual({
      email: 'user@viventium.local',
      id: 'placeholder-owner',
    });
  });

  test('isPlaceholderOwnerEmail identifies sanitized non-runtime owner markers', () => {
    expect(isPlaceholderOwnerEmail('')).toBe(true);
    expect(isPlaceholderOwnerEmail('user@viventium.local')).toBe(true);
    expect(isPlaceholderOwnerEmail('viventium-system@example.com')).toBe(true);
    expect(isPlaceholderOwnerEmail('real-owner@example.com')).toBe(false);
  });
});
