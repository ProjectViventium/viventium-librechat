/* === VIVENTIUM START ===
 * Purpose: Guard the seed/runtime-aware model contract for built-in agents.
 * Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
 * === VIVENTIUM END === */

const {
  normalizeBundleForRuntimeWithOwner,
  normalizePublicAccessRole,
  preserveExistingEditableFields,
  resolvePublicAccessRoleIds,
} = require('../../../scripts/viventium-seed-agents');
const { AccessRoleIds } = require('librechat-data-provider');

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
              model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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
        VIVENTIUM_FC_CONSCIOUS_LLM_MODEL: 'claude-opus-4-6',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_PROVIDER: 'anthropic',
        VIVENTIUM_CORTEX_PRODUCTIVITY_LLM_MODEL: 'claude-sonnet-4-6',
        OTUC_ACTIVATION_PROVIDER: 'groq',
        OTUC_ACTIVATION_LLM: 'meta-llama/llama-4-scout-17b-16e-instruct',
      },
    });

    expect(normalized.meta.user).toEqual({ email: 'seed-owner@example.com' });
    expect(normalized.mainAgent.provider).toBe('anthropic');
    expect(normalized.mainAgent.model).toBe('claude-opus-4-6');
    expect(normalized.mainAgent.voice_llm_provider).toBe('openAI');
    expect(normalized.mainAgent.voice_llm_model).toBe('gpt-5.4');
    expect(normalized.backgroundAgents[0].provider).toBe('anthropic');
    expect(normalized.backgroundAgents[0].model).toBe('claude-sonnet-4-6');
    expect(normalized.backgroundAgents[0].model_parameters.model).toBe('claude-sonnet-4-6');
  });

  test('preserves only runtime-editable cortex wiring from existing agents', () => {
    const existing = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      model_parameters: {
        model: 'claude-sonnet-4-6',
      },
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
      model_parameters: {
        model: 'gpt-5.4',
      },
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
      provider: 'openAI',
      model: 'gpt-5.4',
      model_parameters: {
        model: 'gpt-5.4',
      },
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
});
