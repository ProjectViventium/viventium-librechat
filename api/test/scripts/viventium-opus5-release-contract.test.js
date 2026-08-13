const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const {
  APPROVED_MAIN_RUNTIME_FAMILIES,
  APPROVED_BACKGROUND_RUNTIME_FAMILIES,
} = require('../../../scripts/viventium-agent-runtime-models');
const { buildManagedBaseline } = require('../../../scripts/viventium-seed-agents');

const repoRoot = path.resolve(__dirname, '../../..');
const sourceRoot = path.join(repoRoot, 'viventium', 'source_of_truth');

function loadYaml(name) {
  return yaml.parse(fs.readFileSync(path.join(sourceRoot, name), 'utf8'));
}

describe('Viventium Claude Opus 5 release contract', () => {
  test('publishes Opus 5 as the only managed Anthropic text model', () => {
    const source = loadYaml('local.librechat.yaml');
    const anthropicSpecs = source.modelSpecs.list.filter(
      (entry) => entry?.preset?.endpoint === 'anthropic',
    );

    expect(anthropicSpecs).toContainEqual(
      expect.objectContaining({
        name: 'claude-opus-5',
        preset: expect.objectContaining({ model: 'claude-opus-5' }),
      }),
    );
    expect(anthropicSpecs.map((entry) => entry.name)).toEqual(['claude-opus-5']);
    expect(source.endpoints.anthropic.titleModel).toBe('claude-opus-5');
    expect(source.endpoints.anthropic.summaryModel).toBe('claude-opus-5');
    expect(source.memory.agent).toEqual(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-5' }),
    );
  });

  test('uses declared GlassHive text fallbacks while keeping classifiers fast', () => {
    const source = loadYaml('local.viventium-agents.yaml');
    const agents = [source.mainAgent, ...source.backgroundAgents];

    for (const agent of agents) {
      expect(agent.fallback_llm_provider).toBe('glasshive-harness');
      expect(agent.fallback_llm_model_parameters.model).toBe(agent.fallback_llm_model);
    }

    const managedBaseline = buildManagedBaseline(source);
    for (const handoffAgent of source.handoffAgents ?? []) {
      expect(managedBaseline.agents[handoffAgent.id]?.fields).toMatchObject({
        provider: handoffAgent.provider,
        model: handoffAgent.model,
      });
      expect(handoffAgent.model_parameters.model).toBe(handoffAgent.model);
    }

    const classifiedCortices = source.mainAgent.background_cortices.filter((cortex) =>
      Array.isArray(cortex.activation?.fallbacks),
    );
    expect(classifiedCortices.length).toBeGreaterThan(0);
    for (const cortex of classifiedCortices) {
      expect(cortex.activation.fallbacks).toContainEqual({
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      });
      expect(cortex.activation.fallbacks).not.toContainEqual({
        provider: 'anthropic',
        model: 'claude-opus-5',
      });
    }
  });

  test('accepts Opus 5 at runtime without a retired Anthropic compatibility family', () => {
    expect(APPROVED_MAIN_RUNTIME_FAMILIES).toBeInstanceOf(Set);
    expect(APPROVED_BACKGROUND_RUNTIME_FAMILIES).toBeInstanceOf(Set);
    expect(APPROVED_MAIN_RUNTIME_FAMILIES.has('anthropic::claude-opus-5')).toBe(true);
    expect(APPROVED_BACKGROUND_RUNTIME_FAMILIES.has('anthropic::claude-opus-5')).toBe(true);
    expect(
      [...APPROVED_MAIN_RUNTIME_FAMILIES].filter((family) => family.startsWith('anthropic::')),
    ).toEqual(['anthropic::claude-opus-5']);
    expect(
      [...APPROVED_BACKGROUND_RUNTIME_FAMILIES].filter((family) =>
        family.startsWith('anthropic::'),
      ),
    ).toEqual(['anthropic::claude-opus-5']);
  });

  /* === VIVENTIUM START === Provider effort parity and form-persistence regression coverage. === */
  test('keeps capability effort choices executable without silently rewriting agent forms', () => {
    const source = loadYaml('local.librechat.yaml');
    const capability = source.endpoints.agents.providerCapabilities['glasshive-harness'];
    const codex = capability.models.find((model) => model.id === 'codex-cli:gpt-5.6-sol');
    const claude = capability.models.find((model) => model.id === 'claude-code:opus');
    expect(codex.effortChoices).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(claude.effortChoices).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    const modelParametersSection = fs.readFileSync(
      path.join(
        repoRoot,
        'client',
        'src',
        'components',
        'SidePanel',
        'Agents',
        'ModelParametersSection.tsx',
      ),
      'utf8',
    );
    expect(modelParametersSection).toContain('{ persistReset: false }');
  });

  test('declares the versioned GlassHive messaging delivery contract in tracked config truth', () => {
    const source = loadYaml('local.librechat.yaml');
    const capability = source.endpoints.agents.providerCapabilities['glasshive-harness'];

    expect(capability.messaging_delivery_disposition).toBe(true);
    expect(capability.messaging_delivery_disposition_version).toBe(1);
  });
  /* === VIVENTIUM END === */
});
