#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT_DIR, '..', '..');
const QA_RESULTS_ROOT = path.join(REPO_ROOT, 'qa', 'results', 'activation_provider_benchmarks');
const DEFAULT_BUNDLE_PATH = path.join(
  ROOT_DIR,
  'viventium',
  'source_of_truth',
  'local.viventium-agents.yaml',
);
const RUNTIME_ENV_DIR = path.join(
  process.env.HOME || '',
  'Library',
  'Application Support',
  'Viventium',
  'runtime',
);

const CORTEX_IDS = {
  backgroundAnalysis: 'agent_viventium_background_analysis_95aeb3',
  confirmationBias: 'agent_viventium_confirmation_bias_95aeb3',
  redTeam: 'agent_viventium_red_team_95aeb3',
  deepResearch: 'agent_viventium_deep_research_95aeb3',
  ms365: 'agent_viventium_online_tool_use_95aeb3',
  parietal: 'agent_viventium_parietal_cortex_95aeb3',
  pattern: 'agent_viventium_pattern_recognition_95aeb3',
  emotional: 'agent_viventium_emotional_resonance_95aeb3',
  strategic: 'agent_viventium_strategic_planning_95aeb3',
  support: 'agent_viventium_support_95aeb3',
  google: 'agent_8Y1d7JNhpubtvzYz3hvEv',
};

