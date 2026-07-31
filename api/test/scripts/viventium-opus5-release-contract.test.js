const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

const {
  APPROVED_MAIN_RUNTIME_FAMILIES,
  APPROVED_BACKGROUND_RUNTIME_FAMILIES,
} = require('../../../scripts/viventium-agent-runtime-models');

const repoRoot = path.resolve(__dirname, '../../..');
const sourceRoot = path.join(repoRoot, 'viventium', 'source_of_truth');

function loadYaml(name) {
  return yaml.parse(fs.readFileSync(path.join(sourceRoot, name), 'utf8'));
}

describe('Viventium Claude Opus 5 release contract', () => {
  test('publishes Opus 5 without removing managed Anthropic compatibility specs', () => {
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
    expect(anthropicSpecs).toContainEqual(
      expect.objectContaining({
        name: 'claude-opus-4-8',
        preset: expect.objectContaining({ model: 'claude-opus-4-8' }),
      }),
    );
    expect(source.endpoints.anthropic.titleModel).toBe('claude-sonnet-4-5');
    expect(source.endpoints.anthropic.summaryModel).toBe('claude-sonnet-4-5');
    expect(source.memory.agent).toEqual(
      expect.objectContaining({ provider: 'anthropic', model: 'claude-sonnet-4-5' }),
    );
  });

  test('uses Opus 5 for managed text fallbacks while keeping classifiers fast', () => {
    const source = loadYaml('local.viventium-agents.yaml');
    const agents = [source.mainAgent, ...source.backgroundAgents];

    for (const agent of agents) {
      expect(agent.fallback_llm_provider).toBe('anthropic');
      expect(agent.fallback_llm_model).toBe('claude-opus-5');
      expect(agent.fallback_llm_model_parameters.model).toBe('claude-opus-5');
    }

    for (const handoffAgent of source.handoffAgents ?? []) {
      expect(handoffAgent.provider).toBe('anthropic');
      expect(handoffAgent.model).toBe('claude-opus-5');
      expect(handoffAgent.model_parameters.model).toBe('claude-opus-5');
    }

    for (const cortex of source.mainAgent.background_cortices) {
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

  test('accepts Opus 5 at runtime while preserving explicit Opus 4.8 compatibility', () => {
    expect(APPROVED_MAIN_RUNTIME_FAMILIES).toBeInstanceOf(Set);
    expect(APPROVED_BACKGROUND_RUNTIME_FAMILIES).toBeInstanceOf(Set);
    expect(APPROVED_MAIN_RUNTIME_FAMILIES.has('anthropic::claude-opus-5')).toBe(true);
    expect(APPROVED_BACKGROUND_RUNTIME_FAMILIES.has('anthropic::claude-opus-5')).toBe(true);
    expect(APPROVED_MAIN_RUNTIME_FAMILIES.has('anthropic::claude-opus-4-8')).toBe(true);
    expect(APPROVED_BACKGROUND_RUNTIME_FAMILIES.has('anthropic::claude-opus-4-8')).toBe(true);
  });
});
