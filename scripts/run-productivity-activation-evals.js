#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ROOT_DIR, '..', '..');
const QA_RESULTS_ROOT = path.join(REPO_ROOT, 'qa', 'results', 'productivity_activation');
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

function parseArgs(argv) {
  const args = {
    bundlePath: DEFAULT_BUNDLE_PATH,
    outputDir: null,
  };

  for (const arg of argv) {
    if (arg.startsWith('--bundle=')) {
      args.bundlePath = path.resolve(arg.slice('--bundle='.length));
    } else if (arg.startsWith('--output-dir=')) {
      args.outputDir = path.resolve(arg.slice('--output-dir='.length));
    }
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

function extractActivationByAgentId(bundle) {
  const cortices = bundle?.mainAgent?.background_cortices;
  if (!Array.isArray(cortices)) {
    throw new Error('Bundle is missing mainAgent.background_cortices');
  }
  return new Map(cortices.map((entry) => [entry.agent_id, entry.activation]));
}

function getScenarios() {
  return [
    {
      id: 'google_format_direct_ok_after_failed_productivity_turn',
      messages: [
        {
          role: 'user',
          content:
            'now, check my gmail as well as my outlook to see whats been happenning in past 10 days and give me a full run down',
        },
        { role: 'assistant', content: "I couldn't finish that check just now." },
        { role: 'user', content: 'Please reply with exactly DIRECT_OK and nothing else.' },
      ],
      expectations: { google: false, ms365: false },
    },
    {
      id: 'chat_format_say_test_worked',
      messages: [{ role: 'user', content: 'say Test Worked' }],
      expectations: { google: false, ms365: false },
    },
    {
      id: 'chat_format_respond_only_yes_after_email_context',
      messages: [
        { role: 'user', content: 'check my outlook inbox and gmail inbox and summarize anything urgent' },
        { role: 'assistant', content: 'Checking now.' },
        { role: 'user', content: 'respond only with yes' },
      ],
      expectations: { google: false, ms365: false },
    },
    {
      id: 'google_inbox_last_10_days',
      messages: [
        {
          role: 'user',
          content: 'Check my Gmail inbox and tell me what happened in the past 10 days.',
        },
      ],
      expectations: { google: true, ms365: false },
    },
    {
      id: 'ms365_inbox_last_10_days',
      messages: [
        {
          role: 'user',
          content: 'Check my Outlook inbox and tell me what happened in the past 10 days.',
        },
      ],
      expectations: { google: false, ms365: true },
    },
    {
      id: 'google_calendar_today',
      messages: [{ role: 'user', content: 'What meetings do I have today in Google Calendar?' }],
      expectations: { google: true, ms365: false },
    },
    {
      id: 'ms365_calendar_today',
      messages: [{ role: 'user', content: 'What meetings do I have in Outlook today?' }],
      expectations: { google: false, ms365: true },
    },
    {
      id: 'mixed_outlook_and_gmail',
      messages: [
        {
          role: 'user',
          content: 'Check both Outlook and Gmail and summarize anything urgent from the last 10 days.',
        },
      ],
      expectations: { google: true, ms365: true },
    },
    {
      id: 'capability_question_only',
      messages: [{ role: 'user', content: 'Can you access my email?' }],
      expectations: { google: false, ms365: false },
    },
    {
      id: 'provider_clarification_outlook',
      messages: [
        { role: 'user', content: 'Check my inbox for replies from Joey.' },
        { role: 'assistant', content: 'Gmail or Outlook?' },
        { role: 'user', content: 'Outlook.' },
      ],
      expectations: { google: false, ms365: true },
    },
  ];
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

async function run() {
  const args = parseArgs(process.argv.slice(2));

  process.chdir(ROOT_DIR);
  loadEnvIfPresent(path.join(ROOT_DIR, '.env'));
  loadEnvIfPresent(path.join(ROOT_DIR, '.env.local'), true);
  loadEnvIfPresent(path.join(RUNTIME_ENV_DIR, 'runtime.env'), true);
  loadEnvIfPresent(path.join(RUNTIME_ENV_DIR, 'runtime.local.env'), true);
  process.env.CONFIG_BYPASS_VALIDATION = process.env.CONFIG_BYPASS_VALIDATION || 'true';

  require('module-alias')({ base: path.resolve(ROOT_DIR, 'api') });
  const yaml = require('js-yaml');
  const { checkCortexActivation } = require(path.join(ROOT_DIR, 'api/server/services/BackgroundCortexService'));

  const bundle = yaml.load(fs.readFileSync(args.bundlePath, 'utf8'));
  const activationByAgentId = extractActivationByAgentId(bundle);
  const reqConfig = buildReqConfig();
  const scenarios = getScenarios();
  const timestamp = timestampSlug();
  const outputDir = args.outputDir || path.join(QA_RESULTS_ROOT, timestamp);
  ensureDir(outputDir);

  const agents = [
    { key: 'google', agentId: 'agent_8Y1d7JNhpubtvzYz3hvEv', label: 'Google Workspace' },
    { key: 'ms365', agentId: 'agent_viventium_online_tool_use_95aeb3', label: 'MS365' },
  ];

  const results = [];

  for (const scenario of scenarios) {
    for (const agent of agents) {
      const activation = activationByAgentId.get(agent.agentId);
      if (!activation) {
        throw new Error(`Missing activation config for ${agent.agentId}`);
      }

      const startedAt = Date.now();
      let outcome;
      let error = null;

      try {
        outcome = await checkCortexActivation({
          cortexConfig: {
            agent_id: agent.agentId,
            activation,
          },
          messages: scenario.messages,
          runId: `qa-${scenario.id}-${agent.key}-${Date.now()}`,
          req: {
            config: reqConfig,
            user: { id: `qa-${scenario.id}-${agent.key}` },
            body: {
              conversationId: `qa-${scenario.id}-${agent.key}`,
              viventiumSurface: 'telegram',
              viventiumInputMode: 'text',
            },
          },
          timeoutMs: 6000,
        });
      } catch (err) {
        error = {
          message: err.message,
          stack: err.stack,
        };
      }

      const expected = scenario.expectations[agent.key];
      const actual = outcome ? Boolean(outcome.shouldActivate) : null;
      results.push({
        scenarioId: scenario.id,
        agent: agent.label,
        agentId: agent.agentId,
        expectedShouldActivate: expected,
        actualShouldActivate: actual,
        pass: error == null && actual === expected,
        durationMs: Date.now() - startedAt,
        reason: outcome?.reason || null,
        confidence: outcome?.confidence ?? null,
        error,
        messages: scenario.messages,
      });
    }
  }

  const failures = results.filter((entry) => !entry.pass);
  const summary = {
    generatedAt: new Date().toISOString(),
    bundlePath: args.bundlePath,
    resultCount: results.length,
    passCount: results.length - failures.length,
    failCount: failures.length,
    failures: failures.map((entry) => ({
      scenarioId: entry.scenarioId,
      agent: entry.agent,
      expectedShouldActivate: entry.expectedShouldActivate,
      actualShouldActivate: entry.actualShouldActivate,
      reason: entry.reason,
      error: entry.error?.message || null,
    })),
  };

  const jsonPath = path.join(outputDir, 'productivity-activation-eval.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ summary, results }, null, 2));

  const markdownLines = [
    '# Productivity Activation Eval',
    '',
    `- Generated: ${summary.generatedAt}`,
    `- Bundle: ${summary.bundlePath}`,
    `- Pass: ${summary.passCount}/${summary.resultCount}`,
    `- Failures: ${summary.failCount}`,
    '',
    '| Scenario | Agent | Expected | Actual | Pass | Confidence | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...results.map((entry) => {
      const actualText =
        entry.actualShouldActivate === null ? 'error' : String(entry.actualShouldActivate);
      const confidenceText =
        entry.confidence === null || entry.confidence === undefined
          ? ''
          : Number(entry.confidence).toFixed(2);
      const reasonText = entry.error?.message || entry.reason || '';
      return `| ${entry.scenarioId} | ${entry.agent} | ${entry.expectedShouldActivate} | ${actualText} | ${
        entry.pass ? 'PASS' : 'FAIL'
      } | ${confidenceText} | ${reasonText.replace(/\|/g, '\\|')} |`;
    }),
    '',
  ];

  const markdownPath = path.join(outputDir, 'productivity-activation-eval.md');
  fs.writeFileSync(markdownPath, `${markdownLines.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        outputDir,
        jsonPath,
        markdownPath,
        ...summary,
      },
      null,
      2,
    ),
  );

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: error.message,
        stack: error.stack,
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
