/* === VIVENTIUM START ===
 * Purpose: Guard the seed/runtime-aware model contract for built-in agents.
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');

jest.mock('../../../api/server/services/PermissionService', () => ({
  grantPermission: jest.fn(),
}));

const {
  normalizeBundleForRuntimeWithOwner,
  normalizePublicAccessRole,
  buildSeedAgentUpdatePlan,
  buildManagedBaseline,
  buildManagedBaselineMigrationArtifact,
  buildManagedMigrationState,
  buildManagedValueFingerprint,
  loadManagedBaseline,
  loadManagedBaselineMigration,
  loadManagedMigrationState,
  pickAgentFields,
  preserveExistingEditableFields,
  reconcileManagedAgentFields,
  resolveSeedOwner,
  resolvePublicAccessRoleIds,
  selectCanonicalOwnerId,
  assertExistingAgentOwnersCompatible,
  preflightExistingAgentOwners,
  consumeManagedMigrationState,
  writeManagedBaseline,
} = require('../../../scripts/viventium-seed-agents');
const { AccessRoleIds } = require('librechat-data-provider');
const { Agent, User, AclEntry } = require('../../../api/db/models');
const permissionService = require('../../../api/server/services/PermissionService');
const {
  buildCanonicalPersistedAgentFields,
} = require('../../../scripts/viventium-agent-runtime-models');
const {
  auditHermeticArtifact,
  stableSerialize: stableSerializeHistory,
} = require('../../../scripts/viventium-generate-managed-agent-migrations');

describe('viventium-seed-agents', () => {
  test('normalizes built-in models from runtime env and injects owner metadata', () => {
    const bundle = {
      meta: {
        user: {
          email: 'old-owner@example.com',
          id: 'user-123',
        },
      },
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'openAI',
        model: 'gpt-5.4',
        voice_llm_provider: 'openAI',
        voice_llm_model: 'gpt-5.4',
        background_cortices: [
          {
            agent_id: 'agent_viventium_online_tool_use_95aeb3',
            activation: {
              provider: 'groq',
              model: 'qwen/qwen3.6-27b',
            },
          },
        ],
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_online_tool_use_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.4',
          model_parameters: {
            model: 'gpt-5.4',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntimeWithOwner(bundle, {
      env: {
        VIVENTIUM_AGENT_SEED_OWNER_EMAIL: 'seed-owner@example.com',
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-8',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_MODEL: 'claude-opus-4-8',
        OTUC_ACTIVATION_PROVIDER: 'groq',
        OTUC_ACTIVATION_LLM: 'qwen/qwen3.6-27b',
      },
    });

    expect(normalized.meta.user).toEqual({ email: 'seed-owner@example.com' });
    expect(normalized.mainAgent.provider).toBe('anthropic');
    expect(normalized.mainAgent.model).toBe('claude-opus-4-8');
    expect(normalized.mainAgent.voice_llm_provider).toBe('openAI');
    expect(normalized.mainAgent.voice_llm_model).toBe('gpt-5.4');
    expect(normalized.backgroundAgents[0].provider).toBe('anthropic');
    expect(normalized.backgroundAgents[0].model).toBe('claude-opus-4-8');
    expect(normalized.backgroundAgents[0].model_parameters.model).toBe('claude-opus-4-8');
  });

  test('resolves promptRef instructions before seed-style persistence', () => {
    const normalized = normalizeBundleForRuntimeWithOwner(
      {
        meta: {
          user: {
            email: 'old-owner@example.com',
            id: 'user-123',
          },
        },
        mainAgent: {
          id: 'agent_viventium_main_95aeb3',
          instructions: {
            promptRef: 'main.no_response',
          },
        },
        backgroundAgents: [
          {
            id: 'agent_viventium_red_team_95aeb3',
            instructions: {
              promptRef: 'cortex.red_team.execution',
            },
          },
        ],
      },
      {
        env: {
          VIVENTIUM_AGENT_SEED_OWNER_EMAIL: 'seed-owner@example.com',
        },
      },
    );

    expect(typeof normalized.mainAgent.instructions).toBe('string');
    expect(normalized.mainAgent.instructions).toContain('NO RESPONSE TAG');
    expect(typeof normalized.backgroundAgents[0].instructions).toBe('string');
    expect(normalized.backgroundAgents[0].instructions).toContain('You are the Red Team');
  });

  test('preserves live user-managed agent fields from existing agents during reseed', () => {
    const existing = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      name: 'My Viv',
      description: 'custom description',
      instructions: 'keep my live instructions',
      tools: ['sys__server__sys_mcp_sequential-thinking'],
      model_parameters: {
        model: 'claude-sonnet-4-5',
      },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        thinking: false,
      },
      conversation_starters: ['keep this starter'],
      category: 'Custom',
      background_cortices: [
        {
          agent_id: 'agent-a',
          activation: {
            prompt: 'keep me',
            intent_scope: 'productivity_google_workspace',
          },
        },
      ],
    };
    const incoming = {
      provider: 'openAI',
      model: 'gpt-5.4',
      name: 'Bundle Viv',
      description: 'bundle description',
      instructions: 'replace me',
      tools: ['sys__server__sys_mcp_sequential-thinking', 'web_search'],
      model_parameters: {
        model: 'gpt-5.4',
      },
      voice_llm_provider: 'openAI',
      voice_llm_model: 'gpt-4o-mini',
      voice_llm_model_parameters: {
        model: 'gpt-4o-mini',
      },
      conversation_starters: ['bundle starter'],
      category: 'General',
      background_cortices: [
        {
          agent_id: 'agent-a',
          activation: {
            prompt: 'replace me',
            intent_scope: 'productivity_ms365',
          },
        },
      ],
    };

    expect(preserveExistingEditableFields(existing, incoming)).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      name: 'My Viv',
      description: 'custom description',
      instructions: 'keep my live instructions',
      tools: ['sys__server__sys_mcp_sequential-thinking'],
      model_parameters: {
        model: 'claude-sonnet-4-5',
      },
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        model: 'claude-haiku-4-5',
        thinking: false,
      },
      conversation_starters: ['keep this starter'],
      category: 'Custom',
      background_cortices: [
        {
          agent_id: 'agent-a',
          activation: {
            prompt: 'keep me',
            intent_scope: 'productivity_google_workspace',
          },
        },
      ],
    });
  });

  test('repairs runtime-owned fields from the reconciled assignment without reverting protected drift', () => {
    const existing = {
      provider: 'openAI',
      model: 'gpt-5.2-chat',
      name: 'My Viv',
      instructions: 'keep my live instructions',
      model_parameters: {
        model: 'gpt-5.2-chat',
        reasoning_effort: 'high',
      },
    };
    const incoming = {
      id: 'agent_viventium_main_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      name: 'Bundle Viv',
      instructions: 'replace me',
      model_parameters: {
        model: 'claude-opus-4-7',
        thinking: true,
        effort: 'high',
      },
    };

    const plan = buildSeedAgentUpdatePlan(existing, incoming);

    expect(plan.updateData).toMatchObject({
      provider: 'openAI',
      model: 'gpt-5.2-chat',
      name: 'My Viv',
      instructions: 'keep my live instructions',
      model_parameters: {
        model: 'gpt-5.2-chat',
      },
    });
    expect(plan.runtimeRepairAgentData).toMatchObject({
      id: 'agent_viventium_main_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.2-chat',
      name: 'My Viv',
      instructions: 'keep my live instructions',
      model_parameters: {
        model: 'gpt-5.2-chat',
      },
    });
    expect(plan.runtimeRepairAgentData).toEqual({
      id: 'agent_viventium_main_95aeb3',
      provider: 'openAI',
      model: 'gpt-5.2-chat',
      name: 'My Viv',
      instructions: 'keep my live instructions',
      model_parameters: {
        model: 'gpt-5.2-chat',
        reasoning_effort: 'high',
      },
    });
  });

  test('preserves existing tools during reseed instead of restoring scaffold tools', () => {
    const existing = {
      tools: ['sys__server__sys_mcp_sequential-thinking'],
      background_cortices: [],
    };
    const incoming = {
      tools: ['sys__server__sys_mcp_sequential-thinking', 'web_search'],
      background_cortices: [],
    };

    expect(preserveExistingEditableFields(existing, incoming)).toEqual({
      tools: ['sys__server__sys_mcp_sequential-thinking'],
      background_cortices: [],
    });
  });

  test('applies a reviewed shipped field update only when live still matches its prior baseline', () => {
    const existing = {
      id: 'agent_viventium_main_95aeb3',
      instructions: 'shipped v1',
      conversation_starters: ['user changed this'],
      background_cortices: [{ agent_id: 'agent-a', activation: { prompt: 'shipped v1' } }],
    };
    const incoming = {
      id: 'agent_viventium_main_95aeb3',
      instructions: 'shipped v2',
      conversation_starters: ['shipped v2'],
      background_cortices: [{ agent_id: 'agent-a', activation: { prompt: 'shipped v2' } }],
    };
    const prior = {
      instructions: 'shipped v1',
      conversation_starters: ['shipped v1'],
      background_cortices: [{ agent_id: 'agent-a', activation: { prompt: 'shipped v1' } }],
    };

    const result = reconcileManagedAgentFields(existing, incoming, prior);

    expect(result.agentData.instructions).toBe('shipped v2');
    expect(result.agentData.background_cortices).toEqual(incoming.background_cortices);
    expect(result.agentData.conversation_starters).toEqual(['user changed this']);
    expect(result.drift).toEqual(['conversation_starters']);
  });

  test('merges cortex updates by managed field path while preserving a different user edit', () => {
    const prior = [
      { agent_id: 'agent-a', activation: { prompt: 'a-v1', confidence: 0.5 } },
      { agent_id: 'agent-b', activation: { prompt: 'b-v1', confidence: 0.5 } },
    ];
    const live = [
      { agent_id: 'agent-a', activation: { prompt: 'my a prompt', confidence: 0.5 } },
      { agent_id: 'agent-b', activation: { prompt: 'b-v1', confidence: 0.5 } },
    ];
    const incoming = [
      { agent_id: 'agent-a', activation: { prompt: 'a-v2', confidence: 0.8 } },
      { agent_id: 'agent-b', activation: { prompt: 'b-v2', confidence: 0.8 } },
    ];

    const result = reconcileManagedAgentFields(
      { background_cortices: live },
      { background_cortices: incoming },
      { background_cortices: prior },
    );

    expect(result.agentData.background_cortices).toEqual([
      { agent_id: 'agent-a', activation: { prompt: 'my a prompt', confidence: 0.8 } },
      { agent_id: 'agent-b', activation: { prompt: 'b-v2', confidence: 0.8 } },
    ]);
    expect(result.drift).toEqual(['background_cortices.agent-a.activation.prompt']);
  });

  test('treats a live value already equal to the incoming bundle as an interrupted apply, not drift', () => {
    const result = reconcileManagedAgentFields(
      { instructions: 'shipped v2' },
      { instructions: 'shipped v2' },
      { instructions: 'shipped v1' },
    );

    expect(result.agentData.instructions).toBe('shipped v2');
    expect(result.drift).toEqual([]);
  });

  test('preserves legacy unknown drift but establishes a deterministic non-personal baseline', () => {
    const incoming = {
      id: 'agent_viventium_main_95aeb3',
      instructions: 'new shipped instructions',
      background_cortices: [{ agent_id: 'agent-a' }],
    };
    const result = reconcileManagedAgentFields(
      { ...incoming, instructions: 'existing unproven instructions' },
      incoming,
      null,
    );
    const first = buildManagedBaseline({ mainAgent: incoming, backgroundAgents: [] });
    const second = buildManagedBaseline({ mainAgent: incoming, backgroundAgents: [] });

    expect(result.agentData.instructions).toBe('existing unproven instructions');
    expect(result.drift).toEqual(['instructions']);
    expect(first.bundle_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain('example.com');
  });

  test('uses an exact shipped predecessor baseline on first upgrade while preserving real user edits', () => {
    const prior = {
      id: 'agent_viventium_main_95aeb3',
      instructions: 'shipped v1',
      tools: ['tool-v1'],
      voice_llm_model: 'voice-v1',
    };
    const incoming = {
      id: 'agent_viventium_main_95aeb3',
      instructions: 'shipped v2',
      tools: ['tool-v2'],
      voice_llm_model: 'voice-v2',
    };
    const predecessor = buildManagedBaseline({ mainAgent: prior, backgroundAgents: [] });
    const plan = buildSeedAgentUpdatePlan(
      {
        ...prior,
        tools: ['my-tool'],
        voice_llm_model: 'my-voice',
      },
      incoming,
      { previousFields: predecessor.agents[prior.id].fields },
    );

    expect(plan.updateData).toEqual({
      instructions: 'shipped v2',
      tools: ['my-tool'],
      voice_llm_model: 'my-voice',
    });
    expect(plan.runtimeRepairAgentData).toEqual({
      id: prior.id,
      instructions: 'shipped v2',
      tools: ['my-tool'],
      voice_llm_model: 'my-voice',
    });
    expect(plan.managedDrift).toEqual(['tools', 'voice_llm_model']);
  });

  test('preserves background-agent model parameter drift through canonical runtime repair', () => {
    const id = 'agent_viventium_online_tool_use_95aeb3';
    const prior = {
      id,
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      model_parameters: { model: 'claude-opus-4-7', thinking: true, effort: 'high' },
    };
    const incoming = {
      id,
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      model_parameters: { model: 'claude-opus-4-8', thinking: false, effort: 'high' },
    };
    const predecessor = buildManagedBaseline({ mainAgent: prior, backgroundAgents: [] });
    const existing = {
      ...prior,
      model_parameters: {
        model: 'claude-opus-4-7',
        thinking: true,
        effort: 'low',
      },
    };

    const plan = buildSeedAgentUpdatePlan(existing, incoming, {
      previousFields: predecessor.agents[id].fields,
    });
    const repair = buildCanonicalPersistedAgentFields(
      plan.runtimeRepairAgentData,
      { id, ...plan.updateData },
      { env: {} },
    );

    expect(plan.managedDrift).toEqual(['model_parameters.effort']);
    expect(plan.runtimeRepairAgentData.model_parameters).toEqual({
      model: 'claude-opus-4-8',
      thinking: false,
      effort: 'low',
    });
    expect(repair.model_parameters).toEqual({
      model: 'claude-opus-4-8',
      thinking: false,
      effort: 'low',
    });
  });

  test('uses a shipped value fingerprint without embedding the prior prompt in the migration artifact', () => {
    const result = reconcileManagedAgentFields(
      { instructions: 'shipped v1', tools: ['my-tool'] },
      { instructions: 'shipped v2', tools: ['tool-v2'] },
      {
        instructions: buildManagedValueFingerprint('shipped v1'),
        tools: buildManagedValueFingerprint(['tool-v1']),
      },
    );

    expect(result.agentData).toEqual({ instructions: 'shipped v2', tools: ['my-tool'] });
    expect(result.drift).toEqual(['tools']);
  });

  test('rejects a locally managed baseline whose content no longer matches its recorded hash', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-managed-baseline-'));
    const baselinePath = path.join(directory, 'agent-managed-baseline.json');
    const baseline = buildManagedBaseline({
      mainAgent: { id: 'agent-test', instructions: 'shipped v1' },
      backgroundAgents: [],
    });
    baseline.agents['agent-test'].fields.instructions = 'tampered';
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`, { mode: 0o600 });

    expect(() => loadManagedBaseline(baselinePath)).toThrow(
      'Managed baseline content hash does not match.',
    );
  });

  test('persists and prefers the canonical owner across later multi-admin starts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-managed-owner-'));
    const baselinePath = path.join(directory, 'agent-managed-baseline.json');
    const ownerId = '0123456789abcdef01234567';
    const baseline = buildManagedBaseline({
      mainAgent: { id: 'agent-test', instructions: 'shipped v1' },
      backgroundAgents: [],
    });

    writeManagedBaseline(baselinePath, baseline, [], ownerId);
    const loaded = loadManagedBaseline(baselinePath);

    expect(loaded.owner_id).toBe(ownerId);
    expect(loaded.bundle_sha256).toBe(baseline.bundle_sha256);
    expect(
      selectCanonicalOwnerId({
        storedOwnerId: loaded.owner_id,
        existingAgentOwnerId: '111111111111111111111111',
      }),
    ).toBe(ownerId);
  });

  test('uses the built-in main agent owner before ambiguous administrator inference', () => {
    const existingAgentOwnerId = '111111111111111111111111';

    expect(selectCanonicalOwnerId({ existingAgentOwnerId })).toBe(existingAgentOwnerId);
    expect(
      selectCanonicalOwnerId({
        ownerId: '222222222222222222222222',
        storedOwnerId: '333333333333333333333333',
        existingAgentOwnerId,
      }),
    ).toBe('222222222222222222222222');
    expect(() => selectCanonicalOwnerId({ storedOwnerId: 'not-an-object-id' })).toThrow(
      'Canonical owner user id is invalid.',
    );
  });

  test('rejects an explicit owner that conflicts with an existing non-placeholder author', () => {
    const explicitOwnerId = '0123456789abcdef01234567';

    expect(() =>
      assertExistingAgentOwnersCompatible({
        existingAgents: [
          {
            id: 'agent_viventium_main_95aeb3',
            author: '111111111111111111111111',
          },
        ],
        ownerId: explicitOwnerId,
        placeholderOwnerId: '222222222222222222222222',
      }),
    ).toThrow('existing non-placeholder author');
  });

  test('allows exact-owner and placeholder-authored agents through owner preflight', () => {
    const ownerId = '0123456789abcdef01234567';
    const placeholderOwnerId = '222222222222222222222222';

    expect(() =>
      assertExistingAgentOwnersCompatible({
        existingAgents: [
          { id: 'agent-main', author: ownerId },
          { id: 'agent-background', author: placeholderOwnerId },
        ],
        ownerId,
        placeholderOwnerId,
      }),
    ).not.toThrow();
  });

  test('performs zero agent or ACL writes before rejecting an owner-author conflict', async () => {
    const ownerId = '0123456789abcdef01234567';
    const find = jest.spyOn(Agent, 'find').mockReturnValue({
      select: () => ({
        lean: async () => [
          {
            id: 'agent_viventium_main_95aeb3',
            author: '111111111111111111111111',
          },
        ],
      }),
    });
    const updateAgent = jest.spyOn(Agent, 'updateOne').mockResolvedValue({ acknowledged: true });
    const deleteAcl = jest.spyOn(AclEntry, 'deleteMany').mockResolvedValue({ acknowledged: true });
    permissionService.grantPermission.mockClear();
    try {
      await expect(
        preflightExistingAgentOwners({
          agentIds: ['agent_viventium_main_95aeb3'],
          ownerId,
          placeholderOwnerId: '222222222222222222222222',
        }),
      ).rejects.toThrow('existing non-placeholder author');
      expect(updateAgent).not.toHaveBeenCalled();
      expect(deleteAcl).not.toHaveBeenCalled();
      expect(permissionService.grantPermission).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
      updateAgent.mockRestore();
      deleteAcl.mockRestore();
    }
  });

  test('resolves a persisted owner without scanning an ambiguous administrator set', async () => {
    const ownerId = '0123456789abcdef01234567';
    const owner = { _id: ownerId, email: 'owner@example.test', role: 'ADMIN' };
    const findById = jest.spyOn(User, 'findById').mockReturnValue({ lean: async () => owner });
    const find = jest.spyOn(User, 'find').mockImplementation(() => {
      throw new Error('administrator inference must not run for a persisted owner');
    });

    await expect(
      resolveSeedOwner({
        storedOwnerId: ownerId,
        requestedEmail: 'viventium-system@example.com',
      }),
    ).resolves.toEqual(owner);
    expect(findById).toHaveBeenCalledWith(ownerId);
    expect(find).not.toHaveBeenCalled();

    findById.mockRestore();
    find.mockRestore();
  });

  test('fails closed with recovery guidance when the persisted owner no longer exists', async () => {
    const ownerId = '0123456789abcdef01234567';
    const findById = jest.spyOn(User, 'findById').mockReturnValue({ lean: async () => null });
    const find = jest.spyOn(User, 'find').mockImplementation(() => {
      throw new Error('invalid protected owner must not fall back to administrator inference');
    });
    try {
      await expect(
        resolveSeedOwner({
          storedOwnerId: ownerId,
          requestedEmail: 'viventium-system@example.com',
        }),
      ).rejects.toThrow('latest Viventium state backup');
      expect(find).not.toHaveBeenCalled();
    } finally {
      findById.mockRestore();
      find.mockRestore();
    }
  });

  test('fails closed without administrator inference when the persisted owner is demoted', async () => {
    const ownerId = '0123456789abcdef01234567';
    const demotedOwner = { _id: ownerId, email: 'owner@example.test', role: 'USER' };
    const findById = jest
      .spyOn(User, 'findById')
      .mockReturnValue({ lean: async () => demotedOwner });
    const find = jest.spyOn(User, 'find').mockImplementation(() => {
      throw new Error('demoted protected owner must not fall back to administrator inference');
    });
    try {
      await expect(
        resolveSeedOwner({
          storedOwnerId: ownerId,
          requestedEmail: 'viventium-system@example.com',
        }),
      ).rejects.toThrow('not an administrator');
      expect(find).not.toHaveBeenCalled();
    } finally {
      findById.mockRestore();
      find.mockRestore();
    }
  });

  test('loads only the hash-verified migration artifact for the explicitly identified predecessor', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-managed-migration-'));
    const migrationPath = path.join(directory, 'managed-agent-migrations.json');
    const predecessor = buildManagedBaseline({
      mainAgent: { id: 'agent-test', instructions: 'shipped v1' },
      backgroundAgents: [],
    });
    const migration = buildManagedBaselineMigrationArtifact({
      migrationId: 'synthetic-v1-to-v2',
      predecessorSourceRefs: ['a'.repeat(40)],
      predecessorSourceBundleSha256: 'b'.repeat(64),
      baseline: predecessor,
    });
    fs.writeFileSync(migrationPath, `${JSON.stringify(migration)}\n`, { mode: 0o600 });

    expect(
      loadManagedBaselineMigration(migrationPath, {
        predecessorSourceRef: 'a'.repeat(40),
      }),
    ).toEqual(predecessor);
    expect(() =>
      loadManagedBaselineMigration(migrationPath, {
        predecessorSourceRef: 'c'.repeat(40),
      }),
    ).toThrow('No managed baseline migration matches predecessor');

    const tampered = JSON.parse(fs.readFileSync(migrationPath, 'utf8'));
    tampered.migrations[0].baseline.agents['agent-test'].fields.instructions = 'tampered';
    fs.writeFileSync(migrationPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    expect(() =>
      loadManagedBaselineMigration(migrationPath, {
        predecessorSourceRef: 'a'.repeat(40),
      }),
    ).toThrow('Managed baseline migration content hash does not match.');
  });

  test('loads and one-time consumes only a protected migration state bound to source artifacts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-managed-state-'));
    const statePath = path.join(directory, 'agent-managed-migration-pending.json');
    const bundlePath = path.join(directory, 'agents.yaml');
    const migrationPath = path.join(directory, 'managed-agent-migrations.json');
    const bundleContents = 'mainAgent:\n  id: agent-test\n  instructions: shipped-v2\n';
    fs.writeFileSync(bundlePath, bundleContents, { mode: 0o600 });
    const predecessor = buildManagedBaseline({
      mainAgent: { id: 'agent-test', instructions: 'shipped-v1' },
      backgroundAgents: [],
    });
    const migration = buildManagedBaselineMigrationArtifact({
      migrationId: 'synthetic-v1-to-v2',
      predecessorSourceRefs: ['a'.repeat(40)],
      predecessorSourceBundleSha256: 'b'.repeat(64),
      baseline: predecessor,
    });
    fs.writeFileSync(migrationPath, `${JSON.stringify(migration)}\n`, { mode: 0o600 });
    const state = buildManagedMigrationState({
      predecessorSourceRef: 'a'.repeat(40),
      successorSourceRef: 'c'.repeat(40),
      successorBundleSha256: crypto.createHash('sha256').update(bundleContents).digest('hex'),
      registryArtifactSha256: migration.artifact_sha256,
      transactionId: `upgrade-${'d'.repeat(32)}`,
    });
    fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    const loaded = loadManagedMigrationState(statePath, {
      bundlePath,
      managedBaselineMigrationPath: migrationPath,
      currentSourceRef: 'c'.repeat(40),
    });
    expect(loaded.predecessor_source_ref).toBe('a'.repeat(40));
    expect(consumeManagedMigrationState(statePath, loaded.content_sha256)).toBe(true);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  test('rejects tampered, stale, or ambient migration predecessor state', () => {
    const previous = process.env.VIVENTIUM_AGENT_PREDECESSOR_SOURCE_REF;
    process.env.VIVENTIUM_AGENT_PREDECESSOR_SOURCE_REF = 'e'.repeat(40);
    try {
      expect(
        require('../../../scripts/viventium-seed-agents').parseArgs([]).predecessorSourceRef,
      ).toBe('');
    } finally {
      if (previous == null) delete process.env.VIVENTIUM_AGENT_PREDECESSOR_SOURCE_REF;
      else process.env.VIVENTIUM_AGENT_PREDECESSOR_SOURCE_REF = previous;
    }

    const state = buildManagedMigrationState({
      predecessorSourceRef: 'a'.repeat(40),
      successorSourceRef: 'c'.repeat(40),
      successorBundleSha256: 'b'.repeat(64),
      registryArtifactSha256: 'd'.repeat(64),
      transactionId: `upgrade-${'e'.repeat(32)}`,
    });
    state.successor_source_ref = 'f'.repeat(40);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viventium-managed-state-tamper-'));
    const statePath = path.join(directory, 'agent-managed-migration-pending.json');
    fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    expect(() =>
      loadManagedMigrationState(statePath, {
        bundlePath: path.join(directory, 'missing.yaml'),
        managedBaselineMigrationPath: path.join(directory, 'missing.json'),
        currentSourceRef: 'c'.repeat(40),
      }),
    ).toThrow('Managed migration state content hash does not match.');
  });

  test('audits every published predecessor and proves unchanged versus edited migration behavior', () => {
    const artifactPath = path.resolve(
      __dirname,
      '../../../viventium/source_of_truth/managed-agent-baseline-migration.json',
    );
    const tracked = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const audit = auditHermeticArtifact(tracked);

    expect(audit.artifact).toEqual(tracked);
    expect(tracked.public_lock_revision_count).toBe(74);
    expect(tracked.invalid_predecessors).toHaveLength(3);
    expect(tracked.migrations).toHaveLength(22);
    expect(tracked.migrations.flatMap((item) => item.predecessor_source_refs)).toHaveLength(62);

    for (const group of audit.groups) {
      const migration = tracked.migrations.find(
        (item) =>
          item.predecessor_managed_bundle_sha256 === group.predecessor_managed_bundle_sha256,
      );
      expect(migration).toBeDefined();
      for (const ref of group.predecessor_source_refs) {
        expect(loadManagedBaselineMigration(artifactPath, { predecessorSourceRef: ref })).toEqual(
          migration.baseline,
        );
      }

      let changedField = null;
      for (const [agentId, priorAgent] of Object.entries(group.fullBaseline.agents)) {
        const currentAgent = audit.currentBaseline.agents[agentId];
        if (!currentAgent) continue;
        const result = reconcileManagedAgentFields(
          priorAgent.fields,
          currentAgent.fields,
          migration.baseline.agents[agentId]?.fields || null,
        );
        expect(stableSerializeHistory(result.agentData)).toBe(
          stableSerializeHistory(currentAgent.fields),
        );
        const field = Object.keys(migration.baseline.agents[agentId]?.fields || {})[0];
        if (!changedField && field) {
          changedField = { agentId, field, priorAgent, currentAgent };
        }
      }
      if (changedField) {
        const synthetic = '__synthetic_user_edit__';
        const edited = reconcileManagedAgentFields(
          { ...changedField.priorAgent.fields, [changedField.field]: synthetic },
          changedField.currentAgent.fields,
          migration.baseline.agents[changedField.agentId].fields,
        );
        expect(edited.agentData[changedField.field]).toBe(synthetic);
        expect(edited.drift).toContain(changedField.field);
      }
    }
  }, 120_000);

  test('normalizes Deep Research onto the canonical Anthropic Opus bag during seed-style updates', () => {
    const bundle = {
      meta: {
        user: {
          email: 'seed-owner@example.com',
        },
      },
      mainAgent: {
        id: 'agent_viventium_main_95aeb3',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
      },
      backgroundAgents: [
        {
          id: 'agent_viventium_deep_research_95aeb3',
          provider: 'openAI',
          model: 'gpt-5.4',
          model_parameters: {
            model: 'gpt-5.4',
            reasoning_effort: 'xhigh',
          },
        },
      ],
    };

    const normalized = normalizeBundleForRuntimeWithOwner(bundle, {
      env: {
        VIVENTIUM_AGENT_SEED_OWNER_EMAIL: 'seed-owner@example.com',
        VIVENTIUM_FC_CONSCIOUS_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-8',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_CORTEX_DEEP_RESEARCH_LLM_MODEL: 'claude-opus-4-8',
      },
    });

    expect(normalized.backgroundAgents[0]).toMatchObject({
      id: 'agent_viventium_deep_research_95aeb3',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      model_parameters: {
        model: 'claude-opus-4-8',
        thinkingBudget: 4000,
      },
    });
  });

  test('does not replace missing existing cortex wiring during first seed-style updates', () => {
    const incoming = {
      provider: 'openAI',
      model: 'gpt-5.4',
      background_cortices: [
        {
          agent_id: 'agent-a',
          activation: {
            prompt: 'keep incoming',
            intent_scope: 'productivity_ms365',
          },
        },
      ],
    };

    expect(preserveExistingEditableFields({}, incoming)).toEqual(incoming);
  });

  test('maps local public built-in roles onto ACL-safe access role ids', () => {
    expect(resolvePublicAccessRoleIds('owner')).toEqual({
      normalizedRole: 'owner',
      accessRoleIds: {
        agent: AccessRoleIds.AGENT_OWNER,
        remoteAgent: AccessRoleIds.REMOTE_AGENT_OWNER,
      },
    });

    expect(resolvePublicAccessRoleIds('editor')).toEqual({
      normalizedRole: 'editor',
      accessRoleIds: {
        agent: AccessRoleIds.AGENT_EDITOR,
        remoteAgent: AccessRoleIds.REMOTE_AGENT_EDITOR,
      },
    });
  });

  test('falls back to viewer when public access role is missing or invalid', () => {
    expect(normalizePublicAccessRole('')).toBe('viewer');
    expect(normalizePublicAccessRole('nope')).toBe('viewer');
    expect(normalizePublicAccessRole('agent_owner')).toBe('owner');
    expect(normalizePublicAccessRole('edit')).toBe('editor');
  });

  test('pickAgentFields preserves dedicated voice parameters for seeded installs', () => {
    expect(
      pickAgentFields({
        id: 'agent_viventium_main_95aeb3',
        voice_llm_provider: 'anthropic',
        voice_llm_model: 'claude-haiku-4-5',
        voice_llm_model_parameters: {
          thinking: false,
        },
      }),
    ).toEqual({
      id: 'agent_viventium_main_95aeb3',
      voice_llm_provider: 'anthropic',
      voice_llm_model: 'claude-haiku-4-5',
      voice_llm_model_parameters: {
        thinking: false,
      },
    });
  });
});
