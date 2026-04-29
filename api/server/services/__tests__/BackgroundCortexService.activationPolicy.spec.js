const {
  buildActivationPolicySection,
  hasVisibleCortexInsight,
  normalizeAgentToolNames,
} = require('../BackgroundCortexService');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('BackgroundCortexService activation policy helpers', () => {
  test('renders configured direct-action surfaces only when exact tools are attached', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'The main agent owns direct execution through connected tools.',
            direct_action_mcp_servers: [
              {
                server: 'glasshive-workers-projects',
                owns: 'persistent workers and local computer actions',
                tool_names: ['worker_run_mcp_glasshive-workers-projects'],
              },
              {
                server: 'scheduling-cortex',
                owns: 'scheduled follow-ups',
                tool_names: ['schedule_create_mcp_scheduling-cortex'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects', 'web_search'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('## Global Activation Policy:');
    expect(result.section).toContain('glasshive-workers-projects');
    expect(result.section).not.toContain('scheduling-cortex');
    expect(result.connectedSurfaces.map((surface) => surface.server)).toEqual(['glasshive-workers-projects']);
  });

  test('does not infer direct-action surfaces from undeclared tool-name suffixes', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'Policy text.',
            direct_action_mcp_servers: [
              {
                server: 'future-mcp',
                owns: 'future direct action',
                tool_names: ['future_action'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('Policy text.');
    expect(result.section).not.toContain('future-mcp');
    expect(result.connectedSurfaces).toEqual([]);
  });

  test('renders the generic stricter activation policy without agent-name overfitting', () => {
    const policyPrompt = [
      'The main agent owns the current turn. Background agents are optional reviewers, not controllers.',
      "When this policy and this background agent's own activation criteria disagree, prefer the stricter outcome: do not activate.",
      'unless this same background agent received verified evidence in its own allowed context this turn.',
    ].join('\n\n');
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: policyPrompt,
          },
        },
      },
    };

    const result = buildActivationPolicySection({ config, mainAgent: { tools: [] } });

    expect(result.section).toContain('Background agents are optional reviewers, not controllers.');
    expect(result.section).toContain('prefer the stricter outcome: do not activate.');
    expect(result.section).toContain('verified evidence in its own allowed context');
    expect(result.section).not.toMatch(/emotional|user-help|product-help/i);
  });

  test('source-of-truth activation policy stays generic and agent-name agnostic', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
    const prompt = source?.viventium?.background_cortices?.activation_policy?.prompt || '';

    expect(prompt).toContain('Background agents are optional reviewers, not controllers.');
    expect(prompt).toContain('connected direct-action surface');
    expect(prompt).toContain('Return should_activate=true only when the latest request contains a separate explicit question or decision');
    expect(prompt).toContain('If uncertain, return should_activate=false.');
    expect(prompt).not.toMatch(
      /Emotional Resonance|Confirmation Bias|Red Team|Pattern Recognition|Strategic Planning|Viventium User Help|Deep Research|product-help|user-help/i,
    );
  });

  test('source-of-truth policy does not declare generic reasoning tools as direct-action blockers', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
    const directActionServers =
      source?.viventium?.background_cortices?.activation_policy?.direct_action_mcp_servers || [];
    const declaredTools = directActionServers.flatMap((server) => server.tool_names || []);

    expect(directActionServers.map((server) => server.server)).toEqual(
      expect.arrayContaining(['glasshive-workers-projects', 'scheduling-cortex']),
    );
    expect(declaredTools).not.toContain('web_search');
    expect(declaredTools).not.toContain('file_search');
    expect(declaredTools).not.toContain('sequential-thinking');
  });

  test('normalizes string and object tool declarations', () => {
    expect(
      normalizeAgentToolNames({
        tools: ['web_search', { name: 'worker_run_mcp_glasshive-workers-projects' }, { id: 'schedule_create' }],
      }),
    ).toEqual(['web_search', 'worker_run_mcp_glasshive-workers-projects', 'schedule_create']);
  });

  test('suppresses empty and no-response cortex output', () => {
    expect(hasVisibleCortexInsight('')).toBe(false);
    expect(hasVisibleCortexInsight('   {NTA}   ')).toBe(false);
    expect(hasVisibleCortexInsight('Real insight with {NTA} mentioned in a sentence.')).toBe(true);
  });
});
