/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const {
  isPlaceholderOwnerEmail,
  parseArgs,
  mergeBackgroundCorticesActivationFields,
  normalizeBundleForSourceOfTruth,
  resolveSafeActivationFields,
  shouldApplyRuntimeOverrides,
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

  test('parseArgs captures surgical agent id filters', () => {
    const args = parseArgs([
      'push',
      '--model-config-only',
      '--agent-ids=agent-a,agent-b,agent-a',
    ]);

    expect(args.selectedAgentIds).toEqual(['agent-a', 'agent-b']);
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
      'cooldown_ms',
      'max_history',
      'intent_scope',
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
          intent_scope: 'productivity_google_workspace',
        },
      },
    ];

    expect(
      mergeBackgroundCorticesActivationFields(existing, incoming, [
        'prompt',
        'model',
        'provider',
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