function parseArgs(argv) {
  const args = {
    bundlePath: DEFAULT_BUNDLE_PATH,
    outputDir: null,
    budgetMs: 2000,
    candidates: [],
    userId: process.env.VIVENTIUM_ACTIVATION_BENCH_USER_ID || '',
  };

  for (const arg of argv) {
    if (arg.startsWith('--bundle=')) {
      args.bundlePath = path.resolve(arg.slice('--bundle='.length));
    } else if (arg.startsWith('--output-dir=')) {
      args.outputDir = path.resolve(arg.slice('--output-dir='.length));
    } else if (arg.startsWith('--budget-ms=')) {
      args.budgetMs = Number(arg.slice('--budget-ms='.length)) || args.budgetMs;
    } else if (arg.startsWith('--candidate=')) {
      const raw = arg.slice('--candidate='.length);
      const [label, provider, model] = raw.split('|').map((part) => part?.trim());
      if (label && provider && model) {
        args.candidates.push({ label, provider, model });
      }
    } else if (arg.startsWith('--user-id=')) {
      args.userId = arg.slice('--user-id='.length).trim();
    }
  }

  if (args.candidates.length === 0) {
    args.candidates = [
      {
        label: 'groq-llama4-scout',
        provider: 'groq',
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      },
      {
        label: 'sambanova-llama33-70b',
        provider: 'sambanova',
        model: 'Meta-Llama-3.3-70B-Instruct',
      },
      {
        label: 'sambanova-llama31-8b',
        provider: 'sambanova',
        model: 'Meta-Llama-3.1-8B-Instruct',
      },
      {
        label: 'sambanova-llama4-maverick',
        provider: 'sambanova',
        model: 'Llama-4-Maverick-17B-128E-Instruct',
      },
      {
        label: 'anthropic-haiku45',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      },
    ];
  }

  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadEnvIfPresent(filePath, override = false) {
  if (fs.existsSync(filePath)) {
    require('dotenv').config({ path: filePath, override });
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function toPublicPath(filePath, baseDir = REPO_ROOT) {
  const resolved = path.resolve(filePath);
  const normalizedBase = path.resolve(baseDir);
  if (resolved === normalizedBase) {
    return '.';
  }
  if (resolved.startsWith(`${normalizedBase}${path.sep}`)) {
    return path.relative(normalizedBase, resolved).split(path.sep).join('/');
  }
  return path.basename(resolved);
}

function percentile(values, p) {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function mean(values) {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildReqConfig() {
  return {
    viventium: {
      background_cortices: {
        activation_format: {
          response_format: `Respond with a JSON object:
{
  "should_activate": true,
  "confidence": 1.0,
  "reason": "2-4 explanatory words"
}`,
        },
      },
    },
  };
}

function getScenarios() {
  return [
    {
      id: 'background_analysis_blind_spots',
      description: 'Plan review with explicit blind-spot analysis request',
      messages: [
        {
          role: 'user',
          content:
            "Here's my launch plan: I'll quit my job next month, ship in two weeks, and figure out distribution later. Analyze the blind spots and hidden risks.",
        },
      ],
      targets: [CORTEX_IDS.backgroundAnalysis, CORTEX_IDS.redTeam],
    },
    {
      id: 'confirmation_bias_overconfidence',
      description: 'Overconfident claim with unexamined assumptions',
      messages: [
        {
          role: 'user',
          content:
            "This will definitely work. Everyone knows our users will pay immediately, so I don't need to validate pricing or test alternatives.",
        },
      ],
      targets: [CORTEX_IDS.confirmationBias, CORTEX_IDS.redTeam],
    },
    {
      id: 'deep_research_compare',
      description: 'Explicit multi-step research request',
      messages: [
        {
          role: 'user',
          content:
            'Do a deep dive comparing Linear and Jira across setup effort, workflow flexibility, and reporting. I want a comprehensive comparison.',
        },
      ],
      targets: [CORTEX_IDS.deepResearch],
    },
    {
      id: 'support_how_to',
      description: 'In-product how-to help request',
      messages: [
        {
          role: 'user',
          content:
            'How do I schedule a recurring reminder in Viventium, and where do I manage it after it is created?',
        },
      ],
      targets: [CORTEX_IDS.support],
    },
    {
      id: 'parietal_probability',
      description: 'Math/statistics request',
      messages: [
        {
          role: 'user',
          content: 'What is the probability of getting exactly two heads in three fair coin flips?',
        },
      ],
      targets: [CORTEX_IDS.parietal],
    },
    {
      id: 'emotional_burnout',
      description: 'Emotional vulnerability and burnout signal',
      messages: [
        {
          role: 'user',
          content:
            "I'm exhausted and kind of numb. I keep telling everyone I'm fine, but honestly I feel like I'm burning out.",
        },
      ],
      targets: [CORTEX_IDS.emotional],
    },
    {
      id: 'strategic_planning_roadmap',
      description: 'Roadmap / planning request',
      messages: [
        {
          role: 'user',
          content:
            'Help me build a 90-day roadmap to ship the installer, stabilize onboarding, and prepare an open-source launch.',
        },
      ],
      targets: [CORTEX_IDS.strategic],
    },
    {
      id: 'pattern_recognition_multiturn',
      description: 'Three-turn recurring pattern prompt',
      messages: [
        {
          role: 'user',
          content: 'I keep delaying the public launch because I want every detail perfect first.',
        },
        {
          role: 'assistant',
          content: 'What feels risky about shipping before everything is polished?',
        },
        {
          role: 'user',
          content: 'It keeps happening. I tell myself one more tweak will fix it, then I delay again.',
        },
        {
          role: 'assistant',
          content: 'What stands out to you about that loop?',
        },
        {
          role: 'user',
          content: 'What pattern do you see in how I handle launches?',
        },
      ],
      targets: [CORTEX_IDS.pattern],
    },
    {
      id: 'ms365_provider_clarification',
      description: 'The exact provider clarification bug class from the user report',
      messages: [
        { role: 'user', content: 'Fair to say Contact A and Contact B ghosted?' },
        {
          role: 'assistant',
          content:
            'Zero email activity in either direction for the last 30 days from or to either of them.',
        },
        { role: 'user', content: 'Ms365' },
      ],
      targets: [CORTEX_IDS.ms365],
    },
    {
      id: 'google_inbox_last_10_days',
      description: 'Google Workspace inbox scan',
      messages: [
        {
          role: 'user',
          content: 'Check my Gmail inbox and tell me what happened in the past 10 days.',
        },
      ],
      targets: [CORTEX_IDS.google],
    },
    {
      id: 'mixed_outlook_and_gmail',
      description: 'Mixed-provider inbox request',
      messages: [
        {
          role: 'user',
          content: 'Check both Outlook and Gmail and summarize anything urgent from the last 10 days.',
        },
      ],
      targets: [CORTEX_IDS.ms365, CORTEX_IDS.google],
    },
    {
      id: 'negative_chat_format',
      description: 'Response-format instruction should not activate cortices',
      messages: [{ role: 'user', content: 'Please reply with exactly DIRECT_OK and nothing else.' }],
      targets: [],
    },
  ];
}

function extractActivationByAgentId(bundle) {
  const cortices = bundle?.mainAgent?.background_cortices;
  if (!Array.isArray(cortices)) {
    throw new Error('Bundle is missing mainAgent.background_cortices');
  }
  return cortices;
}

function toStatusCode(error) {
  const status = error?.status ?? error?.response?.status ?? error?.cause?.status ?? null;
  return Number.isFinite(Number(status)) ? Number(status) : null;
}

function truncate(text, max = 180) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function getEnvBackedEndpointConfig(providerName) {
  const normalized = String(providerName || '').trim().toUpperCase();
  if (!normalized) {
    return null;
  }
  const apiKey =
    process.env[`${normalized}_API_KEY`]?.trim() ||
    process.env[`${normalized}_KEY`]?.trim() ||
    '';
  const baseURL =
    process.env[`${normalized}_BASE_URL`]?.trim() ||
    process.env[`${normalized}_API_BASE_URL`]?.trim() ||
    '';
  const defaultBaseUrls = {
    GROQ: 'https://api.groq.com/openai/v1/',
    SAMBANOVA: 'https://api.sambanova.ai/v1/',
    ANTHROPIC: 'https://api.anthropic.com',
  };
  const resolvedBaseURL = baseURL || defaultBaseUrls[normalized] || '';
  if (!apiKey || !resolvedBaseURL) {
    return null;
  }
  return { apiKey, baseURL: resolvedBaseURL };
}

function withTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

async function probeCandidate(candidate, options = {}) {
  if (candidate.provider === 'anthropic' && options.userId) {
    return {
      ok: true,
      status: 'skipped_connected_account',
      httpCode: null,
      latencyMs: null,
      message:
        'Skipped raw API probe because Anthropic is being benchmarked through the connected-account runtime path.',
    };
  }

  const config = getEnvBackedEndpointConfig(candidate.provider);
  if (!config) {
    return {
      ok: false,
      status: 'missing_config',
      httpCode: null,
      latencyMs: null,
      message: 'missing API key or base URL',
    };
  }

  const startedAt = Date.now();

  try {
    let response;
    if (candidate.provider === 'anthropic') {
      response = await fetch(`${config.baseURL.replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: candidate.model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with OK' }],
        }),
      });
    } else {
      response = await fetch(`${withTrailingSlash(config.baseURL)}chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: candidate.model,
          temperature: 0,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Reply with OK' }],
        }),
      });
    }

    const text = await response.text();
    return {
      ok: response.ok,
      status: response.ok ? 'ok' : 'http_error',
      httpCode: response.status,
      latencyMs: Date.now() - startedAt,
      message: truncate(text),
    };
  } catch (error) {
    return {
      ok: false,
      status: 'transport_error',
      httpCode: null,
      latencyMs: Date.now() - startedAt,
      message: truncate(error?.message || error),
    };
  }
}

async function runCandidate({
  candidate,
  cortices,
  scenarios,
  reqConfig,
  checkCortexActivation,
  clearActivationCooldowns,
  budgetMs,
  userId,
}) {
  const scenarioResults = [];
  const batchLatencies = [];
  const callLatencies = [];
  let totalTargets = 0;
  let targetHits = 0;
  let negativeScenarios = 0;
  let cleanNegativeScenarios = 0;
  let spilloverCount = 0;
  let totalCalls = 0;
  let completedCalls = 0;
  let errorCalls = 0;
  let timeoutCalls = 0;
  let exactMatches = 0;

  const probe = await probeCandidate(candidate, { userId });
  clearActivationCooldowns();

  for (const scenario of scenarios) {
    clearActivationCooldowns();
    const batchStartedAt = Date.now();
    const callResults = await Promise.all(
      cortices.map(async (cortex) => {
        const activation = {
          ...(cortex.activation || {}),
          provider: candidate.provider,
          model: candidate.model,
          fallbacks: [],
        };
        const startedAt = Date.now();
        let outcome = null;
        let thrownError = null;
        try {
          outcome = await checkCortexActivation({
            cortexConfig: {
              agent_id: cortex.agent_id,
              activation,
            },
            messages: scenario.messages,
            runId: `bench-${candidate.label}-${scenario.id}-${cortex.agent_id}-${Date.now()}`,
            req: {
              config: reqConfig,
              user: { id: userId || `bench-${candidate.label}-${scenario.id}` },
              body: {
                conversationId: `bench-${candidate.label}-${scenario.id}`,
                viventiumSurface: 'web',
                viventiumInputMode: 'text',
              },
            },
            timeoutMs: budgetMs,
          });
        } catch (error) {
          thrownError = error;
        }

        const durationMs = Date.now() - startedAt;
        callLatencies.push(durationMs);
        totalCalls += 1;
        if (thrownError) {
          errorCalls += 1;
        } else {
          const lastAttempt = outcome?.providerAttempts?.[outcome.providerAttempts.length - 1];
          if (lastAttempt?.status === 'completed') {
            completedCalls += 1;
          } else if (outcome?.reason === 'global_timeout') {
            timeoutCalls += 1;
          } else {
            errorCalls += 1;
          }
        }

        return {
          agentId: cortex.agent_id,
          shouldActivate: Boolean(outcome?.shouldActivate),
          confidence: outcome?.confidence ?? null,
          reason: outcome?.reason ?? (thrownError?.message || null),
          durationMs,
          providerAttempts: outcome?.providerAttempts ?? [],
          error: thrownError
            ? {
                message: truncate(thrownError?.message || thrownError),
                statusCode: toStatusCode(thrownError),
              }
            : null,
        };
      }),
    );
    const batchDurationMs = Date.now() - batchStartedAt;
    batchLatencies.push(batchDurationMs);

    const activated = callResults.filter((entry) => entry.shouldActivate).map((entry) => entry.agentId);
    const activatedSet = new Set(activated);
    const targetSet = new Set(scenario.targets);
    const hits = scenario.targets.filter((agentId) => activatedSet.has(agentId));
    const spillover = activated.filter((agentId) => !targetSet.has(agentId));
    const isExactMatch =
      activated.length === scenario.targets.length &&
      scenario.targets.every((agentId) => activatedSet.has(agentId));

    totalTargets += scenario.targets.length;
    targetHits += hits.length;
    spilloverCount += spillover.length;
    if (scenario.targets.length === 0) {
      negativeScenarios += 1;
      if (activated.length === 0) {
        cleanNegativeScenarios += 1;
      }
    }
    if (isExactMatch) {
      exactMatches += 1;
    }

    scenarioResults.push({
      id: scenario.id,
      description: scenario.description,
      targetAgentIds: scenario.targets,
      activatedAgentIds: activated,
      targetHits: hits,
      spilloverAgentIds: spillover,
      exactMatch: isExactMatch,
      batchDurationMs,
      callResults,
    });
  }

  return {
    candidate,
    probe,
    summary: {
      totalScenarios: scenarios.length,
      totalCalls,
      completedCalls,
      errorCalls,
      timeoutCalls,
      targetHitRate: totalTargets > 0 ? targetHits / totalTargets : null,
      cleanNegativeRate: negativeScenarios > 0 ? cleanNegativeScenarios / negativeScenarios : null,
      avgSpilloverPerScenario: spilloverCount / scenarios.length,
      exactMatchRate: exactMatches / scenarios.length,
      avgBatchLatencyMs: mean(batchLatencies),
      p95BatchLatencyMs: percentile(batchLatencies, 95),
      maxBatchLatencyMs: batchLatencies.length ? Math.max(...batchLatencies) : null,
      avgCallLatencyMs: mean(callLatencies),
      p95CallLatencyMs: percentile(callLatencies, 95),
    },
    scenarios: scenarioResults,
  };
}

function formatPercent(value) {
  if (value == null) {
    return 'n/a';
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value) {
  if (value == null) {
    return 'n/a';
  }
  return `${Math.round(value)} ms`;
}

function buildMarkdown({ budgetMs, results, jsonPath }) {
  const lines = [
    '# Activation Provider Benchmark',
    '',
    `- Run date: ${new Date().toISOString()}`,
    `- Phase A budget per activation call: ${budgetMs} ms`,
    `- Raw JSON: \`${toPublicPath(jsonPath)}\``,
    '',
    '## Summary',
    '',
    '| Candidate | Probe | HTTP | Probe Latency | Target Hit Rate | Clean Negative Rate | Avg Spillover | Avg Batch | P95 Batch | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const entry of results) {
    const notes = [];
    if (!entry.probe.ok) {
      notes.push(entry.probe.message);
    }
    if (entry.summary.errorCalls > 0) {
      notes.push(`${entry.summary.errorCalls}/${entry.summary.totalCalls} activation calls errored`);
    }
    if (entry.summary.timeoutCalls > 0) {
      notes.push(`${entry.summary.timeoutCalls} timed out`);
    }
    lines.push(
      `| ${entry.candidate.label} | ${entry.probe.status} | ${entry.probe.httpCode ?? 'n/a'} | ${formatMs(entry.probe.latencyMs)} | ${formatPercent(entry.summary.targetHitRate)} | ${formatPercent(entry.summary.cleanNegativeRate)} | ${entry.summary.avgSpilloverPerScenario.toFixed(2)} | ${formatMs(entry.summary.avgBatchLatencyMs)} | ${formatMs(entry.summary.p95BatchLatencyMs)} | ${notes.join('; ').replace(/\|/g, '\\|')} |`,
    );
  }

  lines.push('', '## Scenario Details', '');
  for (const entry of results) {
    lines.push(`### ${entry.candidate.label}`, '');
    lines.push(
      '| Scenario | Targets | Activated | Spillover | Batch Latency | Exact Match |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const scenario of entry.scenarios) {
      lines.push(
        `| ${scenario.id} | ${scenario.targetAgentIds.join(', ') || 'none'} | ${scenario.activatedAgentIds.join(', ') || 'none'} | ${scenario.spilloverAgentIds.join(', ') || 'none'} | ${formatMs(scenario.batchDurationMs)} | ${scenario.exactMatch ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  process.chdir(ROOT_DIR);
  // Preserve explicitly supplied shell env vars so ad hoc benchmark credentials win over stale runtime env.
  loadEnvIfPresent(path.join(ROOT_DIR, '.env'));
  loadEnvIfPresent(path.join(ROOT_DIR, '.env.local'));
  loadEnvIfPresent(path.join(RUNTIME_ENV_DIR, 'runtime.env'));
  loadEnvIfPresent(path.join(RUNTIME_ENV_DIR, 'runtime.local.env'));
  process.env.CONFIG_BYPASS_VALIDATION = process.env.CONFIG_BYPASS_VALIDATION || 'true';

  require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });
  const yaml = require('js-yaml');
  const mongoose = require('mongoose');
  const { connectDb } = require(path.join(ROOT_DIR, 'api/db/connect'));
  const {
    checkCortexActivation,
    clearActivationCooldowns,
  } = require(path.join(ROOT_DIR, 'api/server/services/BackgroundCortexService'));

  await connectDb();

  try {
    const bundle = yaml.load(fs.readFileSync(args.bundlePath, 'utf8'));
    const cortices = extractActivationByAgentId(bundle);
    const scenarios = getScenarios();
    const reqConfig = buildReqConfig();

    const outputDir = args.outputDir || path.join(QA_RESULTS_ROOT, timestampSlug());
    ensureDir(outputDir);

    const results = [];
    for (const candidate of args.candidates) {
      results.push(
        await runCandidate({
          candidate,
          cortices,
          scenarios,
          reqConfig,
          checkCortexActivation,
          clearActivationCooldowns,
          budgetMs: args.budgetMs,
          userId: args.userId,
        }),
      );
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      budgetMs: args.budgetMs,
      bundleSource: toPublicPath(args.bundlePath, ROOT_DIR),
      authMode: args.userId ? 'connected-account' : 'env-api-key',
      candidates: args.candidates,
      results,
    };

    const jsonPath = path.join(outputDir, 'activation-provider-benchmark.json');
    fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    const markdown = buildMarkdown({ budgetMs: args.budgetMs, results, jsonPath });
    const markdownPath = path.join(outputDir, 'activation-provider-benchmark.md');
    fs.writeFileSync(markdownPath, markdown, 'utf8');

    console.log(
      JSON.stringify(
        {
          outputDir: toPublicPath(outputDir),
          jsonPath: toPublicPath(jsonPath),
          markdownPath: toPublicPath(markdownPath),
        },
        null,
        2,
      ),
    );
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
